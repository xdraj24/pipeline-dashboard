import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Stage, StageState } from './state.ts';
import { ticketProgress, ticketStatus } from './ticket-status.ts';

const KEYS = ['plan', 'implement', 'code-review', 'commit', 'qa-check', 'land', 'publish', 'pr-review', 'merged'];
const stages = (states: Partial<Record<string, StageState>>): Stage[] => KEYS.map((key) => ({ key, label: key, state: states[key] ?? 'pending', detail: null }));
const upTo = (last: string, state: StageState = 'done') => Object.fromEntries(KEYS.slice(0, KEYS.indexOf(last) + 1).map((k) => [k, state]));

test('progress counts the furthest completed stage', () => {
  assert.equal(ticketProgress(stages({})), 0);
  assert.equal(ticketProgress(stages({ plan: 'done' })), 1);
  assert.equal(ticketProgress(stages(upTo('merged'))), 9);
});

test('progress gives half credit to a reached but unfinished stage', () => {
  assert.equal(ticketProgress(stages({ ...upTo('commit'), 'qa-check': 'warn' })), 4.5);
  assert.equal(ticketProgress(stages({ ...upTo('publish'), 'pr-review': 'active' })), 7.5);
});

test('progress treats skipped stages as passed', () => {
  assert.equal(ticketProgress(stages({ ...upTo('land', 'skipped'), publish: 'done', 'pr-review': 'active' })), 7.5);
});

test('a merged ticket sorts ahead of an approved one, which sorts ahead of local work', () => {
  const merged = ticketProgress(stages(upTo('merged')));
  const approved = ticketProgress(stages(upTo('pr-review')));
  const local = ticketProgress(stages({ ...upTo('code-review'), commit: 'active' }));
  assert.ok(merged > approved && approved > local);
});

test('status follows the PR lifecycle', () => {
  assert.equal(ticketStatus(stages(upTo('merged'))), 'merged');
  assert.equal(ticketStatus(stages(upTo('pr-review'))), 'approved');
  assert.equal(ticketStatus(stages({ ...upTo('publish'), 'pr-review': 'active' })), 'review');
  assert.equal(ticketStatus(stages({ ...upTo('publish'), 'pr-review': 'warn' })), 'attention');
  assert.equal(ticketStatus(stages({ ...upTo('publish'), 'pr-review': 'failed' })), 'blocked');
});

test('status reports local work and untouched tickets', () => {
  assert.equal(ticketStatus(stages({ plan: 'done' })), 'progress');
  assert.equal(ticketStatus(stages({ plan: 'active' })), 'progress');
  assert.equal(ticketStatus(stages({ ...upTo('commit'), 'qa-check': 'warn' })), 'attention');
  assert.equal(ticketStatus(stages({ ...upTo('code-review'), commit: 'failed' })), 'blocked');
  assert.equal(ticketStatus(stages({})), 'todo');
});

test('a PR closed without merging is blocked', () => {
  assert.equal(ticketStatus(stages({ ...upTo('publish'), merged: 'failed' })), 'blocked');
});
