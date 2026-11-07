import path from 'node:path';
import { promises as fs } from 'node:fs';
import { REPO_ROOT, WORKSPACE_DIR, exists, listDir, normalizeTicket, readText, run, statMtime, TICKET_RE_G } from './util.ts';

export type StageEvent = { ticket: string; stage: string; state: 'in progress' | 'done' | 'failed' | 'skipped' | 'retrying' | 'complete' | 'other'; raw: string };
export type RunTicket = { ticket: string; logPath: string; logMtime: string | null; logBytes: number; exitCode: number | null; stages: StageEvent[]; failedAt: string | null; running: boolean };
export type PipelineRun = { id: string; dir: string; startedAt: string; progressPath: string | null; tickets: RunTicket[]; active: boolean };
export type Slot = { slot: number; ticket: string; startedAt: string | null };
export type Worktree = { path: string; name: string; ticket: string | null; branch: string | null; head: string | null; dirtyFiles: number | null; aheadOfMain: number | null };
export type HeadlessAgent = { pid: number; elapsed: string; host: string; ticket: string | null; phase: string | null; command: string };
export type LocalBranch = { name: string; ticket: string; sha: string; committedAt: string; isCurrent: boolean };

const SCAFFOLD = ['.ai-workspace', '.claude', '.mcp.json', 'flags.json', '.codex', '.cursor', '.agents', 'AGENTS.md'];

export function parseProgressLine(line: string): StageEvent | null {
  const m = line.match(/^\[(XWWP-\d+)\]\s+(.*)$/i);
  if (!m) return null;
  const rest = m[2];
  const st = rest.match(/^([\w-]+):\s*(.*)$/);
  const ticket = normalizeTicket(m[1]);
  if (!st) {
    if (/^FAILED at (\S+)/.test(rest)) return { ticket, stage: rest.replace(/^FAILED at /, ''), state: 'failed', raw: rest };
    if (/all requested stages complete/i.test(rest)) return { ticket, stage: 'all', state: 'complete', raw: rest };
    return { ticket, stage: '?', state: 'other', raw: rest };
  }
  const [, stage, detail] = st;
  const d = detail.toLowerCase();
  const state: StageEvent['state'] = d.startsWith('in progress') ? 'in progress' : d.startsWith('done') ? 'done' : d.startsWith('failed') ? 'failed' : d.startsWith('skipped') ? 'skipped' : d.startsWith('retrying') ? 'retrying' : 'other';
  return { ticket, stage, state, raw: rest };
}

export function collapseStages(events: StageEvent[]): StageEvent[] {
  const out: StageEvent[] = [];
  for (const e of events) {
    const idx = e.state === 'in progress' || e.stage === 'all' || e.stage === '?' ? -1 : out.findLastIndex((o) => o.stage === e.stage);
    const prev = idx >= 0 ? out[idx] : null;
    const merge = prev && (prev.state === 'in progress' || prev.state === 'retrying' || prev.state === e.state || e.state === 'other' || e.state === 'retrying');
    if (!prev || !merge) { out.push(e); continue; }
    const state = e.state === 'other' ? prev.state : e.state;
    out[idx] = { ...prev, state, raw: `${prev.raw} → ${e.raw}` };
  }
  return out;
}

export function settleStages(events: StageEvent[], exitCode: number | null, running: boolean): StageEvent[] {
  if (running || exitCode === null) return events;
  return events.map((e) => (e.state === 'in progress' ? { ...e, state: exitCode === 0 ? 'done' : 'failed', raw: `${e.raw} (process ended with exit ${exitCode})` } : e));
}

function stagesFromTicketLog(ticket: string, log: string): StageEvent[] {
  const out: StageEvent[] = [];
  for (const line of log.split(/\r?\n/)) {
    const fromProgress = parseProgressLine(line);
    if (fromProgress) { out.push(fromProgress); continue; }
    const m = line.match(/^=== Stage: ([\w-]+)(?: \((skipped[^)]*)\))? ===$/);
    if (m) out.push({ ticket, stage: m[1], state: m[2] ? 'skipped' : 'in progress', raw: line });
    const f = line.match(/^Result:\s+FAILED at (\S+)/);
    if (f) out.push({ ticket, stage: f[1], state: 'failed', raw: line });
    if (/^Result:\s+All requested stages completed/.test(line)) out.push({ ticket, stage: 'all', state: 'complete', raw: line });
  }
  const hasProgress = out.some((e) => /^\[/.test(e.raw));
  if (hasProgress) return out.filter((e) => /^\[/.test(e.raw) || e.raw.startsWith('Result:'));
  for (let i = 0; i < out.length; i++) if (out[i].state === 'in progress' && out.slice(i + 1).some((e) => e.state !== 'other')) out[i] = { ...out[i], state: 'done' };
  return out;
}

export async function readSlots(): Promise<Slot[]> {
  const dir = path.join(WORKSPACE_DIR, 'pipeline-slots');
  const out: Slot[] = [];
  for (const n of await listDir(dir)) {
    if (!/^\d+$/.test(n)) continue;
    const ticket = (await readText(path.join(dir, n, 'ticket')))?.trim();
    if (!ticket) continue;
    out.push({ slot: Number(n), ticket: normalizeTicket(ticket), startedAt: (await readText(path.join(dir, n, 'started_at')))?.trim() ?? null });
  }
  return out;
}

export async function readHeadlessAgents(): Promise<HeadlessAgent[]> {
  let ps = '';
  try { ps = await run('ps', ['-axo', 'pid=,etime=,command='], { timeoutMs: 5000 }); } catch { return []; }
  const out: HeadlessAgent[] = [];
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[3];
    const host = /\bclaude\b.*--permission-mode dontAsk/.test(cmd) ? 'claude' : /\bcodex exec\b/.test(cmd) ? 'codex' : /\bagent -p\b.*--trust/.test(cmd) ? 'cursor' : null;
    if (!host) continue;
    const t = cmd.match(TICKET_RE_G);
    const ph = cmd.match(/just-(plan|implement|code-review|commit|qa-check)|w-4-publish\s+\S+\s+draft/);
    out.push({ pid: Number(m[1]), elapsed: m[2], host, ticket: t ? normalizeTicket(t[0]) : null, phase: ph ? (ph[1] ?? 'draft-pr') : null, command: cmd.slice(0, 200) });
  }
  return out;
}

export async function readRuns(limit = 30): Promise<PipelineRun[]> {
  const dir = path.join(WORKSPACE_DIR, 'pipeline-logs');
  const ids = (await listDir(dir)).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort().reverse().slice(0, limit);
  const slots = await readSlots();
  const runs: PipelineRun[] = [];
  for (const id of ids) {
    const rdir = path.join(dir, id);
    const files = await listDir(rdir);
    const progressPath = files.includes('progress.log') ? path.join(rdir, 'progress.log') : null;
    const progress = progressPath ? (await readText(progressPath)) ?? '' : '';
    const progressEvents = progress.split(/\r?\n/).map(parseProgressLine).filter((e): e is StageEvent => !!e);
    const tickets: RunTicket[] = [];
    for (const f of files.filter((n) => /^XWWP-\d+\.log$/i.test(n))) {
      const ticket = normalizeTicket(f.replace(/\.log$/i, ''));
      const logPath = path.join(rdir, f);
      // Run logs symlink into the ticket's worktree, which prune removes.
      const st = await fs.stat(logPath).catch(() => fs.lstat(logPath));
      const statusText = await readText(path.join(rdir, `${ticket}.status`));
      const exitCode = statusText === null ? null : Number(statusText.trim());
      let stages = progressEvents.filter((e) => e.ticket === ticket);
      if (!stages.length) stages = stagesFromTicketLog(ticket, (await readText(logPath)) ?? '');
      const recentlyWritten = Date.now() - st.mtime.getTime() < 20 * 60 * 1000;
      const running = exitCode === null && (slots.some((s) => s.ticket === ticket) || recentlyWritten);
      stages = settleStages(collapseStages(stages), exitCode, running);
      const last = [...stages].reverse().find((e) => e.state === 'failed' || e.state === 'complete' || e.state === 'done');
      const failed = last?.state === 'failed' ? last : null;
      tickets.push({ ticket, logPath, logMtime: st.mtime.toISOString(), logBytes: st.size, exitCode, stages, failedAt: failed?.stage ?? null, running });
    }
    const startedAt = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`;
    runs.push({ id, dir: rdir, startedAt, progressPath, tickets, active: tickets.some((t) => t.running) });
  }
  return runs;
}

export async function tailFile(file: string, maxBytes = 64 * 1024): Promise<{ text: string; size: number; truncated: boolean }> {
  const st = await fs.stat(file);
  const start = Math.max(0, st.size - maxBytes);
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), size: st.size, truncated: start > 0 };
  } finally { await fh.close(); }
}

export async function readWorktrees(): Promise<Worktree[]> {
  let out = '';
  try { out = await run('git', ['worktree', 'list', '--porcelain']); } catch { return []; }
  const trees: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9) };
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 14);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === '' && cur.path) {
      const p = cur.path;
      if (p !== REPO_ROOT) {
        const name = path.basename(p);
        const t = name.match(TICKET_RE_G) ?? cur.branch?.match(TICKET_RE_G);
        trees.push({ path: p, name, ticket: t ? normalizeTicket(t[0]) : null, branch: cur.branch ?? null, head: cur.head ?? null, dirtyFiles: null, aheadOfMain: null });
      }
      cur = {};
    }
  }
  await Promise.all(trees.map(async (w) => {
    if (!(await exists(w.path))) return;
    try {
      const status = await run('git', ['status', '--porcelain', '--', '.', ...SCAFFOLD.map((s) => `:!${s}`)], { cwd: w.path });
      w.dirtyFiles = status.split('\n').filter(Boolean).length;
      w.aheadOfMain = Number((await run('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: w.path })).trim());
    } catch { /* worktree in a broken state; leave nulls */ }
  }));
  return trees;
}

export async function readLocalBranches(): Promise<LocalBranch[]> {
  let out = '';
  let current = '';
  try {
    out = await run('git', ['for-each-ref', '--format=%(refname:short)|%(objectname:short)|%(committerdate:iso-strict)', 'refs/heads']);
    current = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch { return []; }
  const res: LocalBranch[] = [];
  for (const line of out.split('\n')) {
    const [name, sha, date] = line.split('|');
    const t = name?.match(TICKET_RE_G);
    if (t) res.push({ name, ticket: normalizeTicket(t[0]), sha, committedAt: date, isCurrent: name === current });
  }
  return res;
}

export type QaStack = { url: string; source: string | null; branch: string | null; sha: string | null; at: string | null; lockedBy: string | null };

// Mirrors stack 3 in the web repo's scripts/pipeline/stack.sh.
const QA_STACK_URL = 'http://qa.localhost:5100';

export function parseStackDeployed(text: string, lockedBy: string | null): QaStack {
  const field = (k: string) => text.match(new RegExp(`^${k}: (.+)$`, 'm'))?.[1].trim() ?? null;
  return { url: QA_STACK_URL, source: field('source'), branch: field('branch'), sha: field('sha'), at: field('at'), lockedBy };
}

export async function readQaStack(): Promise<QaStack | null> {
  const git = path.join(process.env.WEB_STACK3_DIR ?? path.join(path.dirname(REPO_ROOT), 'web-3rd'), '.git');
  const deployed = await readText(path.join(git, 'stack-deployed'));
  if (deployed === null) return null;
  return parseStackDeployed(deployed, (await readText(path.join(git, 'stack-lock', 'owner')))?.trim() || null);
}
