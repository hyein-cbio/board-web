export const SETTLED_KEY = 'settled';
export const SETTLED_VALUE = 'true';
export const SETTLED_TEXT = 'Settled';

export const isSettled = (message) => message.labels?.[SETTLED_KEY] === SETTLED_VALUE;

export function listSections(items, route) {
  if (route.view !== 'channel' && !(route.view === 'tasks' && route.state === 'all')) return { regular: items, done: [] };
  const regular = [];
  const done = [];
  for (const summary of items) {
    const { message } = summary;
    (message.task?.state === 'completed' || isSettled(message) ? done : regular).push(summary);
  }
  return { regular, done };
}
