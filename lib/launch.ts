import { spawn } from 'node:child_process';
import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, REPO_ROOT, listDir, readText } from './util.ts';

export type LaunchHow = 'headless' | 'terminal';
export type Launch = {
  id: string; ticket: string | null; pr: number | null; command: string; how: LaunchHow; cwd: string; pid: number | null; startedAt: string;
  endedAt: string | null; exitCode: number | null; signal: string | null; logPath: string | null; error: string | null;
};

export const LAUNCH_DIR = path.join(DATA_DIR, 'launches');
const COMMAND_RE = /^\/w-[\w-]+( [^\n\r;&|`$<>]*)?$/;

async function save(l: Launch): Promise<void> {
  await fs.mkdir(LAUNCH_DIR, { recursive: true });
  const file = path.join(LAUNCH_DIR, `${l.id}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(l, null, 2));
  await fs.rename(tmp, file);
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function listLaunches(): Promise<Launch[]> {
  const out: Launch[] = [];
  for (const name of await listDir(LAUNCH_DIR)) {
    if (!name.endsWith('.json')) continue;
    const text = await readText(path.join(LAUNCH_DIR, name));
    if (!text) continue;
    try {
      const l = JSON.parse(text) as Launch;
      if (l.how === 'headless' && !l.endedAt && !alive(l.pid)) {
        l.endedAt = new Date().toISOString();
        l.error = l.error ?? 'process gone without an exit record (dashboard restarted?)';
        await save(l);
      }
      out.push(l);
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getLaunch(id: string): Promise<Launch | null> {
  return (await listLaunches()).find((l) => l.id === id) ?? null;
}

export function isRunning(l: Launch): boolean {
  return l.how === 'headless' && !l.endedAt && alive(l.pid);
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function launch(opts: { ticket?: string | null; pr?: number | null; command: string; how: LaunchHow }): Promise<Launch> {
  const command = opts.command.trim();
  if (!COMMAND_RE.test(command)) throw new Error('command must be a single /w-* skill invocation');
  const running = (await listLaunches()).filter(isRunning);
  if (opts.ticket && running.some((l) => l.ticket === opts.ticket)) throw new Error(`${opts.ticket} already has a running launch; stop it first`);
  if (opts.pr && running.some((l) => l.pr === opts.pr)) throw new Error(`PR #${opts.pr} already has a running launch; stop it first`);

  const id = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${(opts.ticket ?? (opts.pr ? `pr-${opts.pr}` : 'misc')).toLowerCase()}`;
  const l: Launch = {
    id, ticket: opts.ticket ?? null, pr: opts.pr ?? null, command, how: opts.how, cwd: REPO_ROOT, pid: null, startedAt: new Date().toISOString(),
    endedAt: null, exitCode: null, signal: null, logPath: null, error: null,
  };
  const env = { ...process.env, PIPELINE_REPO_ROOT: REPO_ROOT, PIPELINE_AGENT: 'claude', PIPELINE_LAUNCHED_FROM: 'dashboard' };

  if (opts.how === 'terminal') {
    const script = `cd ${shellQuote(REPO_ROOT)} && claude ${shellQuote(command)}`;
    const osa = `tell application "Terminal"\n activate\n do script ${JSON.stringify(script)}\nend tell`;
    const child = spawn('osascript', ['-e', osa], { stdio: 'ignore', env });
    await new Promise<void>((resolve) => child.on('exit', (code) => { if (code) l.error = `osascript exited ${code}`; resolve(); }));
    l.endedAt = new Date().toISOString();
    await save(l);
    return l;
  }

  await fs.mkdir(LAUNCH_DIR, { recursive: true });
  l.logPath = path.join(LAUNCH_DIR, `${id}.log`);
  const fd = openSync(l.logPath, 'a');
  const args = ['--permission-mode', 'dontAsk', '--allowedTools', 'mcp__atlassian__*,mcp__slack__*', '-p', command];
  const child = spawn('claude', args, { cwd: REPO_ROOT, detached: true, stdio: ['ignore', fd, fd], env });
  closeSync(fd);
  child.unref();
  l.pid = child.pid ?? null;
  child.on('error', async (e) => { l.error = e.message; l.endedAt = new Date().toISOString(); await save(l); });
  child.on('exit', async (code, signal) => { l.exitCode = code; l.signal = signal; l.endedAt = new Date().toISOString(); await save(l); });
  await fs.appendFile(l.logPath, `# ${l.startedAt} dashboard launch: claude ${args.map(shellQuote).join(' ')}\n# cwd ${REPO_ROOT} pid ${l.pid}\n\n`);
  await save(l);
  return l;
}

export async function stopLaunch(id: string): Promise<Launch | null> {
  const l = await getLaunch(id);
  if (!l) return null;
  if (isRunning(l) && l.pid) {
    try { process.kill(-l.pid, 'SIGTERM'); } catch { try { process.kill(l.pid, 'SIGTERM'); } catch { /* gone */ } }
    l.error = 'stopped from the dashboard';
    l.endedAt = new Date().toISOString();
    await save(l);
  }
  return l;
}
