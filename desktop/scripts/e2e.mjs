// End-to-end check against the real window.
//
// Boots the packaged app with a remote debugging port, drives the renderer over
// CDP the way a user would (type, submit, wait), and asserts the transcript,
// the mascot mount and the header stats. No test hooks live in the app itself.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const electronExe = require('electron');

const PORT = Number(process.env.FAIRY_PI_E2E_PORT || 9333);
const PROMPT = process.env.FAIRY_PI_E2E_PROMPT || '只回复两个字：好的';
const READY_TIMEOUT = 45000;
const RUN_TIMEOUT = 120000;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Point FAIRY_PI_E2E_BIN at a packaged Fairy-pi.exe to check the shipped
// artifact instead of the development tree.
const packaged = process.env.FAIRY_PI_E2E_BIN;

const child = packaged
  ? spawn(packaged, [`--remote-debugging-port=${PORT}`], {
      cwd: path.dirname(packaged),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn(electronExe, [appDir, `--remote-debugging-port=${PORT}`], {
      cwd: appDir,
      env: { ...process.env, FAIRY_PI_WORKDIR: process.env.FAIRY_PI_WORKDIR || path.resolve(appDir, '..') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
child.stdout.setEncoding('utf8');
child.stdout.on('data', () => {});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (text) => {
  const trimmed = String(text).trim();
  if (trimmed) console.log(`  [app] ${trimmed}`);
});

let socket = null;

async function findPage() {
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = await response.json();
      const page = pages.find((entry) => entry.type === 'page' && /index\.html/.test(entry.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('窗口未在超时内出现');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    socket = ws;
    let nextId = 1;
    const waiters = new Map();
    ws.addEventListener('open', () => resolve({ evaluate }));
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const waiter = waiters.get(payload.id);
      if (waiter) {
        waiters.delete(payload.id);
        waiter(payload);
      }
    });

    function evaluate(expression) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiters.set(id, (payload) => {
          const result = payload.result && payload.result.result;
          if (payload.error) resolve({ error: payload.error.message });
          else if (result && result.exceptionDetails) resolve({ error: result.exceptionDetails.text });
          else resolve({ value: result ? result.value : undefined });
        });
        ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      });
    }
  });
}

const readState = `(() => {
  const bubbles = Array.from(document.querySelectorAll('#messages .msg'));
  return {
    mascot: Boolean(document.querySelector('#fairy-mount [data-dsh-fairy-mascot-root="true"]')),
    mascotState: (document.querySelector('#fairy-mount [data-dsh-fairy-mascot-root="true"]') || {}).dataset?.state || null,
    bubbleCount: bubbles.length,
    assistantText: bubbles.filter((b) => b.classList.contains('msg-assistant')).map((b) => b.innerText).join('\\n'),
    userText: bubbles.filter((b) => b.classList.contains('msg-user')).map((b) => b.innerText).join('\\n'),
    errors: Array.from(document.querySelectorAll('.toast.error')).map((t) => t.innerText),
    model: document.getElementById('chip-model').innerText,
    tokens: document.getElementById('stat-tokens').innerText,
    cost: document.getElementById('stat-cost').innerText,
    runState: document.getElementById('run-state').innerText,
    title: document.title,
  };
})()`;

async function main() {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);

  // boot() resolves asynchronously and fills the header in two stages (title,
  // then the state query), so wait for the model chip before asserting.
  let boot = null;
  const bootDeadline = Date.now() + 25000;
  while (Date.now() < bootDeadline) {
    const read = await cdp.evaluate(readState);
    if (read.error) throw new Error(`读取界面失败：${read.error}`);
    boot = read;
    if (boot.value && boot.value.model !== '模型 —') break;
    await sleep(400);
  }
  console.log('  启动状态:', JSON.stringify(boot.value));
  check('Fairy 形象已挂载', boot.value && boot.value.mascot === true);
  check('标题显示 pi 版本', Boolean(boot.value && /pi \d/.test(boot.value.title)), boot.value && boot.value.title);
  check('模型信息已填充', Boolean(boot.value && boot.value.model && boot.value.model !== '模型 —'), boot.value && boot.value.model);
  check('无启动错误提示', boot.value && boot.value.errors.length === 0, JSON.stringify(boot.value && boot.value.errors));

  // The submit listener clears the field synchronously inside dispatchEvent,
  // so read the value back before dispatching.
  const submit = await cdp.evaluate(`(() => {
    const input = document.getElementById('input');
    input.value = ${JSON.stringify(PROMPT)};
    const typed = input.value;
    document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return typed;
  })()`);
  check('输入框接受文本', submit.value === PROMPT, String(submit.value));

  const deadline = Date.now() + RUN_TIMEOUT;
  let state = null;
  while (Date.now() < deadline) {
    const read = await cdp.evaluate(readState);
    if (read.value) {
      state = read.value;
      const hasAnswer = state.assistantText && state.assistantText.trim().length > 0;
      if (hasAnswer && state.runState === '空闲') break;
      if (state.errors.length) break;
    }
    await sleep(1500);
  }

  console.log('  结束状态:', JSON.stringify(state));
  check('用户消息已上屏', Boolean(state && state.userText.includes(PROMPT.slice(0, 4))), state && state.userText.slice(0, 80));
  check('助手已有回复', Boolean(state && state.assistantText.trim().length > 0), state && state.assistantText.slice(0, 160));
  check('会话内无错误提示', Boolean(state && state.errors.length === 0), JSON.stringify(state && state.errors));
  check('运行回到空闲', Boolean(state && state.runState === '空闲'), state && state.runState);
  check('已累计 token 用量', Boolean(state && state.tokens !== '0 tok'), state && state.tokens);
}

try {
  await main();
} catch (error) {
  console.error(`  FAIL ${error.message}`);
  failures += 1;
} finally {
  if (socket) socket.close();
  child.kill();
  await sleep(800);
  if (!child.killed) child.kill('SIGKILL');
}

console.log(failures === 0 ? '\n端到端检查通过' : `\n${failures} 项端到端检查失败`);
process.exit(failures === 0 ? 0 : 1);
