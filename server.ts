import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildState } from './lib/state.ts';
import { readTicketArtifacts } from './lib/artifacts.ts';
import { readRuns, tailFile } from './lib/pipeline.ts';
import { answerQuestion, createQuestion, getQuestion, listQuestions, patchQuestion } from './lib/questions.ts';
import { DASHBOARD_DIR, REPO_ROOT, clearCache, readText } from './lib/util.ts';
import { repoSlug, viewerLogin } from './lib/github.ts';
import { getLaunch, launch, listLaunches, stopLaunch } from './lib/launch.ts';
import { buildReviewDetail, buildReviewState, detailComments } from './lib/review-state.ts';
import { setPublishFlags } from './lib/review-file.ts';

const PORT = Number(process.env.PORT ?? 4848);
const PUBLIC_DIR = path.join(DASHBOARD_DIR, 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req: http.IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const TICKET = /^XWWP-\d+$/i;
const ARTIFACTS = new Set(['plan.md', 'code-review.md', 'qa-check.md', 'change-notes.md', 'local-branch.md']);

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method ?? 'GET';
  let m: RegExpMatchArray | null;

  if (p === '/api/state' && method === 'GET') return json(res, 200, await buildState({ sprint: url.searchParams.get('sprint') === 'all' ? 'all' : 'mine' }));
  if (p === '/api/refresh' && method === 'POST') { clearCache(); return json(res, 200, { ok: true }); }
  if (p === '/api/reviews' && method === 'GET') return json(res, 200, await buildReviewState());
  if ((m = p.match(/^\/api\/reviews\/(\d+)\/detail$/)) && method === 'GET') return json(res, 200, await buildReviewDetail(Number(m[1])));
  if ((m = p.match(/^\/api\/reviews\/(\d+)\/publish-flags$/)) && method === 'POST') {
    const body = await readBody(req);
    const flags: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(body.flags ?? {})) if (/^\d+$/.test(k) && typeof v === 'boolean') flags[k] = v;
    if (!Object.keys(flags).length) return json(res, 400, { error: 'flags {rowIndex: boolean} is required' });
    const table = await setPublishFlags(Number(m[1]), flags);
    if (!table) return json(res, 404, { error: 'no review.md' });
    const text = await readText(path.join(REPO_ROOT, '.pr-reviews', `PR-${m[1]}`, 'review.md'));
    return json(res, 200, { pr: Number(m[1]), comments: detailComments(text, repoSlug().value, typeof body.ref === 'string' ? body.ref : null) });
  }
  if ((m = p.match(/^\/api\/reviews\/(\d+)\/file$/)) && method === 'GET') {
    const text = await readText(path.join(REPO_ROOT, '.pr-reviews', `PR-${m[1]}`, 'review.md'));
    return text === null ? json(res, 404, { error: 'no review.md' }) : json(res, 200, { pr: Number(m[1]), path: `.pr-reviews/PR-${m[1]}/review.md`, text });
  }

  if ((m = p.match(/^\/api\/tickets\/([^/]+)\/artifact\/([^/]+)$/)) && method === 'GET') {
    const [, ticket, name] = m;
    const a = await readTicketArtifacts(ticket.toUpperCase());
    if (!TICKET.test(ticket) || (!ARTIFACTS.has(name) && !a.otherFiles.includes(name))) return json(res, 404, { error: 'not found' });
    const text = await readText(path.join(a.dir, name));
    return text === null ? json(res, 404, { error: 'missing' }) : json(res, 200, { ticket: a.ticket, name, text });
  }
  if ((m = p.match(/^\/api\/tickets\/([^/]+)\/log$/)) && method === 'GET') {
    const ticket = m[1].toUpperCase();
    if (!TICKET.test(ticket)) return json(res, 404, { error: 'bad ticket' });
    const runId = url.searchParams.get('run');
    const runs = await readRuns(100);
    const entry = runs.flatMap((r) => r.tickets.filter((t) => t.ticket === ticket && (!runId || r.id === runId)).map((t) => ({ run: r, t })))[0];
    if (!entry) return json(res, 404, { error: 'no log' });
    const tail = await tailFile(entry.t.logPath, Number(url.searchParams.get('bytes') ?? 96 * 1024));
    return json(res, 200, { ticket, runId: entry.run.id, path: entry.t.logPath, running: entry.t.running, exitCode: entry.t.exitCode, ...tail });
  }
  if ((m = p.match(/^\/api\/runs\/([^/]+)\/progress$/)) && method === 'GET') {
    if (!/^\d{8}T\d{6}Z$/.test(m[1])) return json(res, 404, { error: 'bad run' });
    const text = await readText(path.join(REPO_ROOT, '.claude', 'pipeline-logs', m[1], 'progress.log'));
    return json(res, 200, { runId: m[1], text: text ?? '' });
  }

  if (p === '/api/launches' && method === 'GET') return json(res, 200, await listLaunches());
  if (p === '/api/launch' && method === 'POST') {
    const body = await readBody(req);
    if (typeof body.command !== 'string') return json(res, 400, { error: 'command is required' });
    const ticket = typeof body.ticket === 'string' && TICKET.test(body.ticket) ? body.ticket.toUpperCase() : null;
    const pr = Number.isInteger(body.pr) && body.pr > 0 ? body.pr : null;
    try { return json(res, 201, await launch({ ticket, pr, command: body.command, how: body.how === 'terminal' ? 'terminal' : 'headless' })); }
    catch (e) { return json(res, 400, { error: (e as Error).message }); }
  }
  if ((m = p.match(/^\/api\/launches\/([\w-]+)\/stop$/)) && method === 'POST') {
    const l = await stopLaunch(m[1]);
    return l ? json(res, 200, l) : json(res, 404, { error: 'not found' });
  }
  if ((m = p.match(/^\/api\/launches\/([\w-]+)\/log$/)) && method === 'GET') {
    const l = await getLaunch(m[1]);
    if (!l || !l.logPath) return json(res, 404, { error: 'no log' });
    const tail = await tailFile(l.logPath, Number(url.searchParams.get('bytes') ?? 96 * 1024));
    return json(res, 200, { ...l, ...tail });
  }

  if (p === '/api/questions' && method === 'GET') return json(res, 200, await listQuestions());
  if (p === '/api/questions' && method === 'POST') {
    const body = await readBody(req);
    if (!body.question || typeof body.question !== 'string') return json(res, 400, { error: 'question is required' });
    return json(res, 201, await createQuestion(body));
  }
  if ((m = p.match(/^\/api\/questions\/([\w-]+)$/)) && method === 'GET') {
    const q = await getQuestion(m[1]);
    return q ? json(res, 200, q) : json(res, 404, { error: 'not found' });
  }
  if ((m = p.match(/^\/api\/questions\/([\w-]+)$/)) && method === 'PATCH') {
    const q = await patchQuestion(m[1], await readBody(req));
    return q ? json(res, 200, q) : json(res, 404, { error: 'not found' });
  }
  if ((m = p.match(/^\/api\/questions\/([\w-]+)\/answer$/)) && method === 'POST') {
    const body = await readBody(req);
    if (!body.answer || typeof body.answer !== 'string') return json(res, 400, { error: 'answer is required' });
    const q = await answerQuestion(m[1], body.answer, body.via ?? 'dashboard');
    return q ? json(res, 200, q) : json(res, 404, { error: 'not found' });
  }

  const page = p === '/' ? 'index.html' : p === '/history' ? 'history.html' : p === '/reviews' ? 'reviews.html' : p;
  const file = path.normalize(path.join(PUBLIC_DIR, page));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { json(res, 404, { error: 'not found' }); }
}

repoSlug();
viewerLogin();
http.createServer((req, res) => {
  handle(req, res).catch((e: Error) => { console.error(e); if (!res.headersSent) json(res, 500, { error: e.message }); });
}).listen(PORT, '127.0.0.1', () => console.log(`skills dashboard: http://localhost:${PORT}  (repo: ${REPO_ROOT})`));
