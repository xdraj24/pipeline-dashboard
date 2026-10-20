import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './util.ts';

export type Question = {
  id: string; ticket: string | null; label: string | null; phase: string | null; question: string; options: string[]; createdAt: string;
  source: string | null; status: 'open' | 'answered' | 'expired'; answer: string | null; answeredAt: string | null; answeredVia: string | null;
  slackTs: string | null; cwd: string | null;
};

export const QUESTIONS_DIR = path.join(DATA_DIR, 'questions');

export async function listQuestions(): Promise<Question[]> {
  await fs.mkdir(QUESTIONS_DIR, { recursive: true });
  const out: Question[] = [];
  for (const n of await fs.readdir(QUESTIONS_DIR)) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fs.readFile(path.join(QUESTIONS_DIR, n), 'utf8'))); } catch { /* half-written file; next poll picks it up */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getQuestion(id: string): Promise<Question | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  try { return JSON.parse(await fs.readFile(path.join(QUESTIONS_DIR, `${id}.json`), 'utf8')); } catch { return null; }
}

async function writeQuestion(q: Question): Promise<void> {
  await fs.mkdir(QUESTIONS_DIR, { recursive: true });
  const file = path.join(QUESTIONS_DIR, `${q.id}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(q, null, 2));
  await fs.rename(tmp, file);
}

export async function createQuestion(input: Partial<Question> & { question: string }): Promise<Question> {
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
  const q: Question = {
    id, ticket: input.ticket ? input.ticket.toUpperCase() : null, label: input.label ?? null, phase: input.phase ?? null, question: input.question,
    options: Array.isArray(input.options) ? input.options.map(String) : [], createdAt: new Date().toISOString(), source: input.source ?? null,
    status: 'open', answer: null, answeredAt: null, answeredVia: null, slackTs: input.slackTs ?? null, cwd: input.cwd ?? null,
  };
  await writeQuestion(q);
  return q;
}

export async function answerQuestion(id: string, answer: string, via = 'dashboard'): Promise<Question | null> {
  const q = await getQuestion(id);
  if (!q) return null;
  const next: Question = { ...q, status: 'answered', answer, answeredAt: new Date().toISOString(), answeredVia: via };
  await writeQuestion(next);
  return next;
}

export async function patchQuestion(id: string, patch: Partial<Question>): Promise<Question | null> {
  const q = await getQuestion(id);
  if (!q) return null;
  const next = { ...q, ...patch, id: q.id };
  await writeQuestion(next);
  return next;
}
