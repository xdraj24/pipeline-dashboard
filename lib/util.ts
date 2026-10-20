import { execFile } from 'node:child_process';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';

export const DASHBOARD_DIR = path.resolve(import.meta.dirname, '..');

function webRootFromEnvFile(): string | undefined {
  try {
    return readFileSync(path.join(DASHBOARD_DIR, '.env'), 'utf8').match(/^WEB_REPO_ROOT=(.+)$/m)?.[1].trim();
  } catch {
    return undefined;
  }
}

export const REPO_ROOT = path.resolve(
  process.env.PIPELINE_REPO_ROOT ?? process.env.WEB_REPO_ROOT ?? webRootFromEnvFile() ?? path.join(DASHBOARD_DIR, '..', 'web'),
);
export const DATA_DIR = path.join(DASHBOARD_DIR, 'data');

export type Frontmatter = Record<string, string>;

export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: text.slice(m[0].length) };
}

export function sections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current = '_intro';
  let buf: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (h) {
      out[current] = (out[current] ? out[current] + '\n' : '') + buf.join('\n').trim();
      current = h[1].replace(/\s+/g, ' ').trim();
      buf = [];
    } else buf.push(line);
  }
  out[current] = (out[current] ? out[current] + '\n' : '') + buf.join('\n').trim();
  return out;
}

export function findSection(secs: Record<string, string>, re: RegExp): string | undefined {
  const key = Object.keys(secs).find((k) => re.test(k));
  return key === undefined ? undefined : secs[key];
}

export function bullets(text: string | undefined): string[] {
  if (!text) return [];
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (m) items.push(m[1].trim());
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += ' ' + line.trim();
  }
  return items.filter((b) => b && !/^none\.?$/i.test(b));
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export async function statMtime(file: string): Promise<string | null> {
  try {
    return (await fs.stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd ?? REPO_ROOT, timeout: opts.timeoutMs ?? 30000, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${stderr?.toString().trim() || err.message}`));
        else resolve(stdout.toString());
      },
    );
  });
}

export type Cached<T> = { value: T | null; fetchedAt: string | null; error: string | null; loading: boolean };

const cacheStore = new Map<string, { value: unknown; fetchedAt: number; error: string | null; inflight: Promise<void> | null }>();

export function primeCache<T>(key: string, value: T): void {
  const entry = cacheStore.get(key);
  if (entry?.inflight) return;
  cacheStore.set(key, { value, fetchedAt: Date.now(), error: null, inflight: null });
}

export function clearCache(prefix?: string): void {
  for (const k of [...cacheStore.keys()]) if (!prefix || k.startsWith(prefix)) cacheStore.delete(k);
}

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Cached<T> {
  let entry = cacheStore.get(key);
  const now = Date.now();
  const stale = !entry || now - entry.fetchedAt > ttlMs;
  if (stale && !(entry && entry.inflight)) {
    const inflight = fn()
      .then((value) => {
        cacheStore.set(key, { value, fetchedAt: Date.now(), error: null, inflight: null });
      })
      .catch((e: Error) => {
        const prev = cacheStore.get(key);
        cacheStore.set(key, { value: prev?.value ?? null, fetchedAt: Date.now(), error: e.message, inflight: null });
      });
    entry = { value: entry?.value ?? null, fetchedAt: entry?.fetchedAt ?? 0, error: entry?.error ?? null, inflight };
    cacheStore.set(key, entry);
  }
  return {
    value: (entry?.value as T) ?? null,
    fetchedAt: entry && entry.fetchedAt ? new Date(entry.fetchedAt).toISOString() : null,
    error: entry?.error ?? null,
    loading: !!entry?.inflight,
  };
}

export const TICKET_RE = /\bXWWP-\d+\b/i;
export const TICKET_RE_G = /\bXWWP-\d+\b/gi;
export const normalizeTicket = (t: string) => t.toUpperCase();
