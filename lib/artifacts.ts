import path from 'node:path';
import { parseReviewTable } from './review-file.ts';
import {
  REPO_ROOT, bullets, findSection, listDir, normalizeTicket, parseFrontmatter, readText, sections, statMtime, TICKET_RE,
} from './util.ts';

export type Todo = { text: string; done: boolean };
export type Assumption = { source: string; text: string; humanAnswered: boolean };
export type Models = { reviewer: string; fixer: string; planner: string; qa: string; mentions: string[] };

export type PlanArtifact = {
  path: string; mtime: string | null; frontmatter: Record<string, string>; title: string | null; summary: string | null;
  todos: Todo[]; ticked: number; total: number; risks: string[]; implementationLog: string[]; filesToTouch: string[];
};
export type CodeReviewArtifact = {
  path: string; mtime: string | null; frontmatter: Record<string, string>; status: string; rounds: number | null;
  finalStatus: 'GREEN' | 'FINDINGS' | null; unresolved: string[]; models: Models;
};
export type QaCheckArtifact = {
  path: string; mtime: string | null; frontmatter: Record<string, string>; status: string; codeChanged: boolean; browser: string | null;
  rounds: number | null; finalStatus: 'PASS' | 'FINDINGS' | null; openFindings: string[]; models: Models;
};
export type ChangeNotesArtifact = {
  path: string; mtime: string | null; frontmatter: Record<string, string>; whatChanged: string[]; decisions: string[]; assumptions: string[];
};
export type LocalBranchArtifact = {
  path: string; mtime: string | null; frontmatter: Record<string, string>; status: string; branch: string | null; prUrl: string | null;
  releasePrUrl: string | null; mainCherrypickPrUrl: string | null; overview: string | null; testing: string | null; assumptionsMade: string[];
};
export type TicketArtifacts = {
  ticket: string; dir: string; plan: PlanArtifact | null; codeReview: CodeReviewArtifact | null; qaCheck: QaCheckArtifact | null;
  changeNotes: ChangeNotesArtifact | null; localBranch: LocalBranchArtifact | null; otherFiles: string[]; lastActivity: string | null;
};

const MODEL_WORDS = /\b(opus|sonnet|haiku|fable|mythos|gpt-[\w.-]+|o[1-9][\w-]*|codex|gemini[\w.-]*|claude-[\w.-]+)\b/gi;

export function extractModels(text: string): Models {
  const mentions = [...new Set((text.match(MODEL_WORDS) ?? []).map((m) => m.toLowerCase()))];
  const pick = (role: string): string => {
    const a = text.match(new RegExp(`(${MODEL_WORDS.source})[ \\t-]*(?:as\\s+)?${role}\\b`, 'i'));
    if (a) return a[1].toLowerCase();
    const b = text.match(new RegExp(`${role}(?:\\s+role)?\\s*[:=(]\\s*\\x60?(${MODEL_WORDS.source})`, 'i'));
    if (b) return b[1].toLowerCase();
    const c = text.match(new RegExp(`${role}[^.\\n]{0,40}?\\bran (?:on|by|with)\\s+(${MODEL_WORDS.source})`, 'i'));
    if (c) return c[1].toLowerCase();
    return 'unknown';
  };
  return { reviewer: pick('reviewer'), fixer: pick('fixer'), planner: pick('planner'), qa: pick('qa'), mentions };
}

async function readPlan(file: string): Promise<PlanArtifact | null> {
  const text = await readText(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const secs = sections(body);
  const todoText = findSection(secs, /^to-?do/i) ?? '';
  const todos: Todo[] = [];
  for (const line of todoText.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (m) todos.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
    else if (todos.length && /^\s{2,}\S/.test(line)) todos[todos.length - 1].text += ' ' + line.trim();
  }
  const h1 = body.match(/^#\s+(.+)$/m);
  return {
    path: file, mtime: await statMtime(file), frontmatter: data,
    title: data.title ?? (h1 ? h1[1].replace(/^XWWP-\d+\s*[—–-]\s*/, '') : null),
    summary: (findSection(secs, /^summary/i) ?? '').trim() || null,
    todos, ticked: todos.filter((t) => t.done).length, total: todos.length,
    risks: bullets(findSection(secs, /risks|open questions/i)),
    implementationLog: bullets(findSection(secs, /implementation log/i)),
    filesToTouch: bullets(findSection(secs, /files to touch/i)),
  };
}

async function readCodeReview(file: string): Promise<CodeReviewArtifact | null> {
  const text = await readText(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const secs = sections(body);
  const roundHeads = body.match(/^#{1,4}\s*round\s+\d+/gim) ?? [];
  const roundsStmt = body.match(/(?:rounds?\s*(?:run|total|count)?\s*[:=]?\s*\*?\*?\s*(\d+)|(\d+)\s+rounds?\s+total)/i);
  const rounds = roundsStmt ? Number(roundsStmt[1] ?? roundsStmt[2]) : roundHeads.length || null;
  const greens = [...body.matchAll(/STATUS:\s*(GREEN|FINDINGS)/gi)];
  const finalStatus = greens.length ? (greens[greens.length - 1][1].toUpperCase() as 'GREEN' | 'FINDINGS') : null;
  return {
    path: file, mtime: await statMtime(file), frontmatter: data,
    status: data.status ?? (finalStatus === 'GREEN' ? 'passed' : finalStatus === 'FINDINGS' ? 'findings' : 'unknown'),
    rounds, finalStatus, unresolved: bullets(findSection(secs, /unresolved/i)), models: extractModels(body),
  };
}

async function readQaCheck(file: string): Promise<QaCheckArtifact | null> {
  const text = await readText(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const secs = sections(body);
  const verdicts = [...body.matchAll(/QA:\s*(PASS|FINDINGS)/gi)];
  const finalStatus = verdicts.length ? (verdicts[verdicts.length - 1][1].toUpperCase() as 'PASS' | 'FINDINGS') : null;
  const rounds = Number(data.rounds);
  return {
    path: file, mtime: await statMtime(file), frontmatter: data, status: data.status ?? 'unknown', codeChanged: /^yes$/i.test(data.code_changed ?? ''),
    browser: data.browser || null, rounds: Number.isFinite(rounds) && rounds > 0 ? rounds : null, finalStatus,
    openFindings: bullets(findSection(secs, /open findings|unresolved/i)).filter((x) => !/^none\b/i.test(x)), models: extractModels(body),
  };
}

async function readChangeNotes(file: string): Promise<ChangeNotesArtifact | null> {
  const text = await readText(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const secs = sections(body);
  return {
    path: file, mtime: await statMtime(file), frontmatter: data,
    whatChanged: bullets(findSection(secs, /what changed/i)), decisions: bullets(findSection(secs, /decisions/i)),
    assumptions: bullets(findSection(secs, /assumptions/i)),
  };
}

async function readLocalBranch(file: string): Promise<LocalBranchArtifact | null> {
  const text = await readText(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const secs = sections(body);
  return {
    path: file, mtime: await statMtime(file), frontmatter: data, status: data.status ?? 'unknown', branch: data.branch ?? null,
    prUrl: data.pr_url || null, releasePrUrl: data.release_pr_url || null, mainCherrypickPrUrl: data.main_cherrypick_pr_url || null,
    overview: findSection(secs, /overview/i) ?? null, testing: findSection(secs, /testing/i) ?? null,
    assumptionsMade: bullets(findSection(secs, /assumptions/i)),
  };
}

export async function readTicketArtifacts(ticket: string): Promise<TicketArtifacts> {
  const dir = path.join(REPO_ROOT, '.jira-plans', ticket);
  const files = await listDir(dir);
  const [plan, codeReview, qaCheck, changeNotes, localBranch] = await Promise.all([
    readPlan(path.join(dir, 'plan.md')), readCodeReview(path.join(dir, 'code-review.md')), readQaCheck(path.join(dir, 'qa-check.md')),
    readChangeNotes(path.join(dir, 'change-notes.md')), readLocalBranch(path.join(dir, 'local-branch.md')),
  ]);
  const known = new Set(['plan.md', 'code-review.md', 'qa-check.md', 'change-notes.md', 'local-branch.md']);
  const mtimes = [plan, codeReview, qaCheck, changeNotes, localBranch].map((a) => a?.mtime).filter((m): m is string => !!m).sort();
  return {
    ticket, dir, plan, codeReview, qaCheck, changeNotes, localBranch, otherFiles: files.filter((f) => !known.has(f)),
    lastActivity: mtimes.length ? mtimes[mtimes.length - 1] : null,
  };
}

export async function listPlannedTickets(): Promise<string[]> {
  return (await listDir(path.join(REPO_ROOT, '.jira-plans'))).filter((n) => TICKET_RE.test(n)).map(normalizeTicket);
}

export function collectAssumptions(a: TicketArtifacts): Assumption[] {
  const out: Assumption[] = [];
  for (const r of a.plan?.risks ?? []) out.push({ source: 'plan: risks / open questions', text: r, humanAnswered: /human-answered|answered via/i.test(r) });
  for (const l of a.plan?.implementationLog ?? []) if (/assum|decid|default|deviat|chose|picked|instead/i.test(l)) out.push({ source: 'plan: implementation log', text: l, humanAnswered: false });
  for (const x of a.changeNotes?.assumptions ?? []) out.push({ source: 'change-notes: assumptions', text: x, humanAnswered: /human-answered|answered via|reply/i.test(x) && !/no reply/i.test(x) });
  for (const x of a.changeNotes?.decisions ?? []) out.push({ source: 'change-notes: decisions', text: x, humanAnswered: false });
  for (const x of a.codeReview?.unresolved ?? []) out.push({ source: 'code-review: unresolved at pipeline completion', text: x, humanAnswered: false });
  for (const x of a.qaCheck?.openFindings ?? []) out.push({ source: 'qa-check: open findings', text: x, humanAnswered: false });
  for (const x of a.localBranch?.assumptionsMade ?? []) out.push({ source: 'local-branch: assumptions made', text: x, humanAnswered: false });
  return out;
}

export type PrReviewFile = {
  pr: number | null; dir: string; frontmatter: Record<string, string>; status: string; title: string | null; commentCount: number; publishCount: number | null; mtime: string | null;
};

export async function readPrReviews(): Promise<{ candidates: Record<string, string> | null; candidatesRows: string[]; reviews: PrReviewFile[] }> {
  const dir = path.join(REPO_ROOT, '.pr-reviews');
  const names = await listDir(dir);
  const reviews: PrReviewFile[] = [];
  for (const n of names.filter((x) => /^PR-\d+$/i.test(x))) {
    const file = path.join(dir, n, 'review.md');
    const text = await readText(file);
    if (text === null) continue;
    const { data, body } = parseFrontmatter(text);
    const h1 = body.match(/^#\s+(.+)$/m);
    const table = parseReviewTable(body);
    reviews.push({ pr: Number(data.pr_number ?? n.replace(/\D/g, '')) || null, dir: path.join(dir, n), frontmatter: data, status: data.status ?? 'unknown', title: h1 ? h1[1] : null, commentCount: table.rows.length, publishCount: table.hasPublishColumn ? table.rows.filter((r) => r.publish).length : null, mtime: await statMtime(file) });
  }
  const cand = await readText(path.join(dir, 'candidates.md'));
  const candidatesRows = cand ? cand.split(/\r?\n/).filter((l) => /^\|\s*#\d+/.test(l)) : [];
  return { candidates: cand ? parseFrontmatter(cand).data : null, candidatesRows, reviews: reviews.sort((a, b) => (b.mtime ?? '').localeCompare(a.mtime ?? '')) };
}
