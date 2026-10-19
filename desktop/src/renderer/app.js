'use strict';

/* Fairy-pi desktop renderer.
 *
 * Speaks the pi RPC protocol (docs/rpc.md in the pi package) and renders it.
 * Records arrive as plain JSON objects; this file owns all UI state.
 */

const api = window.fairyPi;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const nodes = {
  stage: $('stage'),
  fairyStage: $('fairy-stage'),
  fairyMount: $('fairy-mount'),
  fairyCaption: $('fairy-caption'),
  emptyState: $('empty-state'),
  emptyHints: $('empty-hints'),
  messages: $('messages'),
  widgets: $('widgets'),
  statusbar: $('statusbar'),
  input: $('input'),
  composer: $('composer'),
  slashMenu: $('slash-menu'),
  runState: $('run-state'),
  queue: $('queue'),
  toasts: $('toasts'),
  modalRoot: $('modal-root'),
  chipModel: $('chip-model'),
  chipCwd: $('chip-cwd'),
  statTokens: $('stat-tokens'),
  statCost: $('stat-cost'),
  statContext: $('stat-context'),
  btnVoice: $('btn-voice'),
  btnAbort: $('btn-abort'),
  btnNew: $('btn-new'),
  btnWorkdir: $('btn-workdir'),
  btnSend: $('btn-send'),
};

const state = {
  running: false,
  ready: false,
  voice: false,
  commands: [],
  sessionName: '',
  lastSpokenText: '',
  slashIndex: 0,
  slashMatches: [],
  statusEntries: new Map(),
  widgets: new Map(),
};

const pending = new Map();

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Compact markdown rendering for transcripts. Input is escaped first, so the
 * only markup that reaches the DOM is what this function emits.
 */
function renderMarkdown(text) {
  const source = escapeHtml(text);
  const fences = [];

  let html = source.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    fences.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  html = html
    .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.*)$/gm, '<li>$1</li>');

  html = html.replace(/(<li>[\s\S]*?<\/li>)(?![\s\S]*?<li>)/, '<ul>$1</ul>');

  html = html
    .split(/\n{2,}/)
    .map((block) => (/^\s*<(h\d|ul|ol|li|blockquote|pre|table)/.test(block) || block.includes('\u0000FENCE') ? block : `<p>${block.replace(/\n/g, '<br />')}</p>`))
    .join('\n');

  return html.replace(/\u0000FENCE(\d+)\u0000/g, (_m, index) => fences[Number(index)]);
}

/** Plain text suitable for a speech synthesiser. */
function toSpeechText(markdown) {
  let text = String(markdown || '');
  text = text.replace(/```[\s\S]*?```/g, ' 代码省略 ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' 代码省略 ');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, '');
  text = text.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{2,}/g, '\n');
  text = text.trim();
  if (text.length > 1500) text = `${text.slice(0, 1500)}…`;
  return text;
}

function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function blockText(block) {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (typeof block.text === 'string') return block.text;
  if (typeof block.thinking === 'string') return block.thinking;
  return '';
}

/** pi messages carry `content` as a string or an array of typed blocks. */
function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map(blockText)
    .join('');
}

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

function command(record) {
  const id = `r-${crypto.randomUUID()}`;
  const payload = { ...record, id };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    if (!api.send(payload)) {
      pending.delete(id);
      resolve({ success: false, error: 'pi 未在运行' });
      return;
    }
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ success: false, error: '命令超时' });
      }
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// Mascot
// ---------------------------------------------------------------------------

function mountMascot() {
  const assets = window.FairyMascotAssets;
  if (!assets) return;
  const root = document.createElement('div');
  root.setAttribute('data-dsh-fairy-mascot-root', 'true');
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('data-state', 'normal');
  root.innerHTML = `<div class="dsh-fairy-float">${assets.HALO_SVG}${assets.PULSE_SVG}${assets.SVG}</div>`;
  nodes.fairyMount.replaceChildren(root);
}

function setMascotState(next) {
  const root = nodes.fairyMount.querySelector('[data-dsh-fairy-mascot-root="true"]');
  if (root) root.setAttribute('data-state', next);
}

function dockMascot(docked) {
  nodes.fairyStage.classList.toggle('hero', !docked);
  nodes.fairyStage.classList.toggle('docked', docked);
}

function setCaption(text) {
  nodes.fairyCaption.textContent = text;
  nodes.fairyStage.classList.toggle('has-caption', Boolean(text) && nodes.fairyStage.classList.contains('hero'));
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

let live = null;

function clearTranscript() {
  nodes.messages.replaceChildren();
  live = null;
  nodes.messages.classList.remove('has-content');
  nodes.emptyState.classList.remove('hidden');
  dockMascot(false);
  setCaption('Fairy 待机中');
}

function markTranscriptHasContent() {
  nodes.messages.classList.add('has-content');
  nodes.emptyState.classList.add('hidden');
  dockMascot(true);
}

function addBubble(role, label) {
  const el = document.createElement('article');
  el.className = `msg msg-${role}`;
  const head = document.createElement('div');
  head.className = 'msg-head';
  const roleEl = document.createElement('span');
  roleEl.className = 'msg-role';
  roleEl.textContent = label;
  const timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  timeEl.textContent = nowLabel();
  head.append(roleEl, timeEl);
  const body = document.createElement('div');
  body.className = 'msg-body';
  el.append(head, body);
  nodes.messages.append(el);
  markTranscriptHasContent();
  return { el, body };
}

function scrollToEnd() {
  nodes.stage.scrollTop = nodes.stage.scrollHeight;
}

function renderStaticMessage(message) {
  const role = message && message.role;
  if (role === 'user') {
    const { body } = addBubble('user', '你');
    body.innerHTML = renderMarkdown(messageText(message));
    return;
  }
  if (role === 'assistant') {
    const { body } = addBubble('assistant', 'Fairy');
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'thinking') {
          const details = document.createElement('details');
          details.className = 'thinking';
          const summary = document.createElement('summary');
          summary.textContent = 'thinking';
          const text = document.createElement('div');
          text.textContent = blockText(block);
          details.append(summary, text);
          body.append(details);
        }
      }
    }
    const holder = document.createElement('div');
    holder.innerHTML = renderMarkdown(messageText(message));
    body.append(holder);
    return;
  }
  if (role === 'system') {
    const { body } = addBubble('system', 'system');
    body.textContent = messageText(message) || JSON.stringify(message).slice(0, 400);
  }
}

function renderTool(toolCallId, toolName, args) {
  const el = document.createElement('div');
  el.className = 'tool';
  el.dataset.tool = toolCallId;
  const head = document.createElement('div');
  head.className = 'tool-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = toolName || 'tool';
  const stateEl = document.createElement('span');
  stateEl.className = 'tool-state';
  stateEl.textContent = '运行中';
  head.append(nameEl, stateEl);
  const body = document.createElement('div');
  body.className = 'tool-body';
  const argsEl = document.createElement('div');
  argsEl.className = 'tool-args';
  argsEl.textContent = args ? JSON.stringify(args) : '';
  body.append(argsEl);
  el.append(head, body);
  nodes.messages.append(el);
  markTranscriptHasContent();
  scrollToEnd();
  return { el, body, stateEl, argsEl };
}

function toolResultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (!block) return '';
        if (block.type === 'text') return block.text || '';
        if (block.type === 'image') return '[image]';
        return '';
      })
      .join('\n');
  }
  if (typeof result.output === 'string') return result.output;
  return JSON.stringify(result).slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Extension UI
// ---------------------------------------------------------------------------

function toast(message, type) {
  const el = document.createElement('div');
  el.className = `toast ${type || ''}`.trim();
  el.textContent = message;
  nodes.toasts.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s ease';
    setTimeout(() => el.remove(), 320);
  }, 5200);
}

function renderStatusEntries() {
  nodes.statusbar.replaceChildren();
  for (const [key, value] of state.statusEntries) {
    if (!value) continue;
    const el = document.createElement('span');
    el.textContent = `${key}: ${value}`;
    nodes.statusbar.append(el);
  }
}

function renderWidgets() {
  nodes.widgets.replaceChildren();
  for (const lines of state.widgets.values()) {
    if (!lines || lines.length === 0) continue;
    const el = document.createElement('div');
    el.textContent = lines.join('\n');
    el.style.whiteSpace = 'pre-wrap';
    nodes.widgets.append(el);
  }
}

function respondToDialog(id, payload) {
  api.send({ type: 'extension_ui_response', id, ...payload });
}

function openDialog({ title, message, field, options, multiline }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';

    const heading = document.createElement('h2');
    heading.textContent = title || 'pi';
    wrap.append(heading);

    if (message) {
      const para = document.createElement('p');
      para.textContent = message;
      wrap.append(para);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const settle = (value) => {
      nodes.modalRoot.hidden = true;
      nodes.modalRoot.replaceChildren();
      resolve(value);
    };

    if (options) {
      const list = document.createElement('div');
      list.className = 'modal-list';
      options.forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = option;
        button.addEventListener('click', () => settle({ value: option }));
        list.append(button);
      });
      wrap.append(list);
    }

    let input = null;
    if (field) {
      input = multiline ? document.createElement('textarea') : document.createElement('input');
      if (multiline) input.className = 'modal-field multiline';
      else input.className = 'modal-field';
      if (!multiline) input.type = 'text';
      input.value = field.value || '';
      if (field.placeholder) input.placeholder = field.placeholder;
      wrap.append(input);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => settle({ cancelled: true }));

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary';
    confirm.textContent = '确定';
    confirm.addEventListener('click', () => {
      if (input) settle({ value: input.value });
      else settle({ confirmed: true });
    });

    actions.append(cancel, confirm);
    wrap.append(actions);
    nodes.modalRoot.replaceChildren(wrap);
    nodes.modalRoot.hidden = false;
    if (input) input.focus();
    else confirm.focus();

    wrap.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') settle({ cancelled: true });
      if (event.key === 'Enter' && !multiline) settle(input ? { value: input.value } : { confirmed: true });
    });
  });
}

async function handleExtensionUiRequest(record) {
  switch (record.method) {
    case 'notify':
      toast(record.message || '', record.notifyType === 'warning' || record.notifyType === 'error' ? record.notifyType : 'info');
      break;
    case 'setStatus':
      if (record.statusText === undefined || record.statusText === null) state.statusEntries.delete(record.statusKey);
      else state.statusEntries.set(record.statusKey, record.statusText);
      renderStatusEntries();
      break;
    case 'setWidget':
      if (!record.widgetLines || record.widgetLines.length === 0) state.widgets.delete(record.widgetKey);
      else state.widgets.set(record.widgetKey, record.widgetLines);
      renderWidgets();
      break;
    case 'setTitle':
      if (record.title) document.title = record.title;
      break;
    case 'set_editor_text':
      nodes.input.value = record.text || '';
      autosize();
      break;
    case 'select': {
      const result = await openDialog({ title: record.title, options: record.options || [] });
      respondToDialog(record.id, result);
      break;
    }
    case 'confirm': {
      const result = await openDialog({ title: record.title, message: record.message });
      respondToDialog(record.id, result);
      break;
    }
    case 'input': {
      const result = await openDialog({ title: record.title, field: { placeholder: record.placeholder } });
      respondToDialog(record.id, result);
      break;
    }
    case 'editor': {
      const result = await openDialog({ title: record.title, field: { value: record.prefill || '' }, multiline: true });
      respondToDialog(record.id, result);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

function setRunning(next) {
  state.running = next;
  nodes.runState.textContent = next ? '运行中' : state.ready ? '空闲' : '未连接';
  nodes.runState.className = `run-state ${next ? 'busy' : state.ready ? 'ready' : ''}`.trim();
  nodes.btnAbort.disabled = !next;
  nodes.btnSend.textContent = next ? '插入' : '发送';
  if (!next) {
    setMascotState('normal');
    setCaption('Fairy 待机中');
  }
}

function handleSessionEvent(record) {
  switch (record.type) {
    case 'agent_start':
      setRunning(true);
      setMascotState('thinking');
      setCaption('Fairy 正在思考…');
      break;
    case 'agent_settled':
      setRunning(false);
      refreshStats();
      speakLatest();
      break;
    case 'message_start':
      if (record.message && record.message.role === 'assistant') {
        const { el, body } = addBubble('assistant', 'Fairy');
        live = { el, body, mode: null };
      }
      break;
    case 'message_update': {
      const event = record.assistantMessageEvent || {};
      if (!live) {
        const created = addBubble('assistant', 'Fairy');
        live = { el: created.el, body: created.body, mode: null };
      }
      if (event.type === 'thinking_start' || event.type === 'thinking_delta' || event.type === 'thinking_end') {
        if (live.mode !== 'thinking') {
          const details = document.createElement('details');
          details.className = 'thinking';
          const summary = document.createElement('summary');
          summary.textContent = 'thinking';
          const text = document.createElement('div');
          details.append(summary, text);
          live.body.append(details);
          live.thinking = text;
          live.mode = 'thinking';
          details.open = true;
        }
        if (event.type === 'thinking_delta') live.thinking.textContent += event.delta || '';
        if (event.type === 'thinking_end') live.thinking.textContent = event.content || live.thinking.textContent;
      } else if (event.type === 'text_start' || event.type === 'text_delta' || event.type === 'text_end') {
        if (live.mode !== 'text') {
          live.textEl = document.createElement('div');
          live.body.append(live.textEl);
          live.textRaw = '';
          live.mode = 'text';
        }
        if (event.type === 'text_delta') live.textRaw += event.delta || '';
        if (event.type === 'text_end') live.textRaw = event.content || live.textRaw;
        live.textEl.innerHTML = renderMarkdown(live.textRaw) + '<span class="cursor"></span>';
      }
      scrollToEnd();
      break;
    }
    case 'message_end': {
      const message = record.message;
      if (message && message.role === 'assistant') {
        if (!live) {
          const created = addBubble('assistant', 'Fairy');
          live = { el: created.el, body: created.body };
        }
        live.body.replaceChildren();
        const holder = document.createElement('div');
        holder.innerHTML = renderMarkdown(messageText(message));
        live.body.append(holder);
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block && block.type === 'thinking') {
              const details = document.createElement('details');
              details.className = 'thinking';
              const summary = document.createElement('summary');
              summary.textContent = 'thinking';
              const text = document.createElement('div');
              text.textContent = blockText(block);
              details.append(summary, text);
              live.body.prepend(details);
            }
          }
        }
        live = null;
        scrollToEnd();
      } else if (message && message.role === 'user') {
        renderStaticMessage(message);
        scrollToEnd();
      }
      break;
    }
    case 'tool_execution_start': {
      const card = renderTool(record.toolCallId, record.toolName, record.args);
      toolCards.set(record.toolCallId, card);
      if (live) live = null;
      break;
    }
    case 'tool_execution_update': {
      const card = toolCards.get(record.toolCallId);
      if (card) {
        card.body.textContent = toolResultText(record.partialResult).slice(0, 20000);
        scrollToEnd();
      }
      break;
    }
    case 'tool_execution_end': {
      const card = toolCards.get(record.toolCallId);
      if (card) {
        card.argsEl.remove();
        card.stateEl.textContent = record.isError ? '失败' : '完成';
        if (record.isError) card.el.classList.add('is-error');
        card.body.textContent = toolResultText(record.result).slice(0, 20000);
        toolCards.delete(record.toolCallId);
        scrollToEnd();
      }
      break;
    }
    case 'queue_update':
      nodes.queue.textContent =
        (record.steering && record.steering.length ? `steering ${record.steering.length}` : '') +
        (record.followUp && record.followUp.length ? ` followUp ${record.followUp.length}` : '');
      break;
    case 'session_info_changed':
      state.sessionName = record.name || '';
      updateModelChip();
      break;
    case 'compaction_start':
      toast(`上下文压缩中（${record.reason}）`, 'info');
      break;
    case 'compaction_end':
      if (record.errorMessage) toast(`压缩失败：${record.errorMessage}`, 'error');
      else toast('上下文已压缩', 'info');
      refreshStats();
      break;
    case 'auto_retry_start':
      toast(`重试第 ${record.attempt} 次：${record.errorMessage || ''}`, 'warning');
      break;
    case 'auto_retry_end':
      if (record.success === false) toast(`重试失败：${record.finalError || ''}`, 'error');
      break;
    case 'extension_error':
      toast(`扩展错误（${record.event}）：${record.error}`, 'error');
      break;
    default:
      break;
  }
}

const toolCards = new Map();

// ---------------------------------------------------------------------------
// Header, stats, voice
// ---------------------------------------------------------------------------

let currentModel = null;

function updateModelChip() {
  const label = currentModel ? currentModel.name || currentModel.id : '—';
  nodes.chipModel.textContent = state.sessionName ? `${label} · ${state.sessionName}` : label;
}

async function refreshState() {
  const result = await command({ type: 'get_state' });
  if (result.success && result.data) {
    currentModel = result.data.model || null;
    state.sessionName = result.data.sessionName || '';
    updateModelChip();
    setRunning(Boolean(result.data.isStreaming));
  }
}

async function refreshStats() {
  const result = await command({ type: 'get_session_stats' });
  if (!result.success || !result.data) return;
  const data = result.data;
  const tokens = data.tokens || {};
  nodes.statTokens.textContent = `${(tokens.total || 0).toLocaleString('en-US')} tok`;
  nodes.statCost.textContent = `$${(data.cost || 0).toFixed(4)}`;
  const context = data.contextUsage;
  nodes.statContext.textContent = context && context.percent != null ? `${Math.round(context.percent)}%` : '—';
}

async function loadCommands() {
  const result = await command({ type: 'get_commands' });
  if (!result.success || !result.data) return;
  state.commands = result.data.commands || [];
  renderEmptyHints();
}

function renderEmptyHints() {
  const interesting = state.commands.filter((c) => !c.name.startsWith('skill:')).slice(0, 6);
  nodes.emptyHints.replaceChildren();
  for (const entry of interesting) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'hint';
    chip.textContent = `/${entry.name}`;
    chip.title = entry.description || '';
    chip.addEventListener('click', () => {
      nodes.input.value = `/${entry.name}`;
      nodes.input.focus();
      updateSlashMenu();
    });
    nodes.emptyHints.append(chip);
  }
}

function pickVoice() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  if (!voices.length) return null;
  return (
    voices.find((v) => /^zh[-_]CN/i.test(v.lang) && /Xiaoxiao|Yunxi|Microsoft/i.test(v.name)) ||
    voices.find((v) => /^zh/i.test(v.lang)) ||
    voices[0]
  );
}

function speak(text) {
  const clean = toSpeechText(text);
  if (!clean || !window.speechSynthesis) return;
  if (clean === state.lastSpokenText) return;
  state.lastSpokenText = clean;
  const utterance = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.lang = voice ? voice.lang : 'zh-CN';
  utterance.rate = 1.02;
  utterance.pitch = 1.06;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

async function speakLatest() {
  if (!state.voice) return;
  const result = await command({ type: 'get_last_assistant_text' });
  if (result.success && result.data && result.data.text) speak(result.data.text);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autosize() {
  nodes.input.style.height = 'auto';
  nodes.input.style.height = `${Math.min(nodes.input.scrollHeight, 190)}px`;
}

function updateSlashMenu() {
  const value = nodes.input.value;
  if (!value.startsWith('/') || value.includes(' ')) {
    nodes.slashMenu.hidden = true;
    state.slashMatches = [];
    return;
  }
  const query = value.slice(1).toLowerCase();
  state.slashMatches = state.commands.filter((entry) => entry.name.toLowerCase().startsWith(query)).slice(0, 12);
  if (state.slashMatches.length === 0) {
    nodes.slashMenu.hidden = true;
    return;
  }
  state.slashIndex = Math.min(state.slashIndex, state.slashMatches.length - 1);
  nodes.slashMenu.replaceChildren();
  state.slashMatches.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = `slash-item${index === state.slashIndex ? ' active' : ''}`;
    const name = document.createElement('span');
    name.className = 'slash-name';
    name.textContent = `/${entry.name}`;
    const desc = document.createElement('span');
    desc.className = 'slash-desc';
    desc.textContent = entry.description || '';
    const source = document.createElement('span');
    source.className = 'slash-source';
    source.textContent = entry.source || '';
    item.append(name, desc, source);
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applySlash(entry);
    });
    nodes.slashMenu.append(item);
  });
  nodes.slashMenu.hidden = false;
}

function applySlash(entry) {
  nodes.input.value = `/${entry.name} `;
  nodes.slashMenu.hidden = true;
  autosize();
  nodes.input.focus();
}

async function submit() {
  const text = nodes.input.value.trim();
  if (!text) return;
  nodes.input.value = '';
  autosize();
  nodes.slashMenu.hidden = true;

  const record = { type: 'prompt', message: text };
  if (state.running) record.streamingBehavior = 'steer';
  const result = await command(record);
  if (!result.success) {
    toast(result.error || '发送失败', 'error');
    nodes.input.value = text;
    autosize();
    return;
  }
  if (result.data && result.data.disposition === 'handled') {
    // An extension command consumed this input; no run will start.
    refreshState();
  }
  nodes.input.focus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function handleRecord(record) {
  if (!record || typeof record !== 'object') return;

  if (record.type === 'response') {
    if (record.id && pending.has(record.id)) {
      const resolve = pending.get(record.id);
      pending.delete(record.id);
      resolve(record);
    }
    return;
  }
  if (record.type === 'extension_ui_request') {
    handleExtensionUiRequest(record);
    return;
  }
  handleSessionEvent(record);
}

function handleStatus(status) {
  if (!status) return;
  if (status.state === 'error') {
    state.ready = false;
    setRunning(false);
    nodes.runState.textContent = '连接失败';
    nodes.runState.className = 'run-state error';
    nodes.input.disabled = true;
    nodes.btnSend.disabled = true;
    toast(status.message || 'pi 启动失败', 'error');
    return;
  }
  if (status.state === 'ready' || status.state === 'starting') {
    state.ready = true;
    nodes.input.disabled = false;
    nodes.btnSend.disabled = false;
    setRunning(state.running);
  }
  if (status.state === 'stopped') {
    state.ready = false;
    setRunning(false);
    nodes.runState.textContent = '已停止';
  }
}

async function boot() {
  mountMascot();

  nodes.btnVoice.addEventListener('click', () => {
    state.voice = !state.voice;
    nodes.btnVoice.setAttribute('aria-pressed', String(state.voice));
    if (!state.voice && window.speechSynthesis) window.speechSynthesis.cancel();
    toast(state.voice ? '语音朗读已开启' : '语音朗读已关闭', 'info');
    if (state.voice) speakLatest();
  });

  nodes.btnAbort.addEventListener('click', () => command({ type: 'abort' }));

  nodes.btnNew.addEventListener('click', async () => {
    const result = await command({ type: 'new_session' });
    if (result.success && !(result.data && result.data.cancelled)) {
      clearTranscript();
      state.lastSpokenText = '';
      refreshState();
      refreshStats();
    }
  });

  nodes.btnWorkdir.addEventListener('click', async () => {
    const picked = await api.pickWorkdir();
    if (!picked) return;
    await api.restart({ cwd: picked });
    await afterStart();
  });

  nodes.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  nodes.input.addEventListener('input', () => {
    autosize();
    updateSlashMenu();
  });

  nodes.input.addEventListener('keydown', (event) => {
    if (!nodes.slashMenu.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.slashIndex = (state.slashIndex + delta + state.slashMatches.length) % state.slashMatches.length;
      updateSlashMenu();
      return;
    }
    if (!nodes.slashMenu.hidden && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && state.slashMatches.length))) {
      const entry = state.slashMatches[state.slashIndex];
      if (entry && nodes.input.value.trim() === `/${entry.name}`) {
        event.preventDefault();
        applySlash(entry);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.running) command({ type: 'abort' });
  });

  api.onRecord(handleRecord);
  api.onStatus(handleStatus);
  api.onStderr((text) => {
    for (const line of String(text).split('\n')) {
      if (/level":"error"/.test(line) || /"level":"warn"/.test(line)) {
        const match = line.match(/\{[^]*\}$/);
        if (match) toast(match[0].slice(0, 300), 'warning');
      }
    }
  });

  const info = await api.bootstrap();
  console.info(
    `[fairy-pi] desktop ${info && info.appVersion}; electron ${info && info.electron}; pi ${
      (info && info.piVersion) || '未找到'
    }${info && info.piPath ? ` @ ${info.piPath}` : ''}`,
  );
  if (info) {
    nodes.chipCwd.textContent = info.cwd || '—';
    nodes.chipCwd.title = `pi 的工作目录：${info.cwd}\npi：${info.piPath || '未找到'}`;
    if (info.piError) {
      nodes.runState.textContent = '未找到 pi';
      nodes.runState.className = 'run-state error';
      toast(info.piError, 'error');
    }
    document.title = `Fairy-pi${info.piVersion ? ` · pi ${info.piVersion}` : ''}`;
  }

  setRunning(false);
  setCaption('Fairy 待机中');
  api.start();
  await afterStart();
}

async function afterStart() {
  await refreshState();
  await refreshStats();
  await loadCommands();
  handleStatus({ state: 'ready' });
}

if (window.speechSynthesis) {
  // Chromium populates the voice list asynchronously.
  window.speechSynthesis.addEventListener('voiceschanged', () => {});
}

function reportFailure(message, detail) {
  console.error(`[fairy-pi] ${message}`, detail === undefined ? '' : detail);
  toast(`${message}${detail ? `：${detail}` : ''}`, 'error');
}

window.addEventListener('error', (event) => {
  reportFailure('界面出错', event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
  reportFailure('未处理的错误', reason);
});

boot().catch((error) => {
  reportFailure('界面初始化失败', error && error.message ? error.message : String(error));
});
