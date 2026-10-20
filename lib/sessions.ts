import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, TICKET_RE, listDir } from './util.ts';

export type SkillSession = {
  sessionId: string; file: string; cwd: string | null; command: string; skill: string; args: string; prs: number[]; ticket: string | null;
  invokedAt: string; lastActivityAt: string; state: 'running' | 'stalled' | 'finished'; finishedAt: string | null; summary: string | null; toolCalls: number;
};

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const LOOKBACK_MS = 24 * 3600_000;
const STALL_MS = 15 * 60_000;
const parsed = new Map<string, { mtimeMs: number; session: SkillSession | null }>();

function parseSession(file: string, text: string, mtime: Date): SkillSession | null {
  const lines = text.split('\n');
  let last: { idx: number; command: string; args: string; at: string; sessionId: string; cwd: string | null } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/<command-name>(\/w-[\w-]+)<\/command-name>/);
    if (!m) continue;
    const args = lines[i].match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? '';
    let at = mtime.toISOString(); let sessionId = path.basename(file, '.jsonl'); let cwd: string | null = null;
    try { const d = JSON.parse(lines[i]); at = d.timestamp ?? at; sessionId = d.sessionId ?? sessionId; cwd = d.cwd ?? null; } catch { /* keep defaults */ }
    last = { idx: i, command: m[1], args: args.trim(), at, sessionId, cwd };
  }
  if (!last) return null;
  let finishedAt: string | null = null; let summary: string | null = null; let toolCalls = 0;
  for (let i = last.idx + 1; i < lines.length; i++) {
    if (!lines[i].startsWith('{"')) continue;
    let d: any;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.type !== 'assistant') continue;
    const content = Array.isArray(d.message?.content) ? d.message.content : [];
    toolCalls += content.filter((c: any) => c.type === 'tool_use').length;
    if (d.message?.stop_reason === 'end_turn') {
      finishedAt = d.timestamp ?? null;
      summary = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim().slice(0, 400) || null;
    } else finishedAt = null;
  }
  const lastActivityAt = mtime.toISOString();
  const state = finishedAt ? 'finished' : 'running';
  const prs = [...last.args.matchAll(/\b\d{2,6}\b/g)].map((x) => Number(x[0]));
  const ticket = last.args.match(TICKET_RE)?.[0].toUpperCase() ?? null;
  return { sessionId: last.sessionId, file, cwd: last.cwd, command: `${last.command}${last.args ? ' ' + last.args : ''}`, skill: last.command.slice(1), args: last.args, prs, ticket, invokedAt: last.at, lastActivityAt, state, finishedAt, summary, toolCalls };
}

export async function readSkillSessions(): Promise<SkillSession[]> {
  const out: SkillSession[] = [];
  const cutoff = Date.now() - LOOKBACK_MS;
  for (const project of await listDir(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, project);
    for (const name of await listDir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let st;
      try { st = await fs.stat(file); } catch { continue; }
      if (st.mtimeMs < cutoff) { parsed.delete(file); continue; }
      let hit = parsed.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs) {
        hit = { mtimeMs: st.mtimeMs, session: parseSession(file, await fs.readFile(file, 'utf8'), st.mtime) };
        parsed.set(file, hit);
      }
      const s = hit.session;
      if (s) out.push({ ...s, state: s.finishedAt ? 'finished' : Date.now() - st.mtimeMs > STALL_MS ? 'stalled' : 'running' });
    }
  }
  return out.filter((s) => !s.cwd || s.cwd.startsWith(REPO_ROOT) || s.cwd.includes('worktree')).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}
