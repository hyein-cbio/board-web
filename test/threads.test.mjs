import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listSections } from '../ui/threads.js';

const thread = (id, state, labels) => ({ message: { id, ...(state && { task: { state } }), labels } });
const failed = thread('failed', 'failed');
const completed = thread('completed', 'completed');
const plain = thread('plain');
const settled = thread('settled', null, { settled: 'true' });
const settledFailure = thread('settled-failure', 'failed', { settled: 'true' });
const settledCompleted = thread('settled-completed', 'completed', { settled: 'true' });
const notSettled = thread('not-settled', 'canceled', { settled: 'false' });

test('channel threads group by completed state or the Settled tag, not failed state', () => {
  const items = [failed, settled, plain, settledFailure, completed, notSettled, settledCompleted];
  assert.deepEqual(listSections(items, { view: 'channel' }), {
    regular: [failed, plain, notSettled],
    done: [settled, settledFailure, completed, settledCompleted],
  });
});

test('the all tasks tab groups threads, while state-specific tabs do not', () => {
  assert.deepEqual(listSections([completed, failed, settledFailure], { view: 'tasks', state: 'all' }), {
    regular: [failed], done: [completed, settledFailure],
  });
  assert.deepEqual(listSections([failed, settledFailure], { view: 'tasks', state: 'failed' }), {
    regular: [failed, settledFailure], done: [],
  });
  assert.deepEqual(listSections([completed, settledCompleted], { view: 'tasks', state: 'completed' }), {
    regular: [completed, settledCompleted], done: [],
  });
});
