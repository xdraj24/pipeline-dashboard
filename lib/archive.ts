import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, REPO_ROOT, listDir, normalizeTicket, parseFrontmatter, readText, TICKET_RE } from './util.ts';

export const ARCHIVE_JIRA_STATUSES = ["QC'd on STG", 'Delivered IN APP.WELLIGENCE'];
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

export type Archived = { at: string; reason: string; file: string };

function planFile(ticket: string): string { return path.join(REPO_ROOT, '.jira-plans', ticket, 'plan.md'); }
function sideFile(ticket: string): string { return path.join(ARCHIVE_DIR, `${ticket}.md`); }

function fromFrontmatter(file: string, data: Record<string, string>): Archived | null {
  if (!data.archived) return null;
  return { at: data.archived, reason: data.archived_reason ?? '', file: path.relative(REPO_ROOT, file) };
}

export async function readArchived(ticket: string): Promise<Archived | null> {
  for (const file of [planFile(ticket), sideFile(ticket)]) {
    const text = await readText(file);
    if (text === null) continue;
    const hit = fromFrontmatter(file, parseFrontmatter(text).data);
    if (hit) return hit;
  }
  return null;
}

export async function listArchivedTickets(): Promise<string[]> {
  return (await listDir(ARCHIVE_DIR)).filter((n) => n.endsWith('.md') && TICKET_RE.test(n.slice(0, -3))).map((n) => normalizeTicket(n.slice(0, -3)));
}

function upsertFrontmatter(text: string, kv: Record<string, string>): string {
  const entries = Object.entries(kv).map(([k, v]) => `${k}: ${v}`);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return `---\n${entries.join('\n')}\n---\n\n${text}`;
  const kept = m[1].split(/\r?\n/).filter((l) => !Object.keys(kv).some((k) => l.startsWith(`${k}:`)));
  return `---\n${[...kept, ...entries].join('\n')}\n---\n${text.slice(m[0].length)}`;
}

async function writeAtomic(file: string, text: string, keepMtime = false): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const before = keepMtime ? await fs.stat(file).catch(() => null) : null;
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
  if (before) await fs.utimes(file, before.atime, before.mtime);
}

export async function archiveTicket(ticket: string, reason: string): Promise<Archived> {
  const existing = await readArchived(ticket);
  if (existing) return existing;
  const at = new Date().toISOString();
  const kv = { archived: at, archived_reason: reason };
  const plan = planFile(ticket);
  const planText = await readText(plan);
  if (planText !== null) {
    await writeAtomic(plan, upsertFrontmatter(planText, kv), true);
    return { at, reason, file: path.relative(REPO_ROOT, plan) };
  }
  const side = sideFile(ticket);
  await writeAtomic(side, upsertFrontmatter(`# ${ticket}\n\nArchived by the dashboard. This ticket has no .jira-plans folder, so the marker lives here.\n`, { ticket, ...kv }));
  return { at, reason, file: path.relative(REPO_ROOT, side) };
}
