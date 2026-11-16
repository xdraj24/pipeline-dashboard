import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.TICKET_PREFIX = 'abc';
process.env.ARCHIVE_JIRA_STATUSES = 'Done on PROD, Released ';
delete process.env.JIRA_SPRINT_JQL;
const { TICKET_RE, TICKET_RE_G } = await import('./util.ts');
const { parseProgressLine } = await import('./pipeline.ts');
const { ARCHIVE_JIRA_STATUSES } = await import('./archive.ts');
const { SPRINT_JQL } = await import('./jira.ts');

test('ticket patterns follow TICKET_PREFIX', () => {
  assert.equal('feature/ABC-12-x'.match(TICKET_RE)?.[0], 'ABC-12');
  assert.equal(TICKET_RE.test('feature/XWWP-12-x'), false);
  assert.deepEqual('abc-1 and ABC-2'.match(TICKET_RE_G), ['abc-1', 'ABC-2']);
});

test('progress lines use the configured prefix', () => {
  assert.equal(parseProgressLine('[abc-7] plan: done')?.ticket, 'ABC-7');
  assert.equal(parseProgressLine('[XWWP-7] plan: done'), null);
});

test('archive statuses and sprint JQL come from the environment', () => {
  assert.deepEqual(ARCHIVE_JIRA_STATUSES, ['Done on PROD', 'Released']);
  assert.match(SPRINT_JQL, /^project = ABC AND /);
});
