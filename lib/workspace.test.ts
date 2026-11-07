import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'dashboard-ws-'));
process.env.PIPELINE_REPO_ROOT = root;
const ws = path.join(root, '.ai-workspace');
const put = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), text);
};

put('jira-plans/XWWP-101/plan.md', '---\nticket: XWWP-101\n---\n# Plan\n\n## Manual checks\n- Export the report: footer not clipped\n- Screen view wraps\n\n## Risks\n- none\n');
put('jira-plans/XWWP-103/plan.md', '---\nticket: XWWP-103\n---\n# Stale plan\n');
put('worktrees/XWWP-103/.ai-workspace/jira-plans/XWWP-103/plan.md', '---\nticket: XWWP-103\n---\n# Live plan\n');
put('worktrees/XWWP-103/.ai-workspace/jira-plans/XWWP-103/code-review.md', '- Final: STATUS: GREEN\n- Reviewer: opus (general-purpose subagent); fixer: not used\n');
put('pipeline-slots/1/ticket', 'XWWP-101\n');
put('pipeline-slots/1/started_at', '2026-10-20T10:00:00Z\n');
put('pipeline-logs/20261020T100000Z/progress.log', '[XWWP-101] plan: done\n');
put('pipeline-logs/20261020T100000Z/XWWP-101.log', '');
put('pipeline-logs/20261021T100000Z/XWWP-102.status', '0\n');
symlinkSync(path.join(root, 'pruned-worktree', 'progress.log'), path.join(ws, 'pipeline-logs/20261021T100000Z/XWWP-102.log'));
put('pr-reviews/PR-42/review.md', '---\nstatus: draft\npr_number: 42\n---\n# Review\n');
mkdirSync(path.join(root, '.jira-plans', 'XWWP-999'), { recursive: true });

const { WORKSPACE_DIR } = await import('./util.ts');
const { listPlannedTickets, readPrReviews, readTicketArtifacts } = await import('./artifacts.ts');
const { readRuns, readSlots } = await import('./pipeline.ts');

test('workspace dir sits under the web checkout', () => {
  assert.equal(WORKSPACE_DIR, ws);
});

test('plans are read from .ai-workspace/jira-plans only', async () => {
  assert.deepEqual(await listPlannedTickets(), ['XWWP-101', 'XWWP-103']);
  assert.equal((await readTicketArtifacts('XWWP-101')).plan?.path, path.join(ws, 'jira-plans', 'XWWP-101', 'plan.md'));
});

test('a running ticket\'s artifacts are read from its worktree first', async () => {
  const a = await readTicketArtifacts('XWWP-103');
  const live = path.join(ws, 'worktrees', 'XWWP-103', '.ai-workspace', 'jira-plans', 'XWWP-103');
  assert.equal(a.plan?.path, path.join(live, 'plan.md'));
  assert.deepEqual([a.codeReview?.models.reviewer, a.codeReview?.models.fixer], ['opus', 'not used']);
});

test('slots and runs are read from .ai-workspace', async () => {
  assert.deepEqual((await readSlots()).map((s) => [s.slot, s.ticket]), [[1, 'XWWP-101']]);
  const runs = await readRuns();
  assert.equal(runs[1].id, '20261020T100000Z');
  assert.equal(runs[1].tickets[0].ticket, 'XWWP-101');
});

test('a run whose log symlink points into a pruned worktree still lists the ticket', async () => {
  const [run] = await readRuns();
  assert.equal(run.id, '20261021T100000Z');
  assert.deepEqual(run.tickets.map((t) => [t.ticket, t.exitCode]), [['XWWP-102', 0]]);
});

test('pr reviews are read from .ai-workspace/pr-reviews', async () => {
  const { reviews } = await readPrReviews();
  assert.deepEqual(reviews.map((r) => [r.pr, r.status]), [[42, 'draft']]);
});

test('manual checks are read from the plan', async () => {
  assert.deepEqual((await readTicketArtifacts('XWWP-101')).plan?.manualChecks, ['Export the report: footer not clipped', 'Screen view wraps']);
});
