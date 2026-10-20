import { cached, run, type Cached, TICKET_RE } from './util.ts';
import { repoSlug, viewerLogin } from './github.ts';

export type ReviewArea = 'frontend' | 'backend' | 'mixed' | 'other';
export type Involvement = 'none' | 'commented' | 'changes_requested' | 'approved';
export type ReviewPr = {
  number: number; url: string; title: string; author: string | null; authorIsBot: boolean; headRefName: string; baseRefName: string;
  createdAt: string; updatedAt: string; lastCommitAt: string | null; additions: number; deletions: number; changedFiles: number;
  lines: { fe: number; be: number; other: number }; area: ReviewArea; small: boolean; ticket: string | null;
  checksState: string | null; mergeable: string | null; reviewDecision: string | null;
  mine: Involvement; myLastAt: string | null; commentsSinceMine: number; pushedSinceMine: boolean;
  others: Involvement; otherHumans: string[];
};
export type ApprovedPr = {
  number: number; url: string; title: string; author: string | null; state: 'OPEN' | 'CLOSED' | 'MERGED'; headRefName: string;
  updatedAt: string; mergedAt: string | null; closedAt: string | null; ticket: string | null;
};

export const SMALL_MAX_LINES = 200;
export const SMALL_MAX_FILES = 10;
const TTL = 2 * 60_000;

const isBot = (a: { login?: string | null; __typename?: string } | null | undefined) =>
  !a || a.__typename === 'Bot' || !a.login || /\[bot\]$|-?bot$|^app\//i.test(a.login) || /dependabot|github-actions|copilot|amazon-inspector/i.test(a.login);

const OPEN_QUERY = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:40,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
 pageInfo{hasNextPage endCursor}
 nodes{number url title isDraft author{login __typename} headRefName baseRefName createdAt updatedAt additions deletions changedFiles mergeable reviewDecision
  files(first:100){nodes{path additions deletions}}
  commits(last:1){nodes{commit{committedDate pushedDate statusCheckRollup{state}}}}
  reviews(last:50){nodes{author{login __typename} state submittedAt}}
  comments(last:50){nodes{author{login __typename} createdAt}}
  reviewThreads(first:50){nodes{comments(first:10){nodes{author{login __typename} createdAt}}}}
 }}}}`;

const ticketOf = (...texts: (string | null | undefined)[]): string | null => {
  for (const t of texts) { const m = t?.match(TICKET_RE); if (m) return m[0].toUpperCase(); }
  return null;
};

export function classifyArea(lines: { fe: number; be: number }): ReviewArea {
  const total = lines.fe + lines.be;
  if (!total) return 'other';
  if (lines.fe > 0 && lines.be / total <= 0.1) return 'frontend';
  if (lines.be > 0 && lines.fe / total <= 0.1) return 'backend';
  return 'mixed';
}

type Event = { login: string | null; at: string; state?: string };

function involvement(events: Event[]): Involvement {
  if (!events.length) return 'none';
  const latestReview = [...events].filter((e) => e.state && e.state !== 'COMMENTED' && e.state !== 'DISMISSED').sort((a, b) => b.at.localeCompare(a.at))[0];
  if (latestReview?.state === 'APPROVED') return 'approved';
  if (latestReview?.state === 'CHANGES_REQUESTED') return 'changes_requested';
  return 'commented';
}

function toReviewPr(pr: any, viewer: string): ReviewPr {
  const lines = { fe: 0, be: 0, other: 0 };
  for (const f of pr.files.nodes) {
    const n = f.additions + f.deletions;
    if (f.path.startsWith('frontend/')) lines.fe += n; else if (f.path.startsWith('backend/')) lines.be += n; else lines.other += n;
  }
  const events: Event[] = [
    ...pr.reviews.nodes.filter((r: any) => !isBot(r.author)).map((r: any) => ({ login: r.author?.login ?? null, at: r.submittedAt ?? '', state: r.state })),
    ...pr.comments.nodes.filter((c: any) => !isBot(c.author)).map((c: any) => ({ login: c.author?.login ?? null, at: c.createdAt })),
    ...pr.reviewThreads.nodes.flatMap((t: any) => t.comments.nodes.filter((c: any) => !isBot(c.author)).map((c: any) => ({ login: c.author?.login ?? null, at: c.createdAt }))),
  ].filter((e) => e.login && e.login !== pr.author?.login);
  const mineEvents = events.filter((e) => e.login === viewer);
  const otherEvents = events.filter((e) => e.login !== viewer);
  const myLastAt = mineEvents.map((e) => e.at).sort().at(-1) ?? null;
  const lastCommit = pr.commits.nodes[0]?.commit;
  const lastCommitAt: string | null = lastCommit?.pushedDate ?? lastCommit?.committedDate ?? null;
  const authorEvents: Event[] = [
    ...pr.comments.nodes.map((c: any) => ({ login: c.author?.login ?? null, at: c.createdAt })),
    ...pr.reviewThreads.nodes.flatMap((t: any) => t.comments.nodes.map((c: any) => ({ login: c.author?.login ?? null, at: c.createdAt }))),
  ].filter((e) => e.login && e.login !== viewer && !isBot({ login: e.login }));
  return {
    number: pr.number, url: pr.url, title: pr.title, author: pr.author?.login ?? null, authorIsBot: isBot(pr.author), headRefName: pr.headRefName, baseRefName: pr.baseRefName,
    createdAt: pr.createdAt, updatedAt: pr.updatedAt, lastCommitAt, additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
    lines, area: classifyArea(lines), small: pr.additions + pr.deletions <= SMALL_MAX_LINES && pr.changedFiles <= SMALL_MAX_FILES,
    ticket: ticketOf(pr.title, pr.headRefName), checksState: lastCommit?.statusCheckRollup?.state?.toLowerCase() ?? null, mergeable: pr.mergeable, reviewDecision: pr.reviewDecision,
    mine: involvement(mineEvents), myLastAt, commentsSinceMine: myLastAt ? authorEvents.filter((e) => e.at > myLastAt).length : 0,
    pushedSinceMine: !!(myLastAt && lastCommitAt && lastCommitAt > myLastAt),
    others: involvement(otherEvents), otherHumans: [...new Set(otherEvents.map((e) => e.login as string))],
  };
}

async function fetchOpenPrs(slug: string, viewer: string): Promise<{ prs: ReviewPr[]; drafts: number; mine: number }> {
  const [owner, name] = slug.split('/');
  const nodes: any[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const args = ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${OPEN_QUERY}`];
    if (after) args.push('-F', `after=${after}`);
    const data = JSON.parse(await run('gh', args, { timeoutMs: 60_000 })).data.repository.pullRequests;
    nodes.push(...data.nodes);
    if (!data.pageInfo.hasNextPage) break;
    after = data.pageInfo.endCursor;
  }
  const notMine = nodes.filter((pr) => pr.author?.login !== viewer);
  const ready = notMine.filter((pr) => !pr.isDraft);
  return { prs: ready.map((pr) => toReviewPr(pr, viewer)), drafts: notMine.length - ready.length, mine: nodes.length - notMine.length };
}

async function fetchApproved(slug: string, viewer: string): Promise<ApprovedPr[]> {
  const raw = await run('gh', ['pr', 'list', '--repo', slug, '--search', `reviewed-by:${viewer} -author:${viewer} sort:updated-desc`, '--state', 'all', '--limit', '100',
    '--json', 'number,url,title,author,state,headRefName,updatedAt,mergedAt,closedAt,latestReviews'], { timeoutMs: 60_000 });
  const list: any[] = JSON.parse(raw);
  return list
    .filter((p) => p.latestReviews.some((r: any) => r.author?.login === viewer && r.state === 'APPROVED'))
    .map((p) => ({ number: p.number, url: p.url, title: p.title, author: p.author?.login ?? null, state: p.state, headRefName: p.headRefName, updatedAt: p.updatedAt, mergedAt: p.mergedAt, closedAt: p.closedAt, ticket: ticketOf(p.title, p.headRefName) }));
}

export function openPrsForReview(): Cached<{ prs: ReviewPr[]; drafts: number; mine: number }> {
  const slug = repoSlug().value;
  const viewer = viewerLogin().value;
  if (!slug || !viewer) return { value: null, fetchedAt: null, error: repoSlug().error ?? viewerLogin().error, loading: true };
  return cached('gh:review-queue', TTL, () => fetchOpenPrs(slug, viewer));
}

export function approvedByMe(): Cached<ApprovedPr[]> {
  const slug = repoSlug().value;
  const viewer = viewerLogin().value;
  if (!slug || !viewer) return { value: null, fetchedAt: null, error: repoSlug().error ?? viewerLogin().error, loading: true };
  return cached('gh:review-approved', TTL, () => fetchApproved(slug, viewer));
}
