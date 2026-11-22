const token = document.querySelector('meta[name="board-token"]')?.content ?? '';

export const online = token !== '';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(method, path, { query, body, signal } = {}) {
  const url = new URL(`/board${path}`, location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of [value].flat()) if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, item);
  }
  const headers = { 'x-inspect-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = response.headers.get('content-type')?.includes('json');
  const data = json ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.code ?? 'http', data?.error?.message ?? (String(data).trim() || response.statusText));
  }
  return data;
}

const id = encodeURIComponent;

export const api = {
  board: () => call('GET', '/'),
  me: () => call('GET', '/me'),
  channels: () => call('GET', '/channels', { query: { limit: 500 } }),
  actors: () => call('GET', '/actors'),
  createChannel: (path) => call('POST', '/channels', { body: { path } }),
  threads: (query, signal) => call('GET', '/threads', { query: { limit: 50, ...query }, signal }),
  thread: (root, signal) => call('GET', `/messages/${id(root)}`, { query: { limit: 500 }, signal }),
  message: (root) => call('GET', `/messages/${id(root)}`, { query: { limit: 1 } }),
  tasks: (query, signal) => call('GET', '/tasks', { query, signal }),
  post: (body) => call('POST', '/messages', { body }),
  edit: (message, text, revision) => call('POST', `/messages/${id(message)}/edit`, { body: { text, revision } }),
  remove: (message, revision) => call('POST', `/messages/${id(message)}/delete`, { body: { revision } }),
  react: (message, emoji, remove = false) =>
    call('POST', `/messages/${id(message)}/reactions`, { body: remove ? { emoji, remove } : { emoji } }),
  events: (query, signal) => call('GET', '/events', { query, signal }),
  createTask: (body) => call('POST', '/tasks', { body }),
  claimTask: (task) => call('POST', `/tasks/${id(task)}/claim`, { body: {} }),
  completeTask: (task, { epoch, token }, result) =>
    call('POST', `/tasks/${id(task)}/complete`, { body: result ? { epoch, token, result } : { epoch, token } }),
  releaseTask: (task, { epoch, token }) => call('POST', `/tasks/${id(task)}/release`, { body: { epoch, token } }),
  cancelTask: (task, reason) => call('POST', `/tasks/${id(task)}/cancel`, { body: { reason } }),
  reopenTask: (task) => call('POST', `/tasks/${id(task)}/reopen`),
  unblockTask: (task) => call('POST', `/tasks/${id(task)}/unblock`),
  async file(attachment) {
    const response = await fetch(`/board/attachments/${id(attachment)}`, { headers: { 'x-inspect-token': token } });
    if (!response.ok) throw new ApiError(response.status, 'http', response.statusText);
    return URL.createObjectURL(await response.blob());
  },
};
