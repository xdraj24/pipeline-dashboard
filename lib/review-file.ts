import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, cached, readText, run, type Cached } from './util.ts';

export type ReviewRow = { index: number; path: string; line: number | null; body: string; publish: boolean | null };
export type ReviewTable = { hasPublishColumn: boolean; rows: ReviewRow[]; noIssues: boolean };
export type Snippet = { startLine: number; focus: number; lines: string[]; ref: string };

const CELL_SPLIT = /(?<!\\)\|/;
const isRow = (l: string) => /^\|\s*`/.test(l);
const splitCells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(CELL_SPLIT).map((c) => c.trim().replace(/\\\|/g, '|'));

export function parseReviewTable(text: string): ReviewTable {
  const lines = text.split(/\r?\n/);
  const header = lines.find((l) => /^\|\s*File:Line\s*\|/i.test(l));
  const hasPublishColumn = !!header && /\|\s*Publish\s*\|\s*$/i.test(header);
  const rows: ReviewRow[] = [];
  for (const l of lines.filter(isRow)) {
    const cells = splitCells(l);
    const ref = cells[0].replace(/`/g, '');
    const colon = ref.lastIndexOf(':');
    const line = colon > 0 ? Number(ref.slice(colon + 1)) : NaN;
    const flag = hasPublishColumn ? (cells[2] ?? '') : null;
    rows.push({ index: rows.length, path: Number.isFinite(line) ? ref.slice(0, colon) : ref, line: Number.isFinite(line) ? line : null, body: cells[1] ?? '', publish: flag === null ? null : /\[x\]/i.test(flag) });
  }
  return { hasPublishColumn, rows, noIssues: /^No issues found\.?$/m.test(text) };
}

export const reviewFilePath = (pr: number) => path.join(REPO_ROOT, '.pr-reviews', `PR-${pr}`, 'review.md');

export async function setPublishFlags(pr: number, flags: Record<string, boolean>): Promise<ReviewTable | null> {
  const file = reviewFilePath(pr);
  const text = await readText(file);
  if (text === null) return null;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const current = parseReviewTable(text);
  let rowIdx = -1;
  const out = lines.map((l) => {
    if (/^\|\s*File:Line\s*\|/i.test(l)) return current.hasPublishColumn ? l : `${l.trimEnd()} Publish |`;
    if (/^\|\s*-{3,}/.test(l)) return current.hasPublishColumn ? l : `${l.trimEnd()}---|`;
    if (!isRow(l)) return l;
    rowIdx++;
    const cells = splitCells(l).map((c) => c.replace(/\|/g, '\\|'));
    const prev = current.rows[rowIdx]?.publish ?? false;
    const next = rowIdx in flags ? flags[rowIdx] : prev;
    return `| ${cells[0]} | ${cells[1] ?? ''} | ${next ? '[x]' : '[ ]'} |`;
  });
  await fs.writeFile(file, out.join(nl), 'utf8');
  return parseReviewTable(out.join(nl));
}

const CONTEXT = 5;
async function fetchSnippet(slug: string, ref: string, filePath: string, line: number): Promise<Snippet> {
  const b64 = await run('gh', ['api', `repos/${slug}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, '-q', '.content']);
  const all = Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8').split(/\r?\n/);
  if (line > all.length) throw new Error(`file has ${all.length} lines on ${ref}, comment points at ${line}`);
  const start = Math.max(1, line - CONTEXT);
  return { startLine: start, focus: line, lines: all.slice(start - 1, Math.min(all.length, line + CONTEXT)), ref };
}

export function snippet(slug: string, ref: string, filePath: string, line: number): Cached<Snippet> {
  return cached(`blob:${slug}:${ref}:${filePath}:${line}`, 2 * 60_000, () => fetchSnippet(slug, ref, filePath, line));
}
