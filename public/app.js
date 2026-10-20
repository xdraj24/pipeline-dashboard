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
    $('#status-row').innerHTML = pill('bad', `server unreachable: ${esc(e.message)}`);
  }
}

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

function jiraChip(t) {
  if (!state.jira.configured) return '';
  if (!t.jira) return '';
  const j = t.jira.value;
  if (!j) return pill(t.jira.error ? 'bad' : '', `JIRA ${t.jira.error ? 'error' : '…'}`, t.jira.error ?? 'loading');
  const cls = j.statusCategory === 'done' ? 'done' : j.statusCategory === 'indeterminate' ? 'active' : '';
  return `<a href="${j.url}" target="_blank" onclick="event.stopPropagation()">${pill(cls, `JIRA: ${esc(j.status)}`, `${j.issueType} · ${j.assignee ?? 'unassigned'} · ${j.sprint ?? 'no sprint'}`)}</a>`;
}

function stagesHtml(t) {
  return `<div class="stages">${t.stages.map((s) => `<span class="stage ${s.state}" title="${esc(s.detail ?? s.state)}">${s.label}</span>`).join('')}</div>`;
}

function runBtns(t, command) {
  const live = t.launches.find((l) => l.how === 'headless' && !l.endedAt);
  if (live) return `<button class="copy" data-stop-launch="${live.id}" title="SIGTERM the headless claude process">stop</button>`;
  return `<button class="copy primary" data-run="${esc(command)}" data-run-ticket="${t.ticket}" data-run-how="headless" title="Run claude -p with this command from the repo root; output lands in the Launches section below">▶ run</button><button class="copy" data-run="${esc(command)}" data-run-ticket="${t.ticket}" data-run-how="terminal" title="Open Terminal.app with an interactive claude session running this command">terminal</button>`;
}

function nextHtml(t) {
  const n = t.nextStep;
  return `<div class="next ${n.urgency}"><span class="urg ${n.urgency}">${n.urgency}</span><div>${n.command ? `<span class="cmd" data-copy="${esc(n.command)}" title="click to copy">${esc(n.command)}</span> ${copyBtn(n.command)} ${runBtns(t, n.command)}<br>` : ''}<span>${esc(n.reason)}</span></div></div>`;
}

function launchChip(t) {
  const live = t.launches.find((l) => l.how === 'headless' && !l.endedAt);
  if (live) return pill('active', `<span class="dot pulse"></span> launched ${ago(live.startedAt)}`, live.command);
  const last = t.launches[0];
  if (!last || last.how !== 'headless') return '';
  return pill(last.exitCode === 0 ? 'ok' : 'bad', `last launch ${last.exitCode === 0 ? 'ok' : last.error ? 'stopped' : `exit ${last.exitCode ?? '?'}`} ${ago(last.endedAt)}`, last.command);
}

function archivedPill(t) {
  return t.archived ? pill('done', `archived ${ago(t.archived.at)}`, `${t.archived.reason} · ${t.archived.file}`) : '';
}

function renderTickets() {
  const showDone = $('#show-done')?.checked ?? true;
  const list = PAGE === 'history' ? state.archived : state.tickets.filter((t) => showDone || t.nextStep.urgency !== 'done');
  if (!list.length) { $('#tickets').innerHTML = `<div class="empty">${PAGE === 'history' ? 'Nothing archived yet. A ticket lands here once its PR is merged and JIRA reaches one of the archive statuses.' : 'No tickets found under .jira-plans, worktrees, slots or local branches.'}</div>`; return; }
  $('#tickets').innerHTML = list.map((t) => {
    const running = t.slot || t.agents.length || (t.latestRun && t.latestRun.ticket.running);
    const plan = t.artifacts.plan;
    return `<div class="card ${running ? 'running' : ''} ${t.openQuestions ? 'needs-answer' : ''} ${t.archived ? 'archived' : ''} ${t.covered ? '' : 'uncovered'} ${selected === t.ticket ? 'selected' : ''}" data-ticket="${t.ticket}">
      <div class="head"><div><span class="id">${t.ticket}</span> <span class="title">${esc(t.title ?? '')}</span></div><span class="muted small">${t.lastActivity ? ago(t.lastActivity) : (t.covered ? '' : 'not started')}</span></div>
      <div class="chips">
        ${running ? pill('active', `<span class="dot pulse"></span> ${esc(t.agents[0]?.phase ?? 'pipeline')} running${t.slot ? ` · slot ${t.slot.slot}` : ''}`) : ''}
        ${t.openQuestions ? pill('warn', `${t.openQuestions} question${t.openQuestions > 1 ? 's' : ''} waiting`) : ''}
        ${launchChip(t)}
        ${t.sprint ? pill(t.sprint.mine ? 'ok' : '', t.sprint.mine ? 'sprint · mine' : 'sprint', t.sprint.name ?? '') : ''}
        ${archivedPill(t)}
        ${jiraChip(t)}
        ${t.prs.map(prChip).join('')}
        ${t.artifacts.localBranch ? pill('', esc(t.artifacts.localBranch.status), t.artifacts.localBranch.branch ?? '') : ''}
        ${t.artifacts.codeReview?.status === 'needs-manual-review' ? pill('warn', 'review needs manual pass') : ''}
        ${t.artifacts.qaCheck?.status === 'needs-manual-qa' ? pill('warn', 'QA needs manual pass') : ''}
      </div>
      ${stagesHtml(t)}
      ${plan && plan.total ? `<div class="bar" title="${plan.ticked}/${plan.total} to-dos"><i style="width:${(100 * plan.ticked) / plan.total}%"></i></div>` : ''}
      ${nextHtml(t)}
      <div class="muted small">models: reviewer ${esc(t.models.reviewer)} · fixer ${esc(t.models.fixer)} · qa ${esc(t.models.qa)}${t.assumptions.length ? ` · ${t.assumptions.length} assumptions` : ''}${t.worktree ? ` · worktree ${t.worktree.dirtyFiles ?? '?'} dirty` : ''}</div>
    </div>`;
  }).join('');
}

function renderQuestions() {
  const open = state.questions.filter((q) => q.status === 'open');
  document.title = (open.length ? `(${open.length}) ` : '') + (PAGE === 'history' ? 'Skills Dashboard · History' : 'Skills Dashboard');
  const el = $('#questions');
  if (!el) return;
  el.classList.toggle('hidden', !open.length);
  el.innerHTML = open.map((q) => `<div class="q" data-q="${q.id}">
    <div class="meta">${pill('warn', 'question from a skill')} <b>${esc(q.ticket ?? q.label ?? '')}</b> <span class="muted small">${esc(q.phase ?? '')} · ${esc(q.source ?? '')} · ${ago(q.createdAt)}${q.slackTs ? ' · also in Slack' : ''}</span></div>
    <div class="text">${esc(q.question)}</div>
    ${q.options.length ? `<div class="opts">${q.options.map((o, i) => `<button class="primary" data-answer="${esc(o)}">${i + 1}. ${esc(o)}</button>`).join('')}</div>` : ''}
    <div class="free"><input type="text" placeholder="Free-text answer" data-free><button data-send>Answer</button></div>
  </div>`).join('');
}

function renderStatus() {
  const running = state.agents.length;
  const activeRuns = state.runs.filter((r) => r.active).length;
  $('#repo').textContent = state.repo.value ? ` · ${state.repo.value}` : '';
  $('#history-count').textContent = state.archived.length ? `(${state.archived.length})` : '';
  $('#status-row').innerHTML = [
    pill(running ? 'active' : '', `${running ? '<span class="dot pulse"></span> ' : ''}${running} headless agent${running === 1 ? '' : 's'}`),
    pill(activeRuns ? 'active' : '', `${activeRuns} active run${activeRuns === 1 ? '' : 's'} · ${state.slots.length}/6 slots`),
    pill(state.gh.value?.ok ? 'ok' : 'bad', `gh ${state.gh.value?.ok ? 'ok' : state.gh.value ? 'not logged in' : '…'}`, state.gh.value?.detail ?? ''),
    pill(state.jira.configured ? 'ok' : 'warn', state.jira.configured ? `JIRA ${state.jira.email}` : 'JIRA off', state.jira.reason ?? state.jira.site),
    state.jira.configured ? pill(state.sprint.error ? 'bad' : '', state.sprint.total === null ? (state.sprint.error ? 'sprint error' : 'sprint …') : `sprint: ${state.sprint.shown} shown · ${state.sprint.mine} mine · ${state.sprint.total} open`, state.sprint.error ?? state.sprint.jql) : '',
    `<span class="muted small" style="align-self:center">updated ${ago(state.generatedAt)}</span>`,
  ].join('');
}

function renderLaunches() {
  if (!$('#launches')) return;
  const ls = state.launches;
  $('#launches-count').textContent = `(${ls.length})`;
  $('#launches').innerHTML = ls.length ? `<table class="grid"><tr><th>Started</th><th>Ticket</th><th>Command</th><th>How</th><th>Status</th><th></th></tr>${ls.map((l) => {
    const running = l.how === 'headless' && !l.endedAt;
    const status = l.how === 'terminal' ? pill('', l.error ? `terminal: ${esc(l.error)}` : 'opened in Terminal') : running ? pill('active', `<span class="dot pulse"></span> running · pid ${l.pid}`) : l.exitCode === 0 ? pill('ok', `ok · ${ago(l.endedAt)}`) : pill('bad', `${l.error ? esc(l.error) : `exit ${l.exitCode ?? '?'}`} · ${ago(l.endedAt)}`);
    return `<tr><td>${ago(l.startedAt)}</td><td>${l.ticket ? `<a href="#" data-ticket="${l.ticket}">${l.ticket}</a>` : '—'}</td><td class="mono">${esc(l.command)}</td><td>${l.how}</td><td>${status}</td>
      <td>${l.logPath ? `<a href="#" data-launch-log="${l.id}" data-ticket="${l.ticket ?? ''}">log</a>` : ''} ${running ? `<button class="copy" data-stop-launch="${l.id}">stop</button>` : ''}</td></tr>`;
  }).join('')}</table>` : '<div class="muted small">Nothing launched yet. The ▶ run button on a card runs its suggested command headlessly from the repo root; "terminal" opens it in Terminal.app instead.</div>';
}

function renderRuns() {
  if (!$('#runs')) return;
  $('#runs-count').textContent = `(${state.runs.length})`;
  $('#runs').innerHTML = state.runs.length ? `<table class="grid"><tr><th>Run</th><th>Started</th><th>Tickets</th><th>Stages</th><th>Result</th></tr>${state.runs.map((r) => `<tr>
    <td class="mono">${r.id}</td><td>${ago(r.startedAt)}</td>
    <td>${r.tickets.map((t) => `<a href="#" data-ticket="${t.ticket}" data-run="${r.id}">${t.ticket}</a>`).join(', ')}</td>
    <td>${r.tickets.map((t) => `<div class="timeline">${t.stages.map((s) => `<span class="stage ${s.state === 'in progress' ? 'active' : s.state === 'complete' ? 'done' : s.state === 'retrying' || s.state === 'other' ? 'warn' : s.state}" title="${esc(s.raw)}">${esc(s.stage)}</span>`).join('')}</div>`).join('')}</td>
    <td>${r.tickets.map((t) => t.running ? pill('active', 'running') : t.exitCode === 0 ? pill('ok', 'ok') : t.exitCode === null ? pill('warn', 'no status', 'process ended without writing .status') : pill('bad', `exit ${t.exitCode}${t.failedAt ? ' at ' + t.failedAt : ''}`)).join(' ')}</td>
  </tr>`).join('')}</table>` : '<div class="muted">No pipeline runs under .claude/pipeline-logs.</div>';
}

function renderReviews() {
  if (!$('#reviews')) return;
  const pr = state.prReviews;
  $('#reviews-count').textContent = `(${pr.reviews.length})`;
  $('#reviews').innerHTML = `${pr.candidates ? `<div class="muted small">candidates.md generated ${ago(pr.candidates.generated_at)} · filter ${esc(pr.candidates.filter ?? '')} · ${pr.candidatesRows.length} candidates</div>` : ''}
  ${pr.reviews.length ? `<table class="grid"><tr><th>PR</th><th>Title</th><th>Status</th><th>Comments</th><th>Reviewer</th><th>Verifier</th><th>Updated</th></tr>${pr.reviews.map((r) => `<tr>
    <td><a href="${esc(r.frontmatter.pr_url ?? '#')}" target="_blank">#${r.pr}</a></td><td>${esc(r.title ?? '')}</td><td>${pill(r.status === 'published' ? 'done' : r.status === 'verified' ? 'ok' : 'warn', esc(r.status))}</td>
    <td>${r.commentCount}</td><td>${esc(r.frontmatter.review_model ?? '?')}</td><td>${esc(r.frontmatter.verified_model ?? '—')}</td><td>${ago(r.mtime)}</td></tr>`).join('')}</table>` : '<div class="muted">No drafted reviews under .pr-reviews.</div>'}`;
}

function renderWorktrees() {
  if (!$('#worktrees')) return;
  $('#worktrees').innerHTML = `${state.agents.length ? `<table class="grid"><tr><th>PID</th><th>Host</th><th>Ticket</th><th>Phase</th><th>Elapsed</th></tr>${state.agents.map((a) => `<tr><td class="mono">${a.pid}</td><td>${a.host}</td><td>${a.ticket ?? '?'}</td><td>${a.phase ?? '?'}</td><td>${a.elapsed}</td></tr>`).join('')}</table>` : '<div class="muted small">No headless agent processes.</div>'}
  ${state.worktrees.length ? `<table class="grid"><tr><th>Worktree</th><th>Branch</th><th>Dirty files</th><th>Commits ahead of main</th></tr>${state.worktrees.map((w) => `<tr><td class="mono">${esc(w.name)}</td><td class="mono">${esc(w.branch ?? `detached ${w.head}`)}</td><td>${w.dirtyFiles ?? '?'}</td><td>${w.aheadOfMain ?? '?'}</td></tr>`).join('')}</table>` : '<div class="muted small">No worktrees.</div>'}`;
}

async function renderDetail() {
  const t = allTickets().find((x) => x.ticket === selected);
  const el = $('#detail');
  $('main').classList.toggle('with-detail', !!t);
  el.classList.toggle('hidden', !t);
  if (!t) { clearInterval(logTimer); return; }
  const a = t.artifacts;
  const tabs = [['overview', 'Overview'], ['plan', 'Plan'], ['review', 'Code review'], ['qa', 'QA check'], ['notes', 'Change notes'], ['branch', 'Local branch'], ['pr', 'PR'], ['log', 'Pipeline log'], ['launch', 'Launch log'], ['questions', 'Questions']];
  let body = '';
  if (tab === 'overview') {
    body = `<dl class="kv">
      <dt>Title</dt><dd>${esc(t.title ?? '—')}</dd>
      ${t.archived ? `<dt>Archived</dt><dd>${ago(t.archived.at)} · ${esc(t.archived.reason)} <span class="muted small">(marker in ${esc(t.archived.file)})</span></dd>` : ''}
      <dt>Next step</dt><dd>${nextHtml(t)}</dd>
      <dt>Models</dt><dd>reviewer <b>${esc(t.models.reviewer)}</b> · fixer <b>${esc(t.models.fixer)}</b> · planner <b>${esc(t.models.planner)}</b> · qa <b>${esc(t.models.qa)}</b> <span class="muted small">(from code-review.md and qa-check.md; "unknown" means the skill did not record it)</span><br><span class="muted small">orchestrating skill: ${esc(t.models.orchestrator)}</span></dd>
      <dt>Branch</dt><dd class="mono">${esc(a.localBranch?.branch ?? t.branches.map((b) => b.name).join(', ') ?? '—')}${t.branches[0]?.isCurrent ? ' (checked out)' : ''}</dd>
      <dt>Worktree</dt><dd>${t.worktree ? `<span class="mono">${esc(t.worktree.path)}</span> · ${t.worktree.dirtyFiles ?? '?'} dirty · ${t.worktree.aheadOfMain ?? '?'} ahead of main` : '—'}</dd>
      <dt>Code review</dt><dd>${a.codeReview ? `${a.codeReview.rounds ?? '?'} round(s) · final ${a.codeReview.finalStatus ?? '?'} · status ${esc(a.codeReview.status)}` : '—'}</dd>
      <dt>QA check</dt><dd>${a.qaCheck ? `${a.qaCheck.rounds ?? '?'} round(s) · final ${a.qaCheck.finalStatus ?? '?'} · status ${esc(a.qaCheck.status)} · browser ${esc(a.qaCheck.browser ?? '?')}${a.qaCheck.codeChanged ? ' · changed code' : ''}` : '—'}</dd>
      <dt>Last run</dt><dd>${t.latestRun ? `${t.latestRun.runId} · ${t.latestRun.ticket.running ? 'running' : t.latestRun.ticket.exitCode === 0 ? 'ok' : `exit ${t.latestRun.ticket.exitCode ?? '?'}`}${t.latestRun.ticket.failedAt ? ` at ${t.latestRun.ticket.failedAt}` : ''}` : '—'}</dd>
      <dt>Files</dt><dd class="mono small">${['plan', 'codeReview', 'qaCheck', 'changeNotes', 'localBranch'].filter((k) => a[k]).map((k) => a[k].path.replace(/.*\.jira-plans\//, '.jira-plans/')).join('<br>') || '—'}</dd>
    </dl>
    <h3>Stages</h3><ul class="list">${t.stages.map((s) => `<li><span class="stage ${s.state}" style="display:inline-block;min-width:70px">${s.label}</span> ${esc(s.detail ?? '')}</li>`).join('')}</ul>
    <h3>Assumptions and decisions the skills made (${t.assumptions.length})</h3>
    ${t.assumptions.length ? `<ul class="list">${t.assumptions.map((x) => `<li>${x.humanAnswered ? pill('ok', 'human answered') + ' ' : ''}${esc(x.text)}<div class="src">${esc(x.source)}</div></li>`).join('')}</ul>` : '<div class="muted">None recorded.</div>'}`;
  } else if (['plan', 'review', 'qa', 'notes', 'branch'].includes(tab)) {
    const name = { plan: 'plan.md', review: 'code-review.md', qa: 'qa-check.md', notes: 'change-notes.md', branch: 'local-branch.md' }[tab];
    const r = await fetch(`/api/tickets/${t.ticket}/artifact/${name}`);
    body = r.ok ? md((await r.json()).text) : `<div class="muted">No ${name} for this ticket yet.</div>`;
  } else if (tab === 'pr') {
    body = t.prs.length ? t.prs.map((pv) => {
      const p = pv.info.value;
      if (!p) return `<div class="muted">PR #${pv.number}: ${esc(pv.info.error ?? 'loading…')}</div>`;
      return `<h3>${pv.role} PR <a href="${p.url}" target="_blank">#${p.number}</a> — ${esc(p.title)}</h3>
      <dl class="kv">
        <dt>State</dt><dd>${prChip(pv)} ${p.mergedAt ? `merged ${ago(p.mergedAt)}` : ''}</dd>
        <dt>Review</dt><dd>${esc(p.reviewDecision ?? '—')}${p.approvedBy.length ? ` · approved by ${p.approvedBy.join(', ')}` : ''}${p.changesRequestedBy.length ? ` · changes requested by ${p.changesRequestedBy.join(', ')}` : ''}</dd>
        <dt>Threads</dt><dd>${p.unresolvedThreads} unresolved of ${p.threads.length}</dd>
        <dt>New since push</dt><dd>${p.newSinceLastPush} human comment(s) after the last commit (${p.lastCommitAt ? ago(p.lastCommitAt) : '?'})</dd>
        <dt>Merge</dt><dd>${esc(p.mergeable ?? '?')} · ${esc(p.mergeStateStatus ?? '?')} · ${p.headRefName} → ${p.baseRefName} · +${p.additions} −${p.deletions}</dd>
        <dt>CI</dt><dd>${esc(p.checksState ?? '—')} ${p.checks.filter((c) => !['success', 'skipped', 'neutral'].includes(c.status)).map((c) => pill(c.status === 'failure' ? 'bad' : 'warn', `${esc(c.name)}: ${esc(c.status)}`)).join(' ')}</dd>
      </dl>
      ${p.threads.filter((th) => !th.isResolved).map((th) => `<div class="thread unresolved"><b>${esc(th.author ?? '?')}</b> <span class="mono">${esc(th.path ?? '')}</span> <span class="muted small">${ago(th.createdAt)} · ${th.replies} replies${th.isOutdated ? ' · outdated' : ''}</span><div class="body">${esc(th.body)}</div></div>`).join('')}
      ${p.comments.slice(0, 10).map((c) => `<div class="thread"><b>${esc(c.author ?? '?')}</b> <span class="muted small">${c.kind} · ${ago(c.createdAt)}</span><div class="body">${esc(c.body)}</div></div>`).join('')}`;
    }).join('<hr>') : '<div class="muted">No PR found for this ticket (no pr_url in local-branch.md, no PR on its branch, none with the ticket id in the title).</div>';
  } else if (tab === 'log') {
    body = `<div id="log-meta" class="muted small"></div><pre class="log" id="log"></pre>`;
  } else if (tab === 'launch') {
    const withLog = t.launches.filter((l) => l.logPath);
    if (!withLog.length) body = '<div class="muted">No headless launch for this ticket from the dashboard yet.</div>';
    else {
      launchId = withLog.some((l) => l.id === launchId) ? launchId : withLog[0].id;
      body = `<div class="tabs">${withLog.map((l) => `<button class="${launchId === l.id ? 'on' : ''}" data-launch-pick="${l.id}">${ago(l.startedAt)} · ${esc(l.command)}</button>`).join('')}</div><div id="log-meta" class="muted small"></div><pre class="log" id="log"></pre>`;
    }
  } else if (tab === 'questions') {
    body = t.questions.length ? t.questions.map((q) => `<div class="thread ${q.status === 'open' ? 'unresolved' : ''}"><b>${esc(q.phase ?? '')}</b> <span class="muted small">${ago(q.createdAt)} · ${esc(q.status)}${q.answeredVia ? ` via ${esc(q.answeredVia)}` : ''}</span><div class="body">${esc(q.question)}</div>${q.answer ? `<div class="body"><b>Answer:</b> ${esc(q.answer)}</div>` : ''}</div>`).join('') : '<div class="muted">No questions were raised for this ticket.</div>';
  }
  el.innerHTML = `<div class="head"><div><b>${t.ticket}</b> <span class="muted">${esc(t.title ?? '')}</span></div><button data-close>close</button></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>${body}`;
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
  meta.innerHTML = `${d.path.replace(/.*\.claude\//, '.claude/')} · ${(d.size / 1024).toFixed(0)} KB · ${d.running ? pill('active', 'running') : d.exitCode === 0 ? pill('ok', 'finished ok') : pill('bad', `exit ${d.exitCode ?? '?'}`)}${d.truncated ? ' · showing the tail' : ''}`;
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
  const run = e.target.closest('[data-run]');
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
  const card = e.target.closest('[data-ticket]');
  if (card && !e.target.closest('a[href^="http"]')) { e.preventDefault(); selected = card.dataset.ticket; if (card.dataset.run) tab = 'log'; renderTickets(); renderDetail(); }
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
