import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DASHBOARD_DIR, cached, primeCache, type Cached } from './util.ts';

export type JiraIssue = {
  key: string; url: string; summary: string; status: string; statusCategory: string; issueType: string; assignee: string | null; assigneeId: string | null;
  priority: string | null; updated: string; sprint: string | null; parent: string | null;
};
export type SprintIssue = JiraIssue & { mine: boolean; rank: number };
export type JiraConfig = { configured: boolean; site: string; email: string | null; reason: string | null };

let envMtime = -1;
const envKeys = new Set<string>();
async function loadDotEnv(): Promise<void> {
  const file = path.join(DASHBOARD_DIR, '.env');
  let mtime = 0;
  try { mtime = (await fs.stat(file)).mtimeMs; } catch { /* no .env */ }
  if (mtime === envMtime) return;
  envMtime = mtime;
  for (const k of envKeys) delete process.env[k];
  envKeys.clear();
  if (!mtime) return;
  const text = await fs.readFile(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (!v) continue;
    process.env[m[1]] = v;
    envKeys.add(m[1]);
  }
}

export async function jiraConfig(): Promise<JiraConfig> {
  await loadDotEnv();
  const site = (process.env.JIRA_SITE ?? 'welligence.atlassian.net').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const email = process.env.JIRA_EMAIL ?? null;
  const token = process.env.JIRA_API_TOKEN ?? null;
  if (!email || !token) return { configured: false, site, email, reason: 'Set JIRA_EMAIL and JIRA_API_TOKEN in pipeline-dashboard/.env (token: https://id.atlassian.com/manage-profile/security/api-tokens).' };
  return { configured: true, site, email, reason: null };
}

const FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'priority', 'updated', 'parent', 'customfield_10020'];
export const SPRINT_JQL = process.env.JIRA_SPRINT_JQL ?? 'project = XWWP AND sprint in openSprints() AND statusCategory != Done AND issuetype != Epic ORDER BY Rank ASC';

async function jiraFetch(pathname: string, init: RequestInit = {}): Promise<any> {
  const cfg = await jiraConfig();
  if (!cfg.configured) throw new Error(cfg.reason ?? 'JIRA not configured');
  const auth = Buffer.from(`${cfg.email}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  const res = await fetch(`https://${cfg.site}${pathname}`, { ...init, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`JIRA ${res.status} for ${pathname}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function toIssue(site: string, j: any): JiraIssue {
  const f = j.fields;
  const sprints = Array.isArray(f.customfield_10020) ? f.customfield_10020 : [];
  const activeSprint = sprints.find((s: any) => s.state === 'active') ?? sprints[sprints.length - 1];
  return {
    key: j.key, url: `https://${site}/browse/${j.key}`, summary: f.summary, status: f.status?.name ?? 'unknown', statusCategory: f.status?.statusCategory?.key ?? 'unknown',
    issueType: f.issuetype?.name ?? 'unknown', assignee: f.assignee?.displayName ?? null, assigneeId: f.assignee?.accountId ?? null, priority: f.priority?.name ?? null, updated: f.updated,
    sprint: activeSprint?.name ?? null, parent: f.parent?.key ?? null,
  };
}

async function fetchIssue(key: string): Promise<JiraIssue> {
  const cfg = await jiraConfig();
  return toIssue(cfg.site, await jiraFetch(`/rest/api/3/issue/${key}?fields=${FIELDS.join(',')}`));
}

export function jiraIssue(key: string): Cached<JiraIssue> {
  return cached(`jira:${key}`, 90_000, () => fetchIssue(key));
}

export type JiraIssueDetail = JiraIssue & { descriptionHtml: string | null; reporter: string | null; created: string; labels: string[]; parentSummary: string | null; resolution: string | null };

const DETAIL_FIELDS = [...FIELDS, 'description', 'reporter', 'created', 'labels', 'resolution'];

function absolutizeJiraHtml(site: string, html: string): string {
  return html.replace(/(src|href)="\/(?!\/)/g, `$1="https://${site}/`);
}

async function fetchIssueDetail(key: string): Promise<JiraIssueDetail> {
  const cfg = await jiraConfig();
  const j = await jiraFetch(`/rest/api/3/issue/${key}?fields=${DETAIL_FIELDS.join(',')}&expand=renderedFields`);
  const f = j.fields;
  const rendered = typeof j.renderedFields?.description === 'string' ? j.renderedFields.description : null;
  return {
    ...toIssue(cfg.site, j), descriptionHtml: rendered ? absolutizeJiraHtml(cfg.site, rendered) : null, reporter: f.reporter?.displayName ?? null, created: f.created,
    labels: Array.isArray(f.labels) ? f.labels : [], parentSummary: f.parent?.fields?.summary ?? null, resolution: f.resolution?.name ?? null,
  };
}

export function jiraIssueDetail(key: string): Cached<JiraIssueDetail> {
  return cached(`jira-detail:${key}`, 90_000, () => fetchIssueDetail(key));
}

async function fetchMyAccountId(): Promise<string> {
  return (await jiraFetch('/rest/api/3/myself')).accountId;
}

async function fetchSprintIssues(): Promise<SprintIssue[]> {
  const cfg = await jiraConfig();
  const me = await fetchMyAccountId();
  const out: SprintIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jiraFetch('/rest/api/3/search/jql', { method: 'POST', body: JSON.stringify({ jql: SPRINT_JQL, maxResults: 100, fields: FIELDS, nextPageToken }) });
    for (const j of page.issues ?? []) {
      const issue = toIssue(cfg.site, j);
      primeCache(`jira:${issue.key}`, issue);
      out.push({ ...issue, mine: !!issue.assigneeId && issue.assigneeId === me, rank: out.length });
    }
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && out.length < 500);
  return out;
}

export function jiraSprintIssues(): Cached<SprintIssue[]> {
  return cached('jira-sprint', 120_000, fetchSprintIssues);
}
