import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrReviewFile } from './artifacts.ts';
import { nextStep } from './review-next.ts';
import type { ReviewPr } from './review-queue.ts';

const pr = (over: Partial<ReviewPr> = {}) => ({ number: 5591, mine: 'commented', pushedSinceMine: false, commentsSinceMine: 0, others: 'none', otherHumans: [], ...over }) as ReviewPr;
const draft = (status: string) => ({ pr: 5591, dir: 'PR-5591', frontmatter: {}, status, title: null, commentCount: 1, publishCount: 1, mtime: null }) as PrReviewFile;

test('published review with new commits suggests the re-review skill', () => {
  const next = nextStep(pr({ pushedSinceMine: true }), draft('published'));
  assert.equal(next.command, '/w-25-re-review-pr 5591');
  assert.equal(next.label, 're-review');
});

test('requested changes without a local draft and new commits suggests the re-review skill', () => {
  assert.equal(nextStep(pr({ mine: 'changes_requested', pushedSinceMine: true }), null).command, '/w-25-re-review-pr 5591');
});

test('published review without new commits keeps waiting', () => {
  const next = nextStep(pr(), draft('published'));
  assert.equal(next.command, null);
  assert.equal(next.label, 'published');
});

test('an unpublished draft takes precedence over new commits', () => {
  assert.equal(nextStep(pr({ pushedSinceMine: true }), draft('draft')).command, '/w-21-review-prs just-verify 5591');
});

test('approved PR with new commits gets a fresh review', () => {
  assert.equal(nextStep(pr({ mine: 'approved', pushedSinceMine: true }), null).command, '/w-21-review-prs 5591');
});
