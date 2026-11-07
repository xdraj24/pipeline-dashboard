import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStackDeployed } from './pipeline.ts';
import { qaTestUrl, settleRunningStages, type Stage, type StageState } from './state.ts';

const KEYS = ['plan', 'implement', 'code-review', 'commit', 'qa-check', 'land', 'publish', 'pr-review', 'merged'];
const settled = (states: Partial<Record<string, StageState>>, runLive = false): Stage[] => {
  const stages: Stage[] = KEYS.map((key) => ({ key, label: key, state: states[key] ?? 'pending', detail: null }));
  settleRunningStages(stages, runLive);
  return stages;
};
const implAfter = (states: Partial<Record<string, StageState>>) => settled(states)[1].state;
const landAfter = (states: Partial<Record<string, StageState>>) => settled(states)[5].state;

test('implement stays pending until a later stage starts', () => {
  assert.equal(implAfter({ plan: 'done' }), 'pending');
  assert.equal(implAfter({ plan: 'done', implement: 'warn' }), 'warn');
});

test('implement pulses while the review loop may be sending fixes back', () => {
  assert.equal(implAfter({ plan: 'done', 'code-review': 'active' }), 'active');
});

test('implement is done once commit or later has started', () => {
  assert.equal(implAfter({ plan: 'done', 'code-review': 'done', commit: 'active' }), 'done');
  assert.equal(implAfter({ plan: 'done', implement: 'warn', 'code-review': 'warn' }), 'done');
});

test('implement keeps a failure or its own active run', () => {
  assert.equal(implAfter({ implement: 'failed', 'code-review': 'active' }), 'failed');
  assert.equal(implAfter({ implement: 'active', 'code-review': 'done' }), 'active');
});

test('skipped later stages do not imply implementation', () => {
  assert.equal(implAfter({ 'code-review': 'skipped', commit: 'skipped' }), 'pending');
});

test('land does not ask for attention while QA is still running', () => {
  assert.equal(landAfter({ commit: 'done', 'qa-check': 'active', land: 'warn' }), 'pending');
  assert.equal(landAfter({ commit: 'done', 'qa-check': 'done', land: 'warn' }), 'warn');
  assert.equal(settled({ commit: 'done', land: 'warn' }, true)[5].state, 'pending');
  assert.equal(landAfter({ commit: 'done', land: 'warn' }), 'warn');
});

const BRANCH = 'feature/XWWP-1-x';
const stack = (over: Partial<ReturnType<typeof parseStackDeployed>> = {}) => ({ ...parseStackDeployed(`source: /wt\nbranch: ${BRANCH}\nsha: abc1234def\nat: 2026-11-06T14:03:17Z\n`, null), ...over });
const qaDone = settled({ commit: 'done', 'qa-check': 'done', land: 'warn' });

test('stack-deployed is parsed into branch and sha', () => {
  const s = stack();
  assert.equal(s.branch, BRANCH);
  assert.equal(s.sha, 'abc1234def');
  assert.equal(s.url, 'http://qa.localhost:5100');
});

test('test link appears once QA finished and the stack serves this commit', () => {
  assert.equal(qaTestUrl('XWWP-1', qaDone, BRANCH, 'abc1234de', stack()), 'http://qa.localhost:5100');
});

test('no test link while QA runs, for another branch or commit, or while another ticket holds the stack', () => {
  assert.equal(qaTestUrl('XWWP-1', settled({ commit: 'done', 'qa-check': 'active' }), BRANCH, 'abc1234de', stack()), null);
  assert.equal(qaTestUrl('XWWP-1', qaDone, 'feature/XWWP-2-y', 'abc1234de', stack()), null);
  assert.equal(qaTestUrl('XWWP-1', qaDone, BRANCH, 'fff0000aa', stack()), null);
  assert.equal(qaTestUrl('XWWP-1', qaDone, BRANCH, 'abc1234de', stack({ lockedBy: 'XWWP-2' })), null);
  assert.equal(qaTestUrl('XWWP-1', qaDone, BRANCH, 'abc1234de', null), null);
});
