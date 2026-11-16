import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSession } from './sessions.ts';

const line = (d: object) => JSON.stringify({ timestamp: '2026-11-11T09:00:00.000Z', sessionId: 's1', cwd: '/repo', ...d });
const invoke = line({ type: 'user', message: { content: '<command-name>/w-21-review-prs</command-name><command-args>5660 5664</command-args>' } });
const endTurn = (text: string) => line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const toolUse = line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const result = (toolUseResult: object) => line({ type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] } });
const notify = (id: string, status = 'completed') => line({ type: 'user', message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` } });
const parse = (...lines: string[]) => parseSession('/x/s1.jsonl', lines.join('\n'), new Date());

test('an end_turn with no background work finishes the session', () => {
  const s = parse(invoke, toolUse, result({ stdout: 'ok' }), endTurn('Done.'));
  assert.equal(s?.state, 'finished');
  assert.equal(s?.summary, 'Done.');
  assert.deepEqual(s?.prs, [5660, 5664]);
});

test('an end_turn while a backgrounded command runs keeps the session running', () => {
  const s = parse(invoke, toolUse, result({ backgroundTaskId: 'bjgj2637a' }), endTurn('Waiting for the switch.'));
  assert.equal(s?.state, 'running');
  assert.equal(s?.finishedAt, null);
});

test('an end_turn while an async subagent or workflow runs keeps the session running', () => {
  assert.equal(parse(invoke, toolUse, result({ status: 'async_launched', agentId: 'a1abe' }), endTurn('Spawned.'))?.state, 'running');
  assert.equal(parse(invoke, toolUse, result({ status: 'async_launched', taskId: 'w3ff9' }), endTurn('Spawned.'))?.state, 'running');
});

test('the session finishes once every background task has notified', () => {
  const s = parse(invoke, toolUse, result({ backgroundTaskId: 'b1' }), endTurn('Waiting.'), notify('b1', 'failed'), endTurn('All reviewed.'));
  assert.equal(s?.state, 'finished');
  assert.equal(s?.summary, 'All reviewed.');
});

test('a monitor event without a status does not count as a finished task', () => {
  const event = line({ type: 'user', message: { content: '<task-notification>\n<task-id>b1</task-id>\n<event>tick</event>\n</task-notification>' } });
  assert.equal(parse(invoke, toolUse, result({ backgroundTaskId: 'b1' }), endTurn('Waiting.'), event, endTurn('Still waiting.'))?.state, 'running');
});
