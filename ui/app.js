import { api, online } from './api.js';
import { emoji, QUICK } from './emoji.js';
import { icon } from './icons.js';
import { escapeHtml, plainText, renderMarkdown, setMentionNames, splitTitle } from './markdown.js';

/* ---------- templating: values are escaped unless wrapped in raw() ---------- */

class Html {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
const raw = (value) => new Html(value);
const flat = (value) => value === null || value === undefined || value === false ? ''
  : value instanceof Html ? value.value : Array.isArray(value) ? value.map(flat).join('') : escapeHtml(value);
const html = (strings, ...values) => raw(strings.reduce((out, part, i) => out + flat(values[i - 1]) + part));
const svg = (name, size) => raw(icon(name, size));
const attr = (name, on) => (on ? raw(` ${name}`) : '');

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const view = { app: $('#app'), sidebar: $('#sidebar'), feed: $('#feed'), reader: $('#reader'), toasts: $('#toasts') };

/* ---------- state ---------- */

const DONE_KEY = 'board-web.done-collapsed';
const state = {
  board: null,
  me: null,
  channels: [],
  actors: new Map(),
  unread: new Set(),
  route: null,
  list: { key: null, items: [], older: null, loading: true, error: null, fresh: null },
  thread: { id: null, data: null, loading: false, error: null },
  live: 'connecting',
  stale: false,
  editing: null,
  taskForm: null,
  deferred: false,
  popover: null,
  doneCollapsed: (() => {
    try {
      return localStorage.getItem(DONE_KEY) === '1';
    } catch {
      return false;
    }
  })(),
};

const TASK_STATES = { waiting: '대기', ready: '준비', claimed: '진행 중', blocked: '막힘', completed: '완료', failed: '실패', canceled: '취소' };
const TASK_TABS = [['open', '열림'], ['ready', '준비'], ['claimed', '진행 중'], ['blocked', '막힘'], ['completed', '완료'], ['failed', '실패'], ['all', '전체']];
const KNOWN_LABELS = ['priority', 'project', 'kind', 'type', 'status'];
const LIVE = { connecting: '연결 중', live: '실시간', offline: '다시 연결 중' };
const THEMES = { auto: ['시스템', 'auto'], light: ['라이트', 'sun'], dark: ['다크', 'moon'] };
const THEME_KEY = 'board-web.theme';

/* ---------- routing ---------- */

const encodeChannel = (channel) => channel.split('/').map(encodeURIComponent).join('/');
const decodeChannel = (path) => path.split('/').map(decodeURIComponent).join('/');

function parseRoute() {
  const params = new URLSearchParams(location.search);
  const base = { q: params.get('q') ?? '', labels: params.getAll('label'), state: params.get('state') ?? 'open' };
  try {
    let match = /^\/tasks(?:\/t\/([^/]+))?\/?$/.exec(location.pathname);
    if (match) return { ...base, view: 'tasks', channel: null, thread: match[1] ? decodeURIComponent(match[1]) : null };
    match = /^\/c\/(.+?)(?:\/t\/([^/]+))?\/?$/.exec(location.pathname);
    if (match) return { ...base, view: 'channel', channel: decodeChannel(match[1]), thread: match[2] ? decodeURIComponent(match[2]) : null };
  } catch {}
  return { ...base, view: 'home', channel: null, thread: null };
}

function href(change = {}) {
  const route = { ...state.route, ...change };
  let path = route.view === 'tasks' ? '/tasks' : `/c/${encodeChannel(route.channel ?? '')}`;
  if (route.thread) path += `/t/${encodeURIComponent(route.thread)}`;
  const params = new URLSearchParams();
  if (route.q) params.set('q', route.q);
  for (const label of route.labels ?? []) params.append('label', label);
  if (route.view === 'tasks' && route.state !== 'open') params.set('state', route.state);
  const query = String(params);
  return query ? `${path}?${query}` : path;
}

const channelHref = (channel) => href({ view: 'channel', channel, thread: null, q: '', labels: [], state: 'open' });
const threadHref = (message) => href({ thread: message.id });
const listKey = (route) => route && [route.view, route.channel, route.q, route.labels.join('&'), route.view === 'tasks' ? route.state : ''].join('|');
const headKey = (route) => route && `${route.view}|${route.channel}`;

function navigate(url, replace = false) {
  if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  onRoute();
}

function onRoute() {
  const previous = state.route;
  state.route = parseRoute();
  const route = state.route;
  if (route.view === 'home') {
    const first = state.channels.find((channel) => channel.path === 'general') ?? state.channels[0];
    if (first) return navigate(channelHref(first.path), true);
  }
  closePopover();
  if (route.channel) state.unread.delete(route.channel);
  document.body.classList.remove('nav-open');
  view.app.dataset.reader = route.thread ? 'open' : 'closed';
  renderSidebar();
  if (headKey(previous) !== headKey(route)) renderFeed();
  else syncFeedHead();
  if (listKey(previous) !== listKey(route)) loadList();
  else renderList();
  if (route.thread !== state.thread.id) openThread(route.thread);
  updateTitle();
}

function updateTitle() {
  const { view: kind, channel } = state.route;
  const root = state.thread.data?.message;
  const where = kind === 'tasks' ? '작업' : channel ? `#${channel}` : '보드';
  const title = root && (splitTitle(root.text).title ?? plainText(root.text).slice(0, 60));
  document.title = [title, where, state.board?.name ?? 'Board'].filter(Boolean).join(' · ');
}

/* ---------- small views ---------- */

const actorName = (id) => state.actors.get(id)?.name ?? String(id).split(':').pop();
const nameOf = (author) => author?.name ?? author?.handle ?? '알 수 없음';
const mine = (message) => Boolean(state.me && message.by?.principal === state.me.principal);
const can = (permission, channel) => Object.entries(state.me?.can ?? {}).some(([pattern, granted]) => granted.includes(permission) &&
  (pattern === '*' || pattern === channel || (pattern.endsWith('/') && channel.startsWith(pattern))));

function tone(text) {
  let hash = 0;
  for (const char of String(text)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 8;
}

function avatar(author, size = 28) {
  const label = nameOf(author);
  if (author?.avatar && /^https:\/\//i.test(author.avatar)) {
    return html`<img class="avatar" data-size="${size}" src="${author.avatar}" alt="" loading="lazy">`;
  }
  return html`<span class="avatar${author?.kind === 'agent' ? ' is-agent' : ''}" data-size="${size}" data-tone="${tone(author?.handle ?? label)}" aria-hidden="true">${[...label][0]?.toUpperCase() ?? '?'}</span>`;
}

const agentMark = (author) => author?.kind === 'agent'
  ? html`<span class="agent" title="${`에이전트${author.via?.name ? ` · ${author.via.name}` : ''}`}">${svg('spark', 11)}</span>` : '';

const clock = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
const fullDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeStyle: 'short' });
const shortDate = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' });
const yearDate = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });

function ago(iso) {
  const date = new Date(iso);
  const seconds = (Date.now() - date) / 1000;
  if (seconds < 60) return '방금';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}일 전`;
  return (date.getFullYear() === new Date().getFullYear() ? shortDate : yearDate).format(date);
}

const time = (iso, full = false) => iso
  ? html`<time datetime="${iso}" title="${fullDate.format(new Date(iso))}"${attr('data-ago', !full)}>${full ? fullDate.format(new Date(iso)) : ago(iso)}</time>` : '';

function labelEntries(labels) {
  const rank = (key) => (KNOWN_LABELS.includes(key) ? KNOWN_LABELS.indexOf(key) : KNOWN_LABELS.length);
  return Object.entries(labels ?? {}).filter(([key]) => !key.startsWith('board.'))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function chip([key, value]) {
  const text = key === 'priority' ? `P${value}` : KNOWN_LABELS.includes(key) ? value : `${key}: ${value}`;
  const pressed = state.route.labels.includes(`${key}=${value}`);
  return html`<button type="button" class="chip" data-action="label" data-key="${key}" data-value="${value}" data-tone="${key === 'project' ? tone(value) : ''}" aria-pressed="${String(pressed)}" title="${`${key}: ${value}`}">${text}</button>`;
}

const DONE_PREFIX = /^\s*\[완료\]\s*/;
/** A completed task's badge already says 완료, so a title that starts with [완료] doesn't say it again. */
const shownTitle = (title, task) => (title && task?.state === 'completed' && title.replace(DONE_PREFIX, '')) || title;

const clip = (text, max = 40) => {
  const chars = [...String(text)];
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : String(text);
};

/* Other threads a view names (a task's needs): read once, then kept current by live events. */
const refs = new Map();

function remember(message) {
  const { title } = splitTitle(message.text);
  refs.set(message.id, {
    status: 'ok',
    title: message.deleted ? '삭제된 메시지' : title ?? (plainText(message.text) || '(내용 없음)'),
    channel: message.channel,
    state: message.task?.state ?? null,
  });
}

function ref(id) {
  const listed = state.list.items.find((summary) => summary.message.id === id);
  if (!refs.has(id) && listed) remember(listed.message);
  if (!refs.has(id)) {
    refs.set(id, { status: 'loading' });
    api.message(id).then(({ message }) => remember(message), () => refs.set(id, { status: 'missing' }))
      .finally(refreshReader);
  }
  return refs.get(id);
}

function refreshReader() {
  if (!state.thread.data) return;
  if (state.editing || state.taskForm) state.deferred = true;
  else renderReaderBody({ quiet: true });
}

const refHref = (id, found) => state.route.view === 'tasks'
  ? href({ thread: id })
  : href({ view: 'channel', channel: found.channel, thread: id, q: '', labels: [] });

function need(id) {
  const found = ref(id);
  if (found.status === 'loading') return html`<li class="need is-quiet">불러오는 중…</li>`;
  if (found.status === 'missing') return html`<li class="need is-quiet" title="${id}">읽을 수 없는 작업</li>`;
  return html`<li><a class="need" href="${refHref(id, found)}" data-link title="${shownTitle(found.title, found)}">
    ${found.state ? taskBadge({ state: found.state }) : ''}<span class="need-title">${clip(shownTitle(found.title, found))}</span>
    ${found.channel !== state.thread.data?.message.channel ? html`<span class="dim">#${found.channel}</span>` : ''}
  </a></li>`;
}

const taskBadge = (task) => task ? html`<span class="task-badge" data-state="${task.state}">${TASK_STATES[task.state] ?? task.state}</span>` : '';

function reactions(message, always) {
  const entries = Object.entries(message.reactions ?? {}).filter(([, who]) => who.length);
  if (!entries.length && !always) return '';
  return html`<div class="reactions">${entries.map(([name, who]) => html`
    <button type="button" class="reaction" data-action="react" data-id="${message.id}" data-emoji="${name}" aria-pressed="${String(who.includes(state.me?.actor))}" title="${who.map(actorName).join(', ')}">
      <span class="emoji">${emoji(name)}</span><span class="count">${who.length}</span>
    </button>`)}
    <button type="button" class="reaction add" data-action="pick" data-id="${message.id}" aria-label="반응 추가" title="반응 추가">${svg('smile', 15)}</button>
  </div>`;
}

function files(message) {
  if (!message.attachments?.length) return '';
  const size = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  return html`<div class="files">${message.attachments.map((file) => file.type?.startsWith('image/')
    ? html`<button type="button" class="file-image" data-action="open-file" data-file="${file.id}" data-name="${file.name}" title="${file.name}"><img data-attachment="${file.id}" alt="${file.name}"></button>`
    : html`<button type="button" class="file" data-action="open-file" data-file="${file.id}" data-name="${file.name}">${svg('file', 16)}<span class="file-name">${file.name}</span><span class="dim">${size(file.size)}</span></button>`)}</div>`;
}

const tools = (message) => html`<div class="tools">
  <button type="button" class="icon-btn" data-action="pick" data-id="${message.id}" aria-label="반응 추가" title="반응 추가">${svg('smile', 16)}</button>
  <button type="button" class="icon-btn" data-action="menu" data-id="${message.id}" aria-label="더 보기" title="더 보기">${svg('more', 16)}</button>
</div>`;

const editor = (message) => html`<form class="editor" id="editor" data-id="${message.id}">
  <textarea id="edit-text" rows="4">${message.text}</textarea>
  <div class="editor-actions">
    <span class="hint"><kbd>⌘</kbd><kbd>↵</kbd> 저장 · <kbd>esc</kbd> 취소</span>
    <button type="button" class="btn" data-action="edit-cancel">취소</button>
    <button type="submit" class="btn btn-primary">저장</button>
  </div>
</form>`;

/* ---------- sidebar ---------- */

function renderSidebar() {
  const naming = $('#new-channel input');
  const draft = naming && { value: naming.value, focused: document.activeElement === naming };
  const route = state.route;
  const theme = document.documentElement.dataset.theme ?? 'auto';
  const me = state.me;
  view.sidebar.innerHTML = html`
    <div class="brand">
      <span class="brand-mark">${svg('spark', 15)}</span>
      <div class="brand-text"><strong>${state.board?.name ?? 'Board'}</strong><span>Vercel Board</span></div>
    </div>
    <nav class="nav">
      <a class="nav-item" href="/tasks" data-link${attr('aria-current="page"', route.view === 'tasks')}>${svg('tasks', 16)}<span class="nav-name">작업</span></a>
      <div class="nav-section"><span>채널</span>
        <button type="button" class="icon-btn sm" data-action="new-channel" aria-label="채널 만들기" title="채널 만들기">${svg('plus', 14)}</button>
      </div>
      <div id="new-channel-slot"></div>
      ${state.channels.map((channel) => html`
        <a class="nav-item" href="${channelHref(channel.path)}" data-link${attr('aria-current="page"', route.view === 'channel' && route.channel === channel.path)}>
          <span class="hash">#</span><span class="nav-name">${channel.path}</span>${state.unread.has(channel.path) ? html`<span class="unread" title="새 글"></span>` : ''}
        </a>`)}
    </nav>
    <div class="sidebar-foot">
      ${me ? html`<div class="me">
        ${avatar({ name: me.name, handle: me.handle, avatar: me.avatar, kind: me.kind }, 28)}
        <div class="me-text"><strong>${me.name}</strong>${me.handle !== me.name ? html`<span>${me.handle}</span>` : html`<span>나</span>`}</div>
        <button type="button" class="icon-btn" data-action="theme" aria-label="${`테마: ${THEMES[theme][0]}`}" title="${`테마: ${THEMES[theme][0]}`}">${svg(THEMES[theme][1], 16)}</button>
      </div>` : ''}
      <div class="foot-row">
        <span class="live" data-state="${state.live}"><i></i>${LIVE[state.live]}</span>
        <a class="foot-link" href="/classic" target="_blank" rel="noopener">기존 Inspector ${svg('external', 12)}</a>
      </div>
    </div>`;
  if (draft) {
    actions['new-channel']();
    const input = $('#new-channel input');
    input.value = draft.value;
    if (!draft.focused) input.blur();
  }
}

function setLive(live) {
  if (state.live === live) return;
  state.live = live;
  const badge = $('.live', view.sidebar);
  if (badge) {
    badge.dataset.state = live;
    badge.lastChild.textContent = LIVE[live];
  }
}

/* ---------- feed ---------- */

function renderFeed() {
  const route = state.route;
  const title = route.view === 'tasks' ? html`${svg('tasks', 20)}<span>작업</span>`
    : route.channel ? html`<span class="hash">#</span><span>${route.channel}</span>` : '보드';
  view.feed.innerHTML = html`
    <header class="feed-head">
      <button type="button" class="icon-btn nav-toggle" data-action="open-nav" aria-label="메뉴">${svg('menu', 18)}</button>
      <div class="feed-heading">
        <h1 class="feed-title">${title}</h1>
        <p class="feed-sub" id="feed-sub">&nbsp;</p>
      </div>
      ${route.view === 'channel' ? html`<div class="feed-tools">
        <label class="search">${svg('search', 15)}
          <input id="search" type="search" placeholder="검색" autocomplete="off" spellcheck="false" value="${route.q}" aria-label="스레드 검색">
          <kbd>/</kbd>
        </label>
        <button type="button" class="btn btn-primary" data-action="compose" title="새 글 (N)">${svg('plus', 16)}<span>새 글</span></button>
      </div>` : ''}
    </header>
    ${route.view === 'tasks' ? html`<nav class="tabs" id="tabs">${TASK_TABS.map(([key, label]) =>
      html`<a class="tab" href="${href({ state: key, thread: null })}" data-link data-state="${key}">${label}</a>`)}</nav>` : ''}
    <div class="filters" id="filters"></div>
    <div id="composer-slot"></div>
    <div class="list" id="list"></div>`;
  syncFeedHead();
  renderList();
}

function syncFeedHead() {
  const route = state.route;
  const search = $('#search');
  if (search && document.activeElement !== search) search.value = route.q;
  for (const tab of $$('#tabs .tab')) tab.toggleAttribute('aria-current', tab.dataset.state === route.state);
  const filters = $('#filters');
  if (!filters) return;
  const active = route.labels.map((label) => label.split('='));
  filters.hidden = !active.length && !route.q;
  filters.innerHTML = html`
    ${route.q ? html`<button type="button" class="chip is-filter" data-action="clear-search">“${route.q}” ${svg('close', 12)}</button>` : ''}
    ${active.map(([key, value]) => html`<button type="button" class="chip is-filter" data-action="label" data-key="${key}" data-value="${value ?? ''}">${key === 'priority' ? `P${value}` : `${key}: ${value}`} ${svg('close', 12)}</button>`)}
    <button type="button" class="link-btn" data-action="clear-filters">모두 지우기</button>`;
}

const DONE_STATES = ['completed', 'failed'];

function listSections() {
  const { items } = state.list;
  const { view, state: taskState } = state.route;
  if (view !== 'channel' && !(view === 'tasks' && taskState === 'all')) return { regular: items, done: [] };
  const regular = [];
  const done = [];
  for (const summary of items) {
    (DONE_STATES.includes(summary.message.task?.state) ? done : regular).push(summary);
  }
  return { regular, done };
}

/** Keyboard navigation follows the rendered order and skips the folded group. */
function listOrder() {
  const { regular, done } = listSections();
  return state.doneCollapsed ? regular : [...regular, ...done];
}

function renderList() {
  const list = $('#list');
  if (!list) return;
  const { items, loading, error, older, scanned } = state.list;
  const route = state.route;
  const sub = $('#feed-sub');
  if (sub) {
    sub.textContent = loading && !items.length ? '불러오는 중…'
      : route.view === 'tasks' ? `작업 ${items.length}개`
      : route.view === 'home' ? '채널을 만들어 시작하세요'
      : `스레드 ${items.length}${older ? '+' : ''}개${scanned ? ` · 최근 ${scanned}개에서 찾음` : ''}`;
  }

  if (route.view === 'home') {
    list.innerHTML = html`<div class="empty">
      <span class="empty-mark">${svg('hash', 22)}</span>
      <h2>아직 채널이 없어요</h2><p>왼쪽 채널 옆의 + 로 첫 채널을 만들어 보세요.</p>
    </div>`;
  } else if (loading && !items.length) {
    list.innerHTML = html`${[0, 1, 2].map(() => html`<div class="card is-skeleton"><i></i><i></i><i></i></div>`)}`;
  } else if (error && !items.length) {
    list.innerHTML = html`<div class="empty is-error"><h2>목록을 불러오지 못했어요</h2><p>${error}</p>
      <button type="button" class="btn" data-action="retry-list">다시 시도</button></div>`;
  } else if (!items.length) {
    const filtered = route.q || route.labels.length;
    list.innerHTML = html`<div class="empty">
      <span class="empty-mark">${svg(filtered ? 'search' : route.view === 'tasks' ? 'tasks' : 'spark', 22)}</span>
      <h2>${filtered ? '맞는 스레드가 없어요' : route.view === 'tasks' ? '이 상태의 작업이 없어요' : '아직 조용하네요'}</h2>
      <p>${filtered ? '검색어나 라벨을 바꿔 보세요.' : route.view === 'tasks' ? '에이전트가 작업을 만들면 여기에 모여요.' : '이 채널의 첫 글을 남겨 보세요.'}</p>
      ${filtered ? html`<button type="button" class="btn" data-action="clear-filters">필터 지우기</button>`
        : route.view === 'channel' ? html`<button type="button" class="btn btn-primary" data-action="compose">${svg('plus', 16)}<span>새 글</span></button>` : ''}
    </div>`;
  } else {
    const { regular, done } = listSections();
    list.innerHTML = html`${regular.map(card)}
      ${done.length ? html`<section class="list-done" aria-label="완료 또는 실패한 스레드">
        <button type="button" class="list-group" data-action="toggle-done" aria-expanded="${String(!state.doneCollapsed)}">
          ${DONE_STATES.map((state) => taskBadge({ state }))}<span class="list-group-count">${done.length}</span>
          <span class="list-group-rule"></span>${svg('chevron', 15)}
        </button>
        ${state.doneCollapsed ? '' : done.map(card)}
      </section>` : ''}
      ${older ? html`<button type="button" class="more" data-action="more"${attr('disabled', loading)}>${loading ? '불러오는 중…' : '이전 스레드 더 보기'}</button>` : ''}`;
  }
  state.list.fresh = null;
  $('.card.is-open', list)?.scrollIntoView({ block: 'nearest' });
}

function card(summary) {
  const message = summary.message;
  const { title, body } = splitTitle(message.text);
  const text = message.deleted ? '삭제된 메시지예요.' : plainText(body).slice(0, 320);
  const labels = labelEntries(message.labels);
  const counts = Object.entries(message.reactions ?? {}).filter(([, who]) => who.length)
    .sort(([, a], [, b]) => b.length - a.length).slice(0, 3);
  const classes = ['card', state.route.thread === message.id && 'is-open',
    state.list.fresh?.has(message.thread) && 'is-fresh', message.deleted && 'is-deleted'].filter(Boolean).join(' ');
  return html`<article class="${classes}">
    <div class="card-meta">
      ${avatar(message.author, 20)}
      <span class="who">${nameOf(message.author)}</span>${agentMark(message.author)}
      ${state.route.view === 'tasks' ? html`<span class="where">#${message.channel}</span>` : ''}
      <span class="sep">·</span>${time(message.createdAt)}
      ${taskBadge(message.task)}
    </div>
    <a class="card-link" href="${threadHref(message)}" data-link>
      ${title ? html`<h2 class="card-title">${shownTitle(title, message.task)}</h2>` : ''}
      ${text ? html`<p class="card-text${title ? '' : ' is-solo'}">${text}</p>` : ''}
    </a>
    ${labels.length || counts.length || summary.replies ? html`<div class="card-foot">
      ${labels.map(chip)}
      <span class="grow"></span>
      ${counts.map(([name, who]) => html`<span class="card-stat">${emoji(name)} ${who.length}</span>`)}
      ${summary.replies ? html`<span class="card-stat">${svg('reply', 14)} ${summary.replies}${summary.last ? html`<span class="dim"> · ${time(summary.last.createdAt)}</span>` : ''}</span>` : ''}
    </div>` : ''}
  </article>`;
}

let listAbort = null;
async function loadList({ quiet = false, more = false } = {}) {
  const route = state.route;
  const key = listKey(route);
  if (route.view === 'home') {
    state.list = { key, items: [], older: null, loading: false, error: null, fresh: null };
    return renderList();
  }
  if (!quiet && !more) state.list = { key, items: [], older: null, loading: true, error: null, fresh: null };
  else if (more) state.list.loading = true;
  renderList();
  listAbort?.abort();
  const controller = listAbort = new AbortController();
  try {
    let items;
    let older = null;
    let scanned = null;
    if (route.view === 'tasks') {
      items = (await api.tasks({ state: route.state, limit: 200 }, controller.signal)).tasks;
    } else {
      const page = await api.threads({
        channel: route.channel, text: route.q, label: route.labels,
        ...(more ? { before: state.list.older } : quiet ? { limit: Math.min(500, Math.max(50, state.list.items.length)) } : {}),
      }, controller.signal);
      ({ threads: items, older = null, scanned = null } = page);
    }
    if (key !== listKey(state.route)) return;
    let fresh = null;
    if (quiet) {
      const signature = (summary) => `${summary.message.version}:${summary.replies}:${summary.last?.id}:${summary.last?.version}`;
      const before = new Map(state.list.items.map((summary) => [summary.message.thread, signature(summary)]));
      fresh = new Set(items.filter((summary) => before.get(summary.message.thread) !== signature(summary)).map((summary) => summary.message.thread));
    }
    if (more) {
      const seen = new Set(state.list.items.map((summary) => summary.message.thread));
      items = [...state.list.items, ...items.filter((summary) => !seen.has(summary.message.thread))];
    }
    state.list = { key, items, older: quiet && !more ? state.list.older ?? older : older, loading: false, error: null, scanned, fresh };
  } catch (error) {
    if (error.name === 'AbortError' || key !== listKey(state.route)) return;
    state.list = { ...state.list, loading: false, error: error.message };
    if (quiet || more) toast(error.message, 'error');
  }
  renderList();
}

let listTimer = 0;
const refreshList = () => {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => loadList({ quiet: true }), 250);
};

/* ---------- composer ---------- */

const drafts = {
  get: (key) => sessionStorage.getItem(`board-web.draft.${key}`) ?? '',
  set: (key, value) => (value ? sessionStorage.setItem(`board-web.draft.${key}`, value) : sessionStorage.removeItem(`board-web.draft.${key}`)),
};

function openComposer() {
  const route = state.route;
  if (route.view !== 'channel' || !route.channel) return;
  const slot = $('#composer-slot');
  if (!slot) return;
  if (!slot.firstElementChild) {
    const key = `compose:${route.channel}`;
    slot.innerHTML = html`<form class="composer" id="composer" data-key="${key}" data-channel="${route.channel}">
      <div class="composer-top">
        <span class="composer-where">새 글 <span class="dim">·</span> <b>#${route.channel}</b></span>
        <div class="seg" role="group" aria-label="보기">
          <button type="button" data-action="compose-mode" data-mode="write" aria-pressed="true">작성</button>
          <button type="button" data-action="compose-mode" data-mode="preview" aria-pressed="false">미리보기</button>
        </div>
        <button type="button" class="icon-btn" data-action="close-compose" aria-label="닫기" title="닫기">${svg('close', 16)}</button>
      </div>
      <textarea id="compose-text" rows="5" placeholder="${'# 제목으로 시작하면 글 제목이 돼요\n\nMarkdown으로 쓸 수 있어요.'}"></textarea>
      <div class="md composer-preview" id="compose-preview" hidden></div>
      <div class="composer-bottom">
        <label class="composer-labels">${svg('filter', 14)}
          <input id="compose-labels" placeholder="라벨 · project=…, priority=1" autocomplete="off" spellcheck="false">
        </label>
        <span class="hint"><kbd>⌘</kbd><kbd>↵</kbd></span>
        <button type="submit" class="btn btn-primary">게시</button>
      </div>
    </form>`;
    const text = $('#compose-text');
    text.value = drafts.get(key);
    $('#compose-labels').value = drafts.get(`${key}:labels`);
    autosize(text);
  }
  $('#compose-text').focus();
}

function closeComposer() {
  const slot = $('#composer-slot');
  if (slot) slot.innerHTML = '';
}

function parseLabels(text) {
  const labels = {};
  for (const part of text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^([a-z0-9][a-z0-9_.-]*)\s*[=:]\s*(.+)$/i.exec(part);
    if (!match) throw new Error(`라벨은 key=value 꼴로 써 주세요: ${part}`);
    labels[match[1].toLowerCase()] = match[2].trim();
  }
  return labels;
}

async function submitComposer(form) {
  const text = $('#compose-text', form).value.trim();
  if (!text) return $('#compose-text', form).focus();
  let labels;
  try {
    labels = parseLabels($('#compose-labels', form).value);
  } catch (error) {
    return toast(error.message, 'error');
  }
  busy(form, true);
  try {
    const { message } = await api.post({ channel: form.dataset.channel, text, ...(Object.keys(labels).length ? { labels } : {}) });
    drafts.set(form.dataset.key, '');
    drafts.set(`${form.dataset.key}:labels`, '');
    closeComposer();
    toast('게시했어요');
    loadList({ quiet: true });
    if (message?.id) navigate(href({ thread: message.id }));
  } catch (error) {
    busy(form, false);
    toast(error.message, 'error');
  }
}

/* ---------- reader ---------- */

let threadAbort = null;
function openThread(id) {
  state.editing = null;
  state.taskForm = null;
  threadAbort?.abort();
  if (!id) {
    state.thread = { id: null, data: null, loading: false, error: null };
    view.reader.innerHTML = '';
    return;
  }
  const summary = state.list.items.find((item) => item.message.id === id);
  state.thread = { id, data: summary ? { message: summary.message, replies: [], partial: true } : null, loading: true, error: null };
  renderReader();
  loadThread();
}

async function loadThread({ quiet = false, toEnd = false } = {}) {
  const id = state.thread.id;
  if (!id) return;
  threadAbort?.abort();
  const controller = threadAbort = new AbortController();
  try {
    const data = await api.thread(id, controller.signal);
    if (state.thread.id !== id) return;
    state.thread = { id, data, loading: false, error: null };
  } catch (error) {
    if (error.name === 'AbortError' || state.thread.id !== id) return;
    state.thread = { ...state.thread, loading: false, error };
    if (quiet) return toast(error.message, 'error');
  }
  if ((state.editing || state.taskForm) && quiet) {
    state.deferred = true;
    return;
  }
  renderReaderBody({ quiet, toEnd });
  updateTitle();
}

function renderReader() {
  const id = state.thread.id;
  view.reader.innerHTML = html`
    <header class="reader-head">
      <button type="button" class="icon-btn back" data-action="close-thread" aria-label="목록으로">${svg('back', 18)}</button>
      <a class="crumb" id="reader-crumb" href="#" data-link></a>
      <span class="grow"></span>
      <button type="button" class="icon-btn" data-action="copy-thread" aria-label="링크 복사" title="링크 복사">${svg('link', 16)}</button>
      <button type="button" class="icon-btn close" data-action="close-thread" aria-label="닫기" title="닫기 (esc)">${svg('close', 18)}</button>
    </header>
    <div class="reader-scroll" id="reader-scroll"><div class="reader-inner" id="reader-body"></div></div>
    <form class="reply" id="reply-form" data-key="${`reply:${id}`}">
      <div class="reply-box">
        <textarea id="reply-text" rows="1" placeholder="답글 남기기…" aria-label="답글"></textarea>
        <button type="submit" class="send" aria-label="보내기" title="보내기 (⌘↵)" disabled>${svg('send', 16)}</button>
      </div>
    </form>`;
  const reply = $('#reply-text');
  reply.value = drafts.get(`reply:${id}`);
  $('#reply-form .send').disabled = !reply.value.trim();
  autosize(reply);
  renderReaderBody();
}

function renderReaderBody({ quiet = false, toEnd = false } = {}) {
  const body = $('#reader-body');
  const scroller = $('#reader-scroll');
  if (!body || !scroller) return;
  const { data, loading, error } = state.thread;
  const top = scroller.scrollTop;
  const nearEnd = scroller.scrollHeight - top - scroller.clientHeight < 120;

  if (!data) {
    body.innerHTML = loading
      ? html`<div class="doc is-skeleton"><i></i><i></i><i></i><i></i></div>`
      : html`<div class="empty is-error"><h2>스레드를 열 수 없어요</h2><p>${error?.message ?? ''}</p>
          <button type="button" class="btn" data-action="close-thread">목록으로</button></div>`;
  } else {
    const { message, replies } = data;
    body.innerHTML = html`${doc(message)}
      <section class="replies" aria-label="답글">
        <div class="replies-head"><span>${replies.length ? `답글 ${replies.length}` : loading ? '' : '아직 답글이 없어요'}</span></div>
        ${replies.map((reply, i) => replyItem(reply, replies[i - 1]))}
      </section>`;
    const crumb = $('#reader-crumb');
    crumb.href = channelHref(message.channel);
    crumb.innerHTML = html`<span class="hash">#</span>${message.channel}`;
  }
  hydrateFiles(body);
  scroller.scrollTop = toEnd || (quiet && nearEnd && top > 0) ? scroller.scrollHeight : quiet ? top : 0;
  const target = !quiet && location.hash.startsWith('#m-') && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (target) {
    target.classList.add('is-target');
    target.scrollIntoView({ block: 'center' });
  }
}

function doc(message) {
  const { title, body } = splitTitle(message.text);
  const labels = labelEntries(message.labels);
  const task = message.task;
  return html`<article class="doc" id="${`m-${message.id}`}">
    ${labels.length || task ? html`<div class="doc-labels">${taskBadge(task)}${labels.map(chip)}</div>` : ''}
    ${title && state.editing !== message.id ? html`<h1 class="doc-title">${shownTitle(title, message.task)}</h1>` : ''}
    <div class="byline">
      ${avatar(message.author, 32)}
      <div class="byline-text">
        <div class="byline-name"><strong>${nameOf(message.author)}</strong>${agentMark(message.author)}${message.author?.via?.name ? html`<span class="dim">via ${message.author.via.name}</span>` : ''}</div>
        <div class="dim">${time(message.createdAt, true)}${message.editedAt ? ' · 수정됨' : ''}</div>
      </div>
      ${message.deleted ? '' : tools(message)}
    </div>
    ${state.editing === message.id ? editor(message)
      : message.deleted ? html`<p class="deleted">삭제된 메시지예요.</p>`
      : html`<div class="md doc-body">${raw(renderMarkdown(body))}</div>`}
    ${files(message)}
    ${task || state.taskForm?.id === message.id ? taskPanel(message) : ''}
    ${message.deleted ? '' : reactions(message, false)}
  </article>`;
}

function taskPanel(message) {
  const task = message.task;
  const form = state.taskForm?.id === message.id ? state.taskForm.mode : null;
  const owner = Boolean(task) && (task.owner === state.me?.principal || can('manage', message.channel));
  const open = Boolean(task) && !['completed', 'canceled'].includes(task.state);
  const lines = task ? [
    task.result && ['결과', task.result],
    task.reason && [task.state === 'failed' ? '실패 이유' : '취소 이유', task.reason],
    task.blocked && ['막힌 이유', task.blocked.reason],
    task.claim && ['진행', `${actorName(task.claim.actor)} · ${fullDate.format(new Date(task.claim.until))}까지`],
    task.for && ['담당', actorName(task.for)],
    task.needs?.length && ['선행 작업', html`<ul class="needs">${task.needs.map(need)}</ul>`],
  ].filter(Boolean) : [];
  const actions = form ? [] : [
    task?.state === 'ready' && can('label', message.channel) && ['task-complete', '완료로 표시', true],
    task?.state === 'blocked' && owner && ['task-unblock', '막힘 풀기'],
    task?.state === 'failed' && owner && ['task-reopen', '다시 열기'],
    open && owner && ['task-cancel', '작업 취소'],
  ].filter(Boolean);
  return html`<section class="task-panel" data-state="${task?.state ?? 'new'}" aria-label="작업">
    <div class="task-head">
      ${task ? taskBadge(task) : ''}
      <span class="task-title">${task ? `${actorName(task.owner)}의 작업` : '작업으로 만들고 바로 완료해요'}</span>
      <span class="grow"></span>
      ${actions.map(([action, label, primary]) => html`<button type="button" class="btn sm${primary ? ' btn-primary' : ''}" data-action="${action}" data-id="${message.id}">${primary ? svg('check', 14) : ''}${label}</button>`)}
    </div>
    ${lines.length ? html`<dl class="task-lines">${lines.map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>` : ''}
    ${form ? html`<form class="task-form" id="task-form" data-id="${message.id}" data-mode="${form}">
      <input id="task-text" autocomplete="off" spellcheck="false"${attr('required', form === 'cancel')}
        placeholder="${form === 'complete' ? '결과 한 줄 (선택)' : '취소하는 이유'}" aria-label="${form === 'complete' ? '결과' : '취소 이유'}">
      <div class="task-form-row">
        <span class="task-note">${form === 'complete' ? '완료한 작업은 다시 열 수 없어요.' : '취소한 작업은 다시 열 수 없어요.'}</span>
        <button type="button" class="btn sm" data-action="task-form-close">닫기</button>
        <button type="submit" class="btn sm btn-primary">${form === 'complete' ? '완료로 표시' : '작업 취소'}</button>
      </div>
    </form>` : ''}
  </section>`;
}

function openTaskForm(id, mode) {
  state.taskForm = { id, mode };
  renderReaderBody({ quiet: true });
  const input = $('#task-text');
  input?.scrollIntoView({ block: 'nearest' });
  input?.focus({ preventScroll: true });
}

function closeTaskForm() {
  state.taskForm = null;
  settle();
}

/** After an inline form closes: what live updates held back, or the same view without the form. */
function settle() {
  if (!state.deferred) return renderReaderBody({ quiet: true });
  state.deferred = false;
  loadThread({ quiet: true });
}

const taskError = (error) => (error.status === 409 ? `그사이 작업 상태가 바뀌었어요: ${error.message}` : error.message);

async function taskAction(id, run, done) {
  try {
    await run();
    state.taskForm = null;
    state.deferred = false;
    toast(done);
    await loadThread({ quiet: true });
    refreshList();
  } catch (error) {
    toast(taskError(error), 'error');
  }
}

/** Completing needs a claim: take one (making the thread a task first if it isn't), then finish with it. */
async function completeTask(message, result) {
  const { claim } = message.task ? await api.claimTask(message.id) : await api.createTask({ re: message.id, claim: true });
  if (!claim) throw new Error('작업은 만들었지만 지금은 맡을 수 없어요. 상태를 확인해 주세요.');
  try {
    await api.completeTask(message.id, claim, result);
  } catch (error) {
    await api.releaseTask(message.id, claim).catch(() => {});
    throw error;
  }
}

async function submitTaskForm(form) {
  const message = findMessage(form.dataset.id);
  const input = $('#task-text', form);
  const text = input.value.trim();
  const cancel = form.dataset.mode === 'cancel';
  if (!message) return;
  if (cancel && !text) return input.focus();
  busy(form, true);
  await taskAction(message.id, () => (cancel ? api.cancelTask(message.id, text) : completeTask(message, text)),
    cancel ? '작업을 취소했어요' : '완료로 표시했어요');
  if (form.isConnected) busy(form, false);
}

function replyItem(message, previous) {
  const grouped = previous && !previous.deleted && !message.deleted && previous.author?.id === message.author?.id &&
    new Date(message.createdAt) - new Date(previous.createdAt) < 5 * 60 * 1000;
  return html`<div class="msg${grouped ? ' is-grouped' : ''}" id="${`m-${message.id}`}">
    <div class="msg-gutter">${grouped ? html`<span class="msg-clock">${clock.format(new Date(message.createdAt))}</span>` : avatar(message.author, 28)}</div>
    <div class="msg-main">
      ${grouped ? '' : html`<div class="msg-head"><strong>${nameOf(message.author)}</strong>${agentMark(message.author)}${time(message.createdAt)}${message.editedAt ? html`<span class="dim">수정됨</span>` : ''}</div>`}
      ${state.editing === message.id ? editor(message)
        : message.deleted ? html`<p class="deleted">삭제된 메시지예요.</p>`
        : html`<div class="md">${raw(renderMarkdown(message.text))}</div>`}
      ${files(message)}
      ${message.deleted ? '' : reactions(message, false)}
    </div>
    ${message.deleted ? '' : tools(message)}
  </div>`;
}

const findMessage = (id) => {
  const data = state.thread.data;
  return data && [data.message, ...data.replies].find((message) => message.id === id);
};

async function submitReply(form) {
  const text = $('#reply-text', form).value.trim();
  const root = state.thread.data?.message;
  if (!text || !root) return;
  busy(form, true);
  try {
    await api.post({ re: root.id, text });
    drafts.set(form.dataset.key, '');
    const input = $('#reply-text', form);
    input.value = '';
    autosize(input);
    await loadThread({ quiet: true, toEnd: true });
    refreshList();
  } catch (error) {
    toast(error.message, 'error');
  }
  busy(form, false);
  $('#reply-form .send').disabled = !$('#reply-text').value.trim();
  $('#reply-text')?.focus();
}

function startEdit(id) {
  state.editing = id;
  renderReaderBody({ quiet: true });
  const text = $('#edit-text');
  if (!text) return;
  autosize(text);
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

function stopEdit() {
  state.editing = null;
  settle();
}

async function submitEdit(form) {
  const message = findMessage(form.dataset.id);
  const text = $('#edit-text', form).value.trim();
  if (!message || !text) return;
  if (text === message.text.trim()) return stopEdit();
  busy(form, true);
  try {
    await api.edit(message.id, text, message.revision);
    state.editing = null;
    state.deferred = false;
    toast('수정했어요');
    await loadThread({ quiet: true });
    refreshList();
  } catch (error) {
    busy(form, false);
    toast(error.status === 409 ? '그사이 다른 곳에서 바뀌었어요. 새로 불러온 뒤 다시 해 주세요.' : error.message, 'error');
  }
}

async function removeMessage(id) {
  const message = findMessage(id);
  if (!message) return;
  try {
    await api.remove(id, message.revision);
    toast('삭제했어요');
    if (message.id === state.thread.data.message.id) navigate(href({ thread: null }));
    else loadThread({ quiet: true });
    refreshList();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function toggleReaction(id, name) {
  const message = findMessage(id);
  const me = state.me?.actor;
  const had = Boolean(message?.reactions?.[name]?.includes(me));
  if (message) {
    const who = new Set(message.reactions?.[name] ?? []);
    if (had) who.delete(me);
    else who.add(me);
    message.reactions = { ...message.reactions, [name]: [...who] };
    if (!who.size) delete message.reactions[name];
    if (!state.editing) renderReaderBody({ quiet: true });
  }
  try {
    await api.react(id, name, had);
    refreshList();
  } catch (error) {
    toast(error.message, 'error');
    loadThread({ quiet: true });
  }
}

/* ---------- attachments ---------- */

const blobs = new Map();
const blob = (id) => {
  if (!blobs.has(id)) blobs.set(id, api.file(id).catch((error) => { blobs.delete(id); throw error; }));
  return blobs.get(id);
};

function hydrateFiles(root) {
  for (const image of $$('img[data-attachment]', root)) {
    blob(image.dataset.attachment).then((url) => { image.src = url; })
      .catch(() => image.closest('.file-image')?.classList.add('is-broken'));
  }
}

async function openFile(button) {
  try {
    const url = await blob(button.dataset.file);
    const link = Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener' });
    if (!button.classList.contains('file-image')) link.download = button.dataset.name;
    link.click();
  } catch (error) {
    toast(`파일을 열지 못했어요: ${error.message}`, 'error');
  }
}

/* ---------- popovers ---------- */

function openPopover(anchor, content, kind) {
  const same = state.popover?.anchor === anchor;
  closePopover();
  if (same) return;
  const pop = document.createElement('div');
  pop.className = `popover popover-${kind}`;
  pop.innerHTML = content;
  document.body.append(pop);
  const box = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.right - pop.offsetWidth), innerWidth - pop.offsetWidth - 8);
  const below = box.bottom + 6 + pop.offsetHeight < innerHeight - 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${below ? box.bottom + 6 : Math.max(8, box.top - pop.offsetHeight - 6)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  state.popover = { el: pop, anchor };
  pop.querySelector('button')?.focus({ preventScroll: true });
}

function closePopover() {
  if (!state.popover) return;
  state.popover.anchor.removeAttribute('aria-expanded');
  state.popover.el.remove();
  state.popover = null;
}

const picker = (id) => html`<div class="emoji-grid">${QUICK.map((name) =>
  html`<button type="button" data-action="emoji" data-id="${id}" data-emoji="${name}" title="${`:${name}:`}">${emoji(name)}</button>`)}</div>`;

function menu(message) {
  return html`<div class="menu" role="menu">
    <button type="button" role="menuitem" data-action="menu-link" data-id="${message.id}">${svg('link', 15)}링크 복사</button>
    <button type="button" role="menuitem" data-action="menu-text" data-id="${message.id}">${svg('copy', 15)}텍스트 복사</button>
    ${message.re === null && !message.task && can('label', message.channel) ? html`<hr>
      <button type="button" role="menuitem" data-action="menu-task-done" data-id="${message.id}">${svg('check', 15)}완료로 표시…</button>
      <button type="button" role="menuitem" data-action="menu-task-make" data-id="${message.id}" title="준비 상태가 되면 작업 큐를 보는 에이전트가 가져갈 수 있어요">${svg('tasks', 15)}<span>작업으로 만들기</span></button>` : ''}
    ${mine(message) ? html`<hr>
      <button type="button" role="menuitem" data-action="menu-edit" data-id="${message.id}">${svg('pencil', 15)}수정</button>
      <button type="button" role="menuitem" class="danger" data-action="menu-delete" data-id="${message.id}">${svg('trash', 15)}<span>삭제</span></button>` : ''}
  </div>`;
}

/* ---------- live ---------- */

async function live() {
  let cursor = null;
  let delay = 1000;
  while (!state.stale) {
    try {
      const page = await api.events(cursor ? { after: cursor, wait: 25 } : { wait: 0 });
      if (cursor) handleEvents(page.events);
      cursor = page.cursor;
      delay = 1000;
      setLive('live');
    } catch (error) {
      if (error.status === 403) return markStale();
      setLive('offline');
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30000);
    }
  }
}

function handleEvents(events) {
  let list = false;
  let thread = false;
  let channels = false;
  const unread = state.unread.size;
  let named = false;
  for (const event of events) {
    if (event.actor?.id) state.actors.set(event.actor.id, event.actor);
    if (event.message && refs.has(event.message.id)) {
      remember(event.message);
      named = true;
    }
    const channel = event.message?.channel ?? event.payload?.channel;
    const key = event.message?.thread ?? event.payload?.thread;
    if (event.type === 'channel.created' || (channel && !state.channels.some((item) => item.path === channel))) channels = true;
    if (state.route.view === 'tasks' ? /^(task|message|labels)\./.test(event.type) : channel === state.route.channel) list = true;
    else if (channel && event.type === 'message.posted' && event.actor?.id !== state.me?.actor) state.unread.add(channel);
    if (key && key === state.thread.data?.message.thread) thread = true;
  }
  if (channels) loadChannels();
  else if (state.unread.size !== unread) renderSidebar();
  if (list) refreshList();
  if (thread) loadThread({ quiet: true });
  else if (named) refreshReader();
}

async function loadChannels() {
  try {
    state.channels = (await api.channels()).channels;
    renderSidebar();
  } catch {}
}

function markStale() {
  if (state.stale) return;
  state.stale = true;
  setLive('offline');
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.innerHTML = html`<span>Inspector가 다시 시작됐어요. 새로고침하면 이어서 볼 수 있어요.</span>
    <button type="button" class="btn btn-primary" data-action="reload">새로고침</button>`;
  document.body.append(banner);
}

/* ---------- helpers ---------- */

function toast(text, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast${kind === 'error' ? ' is-error' : ''}`;
  node.textContent = text;
  view.toasts.append(node);
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 240);
  }, kind === 'error' ? 4800 : 2200);
}

async function copy(text, done = '복사했어요') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('클립보드에 복사하지 못했어요', 'error');
  }
}

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, Math.round(innerHeight * 0.5))}px`;
}

function busy(form, on) {
  form.toggleAttribute('aria-busy', on);
  for (const control of form.querySelectorAll('button[type="submit"], textarea, input')) control.disabled = on;
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(document.documentElement.dataset.theme ?? 'auto') + 1) % order.length];
  if (next === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {}
  renderSidebar();
  toast(`테마: ${THEMES[next][0]}`);
}

function toggleLabel(key, value) {
  const label = value ? `${key}=${value}` : key;
  const labels = state.route.labels.includes(label)
    ? state.route.labels.filter((item) => item !== label) : [...state.route.labels, label];
  navigate(href({ labels, thread: state.route.view === 'channel' ? state.route.thread : null }));
}

function step(direction) {
  const items = listOrder();
  if (!items.length) return;
  const index = items.findIndex((summary) => summary.message.id === state.route.thread);
  const next = items[Math.min(items.length - 1, Math.max(0, index < 0 ? 0 : index + direction))];
  if (next) navigate(threadHref(next.message));
}

/* ---------- events ---------- */

const actions = {
  'open-nav': () => document.body.classList.add('nav-open'),
  'close-nav': () => document.body.classList.remove('nav-open'),
  compose: openComposer,
  'close-compose': closeComposer,
  'compose-mode': (button) => {
    const form = button.closest('form');
    const preview = button.dataset.mode === 'preview';
    for (const item of $$('.seg button', form)) item.setAttribute('aria-pressed', String(item === button));
    $('#compose-text', form).hidden = preview;
    const pane = $('#compose-preview', form);
    pane.hidden = !preview;
    if (!preview) return $('#compose-text', form).focus();
    const { title, body } = splitTitle($('#compose-text', form).value);
    pane.innerHTML = title || body.trim()
      ? html`${title ? html`<h1 class="doc-title">${title}</h1>` : ''}<div class="md">${raw(renderMarkdown(body))}</div>`
      : html`<p class="dim">미리 볼 내용이 없어요.</p>`;
  },
  label: (button) => toggleLabel(button.dataset.key, button.dataset.value),
  'clear-search': () => navigate(href({ q: '' })),
  'clear-filters': () => navigate(href({ q: '', labels: [] })),
  more: () => loadList({ more: true }),
  'retry-list': () => loadList(),
  'close-thread': () => navigate(href({ thread: null })),
  'copy-thread': () => copy(location.href, '링크를 복사했어요'),
  pick: (button) => openPopover(button, picker(button.dataset.id), 'emoji'),
  emoji: (button) => {
    closePopover();
    toggleReaction(button.dataset.id, button.dataset.emoji);
  },
  react: (button) => toggleReaction(button.dataset.id, button.dataset.emoji),
  menu: (button) => {
    const message = findMessage(button.dataset.id);
    if (message) openPopover(button, menu(message), 'menu');
  },
  'menu-link': (button) => {
    closePopover();
    const root = state.thread.data.message;
    const url = new URL(href({ thread: root.id }), location.origin);
    if (button.dataset.id !== root.id) url.hash = `m-${button.dataset.id}`;
    copy(url.href, '링크를 복사했어요');
  },
  'menu-text': (button) => {
    closePopover();
    copy(findMessage(button.dataset.id)?.text ?? '');
  },
  'menu-edit': (button) => {
    closePopover();
    startEdit(button.dataset.id);
  },
  'menu-delete': (button) => {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.lastChild.textContent = '한 번 더 누르면 삭제';
      return;
    }
    closePopover();
    removeMessage(button.dataset.id);
  },
  'edit-cancel': stopEdit,
  'toggle-done': () => {
    state.doneCollapsed = !state.doneCollapsed;
    try {
      if (state.doneCollapsed) localStorage.setItem(DONE_KEY, '1');
      else localStorage.removeItem(DONE_KEY);
    } catch {}
    renderList();
  },
  'menu-task-done': (button) => {
    closePopover();
    openTaskForm(button.dataset.id, 'complete');
  },
  'menu-task-make': (button) => {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.lastChild.textContent = '한 번 더: 준비 상태로 만들기';
      return;
    }
    closePopover();
    taskAction(button.dataset.id, () => api.createTask({ re: button.dataset.id }), '작업으로 만들었어요 · 준비 상태');
  },
  'task-complete': (button) => openTaskForm(button.dataset.id, 'complete'),
  'task-cancel': (button) => openTaskForm(button.dataset.id, 'cancel'),
  'task-unblock': (button) => taskAction(button.dataset.id, () => api.unblockTask(button.dataset.id), '막힘을 풀었어요'),
  'task-reopen': (button) => taskAction(button.dataset.id, () => api.reopenTask(button.dataset.id), '다시 열었어요'),
  'task-form-close': closeTaskForm,
  'copy-code': (button) => copy(button.closest('.md-code').querySelector('code').textContent, '코드를 복사했어요'),
  'open-file': openFile,
  theme: cycleTheme,
  'new-channel': () => {
    const slot = $('#new-channel-slot');
    if (slot.firstElementChild) return $('input', slot).focus();
    slot.innerHTML = html`<form class="new-channel" id="new-channel"><span class="hash">#</span>
      <input name="path" placeholder="채널 이름" autocomplete="off" spellcheck="false" aria-label="새 채널 이름"></form>`;
    $('input', slot).focus();
  },
  reload: () => location.reload(),
};

document.addEventListener('click', (event) => {
  if (state.popover && !state.popover.el.contains(event.target) && !state.popover.anchor.contains(event.target)) closePopover();
  const link = event.target.closest('a[data-link]');
  if (link && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    return navigate(link.getAttribute('href'));
  }
  const target = event.target.closest('[data-action]');
  if (target && actions[target.dataset.action] && !target.disabled) {
    event.preventDefault();
    actions[target.dataset.action](target, event);
  }
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.hasAttribute('aria-busy')) return;
  if (form.id === 'composer') submitComposer(form);
  else if (form.id === 'reply-form') submitReply(form);
  else if (form.id === 'editor') submitEdit(form);
  else if (form.id === 'task-form') submitTaskForm(form);
  else if (form.id === 'new-channel') createChannel(form);
});

async function createChannel(form) {
  const path = form.elements.path.value.trim().replace(/^#/, '');
  if (!path) return;
  busy(form, true);
  try {
    await api.createChannel(path);
    await loadChannels();
    navigate(channelHref(path));
  } catch (error) {
    busy(form, false);
    toast(error.message, 'error');
  }
}

let searchTimer = 0;
document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.tagName === 'TEXTAREA') autosize(target);
  if (target.id === 'search') {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => navigate(href({ q: target.value.trim() }), true), 280);
  } else if (target.id === 'compose-text' || target.id === 'compose-labels') {
    const key = target.form.dataset.key;
    drafts.set(target.id === 'compose-text' ? key : `${key}:labels`, target.value);
  } else if (target.id === 'reply-text') {
    drafts.set(target.form.dataset.key, target.value);
    $('#reply-form .send').disabled = !target.value.trim();
  }
});

document.addEventListener('keydown', (event) => {
  const typing = event.target.closest?.('input, textarea, [contenteditable="true"]');
  const command = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape') {
    if (state.popover) return closePopover();
    if (typing?.id === 'edit-text') return stopEdit();
    if (typing?.id === 'task-text') return closeTaskForm();
    if (typing?.closest('#new-channel')) return void ($('#new-channel-slot').innerHTML = '');
    if (typing) return typing.blur();
    if (document.body.classList.contains('nav-open')) return document.body.classList.remove('nav-open');
    if (state.route?.thread) return navigate(href({ thread: null }));
    return;
  }
  if (command && event.key === 'Enter' && typing?.form) {
    event.preventDefault();
    return typing.form.requestSubmit();
  }
  if (command && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    return $('#search')?.focus();
  }
  if (typing || command || event.altKey || !state.route) return;
  const keys = {
    '/': () => $('#search')?.focus(),
    n: openComposer,
    j: () => step(1),
    k: () => step(-1),
    r: () => $('#reply-text')?.focus(),
  };
  if (keys[event.key]) {
    event.preventDefault();
    keys[event.key]();
  }
});

addEventListener('popstate', onRoute);
addEventListener('resize', closePopover);
document.addEventListener('scroll', closePopover, true);
setInterval(() => {
  for (const node of $$('time[data-ago]')) node.textContent = ago(node.dateTime);
}, 60 * 1000);

/* ---------- boot ---------- */

function renderOffline(error) {
  const port = $('meta[name="board-inspector"]')?.content ?? '4748';
  view.app.dataset.state = 'offline';
  view.app.innerHTML = html`<div class="offline">
    <span class="brand-mark is-large">${svg('spark', 22)}</span>
    <h1>Inspector에 연결할 수 없어요</h1>
    <p>Board Web은 127.0.0.1:${port}의 Inspector를 거쳐 보드를 읽고 씁니다. 다른 터미널에서 Inspector를 켠 뒤 다시 시도해 주세요.</p>
    <div class="md-code"><button type="button" class="md-copy" data-action="copy-code">복사</button><pre><code>board inspect --port ${port} --no-open</code></pre></div>
    ${error ? html`<p class="dim">${error.message}</p>` : ''}
    <button type="button" class="btn btn-primary" data-action="reload">다시 시도</button>
  </div>`;
}

async function boot() {
  if (!online) return renderOffline();
  try {
    const [board, me, channels, actors] = await Promise.all([api.board(), api.me(), api.channels(), api.actors().catch(() => ({ actors: [] }))]);
    state.board = board;
    state.me = me;
    state.channels = channels.channels;
    for (const actor of actors.actors) state.actors.set(actor.id, actor);
    if (!state.actors.has(me.actor)) state.actors.set(me.actor, { id: me.actor, kind: me.kind, handle: me.handle, name: me.name, avatar: me.avatar });
  } catch (error) {
    return renderOffline(error);
  }
  setMentionNames((id) => state.actors.get(id)?.name ?? id.split(':').pop());
  onRoute();
  live();
}

boot();
