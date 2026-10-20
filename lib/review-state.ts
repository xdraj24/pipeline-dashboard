import { readPrReviews, type PrReviewFile } from './artifacts.ts';
import { ghStatus, repoSlug, viewerLogin } from './github.ts';
import { listLaunches, type Launch } from './launch.ts';
import { approvedByMe, openPrsForReview, SMALL_MAX_FILES, SMALL_MAX_LINES, type ApprovedPr, type ReviewPr } from './review-queue.ts';
import { readSkillSessions, type SkillSession } from './sessions.ts';
import { jiraConfig, jiraIssueDetail, type JiraConfig, type JiraIssueDetail } from './jira.ts';
import { REPO_ROOT, TICKET_RE, parseFrontmatter, readText, type Cached } from './util.ts';
import path from 'node:path';
import { parseReviewTable, snippet, type ReviewRow, type Snippet } from './review-file.ts';

export type ReviewNext = { command: string | null; label: string; reason: string };
export type ReviewCard = ReviewPr & { bucket: 'queue' | 'mine' | 'others' | 'approved'; draft: PrReviewFile | null; launches: Launch[]; sessions: SkillSession[]; next: ReviewNext };
export type ReviewState = {
  generatedAt: string; repo: Cached<string>; viewer: Cached<string>; gh: Cached<{ ok: boolean; detail: string }>;
  open: { loading: boolean; error: string | null; fetchedAt: string | null; drafts: number; mine: number };
  small: { maxLines: number; maxFiles: number };
  queue: ReviewCard[]; mine: ReviewCard[]; others: ReviewCard[]; sessions: SkillSession[];
  approved: { loading: boolean; error: string | null; fetchedAt: string | null; prs: (ApprovedPr & { draft: PrReviewFile | null })[] };
};

function nextStep(pr: ReviewPr, draft: PrReviewFile | null): ReviewNext {
  const n = pr.number;
  if (draft?.status === 'published') return { command: null, label: 'published', reason: `review published from .pr-reviews/PR-${n} · waiting for the author` };
  if (draft?.status === 'verified') {
    if (draft.publishCount === 0) return { command: null, label: 'tick comments', reason: `verified draft with ${draft.commentCount} comment(s), none ticked for publishing yet` };
    return { command: `/w-23-publish-review ${n}`, label: 'publish', reason: draft.publishCount === null ? `verified draft with ${draft.commentCount} comment(s) ready to post (tick rows in the detail to post a subset)` : `${draft.publishCount} of ${draft.commentCount} ticked comment(s) ready to post` };
  }
  if (draft?.status === 'draft') return { command: `/w-22-verify-review-comments ${n}`, label: 'verify', reason: `draft with ${draft.commentCount} comment(s) from ${draft.frontmatter.review_model ?? 'unknown'} awaits a second model` };
  if (pr.mine !== 'none') {
    if (pr.pushedSinceMine) return { command: `/w-21-review-prs ${n}`, label: 're-review', reason: `new commits since your last review${pr.commentsSinceMine ? ` · ${pr.commentsSinceMine} new comment(s)` : ''}` };
    return { command: null, label: 'waiting', reason: pr.commentsSinceMine ? `${pr.commentsSinceMine} new comment(s) since your review, no new commits` : 'waiting for the author' };
  }
  return { command: `/w-21-review-prs ${n}`, label: 'review', reason: pr.others === 'none' ? 'no human has reviewed this yet' : `reviewed by ${pr.otherHumans.join(', ')}, not by you` };
}

export async function buildReviewState(): Promise<ReviewState> {
  const [files, launches, allSessions] = await Promise.all([readPrReviews(), listLaunches(), readSkillSessions()]);
  const sessions = allSessions.filter((s) => /^w-2\d-/.test(s.skill) && (s.state !== 'finished' || Date.now() - new Date(s.finishedAt!).getTime() < 12 * 3600_000));
  const open = openPrsForReview();
  const approved = approvedByMe();
  const draftFor = (n: number) => files.reviews.find((r) => r.pr === n) ?? null;
  const candidateNumbers = files.candidatesRows.map((row) => Number(row.match(/#(\d+)/)?.[1])).filter(Boolean);
  const covers = (s: SkillSession, n: number) => s.prs.length ? s.prs.includes(n) : s.skill === 'w-21-review-prs' && (candidateNumbers.length ? candidateNumbers.includes(n) : true);
  const cards: ReviewCard[] = (open.value?.prs ?? []).map((pr) => {
    const bucket = pr.mine === 'approved' ? 'approved' : pr.mine !== 'none' ? 'mine' : pr.others === 'none' ? 'queue' : 'others';
    const draft = draftFor(pr.number);
    return { ...pr, bucket, draft, launches: launches.filter((l) => l.pr === pr.number), sessions: sessions.filter((s) => covers(s, pr.number)), next: nextStep(pr, draft) };
  });
  const byUpdated = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);
  const approvedOpen = cards.filter((c) => c.bucket === 'approved');
  const approvedAll: ReviewState['approved']['prs'] = [
    ...approvedOpen.map((c) => ({ number: c.number, url: c.url, title: c.title, author: c.author, state: 'OPEN' as const, headRefName: c.headRefName, updatedAt: c.updatedAt, mergedAt: null, closedAt: null, ticket: c.ticket, draft: c.draft })),
    ...(approved.value ?? []).filter((p) => !approvedOpen.some((c) => c.number === p.number)).map((p) => ({ ...p, draft: draftFor(p.number) })),
  ].sort(byUpdated);
  return {
    generatedAt: new Date().toISOString(), repo: repoSlug(), viewer: viewerLogin(), gh: ghStatus(),
    open: { loading: open.loading, error: open.error, fetchedAt: open.fetchedAt, drafts: open.value?.drafts ?? 0, mine: open.value?.mine ?? 0 },
    small: { maxLines: SMALL_MAX_LINES, maxFiles: SMALL_MAX_FILES },
    queue: cards.filter((c) => c.bucket === 'queue').sort(byUpdated),
    mine: cards.filter((c) => c.bucket === 'mine').sort(byUpdated),
    others: cards.filter((c) => c.bucket === 'others').sort(byUpdated), sessions,
    approved: { loading: approved.loading, error: approved.error, fetchedAt: approved.fetchedAt, prs: approvedAll },
  };
}

export type DetailComment = ReviewRow & { snippet: Cached<Snippet> | null; blobUrl: string | null };
export type ReviewDetail = {
  pr: number; card: ReviewCard | null; approved: ReviewState['approved']['prs'][number] | null; ticket: string | null;
  jira: { config: JiraConfig; issue: Cached<JiraIssueDetail> | null }; file: { path: string; text: string } | null;
  comments: { hasPublishColumn: boolean; noIssues: boolean; rows: DetailComment[] } | null;
};

export function detailComments(text: string | null, slug: string | null, ref: string | null): ReviewDetail['comments'] {
  if (text === null) return null;
  const table = parseReviewTable(text);
  const rows = table.rows.map((r) => ({
    ...r,
    snippet: slug && ref && r.line ? snippet(slug, ref, r.path, r.line) : null,
    blobUrl: slug && ref ? `https://github.com/${slug}/blob/${ref}/${r.path}${r.line ? `#L${r.line}` : ''}` : null,
  }));
  return { hasPublishColumn: table.hasPublishColumn, noIssues: table.noIssues, rows };
}

export async function buildReviewDetail(pr: number): Promise<ReviewDetail> {
  const state = await buildReviewState();
  const card = [...state.queue, ...state.mine, ...state.others].find((c) => c.number === pr) ?? null;
  const approved = state.approved.prs.find((p) => p.number === pr) ?? null;
  const rel = `.pr-reviews/PR-${pr}/review.md`;
  const text = await readText(path.join(REPO_ROOT, rel));
  const fm = text === null ? {} : parseFrontmatter(text).data;
  const fromFile = (fm.jira_ticket ?? fm.branch ?? '').match(TICKET_RE)?.[0] ?? null;
  const ticket = (card?.ticket ?? approved?.ticket ?? fromFile)?.toUpperCase() ?? null;
  const config = await jiraConfig();
  const ref = card?.headRefName ?? approved?.headRefName ?? fm.branch ?? null;
  return {
    pr, card, approved, ticket, jira: { config, issue: config.configured && ticket ? jiraIssueDetail(ticket) : null }, file: text === null ? null : { path: rel, text },
    comments: detailComments(text, state.repo.value, ref),
  };
}
