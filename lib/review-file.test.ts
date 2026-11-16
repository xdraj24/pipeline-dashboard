import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.PIPELINE_REPO_ROOT = mkdtempSync(path.join(tmpdir(), 'dashboard-review-'));
const { parseReviewTable, reviewFilePath, setPublishFlags } = await import('./review-file.ts');

const review = (rows: string[], header = '| File:Line | Comment |\n|-----------|---------|') => `---\nstatus: draft\n---\n\n# PR #1 Review\n\n${header}\n${rows.join('\n')}\n`;

test('counts rows whose path is not wrapped in backticks', () => {
  const table = parseReviewTable(review(['| frontend/hooks/useAdminsPageOptions.ts:328 | [🔴 Required]: Add a test. |']));
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].path, 'frontend/hooks/useAdminsPageOptions.ts');
  assert.equal(table.rows[0].line, 328);
});

test('counts rows whose path is wrapped in backticks', () => {
  const table = parseReviewTable(review(['| `app/models/user.rb:12` | Missing index. |', '| `app/models/user.rb` | General note. |']));
  assert.deepEqual(table.rows.map((r) => [r.path, r.line]), [['app/models/user.rb', 12], ['app/models/user.rb', null]]);
});

test('ignores tables other than the File:Line one', () => {
  const text = `${review(['| a.ts:1 | x |'])}\n| Other | Table |\n|---|---|\n| foo | bar |\n`;
  assert.equal(parseReviewTable(text).rows.length, 1);
});

test('reports no rows when the review has no File:Line table', () => {
  assert.equal(parseReviewTable('No issues found.').rows.length, 0);
  assert.equal(parseReviewTable('No issues found.').noIssues, true);
});

test('setPublishFlags adds a Publish column to rows without backticks', async () => {
  const file = reviewFilePath(1);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, review(['| a.ts:1 | first |', '| b.ts:2 | second |']));
  const table = await setPublishFlags(1, { 1: true });
  assert.equal(table?.hasPublishColumn, true);
  assert.deepEqual(table?.rows.map((r) => r.publish), [false, true]);
});
