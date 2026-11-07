import { collectAssumptions, listPlannedTickets, readPrReviews, readTicketArtifacts, type Assumption, type QaCheckArtifact, type TicketArtifacts } from './artifacts.ts';
import { ghStatus, prInfo, prNumberForBranch, prNumberFromUrl, prNumbersForTicket, repoSlug, type PrInfo } from './github.ts';
import { SPRINT_JQL, jiraConfig, jiraIssue, jiraSprintIssues, type JiraIssue, type SprintIssue } from './jira.ts';
import { isRunning, listLaunches, type Launch } from './launch.ts';
import { readHeadlessAgents, readLocalBranches, readQaStack, readRuns, readSlots, readWorktrees, type HeadlessAgent, type LocalBranch, type PipelineRun, type QaStack, type RunTicket, type Slot, type StageEvent, type Worktree } from './pipeline.ts';
import { listQuestions, type Question } from './questions.ts';
import { ARCHIVE_JIRA_STATUSES, archiveTicket, listArchivedTickets, readArchived, type Archived } from './archive.ts';
import { ticketProgress, ticketStatus, type TicketStatus } from './ticket-status.ts';
import type { Cached } from './util.ts';

export type StageState = 'done' | 'active' | 'failed' | 'pending' | 'skipped' | 'warn';
export type Stage = { key: string; label: string; state: StageState; detail: string | null };
export type NextStep = { command: string | null; reason: string; urgency: 'now' | 'soon' | 'wait' | 'done' };
export type PrView = { number: number; role: 'main' | 'release' | 'cherrypick'; info: Cached<PrInfo> };

export type TicketView = {
  ticket: string; title: string | null; artifacts: TicketArtifacts; assumptions: Assumption[]; stages: Stage[]; status: TicketStatus; nextStep: NextStep;
  jira: Cached<JiraIssue> | null; prs: PrView[]; worktree: Worktree | null; branches: LocalBranch[]; slot: Slot | null; agents: HeadlessAgent[];
  latestRun: { runId: string; ticket: RunTicket } | null; questions: Question[]; openQuestions: number; lastActivity: string | null;
  models: { reviewer: string; fixer: string; planner: string; qa: string; orchestrator: string };
  archived: Archived | null; sprint: { name: string | null; mine: boolean; rank: number } | null; covered: boolean; launches: Launch[]; testUrl: string | null;
};

export type DashboardState = {
  generatedAt: string; repo: Cached<string>; gh: Cached<{ ok: boolean; detail: string }>; jira: Awaited<ReturnType<typeof jiraConfig>>;
  tickets: TicketView[]; archived: TicketView[]; runs: PipelineRun[]; worktrees: Worktree[]; slots: Slot[]; agents: HeadlessAgent[]; questions: Question[];
  prReviews: Awaited<ReturnType<typeof readPrReviews>>; launches: Launch[];
  sprint: { jql: string; filter: 'mine' | 'all'; total: number | null; mine: number | null; shown: number; error: string | null; loading: boolean };
};

const BRANCH_ONLY_MAX_AGE_MS = 45 * 24 * 3600_000;

const PR_LIKELY_STATUS = /pull request|merged|deployed|qc|review/i;

function resolvePrs(a: TicketArtifacts, branches: LocalBranch[], sprintOnly: SprintIssue | null): PrView[] {
  const out: PrView[] = [];
  if (sprintOnly && !PR_LIKELY_STATUS.test(sprintOnly.status)) return out;
  const lb = a.localBranch;
  const main = prNumberFromUrl(lb?.prUrl);
  if (main) out.push({ number: main, role: 'main', info: prInfo(main) });
  else {
    const branch = lb?.branch ?? branches[0]?.name;
    const byBranch = branch ? prNumberForBranch(branch).value : null;
    if (byBranch) out.push({ number: byBranch, role: 'main', info: prInfo(byBranch) });
    else if (!branch || prNumberForBranch(branch).fetchedAt) {
      const found = prNumbersForTicket(a.ticket).value ?? [];
      for (const n of found.slice(0, 2)) out.push({ number: n, role: 'main', info: prInfo(n) });
    }
  }
  const rel = prNumberFromUrl(lb?.releasePrUrl);
  if (rel) out.push({ number: rel, role: 'release', info: prInfo(rel) });
  const cp = prNumberFromUrl(lb?.mainCherrypickPrUrl);
  if (cp) out.push({ number: cp, role: 'cherrypick', info: prInfo(cp) });
  return out;
}

const POST_IMPLEMENT = ['code-review', 'commit', 'qa-check', 'land', 'publish'];
const PRE_LAND = ['plan', 'implement', 'code-review', 'commit', 'qa-check'];

export function settleRunningStages(stages: Stage[], runLive: boolean): void {
  const at = (key: string) => stages.find((s) => s.key === key);
  const impl = at('implement');
  if (impl && impl.state !== 'failed' && impl.state !== 'active') {
    const later = stages.filter((s) => POST_IMPLEMENT.includes(s.key));
    if (later.some((s) => s.state !== 'pending' && s.state !== 'skipped')) impl.state = at('code-review')?.state === 'active' ? 'active' : 'done';
  }
  const land = at('land');
  const running = stages.find((s) => PRE_LAND.includes(s.key) && s.state === 'active') ?? (runLive && at('qa-check')?.state === 'pending' ? at('qa-check') : null);
  if (land?.state === 'warn' && running) land.state = 'pending', land.detail = `waits for ${running.label}`;
}

export function qaTestUrl(ticket: string, stages: Stage[], branch: string | null, head: string | null, stack: QaStack | null): string | null {
  if (!stack?.branch || !branch || stack.branch !== branch) return null;
  if (stack.lockedBy && stack.lockedBy !== ticket) return null;
  if (head && stack.sha && !stack.sha.startsWith(head) && !head.startsWith(stack.sha)) return null;
  if (stages.some((s) => PRE_LAND.includes(s.key) && s.state === 'active')) return null;
  const qa = stages.find((s) => s.key === 'qa-check')?.state;
  return qa === 'done' || qa === 'warn' ? stack.url : null;
}

function buildStages(v: Omit<TicketView, 'stages' | 'status' | 'nextStep' | 'models' | 'testUrl'>): Stage[] {
  const a = v.artifacts;
  const run = v.latestRun?.ticket;
  const runStage = (name: string) => run?.stages.filter((s) => s.stage === name).at(-1) ?? null;
  const activePhase = v.agents.find((ag) => ag.phase)?.phase ?? (run?.running ? run.stages.filter((s) => s.state === 'in progress').at(-1)?.stage : null) ?? null;
  const lbStatus = a.localBranch?.status ?? null;
  const fastTracked = lbStatus === 'fast-tracked-to-release';
  const mainPr = (fastTracked ? v.prs.find((p) => p.role === 'release')?.info.value : null) ?? v.prs.find((p) => p.role === 'main')?.info.value ?? null;

  const plan: Stage = { key: 'plan', label: 'Plan', state: 'pending', detail: null };
  if (a.plan) plan.state = 'done', plan.detail = a.plan.total ? `${a.plan.total} to-dos` : 'older plan, no to-do list';
  if (activePhase === 'plan') plan.state = 'active';
  if (runStage('plan')?.state === 'failed') plan.state = 'failed', plan.detail = runStage('plan')?.raw ?? null;

  const impl: Stage = { key: 'implement', label: 'Impl', state: 'pending', detail: a.plan ? (a.plan.total ? `${a.plan.ticked}/${a.plan.total}` : 'plan has no to-do list') : null };
  if (a.plan && a.plan.total > 0 && a.plan.ticked === a.plan.total) impl.state = 'done';
  else if (a.plan && a.plan.ticked > 0) impl.state = 'warn', impl.detail = `${a.plan.ticked}/${a.plan.total} ticked`;
  if (a.codeReview || a.localBranch) impl.state = impl.state === 'pending' ? 'done' : impl.state;
  if (activePhase === 'implement') impl.state = 'active';
  if (runStage('implement')?.state === 'failed') impl.state = 'failed', impl.detail = runStage('implement')?.raw ?? null;

  const review: Stage = { key: 'code-review', label: 'Review', state: 'pending', detail: null };
  if (a.codeReview) {
    review.state = a.codeReview.status === 'needs-manual-review' || a.codeReview.finalStatus === 'FINDINGS' ? 'warn' : 'done';
    review.detail = [a.codeReview.rounds ? `${a.codeReview.rounds} round${a.codeReview.rounds === 1 ? '' : 's'}` : null, a.codeReview.finalStatus, a.codeReview.status === 'needs-manual-review' ? 'needs manual review' : null].filter(Boolean).join(' · ');
  }
  if (activePhase === 'code-review') review.state = 'active';
  if (runStage('code-review')?.state === 'failed') review.state = 'failed', review.detail = runStage('code-review')?.raw ?? null;

  const commit: Stage = { key: 'commit', label: 'Commit', state: 'pending', detail: a.localBranch?.branch ?? null };
  if (a.localBranch) commit.state = 'done';
  if (activePhase === 'commit') commit.state = 'active';
  if (runStage('commit')?.state === 'failed') commit.state = 'failed', commit.detail = runStage('commit')?.raw ?? null;

  const qa: Stage = { key: 'qa-check', label: 'QA', state: 'pending', detail: null };
  if (a.qaCheck) {
    const q = a.qaCheck;
    const browserOff = !!q.browser && /^(skipped|blocked)/i.test(q.browser);
    qa.state = q.status === 'needs-manual-qa' || q.finalStatus === 'FINDINGS' || browserOff ? 'warn' : 'done';
    qa.detail = [q.rounds ? `${q.rounds} round${q.rounds === 1 ? '' : 's'}` : null, q.finalStatus, q.browser ? `browser ${q.browser}` : null, q.codeChanged ? 'fixed code' : null, q.status === 'needs-manual-qa' ? 'needs manual QA' : null].filter(Boolean).join(' · ');
  }
  if (activePhase === 'qa-check') qa.state = 'active';
  if (runStage('qa-check')?.state === 'failed') qa.state = 'failed', qa.detail = runStage('qa-check')?.raw ?? null;

  const land: Stage = { key: 'land', label: 'Land', state: 'pending', detail: null };
  if (lbStatus === 'ready-for-review' || lbStatus === 'draft-pr-open') land.state = 'warn', land.detail = `${lbStatus}: needs /w-3-land-branch`;
  else if (lbStatus && ['ready-for-push', 'pushed', 'fast-tracked-to-release'].includes(lbStatus)) land.state = 'done', land.detail = lbStatus;
  else if (a.localBranch) land.detail = lbStatus;

  const publish: Stage = { key: 'publish', label: 'PR', state: 'pending', detail: null };
  if (mainPr) {
    publish.state = mainPr.isDraft ? 'warn' : 'done';
    publish.detail = `#${mainPr.number}${mainPr.isDraft ? ' draft' : ''}`;
  } else if (lbStatus === 'pushed' || a.localBranch?.prUrl) publish.state = 'done', publish.detail = a.localBranch?.prUrl ?? null;
  if (activePhase === 'draft-pr') publish.state = 'active';
  if (runStage('draft-pr')?.state === 'failed') publish.state = 'failed', publish.detail = runStage('draft-pr')?.raw ?? null;

  const reviewed: Stage = { key: 'pr-review', label: 'Approved', state: 'pending', detail: null };
  if (mainPr) {
    if (mainPr.state === 'MERGED') reviewed.state = 'done', reviewed.detail = 'merged';
    else if (mainPr.changesRequestedBy.length) reviewed.state = 'failed', reviewed.detail = `changes requested by ${mainPr.changesRequestedBy.join(', ')}`;
    else if (mainPr.unresolvedThreads || mainPr.newSinceLastPush) reviewed.state = 'warn', reviewed.detail = `${mainPr.unresolvedThreads} unresolved · ${mainPr.newSinceLastPush} new since push`;
    else if (mainPr.reviewDecision === 'APPROVED') reviewed.state = 'done', reviewed.detail = `approved by ${mainPr.approvedBy.join(', ') || '?'}`;
    else if (!mainPr.isDraft) reviewed.state = 'active', reviewed.detail = 'waiting for review';
  }

  const merged: Stage = { key: 'merged', label: 'Merge', state: 'pending', detail: null };
  if (mainPr?.state === 'MERGED') merged.state = 'done', merged.detail = mainPr.mergedAt;
  else if (mainPr?.state === 'CLOSED') merged.state = 'failed', merged.detail = 'closed without merge';
  if (lbStatus === 'fast-tracked-to-release') merged.detail = [merged.detail, `fast-tracked to ${a.localBranch?.frontmatter.release_branch ?? 'release'}`].filter(Boolean).join(' · ');

  const stages = [plan, impl, review, commit, qa, land, publish, reviewed, merged];
  settleRunningStages(stages, !!(run?.running || v.agents.length));
  if (!a.plan && !a.localBranch && mainPr) for (const st of [plan, impl, review, commit, qa, land]) if (st.state === 'pending') st.state = 'skipped', st.detail = 'not run through the skills';
  return stages;
}

function archiveReason(v: Omit<TicketView, 'stages' | 'status' | 'nextStep' | 'models' | 'archived' | 'testUrl'>): string | null {
  const j = v.jira?.value;
  if (!j || !ARCHIVE_JIRA_STATUSES.includes(j.status)) return null;
  const lb = v.artifacts.localBranch;
  if (lb?.status === 'fast-tracked-to-release') {
    const rel = v.prs.find((p) => p.role === 'release')?.info.value;
    const cp = v.prs.find((p) => p.role === 'cherrypick')?.info.value;
    if (rel?.state === 'MERGED' && cp?.state === 'MERGED') return `release PR #${rel.number} and cherry-pick PR #${cp.number} merged; JIRA "${j.status}"`;
    return null;
  }
  const main = v.prs.find((p) => p.role === 'main')?.info.value;
  if (main?.state === 'MERGED') return `PR #${main.number} merged; JIRA "${j.status}"`;
  return null;
}

function jiraNote(v: TicketView): string {
  const j = v.jira?.value;
  if (!j) return '';
  return j.statusCategory === 'done' ? ' JIRA is done.' : ` JIRA: ${j.status}.`;
}

function recycleFinished(run: RunTicket | null): boolean {
  if (!run || run.exitCode !== 0) return false;
  const last = (stage: string, state?: StageEvent['state']) => run.stages.findLastIndex((s) => s.stage === stage && (!state || s.state === state));
  return last('commit', 'done') > last('qa-check');
}

function browserRerunNote(qa: QaCheckArtifact | null, t: string): string {
  if (!qa?.browser || !/^(skipped|blocked)/i.test(qa.browser)) return '';
  return ` QA had no browser pass (${qa.browser}); once landed, start the app and run /w-1-coding ${t} just-qa-check here.`;
}

function suggestNextStep(v: Omit<TicketView, 'status' | 'nextStep' | 'models' | 'testUrl'>): NextStep {
  const a = v.artifacts;
  const t = v.ticket;
  const mainPr = v.prs.find((p) => p.role === 'main')?.info.value ?? null;
  const lb = a.localBranch;
  const pipelineRunning = !!v.slot || v.agents.length > 0 || !!v.latestRun?.ticket.running;

  if (v.prs.some((p) => p.info.loading && !p.info.value)) return { command: null, reason: 'PR data is still loading; the next step is decided once it arrives.', urgency: 'wait' };
  if (v.openQuestions) return { command: null, reason: `Answer the ${v.openQuestions} open question${v.openQuestions > 1 ? 's' : ''} below; the skill is waiting on it.`, urgency: 'now' };
  if (pipelineRunning) {
    const phase = v.agents.find((ag) => ag.phase)?.phase ?? v.latestRun?.ticket.stages.filter((s) => s.state === 'in progress').at(-1)?.stage ?? 'a stage';
    return { command: null, reason: `Pipeline is running (${phase}). Wait for it; watch the log tab.`, urgency: 'wait' };
  }
  if (v.latestRun?.ticket.failedAt && !(lb && ['pushed', 'fast-tracked-to-release'].includes(lb.status)) && !mainPr) {
    const failed = v.latestRun.ticket.failedAt;
    const phaseCmd = failed === 'draft-pr' ? `/w-4-publish ${t} draft` : `/w-1-coding ${t} just-${failed} here`;
    return { command: phaseCmd, reason: `Last pipeline run failed at ${failed} (run ${v.latestRun.runId}). Check the log, then re-run that phase; every phase is re-entrant.`, urgency: 'now' };
  }

  if (lb?.status === 'fast-tracked-to-release') {
    const rel = v.prs.find((p) => p.role === 'release')?.info.value ?? null;
    const cp = v.prs.find((p) => p.role === 'cherrypick')?.info.value ?? null;
    if (rel && rel.state === 'OPEN') {
      if (rel.unresolvedThreads || rel.changesRequestedBy.length) return { command: null, reason: `Release PR #${rel.number} has ${rel.unresolvedThreads} unresolved thread(s). Address them on the release branch.`, urgency: 'now' };
      return { command: null, reason: `Hotfix PR #${rel.number} into ${lb.frontmatter.release_branch ?? 'the release branch'} is ${rel.reviewDecision === 'APPROVED' ? 'approved; merge it' : 'waiting for review'}.`, urgency: rel.reviewDecision === 'APPROVED' ? 'now' : 'wait' };
    }
    if (!lb.mainCherrypickPrUrl) return { command: `/w-4-2-cherrypick-to-main ${t}`, reason: 'Hotfix is on the release branch; main still needs the cherry-pick PR.', urgency: 'soon' };
    if (cp && cp.state === 'OPEN') return { command: null, reason: `Cherry-pick PR #${cp.number} into main is ${cp.reviewDecision === 'APPROVED' ? 'approved; merge it' : 'waiting for review'}.`, urgency: cp.reviewDecision === 'APPROVED' ? 'now' : 'wait' };
    if (rel?.state === 'MERGED' && cp?.state === 'MERGED') {
      return { command: null, reason: `Hotfix merged to the release branch and cherry-picked to main.${jiraNote(v)} Nothing left.`, urgency: 'done' };
    }
    if (!rel || !cp) return { command: null, reason: 'Fast-tracked; release and cherry-pick PR data still loading.', urgency: 'wait' };
  }

  if (mainPr) {
    if (mainPr.state === 'MERGED') {
      if (lb?.status === 'fast-tracked-to-release' && !lb.mainCherrypickPrUrl) return { command: `/w-4-2-cherrypick-to-main ${t}`, reason: 'Hotfix landed on the release branch; main still needs the cherry-pick PR.', urgency: 'soon' };
      return { command: null, reason: `PR #${mainPr.number} merged.${jiraNote(v)} Nothing left.`, urgency: 'done' };
    }
    if (mainPr.state === 'CLOSED') return { command: null, reason: `PR #${mainPr.number} was closed without merging. Decide whether to reopen or drop the branch.`, urgency: 'soon' };
    if (mainPr.isDraft) {
      if (lb?.status === 'draft-pr-open') return { command: `/w-3-land-branch ${t}`, reason: 'Draft PR is up from an unattended run. Land the branch for a human pass, then publish it as ready.', urgency: 'now' };
      return { command: `/w-4-publish ${t}`, reason: 'PR is still a draft. Publishing marks it ready for review.', urgency: 'soon' };
    }
    if (mainPr.changesRequestedBy.length || mainPr.unresolvedThreads > 0) return { command: `/w-5-resolve-pr-comments ${t}`, reason: `${mainPr.unresolvedThreads} unresolved review thread${mainPr.unresolvedThreads === 1 ? '' : 's'}${mainPr.changesRequestedBy.length ? `, changes requested by ${mainPr.changesRequestedBy.join(', ')}` : ''}.`, urgency: 'now' };
    if (mainPr.newSinceLastPush > 0) return { command: `/w-5-resolve-pr-comments ${t}`, reason: `${mainPr.newSinceLastPush} new comment${mainPr.newSinceLastPush === 1 ? '' : 's'} since the last push, not yet addressed.`, urgency: 'now' };
    if (mainPr.mergeable === 'CONFLICTING' || mainPr.mergeStateStatus === 'DIRTY') return { command: `/w-6-rebase-with-main ${t}`, reason: 'PR has merge conflicts with main.', urgency: 'now' };
    if (mainPr.checksState === 'failure' || mainPr.checksState === 'error') return { command: null, reason: `CI is failing: ${mainPr.checks.filter((c) => ['failure', 'error', 'timed_out'].includes(c.status)).map((c) => c.name).join(', ') || 'see PR'}. Fix it before asking for another review.`, urgency: 'now' };
    if (mainPr.mergeStateStatus === 'BEHIND') return { command: `/w-6-rebase-with-main ${t}`, reason: 'PR is behind main and the repo requires branches to be up to date.', urgency: 'soon' };
    if (mainPr.reviewDecision === 'APPROVED') return { command: null, reason: `Approved by ${mainPr.approvedBy.join(', ') || 'a reviewer'}${mainPr.checksState === 'pending' ? ', CI still running' : ''}. Merge it.`, urgency: 'now' };
    return { command: null, reason: 'Open and waiting for a reviewer. Nothing to do until a comment or an approval lands.', urgency: 'wait' };
  }

  if (lb) {
    const qa = a.qaCheck;
    if (qa?.codeChanged && !recycleFinished(v.latestRun?.ticket ?? null)) {
      if (!a.codeReview?.mtime || !qa.mtime || a.codeReview.mtime < qa.mtime) return { command: `/w-1-coding ${t} just-code-review here`, reason: 'QA changed code after the commit; it needs a re-review, then a re-commit.', urgency: 'now' };
      if (!lb.mtime || lb.mtime < qa.mtime) return { command: `/w-1-coding ${t} just-commit here`, reason: 'QA fixes are re-reviewed but not folded into the commit yet.', urgency: 'now' };
    }
    if (!qa && lb.status === 'ready-for-push') return { command: `/w-1-coding ${t} just-qa-check here`, reason: 'Committed locally; the QA check has not run yet.', urgency: 'now' };
    if (qa?.browser && /^(skipped|blocked)/i.test(qa.browser) && lb.status === 'ready-for-push') return { command: `/w-1-coding ${t} just-qa-check here`, reason: `QA ran without a browser pass: ${qa.browser}. Start the app (make start, http://localhost:3000) and re-run the QA check here.`, urgency: 'now' };
    if (qa?.status === 'needs-manual-qa' && lb.status === 'ready-for-push') return { command: `/w-4-publish ${t}`, reason: `QA left ${qa.openFindings.length || 'some'} open finding(s) in qa-check.md. Read them, fix by hand or publish as is.`, urgency: 'now' };
    switch (lb.status) {
      case 'ready-for-review': return { command: `/w-3-land-branch ${t}`, reason: `Unattended run committed the branch. It needs a human pass before it can be pushed.${browserRerunNote(qa, t)}`, urgency: 'now' };
      case 'draft-pr-open': return { command: `/w-3-land-branch ${t}`, reason: `Draft PR is open; the PR lookup is still loading or the PR could not be found.${browserRerunNote(qa, t)}`, urgency: 'now' };
      case 'ready-for-push': return { command: `/w-4-publish ${t}`, reason: 'Branch is committed and reviewed locally. Push it and open the PR.', urgency: 'now' };
      case 'pushed': return { command: null, reason: 'Recorded as pushed but no PR was found for it yet; check pr_url in local-branch.md.', urgency: 'soon' };
      case 'fast-tracked-to-release': return { command: lb.mainCherrypickPrUrl ? null : `/w-4-2-cherrypick-to-main ${t}`, reason: lb.mainCherrypickPrUrl ? 'Hotfix and its main cherry-pick PR both exist. Watch the release PR.' : 'Hotfix is on the release branch; main still needs the cherry-pick.', urgency: lb.mainCherrypickPrUrl ? 'wait' : 'soon' };
      default: return { command: null, reason: `local-branch.md has status "${lb.status}", which no skill produces. Inspect the file.`, urgency: 'soon' };
    }
  }
  if (a.codeReview) {
    if (a.codeReview.status === 'needs-manual-review') return { command: `/w-1-coding ${t} just-commit here`, reason: 'Review loop hit its cap with findings left; read the unresolved list, then commit or fix by hand.', urgency: 'now' };
    return { command: `/w-1-coding ${t} just-commit here`, reason: 'Code review passed; nothing is committed yet.', urgency: 'now' };
  }
  if (a.plan) {
    if (a.plan.total && a.plan.ticked === a.plan.total) return { command: `/w-1-coding ${t} just-code-review here`, reason: 'All to-dos ticked, no review yet.', urgency: 'now' };
    if (a.plan.ticked > 0) return { command: `/w-1-coding ${t} just-implement here`, reason: `${a.plan.ticked}/${a.plan.total} to-dos done; implement resumes from the first unchecked box.`, urgency: 'now' };
    const blocking = a.plan.risks.filter((r) => /attach|screenshot|confirm|blocking|needs the developer/i.test(r) && !/human-answered/i.test(r));
    if (blocking.length) return { command: `/w-1-coding ${t} just-implement here`, reason: `Plan is ready but ${blocking.length} open question${blocking.length === 1 ? '' : 's'} may block implementation; read Risks first.`, urgency: 'soon' };
    return { command: `/w-1-coding ${t}`, reason: 'Plan exists, nothing implemented. A full run goes implement → review → commit in a worktree.', urgency: 'now' };
  }
  if (v.branches.length) return { command: `/w-4-publish ${v.branches[0].name}`, reason: 'A local branch exists for this ticket but it never went through the skills (no plan). Publish it by hand or plan it.', urgency: 'soon' };
  if (v.sprint && !v.covered) {
    const j = v.jira?.value;
    const status = j?.status ?? 'unknown';
    if (j && PR_LIKELY_STATUS.test(status) && !v.prs.length) return { command: null, reason: `In the sprint at "${status}" with no plan, branch or PR here: being handled outside the skills${j.assignee ? ` by ${j.assignee}` : ''}.`, urgency: 'wait' };
    if (j && /in progress/i.test(status) && !v.sprint.mine) return { command: `/w-1-coding ${t} just-plan`, reason: `In progress for ${j.assignee ?? 'someone else'}; nothing from the skills yet. Plan only if you are taking it over.`, urgency: 'wait' };
    if (v.sprint.mine) return { command: `/w-1-coding ${t}`, reason: `Assigned to you in the sprint at "${status}"; the skills have not touched it. A full run plans here, then implements, reviews and commits in a worktree.`, urgency: 'now' };
    return { command: `/w-1-coding ${t} just-plan`, reason: `In the sprint at "${status}", ${j?.assignee ? `assigned to ${j.assignee}` : 'unassigned'}; nothing started by the skills.`, urgency: 'soon' };
  }
  return { command: `/w-1-coding ${t} just-plan`, reason: 'No plan yet.', urgency: 'now' };
}

export async function buildState(opts: { sprint?: 'mine' | 'all' } = {}): Promise<DashboardState> {
  const sprintFilter = opts.sprint === 'all' ? 'all' : 'mine';
  const [planned, runs, worktrees, slots, agents, questions, branches, prReviews, jira, sideArchived, launches, qaStack] = await Promise.all([
    listPlannedTickets(), readRuns(), readWorktrees(), readSlots(), readHeadlessAgents(), listQuestions(), readLocalBranches(), readPrReviews(), jiraConfig(), listArchivedTickets(), listLaunches(), readQaStack(),
  ]);
  const sprintCache = jira.configured ? jiraSprintIssues() : null;
  const sprintAll = sprintCache?.value ?? [];
  const sprintShown = sprintAll.filter((i) => sprintFilter === 'all' || i.mine);
  const sprintByKey = new Map(sprintAll.map((i) => [i.key, i]));
  const ids = new Set<string>([...planned, ...sideArchived]);
  for (const i of sprintShown) ids.add(i.key);
  for (const l of launches) if (l.ticket && isRunning(l)) ids.add(l.ticket);
  for (const w of worktrees) if (w.ticket) ids.add(w.ticket);
  for (const s of slots) ids.add(s.ticket);
  const liveBranches = branches.filter((b) => !/^backup\//.test(b.name));
  for (const b of liveBranches) if (Date.now() - new Date(b.committedAt).getTime() < BRANCH_ONLY_MAX_AGE_MS) ids.add(b.ticket);
  for (const q of questions) if (q.ticket && q.status === 'open') ids.add(q.ticket);
  for (const r of runs.slice(0, 5)) for (const t of r.tickets) ids.add(t.ticket);

  const tickets: TicketView[] = [];
  for (const ticket of ids) {
    const artifacts = await readTicketArtifacts(ticket);
    const tBranches = liveBranches.filter((b) => b.ticket === ticket).sort((x, y) => y.committedAt.localeCompare(x.committedAt));
    const latestRunEntry = runs.flatMap((r) => r.tickets.filter((t) => t.ticket === ticket).map((t) => ({ runId: r.id, ticket: t })))[0] ?? null;
    const tLaunches = launches.filter((l) => l.ticket === ticket);
    const covered = !!(artifacts.plan || artifacts.localBranch || artifacts.codeReview || tBranches.length || latestRunEntry || worktrees.some((w) => w.ticket === ticket) || slots.some((s) => s.ticket === ticket) || questions.some((q) => q.ticket === ticket) || tLaunches.length);
    const sprintIssue = sprintByKey.get(ticket) ?? null;
    const base = {
      ticket, title: artifacts.plan?.title ?? null, artifacts, assumptions: collectAssumptions(artifacts), covered, launches: tLaunches,
      sprint: sprintIssue ? { name: sprintIssue.sprint, mine: sprintIssue.mine, rank: sprintIssue.rank } : null,
      jira: jira.configured ? jiraIssue(ticket) : null, prs: resolvePrs(artifacts, tBranches, covered ? null : sprintIssue), worktree: worktrees.find((w) => w.ticket === ticket) ?? null,
      branches: tBranches, slot: slots.find((s) => s.ticket === ticket) ?? null, agents: agents.filter((ag) => ag.ticket === ticket),
      latestRun: latestRunEntry, questions: questions.filter((q) => q.ticket === ticket), openQuestions: questions.filter((q) => q.ticket === ticket && q.status === 'open').length,
      lastActivity: [artifacts.lastActivity, latestRunEntry?.ticket.logMtime, ...tBranches.map((b) => b.committedAt)].filter((x): x is string => !!x).sort().at(-1) ?? null,
    };
    if (base.jira?.value?.summary && !base.title) base.title = base.jira.value.summary;
    const stages = buildStages(base);
    const nextStep = suggestNextStep({ ...base, stages });
    const branch = artifacts.localBranch?.branch ?? null;
    const testUrl = qaTestUrl(ticket, stages, branch, base.worktree?.head ?? tBranches.find((b) => b.name === branch)?.sha ?? null, qaStack);
    const cr = artifacts.codeReview?.models;
    const qm = artifacts.qaCheck?.models;
    let archived = await readArchived(ticket);
    if (!archived) {
      const reason = archiveReason(base);
      if (reason) archived = await archiveTicket(ticket, reason);
    }
    tickets.push({ ...base, stages, status: ticketStatus(stages), nextStep, models: { reviewer: cr?.reviewer ?? 'unknown', fixer: cr?.fixer ?? qm?.fixer ?? 'unknown', planner: cr?.planner ?? 'unknown', qa: qm?.qa ?? 'unknown', orchestrator: 'sonnet (w-1-coding SKILL.md)' }, archived, testUrl });
  }
  const rank = (t: TicketView) => (t.openQuestions ? 0 : t.slot || t.agents.length || t.latestRun?.ticket.running || t.launches.some(isRunning) ? 1 : !t.covered ? (t.sprint?.mine ? 6 : 7) : t.nextStep.urgency === 'now' ? 2 : t.nextStep.urgency === 'soon' ? 3 : t.nextStep.urgency === 'wait' ? 4 : 5);
  const live = tickets.filter((t) => !t.archived);
  live.sort((a, b) => ticketProgress(b.stages) - ticketProgress(a.stages) || rank(a) - rank(b) || ((a.sprint?.rank ?? 1e9) - (b.sprint?.rank ?? 1e9)) || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  const archived = tickets.filter((t) => t.archived).sort((a, b) => b.archived!.at.localeCompare(a.archived!.at));
  const sprint = {
    jql: SPRINT_JQL, filter: sprintFilter, total: sprintCache?.value ? sprintAll.length : null, mine: sprintCache?.value ? sprintAll.filter((i) => i.mine).length : null,
    shown: sprintShown.length, error: sprintCache?.error ?? (jira.configured ? null : 'JIRA off'), loading: !!sprintCache?.loading,
  };
  return { generatedAt: new Date().toISOString(), repo: repoSlug(), gh: ghStatus(), jira, tickets: live, archived, runs, worktrees, slots, agents, questions, prReviews, launches, sprint };
}
