'use strict';

/* Fairy-pi desktop renderer.
 *
 * Speaks the pi RPC protocol (docs/rpc.md in the pi package) and renders it.
 * Records arrive as plain JSON objects; this file owns all UI state.
 *
 * Layout mirrors the Fairy-DSH client: a left sidebar with navigation and a
 * balance card in its footer, and one page per feature. Extension commands are
 * executed through the same `prompt` channel a user would use, and their
 * `notify` output is captured into the panel that asked for it.
 */

const api = window.fairyPi;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const nodes = {
  // shell
  sidebar: $('sidebar'),
  nav: $('nav'),
  workspace: $('workspace'),
  pages: $('pages'),
  pageTitle: $('page-title'),
  pageSub: $('page-sub'),
  modelMenu: $('model-menu'),
  brand: $('brand'),

  // topbar
  chipModel: $('chip-model'),
  chipModelName: $('chip-model-name'),
  chipCwd: $('chip-cwd'),
  statTokens: $('stat-tokens'),
  statCost: $('stat-cost'),
  statContext: $('stat-context'),
  btnVoice: $('btn-voice'),
  btnAbort: $('btn-abort'),
  btnNew: $('btn-new'),
  btnWorkdir: $('btn-workdir'),
  btnSend: $('btn-send'),
  btnSendLabel: $('btn-send-label'),

  // sidebar footer
  btnNewSession: $('btn-new-session'),
  btnTheme: $('btn-theme'),
  btnGotoSettings: $('btn-goto-settings'),
  balanceCard: $('balance-card'),
  runState: $('run-state'),
  sideBalance: $('side-balance'),
  sideToday: $('side-today'),
  sideCost: $('side-cost'),

  // chat
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
  queue: $('queue'),

  // balance page
  btnBalanceRefresh: $('btn-balance-refresh'),
  balBalance: $('bal-balance'),
  balToday: $('bal-today'),
  balCost: $('bal-cost'),
  balLedger: $('bal-ledger'),
  balanceSource: $('balance-source'),
  sessTokens: $('sess-tokens'),
  sessCost: $('sess-cost'),
  sessContext: $('sess-context'),
  sessMessages: $('sess-messages'),

  // voice page
  voiceEnabled: $('voice-enabled'),
  voiceName: $('voice-name'),
  voiceRate: $('voice-rate'),
  voiceRateValue: $('voice-rate-value'),
  btnVoiceTest: $('btn-voice-test'),
  btnVoiceStatus: $('btn-voice-status'),
  voiceService: $('voice-service'),

  // persona page
  btnPersonaRefresh: $('btn-persona-refresh'),
  personaEnabled: $('persona-enabled'),
  personaStatus: $('persona-status'),
  personaCorpus: $('persona-corpus'),

  // skills page
  btnSkillsRefresh: $('btn-skills-refresh'),
  skillsList: $('skills-list'),
  extList: $('ext-list'),

  // browser page
  btnBrowserRefresh: $('btn-browser-refresh'),
  browserStatus: $('browser-status'),
  browserUrl: $('browser-url'),
  browserState: $('browser-state'),

  // settings page
  setModel: $('set-model'),
  btnSetModel: $('btn-set-model'),
  setThinking: $('set-thinking'),
  btnSetThinking: $('btn-set-thinking'),
  setCwd: $('set-cwd'),
  btnSetWorkdir: $('btn-set-workdir'),
  setTheme: $('set-theme'),
  setMascot: $('set-mascot'),
  setMascotScale: $('set-mascot-scale'),
  setMascotScaleValue: $('set-mascot-scale-value'),
  setMascotSpeed: $('set-mascot-speed'),
  infoSession: $('info-session'),
  infoMessages: $('info-messages'),
  infoPi: $('info-pi'),
  infoElectron: $('info-electron'),
  infoPaths: $('info-paths'),

  // overlays
  toasts: $('toasts'),
  modalRoot: $('modal-root'),
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

// ---------------------------------------------------------------------------
// Persistent desktop preferences
// ---------------------------------------------------------------------------

const PREFS_KEY = 'fairy-pi.desktop.prefs';

const DEFAULT_PREFS = {
  theme: 'dark',
  voice: false,
  voiceName: '',
  voiceRate: 1.02,
  mascotVisible: true,
  mascotScale: 1,
  mascotSpeed: 1,
};

function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (stored && typeof stored === 'object') return { ...DEFAULT_PREFS, ...stored };
  } catch {
    /* first run, or storage disabled */
  }
  return { ...DEFAULT_PREFS };
}

let prefs = loadPrefs();

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage may be unavailable; the session still works */
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  running: false,
  ready: false,
  page: 'chat',
  commands: [],
  models: [],
  thinkingLevels: [],
  currentModel: null,
  sessionName: '',
  sessionId: '',
  messageCount: 0,
  info: null,
  lastSpokenText: '',
  slashIndex: 0,
  slashMatches: [],
  statusEntries: new Map(),
  widgets: new Map(),
  balance: null,
  browser: null,
};

const pending = new Map();

// While a panel runs an extension command, its `notify` output is captured
// here instead of being raised as a toast.
let capture = null;

const NAV = [
  { id: 'chat', label: '对话', icon: 'i-chat', sub: '与 pi 的会话' },
  { id: 'balance', label: '余额', icon: 'i-wallet', sub: 'DeepSeek 余额与当日用量' },
  { id: 'voice', label: '语音', icon: 'i-voice', sub: '朗读与本地语音服务' },
  { id: 'persona', label: '人格', icon: 'i-persona', sub: 'Fairy 语域注入' },
  { id: 'skills', label: '技能', icon: 'i-skills', sub: '技能与扩展命令' },
  { id: 'browser', label: '浏览器坞', icon: 'i-browser', sub: 'MCP 浏览器观察与接管' },
  { id: 'settings', label: '设置', icon: 'i-settings', sub: '模型、目录、外观' },
];

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

/**
 * Run an extension command the way a user would (`/name args`) and collect the
 * `notify` messages it emits. Used by the panels so余额/语音/人格/坞 do not
 * require typing a command. Resolves after a short grace period past the
 * command response, because pi does not guarantee notify ordering.
 */
function captureCommand(text, timeout = 20000) {
  const id = `c-${crypto.randomUUID()}`;
  return new Promise((resolve) => {
    const messages = [];
    let settled = false;
    let grace = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (capture && capture.id === id) capture = null;
      resolve(messages);
    };

    const timer = setTimeout(finish, timeout);
    capture = { id, messages };
    pending.set(id, () => {
      grace = setTimeout(finish, 600);
    });

    if (!api.send({ id, type: 'prompt', message: text })) {
      pending.delete(id);
      finish();
    }
  });
}

async function runPanelCommand(text, timeout) {
  const messages = await captureCommand(text, timeout);
  return messages.map((entry) => String(entry.message || '')).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function buildNav() {
  nodes.nav.replaceChildren();
  for (const item of NAV) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.page = item.id;
    button.append(icon(item.icon));
    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(label);
    const badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.dataset.badge = item.id;
    button.append(badge);
    button.addEventListener('click', () => showPage(item.id));
    nodes.nav.append(button);
  }
}

const PAGE_ENTER = {
  balance: () => refreshBalance(),
  voice: () => refreshVoiceService(),
  persona: () => refreshPersona(),
  skills: () => renderSkills(),
  browser: () => refreshBrowser(),
  settings: () => refreshSettings(),
};

function showPage(id) {
  const next = NAV.find((entry) => entry.id === id) ? id : 'chat';
  state.page = next;
  for (const section of nodes.pages.querySelectorAll('.page')) {
    const active = section.dataset.page === next;
    section.classList.toggle('active', active);
    section.hidden = !active;
  }
  for (const button of nodes.nav.querySelectorAll('.nav-item')) {
    if (button.dataset.page === next) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const meta = NAV.find((entry) => entry.id === next);
  nodes.pageTitle.textContent = meta ? meta.label : '对话';
  nodes.pageSub.textContent = meta ? meta.sub : '';
  if (next === 'chat') layoutHero();
  const enter = PAGE_ENTER[next];
  if (enter) Promise.resolve(enter()).catch((error) => reportFailure('页面加载失败', error && error.message));
}

function navBadge(id, text) {
  const badge = nodes.nav.querySelector(`.nav-badge[data-badge="${id}"]`);
  if (badge) badge.textContent = text || '';
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

function mascotRoot() {
  return nodes.fairyMount.querySelector('[data-dsh-fairy-mascot-root="true"]');
}

function setMascotState(next) {
  const root = mascotRoot();
  if (root) root.setAttribute('data-state', next);
}

/** Place the fixed mascot over the reserved slot so the welcome copy stays clear. */
function layoutHero() {
  if (nodes.fairyStage.classList.contains('docked')) return;
  const slot = nodes.emptyState.querySelector('.mascot-slot');
  if (!slot) return;
  const rect = slot.getBoundingClientRect();
  if (rect.width === 0) return;
  nodes.fairyStage.style.left = `${rect.left}px`;
  nodes.fairyStage.style.top = `${rect.top}px`;
  nodes.fairyStage.style.width = `${rect.width}px`;
  nodes.fairyStage.style.height = `${rect.height}px`;
}

function dockMascot(docked) {
  nodes.fairyStage.classList.toggle('hero', !docked);
  nodes.fairyStage.classList.toggle('docked', docked);
  if (docked) nodes.fairyStage.style.cssText = '';
  else layoutHero();
}

function setCaption(text) {
  nodes.fairyCaption.textContent = text;
  nodes.fairyStage.classList.toggle('has-caption', Boolean(text) && !nodes.fairyStage.classList.contains('docked'));
}

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.style.setProperty('--mascot-scale', String(prefs.mascotScale));
  const root = mascotRoot();
  if (root) root.style.setProperty('--dsh-fairy-steady-rate', String(prefs.mascotSpeed));
  nodes.fairyStage.hidden = !prefs.mascotVisible;

  const themeUse = nodes.btnTheme.querySelector('use');
  if (themeUse) themeUse.setAttribute('href', prefs.theme === 'dark' ? '#i-sun' : '#i-moon');
  nodes.btnTheme.title = prefs.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';

  if (nodes.setTheme) nodes.setTheme.value = prefs.theme;
  if (nodes.setMascot) nodes.setMascot.checked = prefs.mascotVisible;
  if (nodes.setMascotScale) {
    nodes.setMascotScale.value = String(prefs.mascotScale);
    nodes.setMascotScaleValue.textContent = Number(prefs.mascotScale).toFixed(2);
  }
  if (nodes.setMascotSpeed) nodes.setMascotSpeed.value = String(prefs.mascotSpeed);
  if (nodes.voiceEnabled) nodes.voiceEnabled.checked = prefs.voice;
  if (nodes.voiceRate) {
    nodes.voiceRate.value = String(prefs.voiceRate);
    nodes.voiceRateValue.textContent = Number(prefs.voiceRate).toFixed(2);
  }
  nodes.btnVoice.setAttribute('aria-pressed', String(prefs.voice));

  if (prefs.mascotVisible) layoutHero();
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
        if (block && block.type === 'thinking') body.append(thinkingBlock(blockText(block)));
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

function thinkingBlock(text) {
  const details = document.createElement('details');
  details.className = 'thinking';
  const summary = document.createElement('summary');
  summary.textContent = 'thinking';
  const body = document.createElement('div');
  body.textContent = text;
  details.append(summary, body);
  return details;
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
      if (capture) {
        capture.messages.push({ type: record.notifyType || 'info', message: record.message || '' });
        break;
      }
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

const toolCards = new Map();

function setRunning(next) {
  state.running = next;
  nodes.runState.textContent = next ? '运行中' : state.ready ? '空闲' : '未连接';
  nodes.runState.className = `run-state ${next ? 'busy' : state.ready ? 'ready' : ''}`.trim();
  nodes.btnAbort.disabled = !next;
  nodes.btnSendLabel.textContent = next ? '插入' : '发送';
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
          const details = thinkingBlock('');
          live.body.append(details);
          live.thinking = details.querySelector('div');
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
            if (block && block.type === 'thinking') live.body.prepend(thinkingBlock(blockText(block)));
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

// ---------------------------------------------------------------------------
// Header, stats, models
// ---------------------------------------------------------------------------

function updateModelChip() {
  const model = state.currentModel;
  const label = model ? model.name || model.id : '—';
  const suffix = model && model.provider ? ` · ${model.provider}` : '';
  nodes.chipModelName.textContent = state.sessionName ? `${label}${suffix} · ${state.sessionName}` : `${label}${suffix}`;
  nodes.chipModel.title = model
    ? `当前模型：${label}（${model.provider}/${model.id}）\n上下文 ${model.contextWindow || '—'} · ${model.reasoning ? '支持推理' : '不支持推理'}`
    : '当前模型';
  navBadge('chat', '');
}

async function refreshState() {
  const result = await command({ type: 'get_state' });
  if (result.success && result.data) {
    state.currentModel = result.data.model || null;
    state.sessionName = result.data.sessionName || '';
    state.sessionId = result.data.sessionId || '';
    state.messageCount = result.data.messageCount || 0;
    updateModelChip();
    setRunning(Boolean(result.data.isStreaming));
  }
}

async function refreshStats() {
  const result = await command({ type: 'get_session_stats' });
  if (!result.success || !result.data) return;
  const data = result.data;
  const tokens = data.tokens || {};
  const total = Number(tokens.total || 0);
  const cost = Number(data.cost || 0);
  const percent = data.contextUsage && data.contextUsage.percent != null ? Math.round(data.contextUsage.percent) : null;

  nodes.statTokens.textContent = `${total.toLocaleString('en-US')} tok`;
  nodes.statCost.textContent = `$${cost.toFixed(4)}`;
  nodes.statContext.textContent = percent == null ? '—' : `${percent}%`;

  nodes.sessTokens.textContent = total.toLocaleString('en-US');
  nodes.sessCost.textContent = `$${cost.toFixed(4)}`;
  nodes.sessContext.textContent = percent == null ? '—' : `${percent}%`;
  nodes.sessMessages.textContent = String(state.messageCount || 0);
  nodes.infoMessages.textContent = String(state.messageCount || 0);
}

async function loadCommands() {
  const result = await command({ type: 'get_commands' });
  if (!result.success || !result.data) return;
  // Names are used verbatim: when two extensions register the same command pi
  // disambiguates them as `name:1` / `name:2`, and only those exact names are
  // dispatchable — a stripped `name` is not a command and would be sent to the
  // model as ordinary prose.
  const seen = new Map();
  for (const entry of result.data.commands || []) {
    if (!entry || !entry.name || seen.has(entry.name)) continue;
    seen.set(entry.name, entry);
  }
  state.commands = [...seen.values()];
  renderEmptyHints();
  renderSkills();
}

function renderEmptyHints() {
  const rank = (entry) => {
    if (entry.source === 'skill') return 2;
    if (entry.name.startsWith('fairy')) return 0;
    return 1;
  };
  const interesting = state.commands
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 6);
  nodes.emptyHints.replaceChildren();
  for (const entry of interesting) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'hint';
    chip.textContent = `/${entry.name}`;
    chip.title = entry.description || '';
    chip.addEventListener('click', () => {
      nodes.input.value = `/${entry.name}`;
      showPage('chat');
      nodes.input.focus();
      updateSlashMenu();
    });
    nodes.emptyHints.append(chip);
  }
}

async function loadModels() {
  const result = await command({ type: 'get_available_models' });
  if (result.success && result.data) state.models = result.data.models || [];
  const levels = await command({ type: 'get_available_thinking_levels' });
  if (levels.success && levels.data) state.thinkingLevels = levels.data.levels || [];
  fillModelSelect();
  fillThinkingSelect();
}

function fillModelSelect() {
  if (!nodes.setModel) return;
  nodes.setModel.replaceChildren();
  const groups = new Map();
  for (const model of state.models) {
    const key = model.provider || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  for (const [provider, list] of groups) {
    const group = document.createElement('optgroup');
    group.label = provider;
    for (const model of list) {
      const option = document.createElement('option');
      option.value = `${model.provider}/${model.id}`;
      option.textContent = `${model.name || model.id}${model.reasoning ? ' · 推理' : ''}`;
      group.append(option);
    }
    nodes.setModel.append(group);
  }
  if (state.currentModel) nodes.setModel.value = `${state.currentModel.provider}/${state.currentModel.id}`;
}

function fillThinkingSelect() {
  if (!nodes.setThinking) return;
  nodes.setThinking.replaceChildren();
  for (const level of state.thinkingLevels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level;
    nodes.setThinking.append(option);
  }
}

async function setModel(provider, modelId) {
  const result = await command({ type: 'set_model', provider, modelId });
  if (!result.success) {
    toast(`切换模型失败：${result.error || '未知原因'}`, 'error');
    return;
  }
  state.currentModel = result.data || state.currentModel;
  updateModelChip();
  fillModelSelect();
  toast(`已切换到 ${state.currentModel.name || modelId}`, 'info');
}

async function applyThinkingLevel(level) {
  const result = await command({ type: 'set_thinking_level', level });
  if (!result.success) toast(`设置思考档位失败：${result.error || ''}`, 'error');
  else toast(`思考档位：${level}`, 'info');
}

// -- model menu --------------------------------------------------------------

function closeModelMenu() {
  nodes.modelMenu.hidden = true;
  nodes.chipModel.setAttribute('aria-expanded', 'false');
}

function openModelMenu() {
  if (!state.models.length) {
    toast('模型列表尚未就绪', 'warning');
    return;
  }
  nodes.modelMenu.replaceChildren();
  const groups = new Map();
  for (const model of state.models) {
    const key = model.provider || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  for (const [provider, list] of groups) {
    const group = document.createElement('div');
    group.className = 'model-group';
    const title = document.createElement('div');
    title.className = 'model-group-title';
    title.textContent = provider;
    group.append(title);
    for (const model of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-option';
      button.setAttribute('role', 'menuitem');
      const active = state.currentModel && state.currentModel.id === model.id && state.currentModel.provider === model.provider;
      button.dataset.active = String(Boolean(active));
      const name = document.createElement('span');
      name.className = 'model-option-name';
      name.textContent = model.name || model.id;
      const desc = document.createElement('span');
      desc.className = 'model-option-desc';
      if (model.reasoning) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = '推理';
        desc.append(tag);
      }
      const ctx = document.createElement('span');
      ctx.className = 'model-tag';
      ctx.textContent = `${Math.round((model.contextWindow || 0) / 1000)}k`;
      desc.append(ctx);
      button.append(name, desc);
      button.addEventListener('click', () => {
        closeModelMenu();
        setModel(model.provider, model.id);
      });
      group.append(button);
    }
    nodes.modelMenu.append(group);
  }

  const chipRect = nodes.chipModel.getBoundingClientRect();
  const wsRect = nodes.workspace.getBoundingClientRect();
  const width = nodes.modelMenu.offsetWidth || 340;
  const left = Math.max(8, Math.min(chipRect.left - wsRect.left, wsRect.width - width - 12));
  nodes.modelMenu.style.left = `${left}px`;
  nodes.modelMenu.style.top = `${chipRect.bottom - wsRect.top + 6}px`;
  nodes.modelMenu.hidden = false;
  nodes.chipModel.setAttribute('aria-expanded', 'true');
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

function voiceList() {
  return window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
}

function fillVoiceSelect() {
  if (!nodes.voiceName) return;
  const voices = voiceList();
  nodes.voiceName.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自动（优先中文）';
  nodes.voiceName.append(auto);
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} — ${voice.lang}`;
    nodes.voiceName.append(option);
  }
  const has = voices.some((voice) => voice.name === prefs.voiceName);
  nodes.voiceName.value = has ? prefs.voiceName : '';
}

function pickVoice() {
  const voices = voiceList();
  if (!voices.length) return null;
  if (prefs.voiceName) {
    const exact = voices.find((voice) => voice.name === prefs.voiceName);
    if (exact) return exact;
  }
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
  utterance.rate = Number(prefs.voiceRate) || 1.02;
  utterance.pitch = 1.06;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

async function speakLatest() {
  if (!prefs.voice) return;
  const result = await command({ type: 'get_last_assistant_text' });
  if (result.success && result.data && result.data.text) speak(result.data.text);
}

async function refreshVoiceService() {
  const text = await runPanelCommand('/fairy-voice status', 12000);
  nodes.voiceService.textContent = text || '本地语音服务未返回信息。';
  const ok = /正常|可用|available/i.test(text) && !/不可用|未启动/.test(text);
  navBadge('voice', ok ? '在线' : '离线');
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

function parseBalance(text) {
  const out = { source: '' };
  for (const line of String(text || '').split('\n')) {
    let match;
    if ((match = line.match(/余额[：:]\s*(.+)/))) out.balance = match[1].trim();
    else if ((match = line.match(/今日用量[：:]\s*(.+)/))) out.today = match[1].trim();
    else if ((match = line.match(/费用估算[：:]\s*(.+)/))) {
      out.cost = match[1].trim();
      const paren = out.cost.match(/[（(]([^）)]+)[）)]/);
      if (paren) out.source = paren[1].trim();
      out.cost = out.cost.replace(/[（(][^）)]+[）)]/, '').trim();
    } else if ((match = line.match(/Pi 记账[：:]\s*(.+)/))) out.ledger = match[1].trim();
  }
  return out;
}

function renderBalance() {
  const data = state.balance;
  const setAll = (targets, value) => targets.forEach((node) => { if (node) node.textContent = value; });
  if (!data) {
    setAll([nodes.balBalance, nodes.sideBalance], '—');
    setAll([nodes.balToday, nodes.sideToday], '—');
    setAll([nodes.balCost, nodes.sideCost], '—');
    setAll([nodes.balLedger], '—');
    return;
  }
  setAll([nodes.balBalance, nodes.sideBalance], data.balance || '—');
  setAll([nodes.balToday, nodes.sideToday], data.today || '—');
  setAll([nodes.balCost, nodes.sideCost], data.cost || '—');
  setAll([nodes.balLedger], data.ledger || '—');
  nodes.balanceSource.textContent = data.source
    ? `计价源：${data.source}。数据由 /fairy-balance 向 DeepSeek 拉取，仅用于估算。`
    : '数据由 /fairy-balance 向 DeepSeek 拉取，仅用于估算。';
}

async function refreshBalance() {
  const text = await runPanelCommand('/fairy-balance', 25000);
  if (!text) {
    nodes.balanceSource.textContent = '未取到余额数据（本地服务或网络未就绪）。可稍后重试。';
    return;
  }
  state.balance = parseBalance(text);
  renderBalance();
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

function parseCorpus(text) {
  const items = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const bullet = line.match(/^-\s+([^（(]+)[（(]([^）)]+)[）)]：(.*)$/);
    if (bullet) {
      current = { name: bullet[1].trim(), meta: bullet[2].trim(), desc: bullet[3].trim(), path: '' };
      items.push(current);
      continue;
    }
    const path = line.match(/^\s{2,}(\S.*)$/);
    if (path && current) current.path = path[1].trim();
    else current = null;
  }
  return items;
}

function renderCorpus(items) {
  nodes.personaCorpus.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-note';
    empty.textContent = '未取到语料列表。';
    nodes.personaCorpus.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'corpus-item';
    const name = document.createElement('span');
    name.className = 'skill-name';
    name.textContent = item.name;
    const desc = document.createElement('span');
    desc.className = 'skill-desc';
    desc.textContent = `${item.meta}：${item.desc}`;
    row.append(name, desc);
    if (item.path) row.title = item.path;
    nodes.personaCorpus.append(row);
  }
}

async function refreshPersona() {
  const status = await runPanelCommand('/fairy-persona status', 12000);
  nodes.personaStatus.textContent = status || '人格插件未返回信息。';
  const enabled = /已开启|已启用|开启中/.test(status) && !/已关闭/.test(status);
  nodes.personaEnabled.checked = enabled;
  navBadge('persona', enabled ? '开' : '关');
  const corpus = await runPanelCommand('/fairy-persona corpus', 12000);
  renderCorpus(parseCorpus(corpus));
}

async function setPersona(enabled) {
  await captureCommand(`/fairy-persona ${enabled ? 'on' : 'off'}`, 12000);
  await refreshPersona();
  toast(enabled ? '人设注入已开启（会话级）' : '人设注入已关闭', 'info');
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function renderSkills() {
  if (!nodes.skillsList) return;
  const skills = state.commands.filter((entry) => entry.source === 'skill');
  const extensions = state.commands.filter((entry) => entry.source !== 'skill');
  const fill = (host, list, prefix) => {
    host.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-note';
      empty.textContent = '暂无。可点右上角刷新。';
      host.append(empty);
      return;
    }
    for (const entry of list) {
      const row = document.createElement('div');
      row.className = 'skill-item';
      const name = document.createElement('span');
      name.className = 'skill-name';
      name.textContent = `${prefix}${entry.name}`;
      const desc = document.createElement('span');
      desc.className = 'skill-desc';
      desc.textContent = entry.description || '';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'ghost';
      use.textContent = '使用';
      use.addEventListener('click', () => {
        nodes.input.value = `${prefix}${entry.name} `;
        showPage('chat');
        autosize();
        nodes.input.focus();
      });
      row.append(name, desc, use);
      host.append(row);
    }
  };
  fill(nodes.skillsList, skills, '/');
  fill(nodes.extList, extensions, '/');
  navBadge('skills', String(skills.length));
}

// ---------------------------------------------------------------------------
// Browser dock
// ---------------------------------------------------------------------------

function renderBrowser() {
  const data = state.browser;
  if (!data) {
    nodes.browserStatus.textContent = '未查询';
    nodes.browserStatus.dataset.state = '';
    nodes.browserUrl.textContent = '';
    return;
  }
  const active = Boolean(data.active);
  nodes.browserStatus.textContent = `${data.status || '未知'}${active ? ' · 已激活' : ''}`;
  nodes.browserStatus.dataset.state = active ? 'active' : 'warning';
  nodes.browserUrl.textContent = data.title || data.url || '';
  nodes.browserState.textContent = JSON.stringify(data, null, 2);
  navBadge('browser', active ? '活动' : '');
}

async function refreshBrowser() {
  const text = await runPanelCommand('/fairy-browser state', 12000);
  const json = text.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      state.browser = JSON.parse(json[0]);
    } catch {
      state.browser = { status: text.split('\n')[0] || '未知' };
    }
  } else {
    state.browser = { status: text.split('\n')[0] || '未激活' };
  }
  renderBrowser();
}

async function browserCommand(action) {
  const revision = state.browser && state.browser.frameRevision != null ? state.browser.frameRevision : 0;
  const text = action === 'takeover' ? `/fairy-browser takeover ${revision}` : `/fairy-browser ${action}`;
  const reply = await runPanelCommand(text, 12000);
  if (reply) toast(reply.split('\n')[0], 'info');
  await refreshBrowser();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function refreshSettings() {
  await loadModels();
  if (state.currentModel) nodes.setModel.value = `${state.currentModel.provider}/${state.currentModel.id}`;
  nodes.setThinking.value = state.thinkingLevels.includes('high') ? 'high' : nodes.setThinking.value;
  const levels = await command({ type: 'get_available_thinking_levels' });
  if (levels.success && levels.data && levels.data.levels) {
    state.thinkingLevels = levels.data.levels;
    fillThinkingSelect();
  }
  const stateResult = await command({ type: 'get_state' });
  if (stateResult.success && stateResult.data) {
    nodes.setThinking.value = stateResult.data.thinkingLevel || nodes.setThinking.value;
  }
  applyPrefs();
  const info = state.info || {};
  nodes.setCwd.textContent = (info.cwd || '—');
  nodes.infoSession.textContent = state.sessionId || '—';
  nodes.infoMessages.textContent = String(state.messageCount || 0);
  nodes.infoPi.textContent = info.piVersion || '未找到';
  nodes.infoElectron.textContent = info.electron || '—';
  nodes.infoPaths.textContent = [
    `工作目录：${info.cwd || '—'}`,
    `pi 入口：${info.piPath || '未找到'}`,
    `pi 版本：${info.piVersion || '未找到'}`,
  ].join('\n');
}

async function chooseWorkdir() {
  const picked = await api.pickWorkdir();
  if (!picked) return;
  await api.restart({ cwd: picked });
  await afterStart();
  toast(`工作目录已切到 ${picked}`, 'info');
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autosize() {
  nodes.input.style.height = 'auto';
  const content = nodes.input.scrollHeight;
  nodes.input.style.height = `${Math.min(content, 190)}px`;
  // A textarea scrolls by default; only keep the scrollbar once the cap is hit.
  nodes.input.style.overflowY = content > 190 ? 'auto' : 'hidden';
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

function bindShell() {
  buildNav();

  nodes.btnVoice.addEventListener('click', () => {
    prefs.voice = !prefs.voice;
    savePrefs();
    applyPrefs();
    if (!prefs.voice && window.speechSynthesis) window.speechSynthesis.cancel();
    toast(prefs.voice ? '语音朗读已开启' : '语音朗读已关闭', 'info');
    if (prefs.voice) speakLatest();
  });

  nodes.btnAbort.addEventListener('click', () => command({ type: 'abort' }));

  const newSession = async () => {
    const result = await command({ type: 'new_session' });
    if (result.success && !(result.data && result.data.cancelled)) {
      clearTranscript();
      state.lastSpokenText = '';
      refreshState();
      refreshStats();
    }
  };
  nodes.btnNew.addEventListener('click', newSession);
  nodes.btnNewSession.addEventListener('click', () => {
    showPage('chat');
    newSession();
  });

  nodes.btnWorkdir.addEventListener('click', chooseWorkdir);
  nodes.btnSetWorkdir.addEventListener('click', chooseWorkdir);

  nodes.btnTheme.addEventListener('click', () => {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    savePrefs();
    applyPrefs();
  });

  nodes.btnGotoSettings.addEventListener('click', () => showPage('settings'));
  nodes.balanceCard.addEventListener('click', () => showPage('balance'));

  nodes.chipModel.addEventListener('click', (event) => {
    event.stopPropagation();
    if (nodes.modelMenu.hidden) openModelMenu();
    else closeModelMenu();
  });
  nodes.chipCwd.addEventListener('click', () => showPage('settings'));
  document.addEventListener('click', (event) => {
    if (nodes.modelMenu.hidden) return;
    if (!nodes.modelMenu.contains(event.target) && !nodes.chipModel.contains(event.target)) closeModelMenu();
  });

  // balance page
  nodes.btnBalanceRefresh.addEventListener('click', () => refreshBalance());

  // voice page
  nodes.voiceEnabled.addEventListener('change', () => {
    prefs.voice = nodes.voiceEnabled.checked;
    savePrefs();
    applyPrefs();
    if (prefs.voice) speakLatest();
  });
  nodes.voiceName.addEventListener('change', () => {
    prefs.voiceName = nodes.voiceName.value;
    savePrefs();
  });
  nodes.voiceRate.addEventListener('input', () => {
    prefs.voiceRate = Number(nodes.voiceRate.value);
    nodes.voiceRateValue.textContent = prefs.voiceRate.toFixed(2);
    savePrefs();
  });
  nodes.btnVoiceTest.addEventListener('click', () => {
    state.lastSpokenText = '';
    speak('我是 Fairy，pi 的桌面端已就绪。');
  });
  nodes.btnVoiceStatus.addEventListener('click', () => refreshVoiceService());

  // persona page
  nodes.btnPersonaRefresh.addEventListener('click', () => refreshPersona());
  nodes.personaEnabled.addEventListener('change', () => setPersona(nodes.personaEnabled.checked));

  // skills page
  nodes.btnSkillsRefresh.addEventListener('click', async () => {
    await loadCommands();
    renderSkills();
  });

  // browser page
  nodes.btnBrowserRefresh.addEventListener('click', () => refreshBrowser());
  for (const button of document.querySelectorAll('[data-browser-cmd]')) {
    button.addEventListener('click', () => browserCommand(button.dataset.browserCmd));
  }

  // settings page
  nodes.btnSetModel.addEventListener('click', () => {
    const value = nodes.setModel.value;
    if (!value) return;
    const [provider, ...rest] = value.split('/');
    setModel(provider, rest.join('/'));
  });
  nodes.btnSetThinking.addEventListener('click', () => {
    if (nodes.setThinking.value) applyThinkingLevel(nodes.setThinking.value);
  });
  nodes.setTheme.addEventListener('change', () => {
    prefs.theme = nodes.setTheme.value;
    savePrefs();
    applyPrefs();
  });
  nodes.setMascot.addEventListener('change', () => {
    prefs.mascotVisible = nodes.setMascot.checked;
    savePrefs();
    applyPrefs();
  });
  nodes.setMascotScale.addEventListener('input', () => {
    prefs.mascotScale = Number(nodes.setMascotScale.value);
    nodes.setMascotScaleValue.textContent = prefs.mascotScale.toFixed(2);
    savePrefs();
    applyPrefs();
  });
  nodes.setMascotSpeed.addEventListener('change', () => {
    prefs.mascotSpeed = Number(nodes.setMascotSpeed.value);
    savePrefs();
    applyPrefs();
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
    if (event.key === 'Escape') {
      if (!nodes.modelMenu.hidden) {
        closeModelMenu();
        return;
      }
      if (state.running) command({ type: 'abort' });
    }
  });

  window.addEventListener('resize', () => {
    layoutHero();
    if (!nodes.modelMenu.hidden) closeModelMenu();
  });
}

async function boot() {
  applyPrefs();
  mountMascot();
  applyPrefs();
  bindShell();
  showPage('chat');
  layoutHero();

  api.onRecord(handleRecord);
  api.onStatus(handleStatus);
  api.onStderr((text) => {
    // pi writes structured lines (JSON or `[fairy-pi] ...` diagnostics) to
    // stderr. Only genuine errors are worth a toast; warnings such as a missing
    // optional reference file are logged but suppressed as noise.
    for (const line of String(text).split('\n')) {
      if (!/"level":"error"/.test(line)) {
        console.warn(line);
        continue;
      }
      const match = line.match(/\{[^]*\}$/);
      reportFailure('pi 报告错误', (match ? match[0] : line).slice(0, 240));
    }
  });

  const info = await api.bootstrap();
  state.info = info;
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
  await loadModels();
  fillVoiceSelect();
  renderBalance();
  handleStatus({ state: 'ready' });
  // The sidebar card mirrors DSH's one; fill it once at startup.
  refreshBalance().catch(() => {});
}

function reportFailure(message, detail) {
  console.error(`[fairy-pi] ${message}`, detail === undefined ? '' : detail);
  toast(`${message}${detail ? `：${detail}` : ''}`, 'error');
}

if (window.speechSynthesis) {
  // Chromium populates the voice list asynchronously.
  window.speechSynthesis.addEventListener('voiceschanged', () => fillVoiceSelect());
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
