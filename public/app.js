const PAGE = document.body.dataset.page || 'board';
const allTickets = () => (state ? [...state.tickets, ...state.archived] : []);
let state = null;
let selected = null;
let tab = 'overview';
let logTimer = null;
let launchId = null;

const sprintFilter = () => { try { return localStorage.getItem('sprintFilter') || 'mine'; } catch { return 'mine'; } };

async function load() {
  try {
    const res = await fetch(`/api/state?sprint=${sprintFilter()}`);
    state = await res.json();
    render();
  } catch (e) {
    $('#status-row').innerHTML = hs('bad', `Server unreachable: ${esc(e.message)}`);
  }
}

function validateHtml(t) {
  const checks = t.artifacts.plan?.manualChecks ?? [];
  const fallback = t.artifacts.localBranch?.testing;
  if (!t.testUrl || (!checks.length && !fallback)) return '';
  return `<div class="validate"><b>Check on ${esc(t.testUrl.replace(/^https?:\/\//, ''))}:</b>${checks.length ? `<ul>${checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : `<p>${esc(fallback)}</p>`}</div>`;
}

const testLink = (t) => t.testUrl ? `<a class="pill ok" href="${esc(t.testUrl)}" target="_blank" rel="noopener" title="QA stack is serving this branch">test on ${esc(t.testUrl.replace(/^https?:\/\//, ''))}</a>` : '';

function prChip(pv) {
  const p = pv.info.value;
  const role = pv.role === 'main' ? '' : `${pv.role} `;
  if (!p) return pill(pv.info.error ? 'bad' : '', `${role}PR #${pv.number} ${pv.info.error ? 'error' : '…'}`, pv.info.error ?? 'loading');
  let cls = 'active', label = 'open';
  if (p.state === 'MERGED') { cls = 'done'; label = 'merged'; }
  else if (p.state === 'CLOSED') { cls = 'bad'; label = 'closed'; }
  else if (p.isDraft) { cls = 'warn'; label = 'draft'; }
  else if (p.changesRequestedBy.length) { cls = 'bad'; label = 'changes requested'; }
  else if (p.reviewDecision === 'APPROVED') { cls = 'ok'; label = 'approved'; }
  const extras = [];
  if (p.state === 'OPEN') {
    if (p.unresolvedThreads) extras.push(`${p.unresolvedThreads} unresolved`);
    if (p.newSinceLastPush) extras.push(`${p.newSinceLastPush} new`);
    if (p.checksState && p.checksState !== 'success') extras.push(`CI ${p.checksState}`);
    if (p.mergeable === 'CONFLICTING') extras.push('conflicts');
  }
  return `<a href="${p.url}" target="_blank" onclick="event.stopPropagation()">${pill(cls, `${role}#${p.number} ${label}${extras.length ? ' · ' + extras.join(' · ') : ''}`, p.title)}</a>`;
}

function jiraText(t) {
  if (!state.jira.configured || !t.jira) return '';
  const j = t.jira.value;
  if (!j) return `JIRA ${t.jira.error ? 'error' : '…'}`;
  return `<a href="${j.url}" target="_blank" onclick="event.stopPropagation()" title="${esc(`${j.issueType} · ${j.assignee ?? 'unassigned'} · ${j.sprint ?? 'no sprint'}`)}">JIRA ${esc(j.status)}</a>`;
}

function runBtns(t, command, terminal = false) {
  const live = t.launches.find((l) => l.how === 'headless' && !l.endedAt);
  if (live) return `<button data-stop-launch="${live.id}" title="SIGTERM the headless claude process">Stop</button>`;
  return `${terminal ? `<button data-run="${esc(command)}" data-run-ticket="${t.ticket}" data-run-how="terminal" title="Open Terminal.app with an interactive claude session running this command">Terminal</button>` : ''}<button class="primary" data-run="${esc(command)}" data-run-ticket="${t.ticket}" data-run-how="headless" title="Run claude -p with this command from the repo root">Run</button>`;
}

function recordedModels(m) {
  const roles = ['reviewer', 'fixer', 'qa'].filter((r) => m[r] !== 'unknown').map((r) => `${r} ${esc(m[r])}`);
  return roles.length ? roles.join(' · ') : '';
}

function launchChip(t) {
  const live = t.launches.find((l) => l.how === 'headless' && !l.endedAt);
  if (live) return pill('active', `<span class="dot pulse"></span> launched ${ago(live.startedAt)}`, live.command);
  const last = t.launches[0];
  if (!last || last.how !== 'headless') return '';
  return pill(last.exitCode === 0 ? 'ok' : 'bad', `last launch ${last.exitCode === 0 ? 'ok' : last.error ? 'stopped' : `exit ${last.exitCode ?? '?'}`} ${ago(last.endedAt)}`, last.command);
}

const isRunning = (t) => !!(t.slot || t.agents.length || t.latestRun?.ticket.running);

function flagOf(t) {
  if (t.openQuestions) return `${t.openQuestions} open question${t.openQuestions > 1 ? 's' : ''}`;
  if (t.artifacts.codeReview?.status === 'needs-manual-review') return 'Review needs manual pass';
  if (t.artifacts.qaCheck?.status === 'needs-manual-qa') return 'QA needs manual pass';
  return '';
}

function groupOf(t) {
  if (t.openQuestions) return 'you';
  if (isRunning(t)) return 'running';
  if (!t.covered) return 'todo';
  if (t.nextStep.urgency === 'done') return 'done';
  return t.nextStep.urgency === 'wait' ? 'wait' : 'you';
}

const GROUPS = [
  ['you', 'Needs you', 'Questions, human passes and commands waiting to run', ''],
  ['running', 'Running', 'No action needed', 'blue'],
  ['wait', 'Waiting', 'On a reviewer, CI or someone else', 'grey'],
  ['todo', 'Not started', 'In the sprint, not touched by the skills', 'grey'],
  ['done', 'Done', 'Merged; nothing left', 'grey'],
];

const LEGEND = [['done', 'Finished OK'], ['active', 'In progress'], ['warn', 'Needs attention'], ['failed', 'Failed'], ['pending', 'Not started']];

const segsHtml = (t) => `<div class="segs">${t.stages.map((s) => `<span class="seg ${s.state}" title="${esc(`${s.label} — ${s.state}${s.detail ? ': ' + s.detail : ''}`)}">${s.label}</span>`).join('')}</div>`;

function nextBlock(t) {
  const n = t.nextStep;
  return `<div class="row-next"><span class="nb ${n.urgency}">${n.urgency}</span><div>
    <div class="next-text ellipsis" title="${esc(n.reason)}">${esc(n.reason)}</div>
    ${n.command ? cmdBox(n.command, runBtns(t, n.command)) : ''}
  </div></div>`;
}

function rowHtml(t) {
  const running = isRunning(t);
  const flag = flagOf(t);
  const meta = [
    flag ? `<span class="flag">${esc(flag)}</span>` : '',
    running ? `${esc(t.agents[0]?.phase ?? 'pipeline')} running${t.slot ? ` · slot ${t.slot.slot}` : ''}` : '',
    jiraText(t),
    t.artifacts.localBranch && !running ? esc(t.artifacts.localBranch.status) : '',
    t.assumptions.length ? `${t.assumptions.length} assumptions` : '',
    t.worktree ? `${t.worktree.dirtyFiles ?? '?'} dirty` : '',
    recordedModels(t.models),
  ].filter(Boolean).join(' · ');
  const chips = [launchChip(t), t.sprint && !t.sprint.mine ? pill('', 'sprint', t.sprint.name ?? '') : '', t.archived ? pill('done', `archived ${ago(t.archived.at)}`, `${t.archived.reason} · ${t.archived.file}`) : '', ...t.prs.map(prChip), testLink(t)].filter(Boolean).join('');
  return `<div class="row ${groupOf(t) === 'you' ? 'you' : ''} ${t.archived ? 'archived' : ''} ${t.covered ? '' : 'uncovered'} ${selected === t.ticket ? 'selected' : ''}" data-ticket="${t.ticket}">
    <div class="row-main">
      <div class="row-top"><div class="row-title ellipsis" title="${esc(t.title ?? '')}"><b>${t.ticket}</b> ${esc(t.title ?? '')}</div><span class="row-age">${t.lastActivity ? ago(t.lastActivity) : (t.covered ? '' : 'not started')}</span></div>
      ${meta ? `<div class="row-meta ellipsis">${meta}</div>` : ''}
      ${chips ? `<div class="row-chips">${chips}</div>` : ''}
      ${validateHtml(t)}
    </div>
    ${segsHtml(t)}
    ${nextBlock(t)}
  </div>`;
}

function renderBoard() {
  const showDone = $('#show-done')?.checked ?? true;
  const list = state.tickets.filter((t) => showDone || t.nextStep.urgency !== 'done');
  if (!list.length) { $('#tickets').innerHTML = '<div class="panel empty">No tickets found under .ai-workspace/jira-plans, worktrees, slots or local branches.</div>'; return; }
  const groups = GROUPS.map(([key, label, desc, color]) => ({ label, desc, color, items: list.filter((t) => groupOf(t) === key) })).filter((g) => g.items.length);
  $('#tickets').innerHTML = `<div class="legend">${LEGEND.map(([cls, label]) => `<span><i class="seg ${cls}"></i>${label}</span>`).join('')}</div>
    <div class="panel" style="margin-top:12px">${groups.map((g) => `<div class="grp-head"><span class="eyebrow ${g.color}">${g.label} · ${g.items.length}</span><span class="desc ellipsis">${g.desc}</span></div>${g.items.map(rowHtml).join('')}`).join('')}</div>`;
}

function renderHistory() {
  const list = state.archived;
  const head = `<div class="grp-head"><span class="eyebrow">Archived · ${list.length}</span><span class="desc ellipsis">PR merged and JIRA reached "QC'd on STG" or "Delivered IN APP.WELLIGENCE"; plan.md frontmatter carries an archived: line</span></div>`;
  if (!list.length) { $('#tickets').innerHTML = `<div class="panel">${head}<div class="empty">Nothing archived yet. A ticket lands here once its PR is merged and JIRA reaches one of the archive statuses.</div></div>`; return; }
  $('#tickets').innerHTML = `<div class="panel">${head}<div class="grid-wrap"><table class="grid fixed"><colgroup><col style="width:96px"><col style="width:34%"><col style="width:110px"><col style="width:76px"><col style="width:26%"><col></colgroup><tr><th>Ticket</th><th>Title</th><th>JIRA</th><th>Archived</th><th>Local branch</th><th>Next step</th></tr>${list.map((t) => {
    const branch = t.artifacts.localBranch?.branch ?? t.branches[0]?.name;
    const n = t.nextStep;
    return `<tr class="clickable" data-ticket="${t.ticket}"><td><b>${t.ticket}</b></td><td class="clip" title="${esc(t.title ?? '')}">${esc(t.title ?? '')}</td>
      <td class="muted">${t.jira?.value ? esc(t.jira.value.status) : '—'}</td><td class="muted">${t.archived ? ago(t.archived.at) : '—'}</td>
      <td class="clip"><code class="${branch ? '' : 'muted'}" title="${esc(branch ?? '')}">${esc(branch ?? 'No local branch')}</code></td>
      <td title="${esc(n.reason)}">${n.command ? `${copyBtn(n.command)} <code>${esc(n.command)}</code>` : `<span class="muted">${esc(n.reason)}</span>`}</td></tr>`;
  }).join('')}</table></div></div>`;
}

function renderTickets() {
  if (PAGE === 'history') renderHistory(); else renderBoard();
}

function renderQuestions() {
  const open = state.questions.filter((q) => q.status === 'open');
  document.title = (open.length ? `(${open.length}) ` : '') + (PAGE === 'history' ? 'Skills dashboard · History' : 'Skills dashboard');
  const el = $('#questions');
  if (!el) return;
  el.classList.toggle('hidden', !open.length);
  el.innerHTML = open.map((q) => `<div class="q" data-q="${q.id}">
    <div class="meta"><span class="eyebrow">Question from a skill</span> <b>${esc(q.ticket ?? q.label ?? '')}</b> ${esc(q.phase ?? '')} · ${esc(q.source ?? '')} · ${ago(q.createdAt)}${q.slackTs ? ' · also in Slack' : ''}</div>
    <div class="text">${esc(q.question)}</div>
    ${q.options.length ? `<div class="opts">${q.options.map((o, i) => `<button class="primary" data-answer="${esc(o)}">${i + 1}. ${esc(o)}</button>`).join('')}</div>` : ''}
    <div class="free"><input type="text" placeholder="Free-text answer" data-free><button data-send>Answer</button></div>
  </div>`).join('');
}

function renderStatus() {
  const running = state.agents.length;
  const used = new Map(state.slots.map((s) => [s.slot, s.ticket]));
  $('#repo').textContent = state.repo.value ?? '';
  $('#history-count').textContent = state.archived.length ? ` ${state.archived.length}` : '';
  const sprint = state.jira.configured ? (state.sprint.total === null ? (state.sprint.error ? 'sprint error' : 'sprint …') : `${state.sprint.shown} shown`) : '';
  $('#status-row').innerHTML = [
    `<span class="hs" title="Pipeline slots">Slots <span class="slots">${[1, 2, 3, 4, 5, 6].map((n) => `<span class="${used.has(n) ? 'on' : ''}" title="Slot ${n}: ${esc(used.get(n) ?? 'free')}"></span>`).join('')}</span><b>${state.slots.length}/6</b></span>`,
    `<span class="hs" title="Headless agent processes">Headless <b>${running}</b></span>`,
    hs(state.gh.value?.ok ? '' : 'bad', state.gh.value ? (state.gh.value.ok ? 'GitHub' : 'GitHub not logged in') : 'GitHub …', state.gh.value?.detail ?? ''),
    hs(state.jira.configured ? '' : 'off', state.jira.configured ? 'JIRA' : 'JIRA off', state.jira.configured ? state.jira.email : state.jira.reason ?? state.jira.site),
    sprint ? `<span class="hs" title="${esc(state.sprint.error ?? `${state.sprint.shown} shown · ${state.sprint.mine} mine · ${state.sprint.total} open in sprint\n${state.sprint.jql ?? ''}`)}">${esc(sprint)}</span>` : '',
    `<span class="hs" title="Last refresh">${ago(state.generatedAt)}</span>`,
  ].join('');
}

function renderLaunches() {
  if (!$('#launches')) return;
  const ls = state.launches;
  $('#launches-count').textContent = `· ${ls.length}`;
  $('#launches').innerHTML = ls.length ? `<div class="grid-wrap"><table class="grid"><tr><th>Started</th><th>Ticket</th><th>Command</th><th>How</th><th>Status</th><th></th></tr>${ls.map((l) => {
    const running = l.how === 'headless' && !l.endedAt;
    const status = l.how === 'terminal' ? (l.error ? `terminal: ${esc(l.error)}` : 'Opened in Terminal') : running ? pill('active', `<span class="dot pulse"></span> running · pid ${l.pid}`) : l.exitCode === 0 ? pill('ok', `ok · ${ago(l.endedAt)}`) : pill('bad', `${l.error ? esc(l.error) : `exit ${l.exitCode ?? '?'}`} · ${ago(l.endedAt)}`);
    return `<tr><td class="muted">${ago(l.startedAt)}</td><td>${l.ticket ? `<a href="#" data-ticket="${l.ticket}">${l.ticket}</a>` : '—'}</td><td><code>${esc(l.command)}</code></td><td class="muted">${l.how}</td><td class="muted">${status}</td>
      <td>${l.logPath ? `<a href="#" data-launch-log="${l.id}" data-ticket="${l.ticket ?? ''}">Log</a>` : ''} ${running ? `<button data-stop-launch="${l.id}">Stop</button>` : ''}</td></tr>`;
  }).join('')}</table></div>` : '<div class="empty">Nothing launched yet. Run on a row runs its command headlessly from the repo root; Terminal in the detail opens it in Terminal.app instead.</div>';
}

const RUN_STAGE = { 'in progress': 'active', complete: 'done', retrying: 'warn', other: 'warn' };

function renderRuns() {
  if (!$('#runs')) return;
  $('#runs-count').textContent = `· ${state.runs.length}`;
  $('#runs').innerHTML = state.runs.length ? `<div class="grid-wrap"><table class="grid"><tr><th>Run</th><th>Started</th><th>Tickets</th><th>Stages</th><th>Result</th></tr>${state.runs.map((r) => `<tr>
    <td><code>${r.id}</code></td><td class="muted">${ago(r.startedAt)}</td>
    <td>${r.tickets.map((t) => `<div><a href="#" data-ticket="${t.ticket}" data-run="${r.id}">${t.ticket}</a></div>`).join('')}</td>
    <td>${r.tickets.map((t) => `<div class="timeline">${t.stages.map((s) => `<span class="seg ${RUN_STAGE[s.state] ?? s.state}" title="${esc(s.raw)}">${esc(s.stage)}</span>`).join('')}</div>`).join('')}</td>
    <td>${r.tickets.map((t) => `<div>${t.running ? pill('active', 'running') : t.exitCode === 0 ? pill('ok', 'ok') : t.exitCode === null ? pill('warn', 'no status', 'process ended without writing .status') : pill('bad', `exit ${t.exitCode}${t.failedAt ? ' at ' + t.failedAt : ''}`)}</div>`).join('')}</td>
  </tr>`).join('')}</table></div>` : '<div class="empty">No pipeline runs under .ai-workspace/pipeline-logs.</div>';
}

function renderReviews() {
  if (!$('#reviews')) return;
  const pr = state.prReviews;
  $('#reviews-count').textContent = `· ${pr.reviews.length}`;
  $('#reviews').innerHTML = `${pr.candidates ? `<div class="empty">candidates.md generated ${ago(pr.candidates.generated_at)} · filter ${esc(pr.candidates.filter ?? '')} · ${pr.candidatesRows.length} candidates</div>` : ''}
  ${pr.reviews.length ? `<div class="grid-wrap"><table class="grid"><tr><th>PR</th><th>Title</th><th>Status</th><th>Comments</th><th>Reviewer</th><th>Verifier</th><th>Updated</th></tr>${pr.reviews.map((r) => `<tr>
    <td><a href="${esc(r.frontmatter.pr_url ?? '#')}" target="_blank">#${r.pr}</a></td><td class="clip" title="${esc(r.title ?? '')}">${esc(r.title ?? '')}</td><td>${pill(r.status === 'published' ? 'done solid' : r.status === 'verified' ? 'ok' : 'warn', esc(r.status))}</td>
    <td class="num">${r.commentCount}</td><td>${esc(r.frontmatter.review_model ?? '?')}</td><td>${esc(r.frontmatter.verified_model ?? '—')}</td><td class="muted">${ago(r.mtime)}</td></tr>`).join('')}</table></div>` : '<div class="empty">No drafted reviews under .ai-workspace/pr-reviews.</div>'}`;
}

function renderWorktrees() {
  if (!$('#worktrees')) return;
  $('#worktrees').innerHTML = `${state.agents.length ? `<div class="grid-wrap"><table class="grid"><tr><th>PID</th><th>Host</th><th>Ticket</th><th>Phase</th><th>Elapsed</th></tr>${state.agents.map((a) => `<tr><td><code>${a.pid}</code></td><td>${a.host}</td><td>${a.ticket ?? '?'}</td><td>${a.phase ?? '?'}</td><td>${a.elapsed}</td></tr>`).join('')}</table></div>` : '<div class="empty">No headless agent processes.</div>'}
  ${state.worktrees.length ? `<div class="grid-wrap"><table class="grid"><tr><th>Worktree</th><th>Branch</th><th style="text-align:right">Dirty</th><th style="text-align:right">Ahead</th></tr>${state.worktrees.map((w) => `<tr><td><b>${esc(w.name)}</b></td><td class="clip"><code title="${esc(w.branch ?? '')}">${esc(w.branch ?? `detached ${w.head}`)}</code></td><td class="num ${w.dirtyFiles ? 'hot' : 'muted'}">${w.dirtyFiles ?? '?'}</td><td class="num">${w.aheadOfMain ?? '?'}</td></tr>`).join('')}</table></div>` : '<div class="empty">No worktrees.</div>'}`;
}

function overviewHtml(t) {
  const a = t.artifacts;
  const n = t.nextStep;
  const branch = a.localBranch?.branch ?? t.branches.map((b) => b.name).join(', ');
  const defs = [
    t.archived ? ['Archived', `${ago(t.archived.at)} · ${esc(t.archived.reason)} <span class="muted">(marker in ${esc(t.archived.file)})</span>`] : null,
    ['Models', `reviewer <b>${esc(t.models.reviewer)}</b> · fixer <b>${esc(t.models.fixer)}</b> · planner <b>${esc(t.models.planner)}</b> · qa <b>${esc(t.models.qa)}</b><br><span class="muted">orchestrating skill: ${esc(t.models.orchestrator)}</span>`],
    ['Branch', branch ? `<code title="${esc(branch)}">${esc(branch)}</code>${t.branches[0]?.isCurrent ? ' (checked out)' : ''}` : '—'],
    ['Worktree', t.worktree ? `${t.worktree.dirtyFiles ?? '?'} dirty · ${t.worktree.aheadOfMain ?? '?'} ahead of main<code title="${esc(t.worktree.path)}">${esc(t.worktree.path)}</code>` : '—'],
    ['Code review', a.codeReview ? `${a.codeReview.rounds ?? '?'} round(s) · final ${a.codeReview.finalStatus ?? '?'} · ${esc(a.codeReview.status)}` : '—'],
    ['QA check', a.qaCheck ? `${a.qaCheck.rounds ?? '?'} round(s) · final ${a.qaCheck.finalStatus ?? '?'} · ${esc(a.qaCheck.status)} · browser ${esc(a.qaCheck.browser ?? '?')}${a.qaCheck.codeChanged ? ' · changed code' : ''}` : '—'],
    ['Test at', testLink(t) || '<span class="muted">Not on the QA stack</span>'],
    ['Last run', t.latestRun ? `${t.latestRun.runId} · ${t.latestRun.ticket.running ? 'running' : t.latestRun.ticket.exitCode === 0 ? 'ok' : `exit ${t.latestRun.ticket.exitCode ?? '?'}`}${t.latestRun.ticket.failedAt ? ` at ${t.latestRun.ticket.failedAt}` : ''}` : '—'],
    ['Files', ['plan', 'codeReview', 'qaCheck', 'changeNotes', 'localBranch'].filter((k) => a[k]).map((k) => { const p = a[k].path.replace(/.*\.ai-workspace\//, '.ai-workspace/'); return `<code title="${esc(p)}">${esc(p)}</code>`; }).join('') || '—'],
  ].filter(Boolean);
  return `<div class="callout ${groupOf(t) === 'you' ? 'you' : ''}">
      <div class="lead"><span class="nb ${n.urgency}">${n.urgency}</span><span>${esc(n.reason)}</span></div>
      ${n.command ? cmdBox(n.command, runBtns(t, n.command, true)) : ''}
      ${validateHtml(t)}
    </div>
    <div class="cols">
      <div class="block"><span class="eyebrow grey">Pipeline</span>${t.stages.map((s) => `<div class="stage-row ${s.state}"><span class="sw ${s.state}"></span><b>${s.label}</b><span class="note ellipsis" title="${esc(s.detail ?? '')}">${esc(s.detail ?? (s.state === 'pending' ? '—' : s.state))}</span></div>`).join('')}</div>
      <div class="block"><span class="eyebrow grey">Details</span><dl class="kv">${defs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
    </div>
    <div class="block"><span class="eyebrow grey">Assumptions and decisions · ${t.assumptions.length}</span>
      ${t.assumptions.length ? t.assumptions.map((x) => `<div class="arow"><span class="src">${esc(x.source)}${x.humanAnswered ? '<b>Human answered</b>' : ''}</span><span>${window.marked ? marked.parseInline(esc(x.text)) : esc(x.text)}</span></div>`).join('') : '<span class="muted">None recorded.</span>'}
    </div>`;
}

function prTabHtml(t) {
  if (!t.prs.length) return '<div class="muted">No PR found for this ticket (no pr_url in local-branch.md, no PR on its branch, none with the ticket id in the title).</div>';
  return t.prs.map((pv) => {
    const p = pv.info.value;
    if (!p) return `<div class="muted">PR #${pv.number}: ${esc(pv.info.error ?? 'loading…')}</div>`;
    return `<div class="block"><span class="eyebrow grey">${pv.role} PR</span>
      <div style="font-size:14px"><a href="${p.url}" target="_blank"><b>#${p.number}</b></a> ${esc(p.title)}</div>
      <dl class="kv">
        <dt>State</dt><dd>${prChip(pv)} ${p.mergedAt ? `merged ${ago(p.mergedAt)}` : ''}</dd>
        <dt>Review</dt><dd>${esc(p.reviewDecision ?? '—')}${p.approvedBy.length ? ` · approved by ${p.approvedBy.join(', ')}` : ''}${p.changesRequestedBy.length ? ` · changes requested by ${p.changesRequestedBy.join(', ')}` : ''}</dd>
        <dt>Threads</dt><dd>${p.unresolvedThreads} unresolved of ${p.threads.length}</dd>
        <dt>New</dt><dd>${p.newSinceLastPush} human comment(s) after the last commit (${p.lastCommitAt ? ago(p.lastCommitAt) : '?'})</dd>
        <dt>Merge</dt><dd>${esc(p.mergeable ?? '?')} · ${esc(p.mergeStateStatus ?? '?')} · <code style="display:inline">${p.headRefName} → ${p.baseRefName}</code> · <span style="color:var(--ok)">+${p.additions}</span> <span style="color:var(--bad)">−${p.deletions}</span></dd>
        <dt>CI</dt><dd>${esc(p.checksState ?? '—')} ${p.checks.filter((c) => !['success', 'skipped', 'neutral'].includes(c.status)).map((c) => pill(c.status === 'failure' ? 'bad' : 'warn', `${esc(c.name)}: ${esc(c.status)}`)).join(' ')}</dd>
      </dl>
      ${p.threads.filter((th) => !th.isResolved).map((th) => `<div class="thread unresolved"><b>${esc(th.author ?? '?')}</b> <code style="display:inline">${esc(th.path ?? '')}</code> <span class="muted small">${ago(th.createdAt)} · ${th.replies} replies${th.isOutdated ? ' · outdated' : ''}</span><div class="body">${esc(th.body)}</div></div>`).join('')}
      ${p.comments.slice(0, 10).map((c) => `<div class="thread"><b>${esc(c.author ?? '?')}</b> <span class="muted small">${c.kind} · ${ago(c.createdAt)}</span><div class="body">${esc(c.body)}</div></div>`).join('')}
    </div>`;
  }).join('');
}

async function renderDetail() {
  const t = allTickets().find((x) => x.ticket === selected);
  const el = $('#detail');
  showDrawer(!!t);
  if (!t) { clearInterval(logTimer); return; }
  const tabs = [['overview', 'Overview'], ['plan', 'Plan'], ['review', 'Code review'], ['qa', 'QA check'], ['notes', 'Change notes'], ['branch', 'Local branch'], ['pr', 'PR'], ['log', 'Pipeline log'], ['launch', 'Launch log'], ['questions', 'Questions', t.questions.length]];
  let body = '';
  if (tab === 'overview') body = overviewHtml(t);
  else if (['plan', 'review', 'qa', 'notes', 'branch'].includes(tab)) {
    const name = { plan: 'plan.md', review: 'code-review.md', qa: 'qa-check.md', notes: 'change-notes.md', branch: 'local-branch.md' }[tab];
    const r = await fetch(`/api/tickets/${t.ticket}/artifact/${name}`);
    body = r.ok ? docHtml((await r.json()).text) : `<div class="muted">No ${name} for ${t.ticket} yet.</div>`;
  } else if (tab === 'pr') body = prTabHtml(t);
  else if (tab === 'log') body = '<div id="log-meta" class="logmeta"></div><pre class="log" id="log"></pre>';
  else if (tab === 'launch') {
    const withLog = t.launches.filter((l) => l.logPath);
    if (!withLog.length) body = '<div class="muted">No headless launch for this ticket from the dashboard yet.</div>';
    else {
      launchId = withLog.some((l) => l.id === launchId) ? launchId : withLog[0].id;
      body = `<div class="tabs sub">${withLog.map((l) => `<button class="${launchId === l.id ? 'on' : ''}" data-launch-pick="${l.id}">${ago(l.startedAt)} · ${esc(l.command)}</button>`).join('')}</div><div id="log-meta" class="logmeta"></div><pre class="log" id="log"></pre>`;
    }
  } else if (tab === 'questions') {
    body = t.questions.length ? `<div>${t.questions.map((q) => `<div class="thread ${q.status === 'open' ? 'unresolved' : ''}"><span class="muted small"><b style="color:var(--navy)">${esc(q.phase ?? '')}</b> · ${ago(q.createdAt)} · ${esc(q.status)}${q.answeredVia ? ` via ${esc(q.answeredVia)}` : ''}</span><div class="body">${esc(q.question)}</div>${q.answer ? `<div class="body"><span class="muted">Answer</span> <b>${esc(q.answer)}</b></div>` : ''}</div>`).join('')}</div>` : '<div class="muted">No questions were raised for this ticket.</div>';
  }
  const j = t.jira?.value;
  const view = `${t.ticket}/${tab}`;
  const scroll = el.dataset.view === view ? $('.drawer-body', el)?.scrollTop ?? 0 : 0;
  el.dataset.view = view;
  el.innerHTML = `<div class="drawer-head">
      <div class="drawer-title"><div><a class="id" href="https://${state.jira.site}/browse/${t.ticket}" target="_blank">${t.ticket}</a> ${esc(t.title ?? '')} <span class="sub">${[j ? `JIRA ${esc(j.status)}` : '', t.lastActivity ? ago(t.lastActivity) : ''].filter(Boolean).join(' · ')}</span></div><button data-close title="Close (Esc)">Close</button></div>
      <div class="tabs">${tabs.map(([k, l, c]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}${c ? `<span> ${c}</span>` : ''}</button>`).join('')}</div>
    </div>
    <div class="drawer-body">${body}</div>`;
  $('.drawer-body', el).scrollTop = scroll;
  clearInterval(logTimer);
  if (tab === 'log') { const tick = () => loadLog(t); tick(); logTimer = setInterval(tick, 3000); }
  if (tab === 'launch' && launchId) { const tick = () => pollLaunchLog(launchId); tick(); logTimer = setInterval(tick, 3000); }
}

async function loadLog(t) {
  const r = await fetch(`/api/tickets/${t.ticket}/log`);
  const pre = $('#log'); const meta = $('#log-meta');
  if (!pre) return;
  if (!r.ok) { pre.textContent = ''; meta.textContent = 'No pipeline log for this ticket.'; return; }
  const d = await r.json();
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  meta.innerHTML = `<code>${esc(d.path.replace(/.*\.claude\//, '.claude/'))}</code> · ${(d.size / 1024).toFixed(0)} KB ${d.running ? pill('active', '<span class="dot pulse"></span> running') : d.exitCode === 0 ? pill('done solid', 'finished ok') : pill('bad', `exit ${d.exitCode ?? '?'}`)}${d.truncated ? ' · showing the tail' : ''}`;
  pre.textContent = d.text;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function render() {
  renderStatus(); renderQuestions(); renderTickets(); renderLaunches(); renderRuns(); renderReviews(); renderWorktrees(); renderDetail();
}

async function launchCommand(btn) {
  const { runTicket: ticket, runHow: how } = btn.dataset;
  const l = await postLaunch(btn, { ticket });
  if (!l) return;
  if (how === 'headless' && ticket) { selected = ticket; tab = 'launch'; launchId = l.id; }
  load();
}

document.addEventListener('click', async (e) => {
  if (handleCopyClick(e)) return;
  const run = e.target.closest('button[data-run]');
  if (run) { e.stopPropagation(); await launchCommand(run); return; }
  const stop = e.target.closest('[data-stop-launch]');
  if (stop) { e.stopPropagation(); if (confirm('Stop this headless claude process?')) { await fetch(`/api/launches/${stop.dataset.stopLaunch}/stop`, { method: 'POST' }); load(); } return; }
  const pick = e.target.closest('[data-launch-pick]');
  if (pick) { launchId = pick.dataset.launchPick; renderDetail(); return; }
  const llog = e.target.closest('[data-launch-log]');
  if (llog) { e.preventDefault(); launchId = llog.dataset.launchLog; selected = llog.dataset.ticket || null; tab = 'launch'; renderTickets(); renderDetail(); return; }
  const ans = e.target.closest('[data-answer]');
  if (ans) { await answer(ans.closest('[data-q]').dataset.q, ans.dataset.answer); return; }
  const send = e.target.closest('[data-send]');
  if (send) { const box = send.closest('.q'); const v = $('[data-free]', box).value.trim(); if (v) await answer(box.dataset.q, v); return; }
  if (e.target.closest('[data-close]')) { selected = null; renderDetail(); renderTickets(); return; }
  const tb = e.target.closest('[data-tab]');
  if (tb) { tab = tb.dataset.tab; renderDetail(); return; }
  const row = e.target.closest('[data-ticket]');
  if (row && !e.target.closest('a[href^="http"]')) { e.preventDefault(); if (selected !== row.dataset.ticket) tab = 'overview'; selected = row.dataset.ticket; if (row.dataset.run) tab = 'log'; renderTickets(); renderDetail(); }
});
$('#refresh').addEventListener('click', async () => { await fetch('/api/refresh', { method: 'POST' }); load(); });
$('#show-done')?.addEventListener('change', renderTickets);
const sprintSel = $('#sprint-filter');
if (sprintSel) { sprintSel.value = sprintFilter(); sprintSel.addEventListener('change', () => { try { localStorage.setItem('sprintFilter', sprintSel.value); } catch {} load(); }); }
document.addEventListener('keydown', (e) => { const box = e.target.closest?.('.q'); if (e.key === 'Enter' && box && e.target.matches('[data-free]')) $('[data-send]', box).click(); });

async function answer(id, text) {
  await fetch(`/api/questions/${id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: text }) });
  load();
}

load();
setInterval(load, 5000);
