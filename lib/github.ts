import { cached, run, type Cached } from './util.ts';

export type PrThread = { isResolved: boolean; isOutdated: boolean; path: string | null; author: string | null; createdAt: string | null; body: string; replies: number };
export type PrComment = { author: string | null; createdAt: string; body: string; kind: 'issue' | 'review' };
export type PrCheck = { name: string; status: string };
export type PrInfo = {
  number: number; url: string; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; author: string | null;
  headRefName: string; baseRefName: string; reviewDecision: string | null; mergeable: string | null; mergeStateStatus: string | null;
  mergedAt: string | null; closedAt: string | null; updatedAt: string; lastCommitAt: string | null; additions: number; deletions: number;
  reviews: { author: string | null; state: string; submittedAt: string | null }[]; threads: PrThread[]; unresolvedThreads: number;
  comments: PrComment[]; newSinceLastPush: number; checks: PrCheck[]; checksState: string | null; approvedBy: string[]; changesRequestedBy: string[];
};

const TTL = 60_000;
const MAX_PARALLEL = 4;
let inFlight = 0;
const queue: (() => void)[] = [];
async function gh(args: string[]): Promise<string> {
  if (inFlight >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  inFlight++;
  try { return await run('gh', args); } finally { inFlight--; queue.shift()?.(); }
}

export function repoSlug(): Cached<string> {
  return cached('gh:repo', 24 * 3600_000, async () => (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim());
}

export function viewerLogin(): Cached<string> {
  return cached('gh:viewer', 24 * 3600_000, async () => (await gh(['api', 'user', '-q', '.login'])).trim());
}

export function ghStatus(): Cached<{ ok: boolean; detail: string }> {
  return cached('gh:auth', 10 * 60_000, async () => {
    try { const out = await gh(['auth', 'status']); return { ok: true, detail: out.split('\n').find((l) => /Logged in/.test(l))?.trim() ?? 'ok' }; }
    catch (e) { return { ok: false, detail: (e as Error).message }; }
  });
}

const isBot = (login: string | null | undefined) => !login || /\[bot\]$/.test(login) || /^app\//.test(login) || /dependabot|github-actions|copilot/i.test(login);

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
 number url title state isDraft author{login} headRefName baseRefName reviewDecision mergeable mergeStateStatus mergedAt closedAt updatedAt additions deletions
 commits(last:1){nodes{commit{committedDate pushedDate statusCheckRollup{state contexts(first:60){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}
 reviews(last:30){nodes{author{login} state submittedAt}}
 reviewThreads(first:100){nodes{isResolved isOutdated comments(first:50){totalCount nodes{author{login} createdAt path body}}}}
 comments(last:50){nodes{author{login} createdAt body}}
}}}`;

async function fetchPr(slug: string, number: number, viewer: string | null): Promise<PrInfo> {
  const [owner, name] = slug.split('/');
  const raw = await gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`, '-f', `query=${PR_QUERY}`]);
  const pr = JSON.parse(raw).data.repository.pullRequest;
  const lastCommit = pr.commits.nodes[0]?.commit;
  const lastCommitAt: string | null = lastCommit?.pushedDate ?? lastCommit?.committedDate ?? null;
  const threads: PrThread[] = pr.reviewThreads.nodes.map((t: any) => {
    const first = t.comments.nodes[0];
    return { isResolved: t.isResolved, isOutdated: t.isOutdated, path: first?.path ?? null, author: first?.author?.login ?? null, createdAt: first?.createdAt ?? null, body: (first?.body ?? '').slice(0, 600), replies: Math.max(0, t.comments.totalCount - 1) };
  });
  const comments: PrComment[] = [
    ...pr.comments.nodes.map((c: any) => ({ author: c.author?.login ?? null, createdAt: c.createdAt, body: (c.body ?? '').slice(0, 600), kind: 'issue' as const })),
    ...pr.reviewThreads.nodes.flatMap((t: any) => t.comments.nodes.map((c: any) => ({ author: c.author?.login ?? null, createdAt: c.createdAt, body: (c.body ?? '').slice(0, 600), kind: 'review' as const }))),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const human = (c: { author: string | null }) => !isBot(c.author) && c.author !== viewer;
  const newSinceLastPush = lastCommitAt ? comments.filter((c) => human(c) && c.createdAt > lastCommitAt).length : comments.filter(human).length;
  const rollup = lastCommit?.statusCheckRollup;
  const checks: PrCheck[] = (rollup?.contexts?.nodes ?? []).map((c: any) => c.__typename === 'CheckRun' ? { name: c.name, status: (c.conclusion ?? c.status ?? '').toLowerCase() } : { name: c.context, status: (c.state ?? '').toLowerCase() });
  const latestByAuthor = new Map<string, string>();
  for (const r of pr.reviews.nodes) if (r.author?.login && r.state !== 'COMMENTED') latestByAuthor.set(r.author.login, r.state);
  return {
    number: pr.number, url: pr.url, title: pr.title, state: pr.state, isDraft: pr.isDraft, author: pr.author?.login ?? null, headRefName: pr.headRefName,
    baseRefName: pr.baseRefName, reviewDecision: pr.reviewDecision, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, mergedAt: pr.mergedAt,
    closedAt: pr.closedAt, updatedAt: pr.updatedAt, lastCommitAt, additions: pr.additions, deletions: pr.deletions,
    reviews: pr.reviews.nodes.map((r: any) => ({ author: r.author?.login ?? null, state: r.state, submittedAt: r.submittedAt })),
    threads, unresolvedThreads: threads.filter((t) => !t.isResolved).length, comments: comments.slice(0, 40), newSinceLastPush, checks,
    checksState: rollup?.state?.toLowerCase() ?? null,
    approvedBy: [...latestByAuthor].filter(([, s]) => s === 'APPROVED').map(([a]) => a),
    changesRequestedBy: [...latestByAuthor].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([a]) => a),
  };
}

export function prInfo(number: number): Cached<PrInfo> {
  const slug = repoSlug().value;
  const viewer = viewerLogin().value;
  if (!slug) return { value: null, fetchedAt: null, error: repoSlug().error, loading: true };
  return cached(`gh:pr:${number}`, TTL, () => fetchPr(slug, number, viewer));
}

export function prNumberForBranch(branch: string): Cached<number | null> {
  const slug = repoSlug().value;
  if (!slug) return { value: null, fetchedAt: null, error: null, loading: true };
  return cached(`gh:branch:${branch}`, 5 * TTL, async () => {
    const raw = await gh(['pr', 'list', '--repo', slug, '--head', branch, '--state', 'all', '--json', 'number,state,updatedAt', '--limit', '10']);
    const list: { number: number; state: string; updatedAt: string }[] = JSON.parse(raw);
    if (!list.length) return null;
    const open = list.find((p) => p.state === 'OPEN');
    return (open ?? list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]).number;
  });
}

export function prNumbersForTicket(ticket: string): Cached<number[]> {
  const slug = repoSlug().value;
  if (!slug) return { value: null, fetchedAt: null, error: null, loading: true };
  return cached(`gh:search:${ticket}`, 10 * TTL, async () => {
    const raw = await gh(['pr', 'list', '--repo', slug, '--search', `${ticket} in:title`, '--state', 'all', '--json', 'number,title,headRefName,updatedAt', '--limit', '10']);
    const list: { number: number; title: string; headRefName: string; updatedAt: string }[] = JSON.parse(raw);
    const re = new RegExp(`\\b${ticket}\\b`, 'i');
    return list.filter((p) => re.test(p.title) || re.test(p.headRefName)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((p) => p.number);
  });
}

export const prNumberFromUrl = (url: string | null | undefined): number | null => {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
};
