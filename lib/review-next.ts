import type { PrReviewFile } from './artifacts.ts';
import type { ReviewPr } from './review-queue.ts';

export type ReviewNext = { command: string | null; label: string; reason: string };

export function nextStep(pr: ReviewPr, draft: PrReviewFile | null): ReviewNext {
  const n = pr.number;
  const awaitingMyReReview = (pr.mine === 'commented' || pr.mine === 'changes_requested') && pr.pushedSinceMine;
  if (awaitingMyReReview && (!draft || draft.status === 'published')) return { command: `/w-25-re-review-pr ${n}`, label: 're-review', reason: `new commits since your last review${pr.commentsSinceMine ? ` · ${pr.commentsSinceMine} new comment(s)` : ''}` };
  if (draft?.status === 'published') return { command: null, label: 'published', reason: `review published from .pr-reviews/PR-${n} · waiting for the author` };
  if (draft?.status === 'verified') {
    if (draft.publishCount === 0) return { command: null, label: 'tick comments', reason: `verified draft with ${draft.commentCount} comment(s), none ticked for publishing yet` };
    return { command: `/w-23-publish-review ${n}`, label: 'publish', reason: draft.publishCount === null ? `verified draft with ${draft.commentCount} comment(s) ready to post (tick rows in the detail to post a subset)` : `${draft.publishCount} of ${draft.commentCount} ticked comment(s) ready to post` };
  }
  if (draft?.status === 'draft') return { command: `/w-21-review-prs just-verify ${n}`, label: 'verify', reason: `draft with ${draft.commentCount} comment(s) from ${draft.frontmatter.review_model ?? 'unknown'} awaits a second model` };
  if (pr.mine !== 'none') {
    if (pr.pushedSinceMine) return { command: `/w-21-review-prs ${n}`, label: 're-review', reason: `new commits since your last review${pr.commentsSinceMine ? ` · ${pr.commentsSinceMine} new comment(s)` : ''}` };
    return { command: null, label: 'waiting', reason: pr.commentsSinceMine ? `${pr.commentsSinceMine} new comment(s) since your review, no new commits` : 'waiting for the author' };
  }
  return { command: `/w-21-review-prs ${n}`, label: 'review', reason: pr.others === 'none' ? 'no human has reviewed this yet' : `reviewed by ${pr.otherHumans.join(', ')}, not by you` };
}
