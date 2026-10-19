// End-to-end check against the real window.
//
// Boots the packaged app with a remote debugging port, drives the renderer over
// CDP the way a user would (type, submit, wait), and asserts the transcript,
// the mascot mount and the header stats. No test hooks live in the app itself.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    ws.addEventListener('open', () => resolve({ evaluate, captureScreenshot }));
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

    function send(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiters.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const payload = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const result = payload.result && payload.result.result;
      if (payload.error) return { error: payload.error.message };
      if (result && result.exceptionDetails) return { error: result.exceptionDetails.text };
      return { value: result ? result.value : undefined };
    }

    async function captureScreenshot(file) {
      const payload = await send('Page.captureScreenshot', { format: 'png' });
      const data = payload.result && payload.result.data;
      if (!data) return false;
      writeFileSync(file, Buffer.from(data, 'base64'));
      return true;
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
    model: document.getElementById('chip-model-name').innerText,
    tokens: document.getElementById('stat-tokens').innerText,
    cost: document.getElementById('stat-cost').innerText,
    runState: document.getElementById('run-state').innerText,
    title: document.title,
    navItems: Array.from(document.querySelectorAll('#nav .nav-item')).map((b) => b.dataset.page),
    activePage: (document.querySelector('#pages .page.active') || {}).dataset?.page || null,
    pageTitle: document.getElementById('page-title').innerText,
    sideBalance: document.getElementById('side-balance').innerText,
    sideToday: document.getElementById('side-today').innerText,
    modelMenuOpen: !document.getElementById('model-menu').hidden,
    modelOptions: document.querySelectorAll('#model-menu .model-option').length,
    settingsModels: document.getElementById('set-model').options.length,
    modelSelectValue: document.getElementById('set-model').value,
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

  const shotDir = process.env.FAIRY_PI_E2E_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  // --- shell: sidebar navigation, pages and the model menu ---------------
  check('侧边栏有 7 个导航项', boot.value.navItems.length === 7, JSON.stringify(boot.value.navItems));
  check('默认停在对话页', boot.value.activePage === 'chat', boot.value.activePage);

  // The sidebar balance card is filled by running /fairy-balance once at boot.
  let balance = '—';
  const balanceDeadline = Date.now() + 25000;
  while (Date.now() < balanceDeadline) {
    const read = await cdp.evaluate(readState);
    balance = read.value && read.value.sideBalance;
    if (balance && balance !== '—') break;
    await sleep(1200);
  }
  if (balance && balance !== '—') check('侧边栏余额卡已填充', true, balance);
  else console.log('  note 余额卡仍为空（网络或本地服务未就绪），跳过余额断言');

  if (shotDir) {
    const welcome = path.join(shotDir, 'screenshot.png');
    const saved = await cdp.captureScreenshot(welcome);
    check('欢迎态截图已保存', saved, welcome);
  }

  await cdp.evaluate(`document.querySelector('#nav .nav-item[data-page="balance"]').click()`);
  await sleep(1200);
  const balancePage = await cdp.evaluate(readState);
  check('点「余额」切到余额页', balancePage.value.activePage === 'balance', balancePage.value.activePage);
  check('余额页显示余额数值', /CNY|¥|\d/.test(balancePage.value.sideBalance), balancePage.value.sideBalance);
  if (shotDir) {
    const saved = await cdp.captureScreenshot(path.join(shotDir, 'screenshot-balance.png'));
    check('余额页截图已保存', saved);
  }

  await cdp.evaluate(`document.querySelector('#nav .nav-item[data-page="settings"]').click()`);
  await sleep(1200);
  const settings = await cdp.evaluate(readState);
  check('点「设置」切到设置页', settings.value.activePage === 'settings', settings.value.activePage);
  check('页面标题跟着切', settings.value.pageTitle === '设置', settings.value.pageTitle);
  check('设置页列出了模型', settings.value.settingsModels > 1, String(settings.value.settingsModels));
  check('模型下拉选中当前模型', /deepseek/.test(settings.value.modelSelectValue || ''), settings.value.modelSelectValue);
  if (shotDir) {
    const saved = await cdp.captureScreenshot(path.join(shotDir, 'screenshot-settings.png'));
    check('设置页截图已保存', saved);
  }

  const themeLight = await cdp.evaluate(`(() => {
    document.getElementById('btn-theme').click();
    return document.documentElement.dataset.theme;
  })()`);
  check('主题能切到浅色', themeLight.value === 'light', String(themeLight.value));
  await sleep(500);
  if (shotDir) {
    const saved = await cdp.captureScreenshot(path.join(shotDir, 'screenshot-light.png'));
    check('浅色主题截图已保存', saved);
  }
  const themeDark = await cdp.evaluate(`(() => {
    document.getElementById('btn-theme').click();
    return document.documentElement.dataset.theme;
  })()`);
  check('主题能切回深色', themeDark.value === 'dark', String(themeDark.value));
  await sleep(400);

  await cdp.evaluate(`document.getElementById('chip-model').click()`);
  await sleep(600);
  const menu = await cdp.evaluate(readState);
  check('模型菜单能打开', menu.value.modelMenuOpen === true);
  check('模型菜单列出了模型', menu.value.modelOptions > 1, String(menu.value.modelOptions));
  if (shotDir) {
    const saved = await cdp.captureScreenshot(path.join(shotDir, 'screenshot-models.png'));
    check('模型菜单截图已保存', saved);
  }
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(400);
  const closed = await cdp.evaluate(readState);
  check('Esc 关闭模型菜单', closed.value.modelMenuOpen === false);

  await cdp.evaluate(`document.querySelector('#nav .nav-item[data-page="chat"]').click()`);
  await sleep(500);
  const back = await cdp.evaluate(readState);
  check('能切回对话页', back.value.activePage === 'chat', back.value.activePage);

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

  if (shotDir) {
    const conversation = path.join(shotDir, 'screenshot-conversation.png');
    const saved = await cdp.captureScreenshot(conversation);
    check('对话态截图已保存', saved, conversation);
  }
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
