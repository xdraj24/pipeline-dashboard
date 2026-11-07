let state = null;
let selectedLaunch = null;
let detailPr = null;
let detailTab = 'ticket';
let logTimer = null;
let detailTimer = null;

const readFilters = () => { try { return JSON.parse(localStorage.getItem('reviewFilters') || '{}'); } catch { return {}; } };
const saveFilters = (f) => { try { localStorage.setItem('reviewFilters', JSON.stringify(f)); } catch {} };
let filters = { small: false, area: null, hideBots: false, ...readFilters() };

async function load() {
  try {
    state = await (await fetch('/api/reviews')).json();
    render();
  } catch (e) {
    $('#status-row').innerHTML = hs('bad', `Server unreachable: ${esc(e.message)}`);
  }
}

const matches = (p) => (!filters.small || p.small) && (!filters.area || p.area === filters.area) && (!filters.hideBots || !p.authorIsBot);

const areaTitle = (p) => `frontend ${p.lines.fe} · backend ${p.lines.be} · other ${p.lines.other} changed lines${p.changedFiles > 100 ? ' (first 100 files only)' : ''}`;
const areaChip = (p) => pill(p.area === 'frontend' ? 'active' : p.area === 'backend' ? 'ok' : '', p.area, areaTitle(p));

function sizeChip(p) {
  return pill(p.small ? 'ok' : '', `${p.small ? 'small · ' : ''}+${p.additions} −${p.deletions} · ${p.changedFiles} files`, p.small ? `≤ ${state.small.maxLines} lines and ≤ ${state.small.maxFiles} files` : '');
}

function draftChip(d) {
  if (!d) return '';
  const cls = d.status === 'published' ? 'done solid' : d.status === 'verified' ? 'ok' : 'warn';
  return pill(cls, `${esc(d.status[0].toUpperCase() + d.status.slice(1))} · ${d.commentCount} comment${d.commentCount === 1 ? '' : 's'}`, `${d.dir.replace(/.*\.ai-workspace\//, '.ai-workspace/')} · reviewer ${d.frontmatter.review_model ?? '?'} · verifier ${d.frontmatter.verified_model ?? '—'}`);
}

function launchChip(p) {
  const live = p.launches.find((l) => l.how === 'headless' && !l.endedAt);
  if (live) return pill('active', `<span class="dot pulse"></span> launched ${ago(live.startedAt)}`, live.command);
  const last = p.launches[0];
  if (!last || last.how !== 'headless') return '';
  return pill(last.exitCode === 0 ? 'ok' : 'bad', `last launch ${last.exitCode === 0 ? 'ok' : last.error ? 'stopped' : `exit ${last.exitCode ?? '?'}`} ${ago(last.endedAt)}`, last.command);
}

function sessionChip(p) {
  const live = p.sessions.find((s) => s.state !== 'finished');
  if (live) return pill(live.state === 'running' ? 'active' : 'warn', `<span class="dot ${live.state === 'running' ? 'pulse' : ''}"></span> ${esc(live.skill)} ${live.state === 'stalled' ? 'quiet' : 'running'} · ${ago(live.lastActivityAt)}`, `${live.command}${live.prs.length ? '' : ' (every PR in .ai-workspace/pr-reviews/candidates.md)'} · started ${ago(live.invokedAt)}`);
  const done = p.sessions[0];
  return done ? pill('', `${esc(done.skill)} finished ${ago(done.finishedAt)}`, done.summary ?? done.command) : '';
}

function previewBtn(p) {
  return p.draft ? `<button data-preview="${p.number}" title="Show .ai-workspace/pr-reviews/PR-${p.number}/review.md">Preview</button>` : '';
}

function runBtns(p, command, terminal = false) {
  const live = p.launches.find((l) => l.how === 'headless' && !l.endedAt);
  if (live) return `<button data-launch-log="${live.id}">Log</button><button data-stop-launch="${live.id}" title="SIGTERM the headless claude process">Stop</button>`;
  const last = p.launches.find((l) => l.logPath);
  return `${last ? `<button data-launch-log="${last.id}" title="Last launch log">Log</button>` : ''}${terminal ? `<button data-run="${esc(command)}" data-run-pr="${p.number}" data-run-how="terminal" title="Open Terminal.app with an interactive claude session running this command">Terminal</button>` : ''}<button class="primary" data-run="${esc(command)}" data-run-pr="${p.number}" data-run-how="headless" title="Run claude -p with this command from the repo root">Run</button>`;
}

const NB = { publish: 'publish', 'tick comments': 'now', published: 'done', waiting: 'wait' };
const nbHtml = (n) => `<span class="nb ${NB[n.label] ?? 'review'}">${esc(n.label)}</span>`;

function nextHtml(p) {
  const n = p.next;
  return `<div class="row-next">${nbHtml(n)}<div>
    <div class="next-text ellipsis" title="${esc(n.reason)}">${esc(n.reason)}</div>
    ${n.command ? cmdBox(n.command, runBtns(p, n.command)) : ''}
  </div></div>`;
}

function card(p) {
  const mine = p.bucket === 'mine';
  const extras = [];
  if (p.checksState && p.checksState !== 'success') extras.push(pill(p.checksState === 'failure' ? 'bad' : 'warn', `CI ${esc(p.checksState)}`));
  if (p.mergeable === 'CONFLICTING') extras.push(pill('bad', 'conflicts'));
  if (p.others !== 'none') extras.push(pill(p.others === 'approved' ? 'ok' : p.others === 'changes_requested' ? 'bad' : '', `${p.others.replace('_', ' ')} by ${esc(p.otherHumans.join(', '))}`));
  if (mine) extras.push(pill(p.mine === 'changes_requested' ? 'bad' : 'active', `you ${p.mine === 'changes_requested' ? 'requested changes' : 'commented'} ${ago(p.myLastAt)}`));
  if (mine && p.commentsSinceMine) extras.push(pill('warn', `${p.commentsSinceMine} new comment(s)`));
  if (mine && p.pushedSinceMine) extras.push(pill('warn', `pushed ${ago(p.lastCommitAt)}`));
  const chips = [...extras, sessionChip(p), launchChip(p)].filter(Boolean).join('');
  const ticket = p.ticket ? `<a href="https://welligence.atlassian.net/browse/${p.ticket}" target="_blank">${p.ticket}</a>` : 'no ticket';
  return `<div class="row ${p.next.label === 'publish' ? 'ok' : ''} ${detailPr === p.number ? 'selected' : ''}" data-pr="${p.number}" title="Click for ticket details and the review file">
    <div class="row-main">
      <div class="row-top"><div class="row-title ellipsis" title="${esc(`${p.headRefName} → ${p.baseRefName}`)}"><a class="id" href="${p.url}" target="_blank">#${p.number}</a> ${esc(p.title)}</div><span class="row-age" title="last updated">${ago(p.updatedAt)}</span></div>
      <div class="row-meta ellipsis"><b>${esc(p.author ?? '?')}</b>${p.authorIsBot ? ' · bot' : ''} · <span title="${esc(areaTitle(p))}">${p.area}</span> · <span title="${p.small ? `≤ ${state.small.maxLines} lines and ≤ ${state.small.maxFiles} files` : ''}">${p.small ? 'small · ' : ''}<span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span> · ${p.changedFiles} files</span> · ${ticket} · opened ${ago(p.createdAt)}</div>
      ${chips ? `<div class="row-chips">${chips}</div>` : ''}
    </div>
    <div class="row-mid">${draftChip(p.draft) || pill('', 'No local review')}</div>
    ${nextHtml(p)}
  </div>`;
}

function renderGroup(id, list) {
  const shown = list.filter(matches);
  $(`#${id}-n`).textContent = shown.length === list.length ? `${list.length}` : `${shown.length} of ${list.length}`;
  $(`#${id}`).innerHTML = shown.length ? shown.map(card).join('') : `<div class="empty">${list.length ? 'Nothing matches the filter.' : 'Nothing here.'}</div>`;
}

function renderBatch() {
  const nums = state.queue.filter(matches).map((p) => p.number);
  if (!nums.length) { $('#batch').innerHTML = ''; return; }
  const cmd = `/w-21-review-prs ${nums.join(' ')}`;
  $('#batch').innerHTML = `<span>All ${nums.length} waiting</span>${cmdBox(cmd, `<button data-run="${esc(cmd)}" data-run-how="terminal">Terminal</button><button class="primary" data-run="${esc(cmd)}" data-run-how="headless">Run</button>`)}`;
}

function renderApproved() {
  const a = state.approved;
  $('#approved-n').textContent = a.prs.length ? `· ${a.prs.length}` : '';
  if (a.error) { $('#approved').innerHTML = `<div class="empty">${pill('bad', 'error')} ${esc(a.error)}</div>`; return; }
  if (!a.prs.length) { $('#approved').innerHTML = `<div class="empty">${a.loading ? 'Loading…' : 'No PR carries your approval.'}</div>`; return; }
  $('#approved').innerHTML = `<div class="grid-wrap"><table class="grid"><tr><th>PR</th><th>Title</th><th>Author</th><th>JIRA</th><th>State</th><th>Updated</th><th>Local review</th></tr>${a.prs.map((p) => `<tr>
    <td><a href="${p.url}" target="_blank">#${p.number}</a></td><td class="clip"><a href="#" data-open-pr="${p.number}" title="${esc(p.title)}">${esc(p.title)}</a></td><td>${esc(p.author ?? '?')}</td>
    <td>${p.ticket ? `<a href="https://welligence.atlassian.net/browse/${p.ticket}" target="_blank">${p.ticket}</a>` : '—'}</td>
    <td>${pill(p.state === 'MERGED' ? 'done' : p.state === 'CLOSED' ? 'bad' : 'ok', p.state === 'MERGED' ? `merged ${ago(p.mergedAt)}` : p.state === 'CLOSED' ? 'closed' : 'open · approved')}</td>
    <td class="muted">${ago(p.updatedAt)}</td><td>${p.draft ? draftChip(p.draft) + ' ' + previewBtn(p) : '—'}</td></tr>`).join('')}</table></div>`;
}

function renderSessions() {
  const list = state.sessions;
  const live = list.filter((s) => s.state !== 'finished').length;
  $('#sessions-n').textContent = list.length ? `· ${live} live · ${list.length - live} finished today` : '';
  if (!list.length) { $('#sessions').innerHTML = '<div class="empty">No review skill ran in the last 12 hours.</div>'; return; }
  $('#sessions').innerHTML = `<div class="grid-wrap"><table class="grid"><tr><th>State</th><th>Command</th><th>PRs</th><th>Started</th><th>Last activity</th><th>Tool calls</th><th>Outcome</th></tr>${list.map((s) => `<tr>
    <td>${s.state === 'running' ? pill('active', '<span class="dot pulse"></span> running') : s.state === 'stalled' ? pill('warn', 'quiet 15m+', 'no transcript activity for 15 minutes and the turn has not ended') : pill('ok', `finished ${ago(s.finishedAt)}`)}</td>
    <td><code>${esc(s.command)}</code></td>
    <td>${s.prs.length ? s.prs.map((n) => `<a href="#" data-scroll-pr="${n}">#${n}</a>`).join(' ') : s.skill === 'w-21-review-prs' ? '<span class="muted">candidates.md</span>' : '—'}</td>
    <td>${ago(s.invokedAt)}</td><td>${ago(s.lastActivityAt)}</td><td>${s.toolCalls}</td>
    <td class="muted">${s.summary ? esc(s.summary.slice(0, 220)) : '—'}</td></tr>`).join('')}</table></div>`;
}

function renderStatus() {
  $('#repo').textContent = state.repo.value ?? '';
  $('#queue-count').textContent = state.queue.length ? ` ${state.queue.length}` : '';
  document.title = `${state.queue.length ? `(${state.queue.length}) ` : ''}Skills dashboard · PRs`;
  const o = state.open;
  $('#status-row').innerHTML = [
    hs(state.gh.value?.ok ? '' : 'bad', state.gh.value?.ok ? `GitHub as <b>${esc(state.viewer.value ?? '?')}</b>` : state.gh.value ? 'GitHub not logged in' : 'GitHub …', state.gh.value?.detail ?? ''),
    o.error ? hs('bad', 'PR list error', o.error) : `<span class="hs">${o.fetchedAt ? `${state.queue.length + state.mine.length + state.others.length} open by others · ${o.drafts} draft${o.drafts === 1 ? '' : 's'} skipped · ${o.mine} yours` : 'Loading PRs…'}</span>`,
    `<span class="hs" title="PRs fetched">${o.fetchedAt ? ago(o.fetchedAt) : '—'}</span>`,
  ].join('');
  for (const b of document.querySelectorAll('[data-filter]')) b.classList.toggle('on', b.dataset.filter === 'small' ? filters.small : filters.area === b.dataset.filter);
  $('#hide-bots').checked = filters.hideBots;
}

function renderDetail() {
  const el = $('#detail');
  showDrawer(!!(selectedLaunch || detailPr));
  clearInterval(logTimer); clearTimeout(detailTimer);
  if (detailPr) { renderPrDetail(el); return; }
  if (!selectedLaunch) return;
  el.innerHTML = `<div class="drawer-head"><div class="drawer-title"><div><b>Launch log</b> <span class="sub">${esc(selectedLaunch)}</span></div><button data-close title="Close (Esc)">Close</button></div></div>
    <div class="drawer-body"><div id="log-meta" class="logmeta"></div><pre class="log" id="log"></pre></div>`;
  const tick = () => pollLaunchLog(selectedLaunch);
  tick();
  logTimer = setInterval(tick, 3000);
}

const sanitize = (html) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const n of doc.querySelectorAll('script, style, iframe, object, embed')) n.remove();
  for (const n of doc.querySelectorAll('*')) for (const a of [...n.attributes]) if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
  for (const a of doc.querySelectorAll('a[href]')) a.setAttribute('target', '_blank');
  return doc.body.innerHTML;
};

const fmDate = (iso) => iso ? `${new Date(iso).toLocaleString()} (${ago(iso)})` : '—';

function jiraSection(d) {
  const cfg = d.jira.config;
  const h = (extra = '') => `<span class="eyebrow grey">JIRA ${extra}</span>`;
  if (!d.ticket) return `<div class="block">${h()}<span class="muted">No XWWP ticket in the PR title, branch or review file.</span></div>`;
  const link = `<a href="https://${cfg.site}/browse/${d.ticket}" target="_blank">${d.ticket}</a>`;
  if (!cfg.configured) return `<div class="block">${h(link)}<span class="muted">${pill('warn', 'JIRA off')} ${esc(cfg.reason)}</span></div>`;
  const c = d.jira.issue;
  const j = c?.value;
  if (!j) return `<div class="block">${h(link)}<span class="muted">${c?.error ? pill('bad', 'error') + ' ' + esc(c.error) : 'Loading issue…'}</span></div>`;
  const statusCls = j.statusCategory === 'done' ? 'done' : j.statusCategory === 'indeterminate' ? 'active' : '';
  return `<div class="block">${h(link)}
    <div style="font-size:14px;margin-bottom:4px">${esc(j.summary)}</div>
    <dl class="kv">
      <dt>Status</dt><dd>${pill(statusCls, esc(j.status))} ${j.resolution ? `<span class="muted small">resolution ${esc(j.resolution)}</span>` : ''}</dd>
      <dt>Type</dt><dd>${esc(j.issueType)}${j.priority ? ` · priority ${esc(j.priority)}` : ''}</dd>
      <dt>Assignee</dt><dd>${esc(j.assignee ?? 'unassigned')}${j.reporter ? ` <span class="muted small">· reported by ${esc(j.reporter)}</span>` : ''}</dd>
      <dt>Sprint</dt><dd>${esc(j.sprint ?? '—')}</dd>
      ${j.parent ? `<dt>Parent</dt><dd><a href="https://${cfg.site}/browse/${j.parent}" target="_blank">${j.parent}</a> ${esc(j.parentSummary ?? '')}</dd>` : ''}
      ${j.labels.length ? `<dt>Labels</dt><dd>${j.labels.map((l) => pill('', esc(l))).join(' ')}</dd>` : ''}
      <dt>Created</dt><dd>${fmDate(j.created)}</dd>
      <dt>Updated</dt><dd>${fmDate(j.updated)}</dd>
    </dl></div>
    <div class="block"><span class="eyebrow grey">Description</span>
    ${j.descriptionHtml ? `<div class="jira-desc">${sanitize(j.descriptionHtml)}</div>` : '<span class="muted">No description.</span>'}
    ${c.error ? `<span class="muted small">${pill('warn', 'stale')} last refresh failed: ${esc(c.error)}</span>` : ''}</div>`;
}

function prSection(d) {
  const p = d.card;
  if (!p) {
    const a = d.approved;
    return `<div class="block"><span class="eyebrow grey">Pull request</span>${a ? `<dl class="kv"><dt>Title</dt><dd><a href="${a.url}" target="_blank">#${a.number}</a> ${esc(a.title)}</dd><dt>Author</dt><dd>${esc(a.author ?? '?')}</dd><dt>State</dt><dd>${esc(a.state)}${a.mergedAt ? ` · merged ${ago(a.mergedAt)}` : ''}</dd><dt>Branch</dt><dd><code>${esc(a.headRefName ?? '—')}</code></dd></dl>` : '<span class="muted">Not among the open PRs by others right now.</span>'}</div>`;
  }
  return `<div class="callout ${p.next.command ? 'you' : ''}">
      <div class="lead">${nbHtml(p.next)}<span>${esc(p.next.reason)}</span></div>
      ${p.next.command ? cmdBox(p.next.command, runBtns(p, p.next.command, true)) : ''}
      ${p.sessions.length || p.launches.length ? `<div class="row-chips">${sessionChip(p)} ${launchChip(p)}</div>` : ''}
    </div>
    <div class="block"><span class="eyebrow grey">Pull request</span>
    <dl class="kv">
      <dt>Author</dt><dd>${esc(p.author ?? '?')}${p.authorIsBot ? ' · bot' : ''}</dd>
      <dt>Branch</dt><dd><code>${esc(p.headRefName)} → ${esc(p.baseRefName)}</code></dd>
      <dt>Size</dt><dd>${sizeChip(p)} ${areaChip(p)}</dd>
      <dt>CI</dt><dd>${p.checksState ? pill(p.checksState === 'success' ? 'ok' : p.checksState === 'failure' ? 'bad' : 'warn', esc(p.checksState)) : '—'}${p.mergeable === 'CONFLICTING' ? ' ' + pill('bad', 'conflicts') : ''}</dd>
      <dt>Reviews</dt><dd>${p.others === 'none' ? 'no other human yet' : `${esc(p.others.replace('_', ' '))} by ${esc(p.otherHumans.join(', '))}`}${p.mine !== 'none' ? ` · you ${esc(p.mine.replace('_', ' '))} ${ago(p.myLastAt)}` : ''}</dd>
      <dt>Opened</dt><dd>${fmDate(p.createdAt)}</dd>
      <dt>Last commit</dt><dd>${fmDate(p.lastCommitAt)}</dd>
    </dl></div>`;
}

const mdInline = (text) => (window.marked ? marked.parseInline(text ?? '') : esc(text));

function snippetHtml(c) {
  if (!c.line) return '';
  const sn = c.snippet;
  if (!sn) return '<div class="empty">No branch to fetch the code from.</div>';
  if (!sn.value) return `<div class="empty">${sn.error ? pill('bad', 'code unavailable', sn.error) + ' ' + esc(sn.error) : 'Loading code…'}</div>`;
  const w = String(sn.value.startLine + sn.value.lines.length - 1).length;
  return `<pre class="snippet">${sn.value.lines.map((l, i) => { const n = sn.value.startLine + i; return `<span class="ln ${n === sn.value.focus ? 'focus' : ''}"><span class="no">${String(n).padStart(w)}</span>${esc(l)}</span>`; }).join('')}</pre>`;
}

function reviewFileSection(d) {
  if (!d.file) return `<div class="muted">No review.md for this PR yet. Run <code>/w-21-review-prs ${d.pr}</code> to draft one.</div>`;
  const fm = (d.file.text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/) ?? [''])[0];
  const body = d.file.text.slice(fm.length);
  const head = `<div class="block"><code class="muted">${esc(d.file.path)}</code>${fm ? docHtml(fm) : ''}</div>`;
  const cm = d.comments;
  if (!cm || !cm.rows.length) return head + md(body);
  const ticked = cm.rows.filter((r) => r.publish).length;
  const published = (d.card?.draft ?? d.approved?.draft)?.status === 'published';
  const bar = `<div class="pubbar">
      <label><input type="checkbox" data-flag-all="1" ${ticked === cm.rows.length ? 'checked' : ''} ${published ? 'disabled' : ''}> <b>${cm.hasPublishColumn ? `${ticked} of ${cm.rows.length}` : 'none of the ' + cm.rows.length}</b> ticked for publishing</label>
      <span>${published ? 'already published' : cm.hasPublishColumn ? `/w-23-publish-review ${d.pr} posts only the ticked rows (the Publish column in review.md)` : `tick the comments to post; /w-23-publish-review ${d.pr} then posts only those`}</span>
    </div>`;
  const rows = cm.rows.map((c) => `<div class="rc ${c.publish ? 'on' : ''}">
      <label class="rc-head"><input type="checkbox" data-flag="${c.index}" ${c.publish ? 'checked' : ''} ${published ? 'disabled' : ''}>
        ${c.blobUrl ? `<a class="mono" href="${esc(c.blobUrl)}" target="_blank" onclick="event.stopPropagation()">${esc(c.path)}${c.line ? `:${c.line}` : ''}</a>` : `<span class="mono">${esc(c.path)}${c.line ? `:${c.line}` : ''}</span>`}</label>
      ${snippetHtml(c)}
      <div class="rc-body">${mdInline(c.body)}</div>
    </div>`).join('');
  const h1 = body.match(/^#\s+(.+)$/m);
  return head + (h1 ? `<span class="eyebrow grey">${esc(h1[1])}</span>` : '') + bar + rows;
}

async function renderPrDetail(el) {
  const pr = detailPr;
  const r = await fetch(`/api/reviews/${pr}/detail`);
  if (pr !== detailPr) return;
  if (!r.ok) { el.innerHTML = `<div class="drawer-head"><div class="drawer-title"><div><b>#${pr}</b></div><button data-close>Close</button></div></div><div class="drawer-body muted">${esc((await r.json()).error ?? 'failed to load')}</div>`; return; }
  const d = await r.json();
  const title = d.card?.title ?? d.approved?.title ?? d.card?.draft?.title ?? '';
  const url = d.card?.url ?? d.approved?.url ?? `https://github.com/${state?.repo?.value ?? ''}/pull/${pr}`;
  const draft = d.card?.draft ?? d.approved?.draft ?? null;
  const tabs = [['ticket', 'Ticket', d.ticket ?? ''], ['review', 'Review file', draft ? esc(draft.status) : '']];
  const author = d.card?.author ?? d.approved?.author;
  const view = `${pr}/${detailTab}`;
  const scroll = el.dataset.view === view ? $('.drawer-body', el)?.scrollTop ?? 0 : 0;
  el.dataset.view = view;
  el.innerHTML = `<div class="drawer-head">
      <div class="drawer-title"><div><a class="id" href="${url}" target="_blank">#${pr}</a> ${esc(title)} <span class="sub">${author ? `· ${esc(author)}` : ''}${d.card ? ` · updated ${ago(d.card.updatedAt)}` : ''}</span></div><a href="${url}" target="_blank" style="font-size:12.5px">Open on GitHub</a><button data-close title="Close (Esc)">Close</button></div>
      <div class="tabs">${tabs.map(([k, l, sub]) => `<button class="${detailTab === k ? 'on' : ''}" data-detail-tab="${k}">${l}${sub ? `<span> · ${sub}</span>` : ''}</button>`).join('')}</div>
    </div>
    <div class="drawer-body">${detailTab === 'ticket' ? prSection(d) + `<div class="cols">${jiraSection(d)}</div>` : reviewFileSection(d)}</div>`;
  $('.drawer-body', el).scrollTop = scroll;
  const waiting = d.jira.issue?.loading || (d.comments?.rows ?? []).some((c) => c.snippet?.loading);
  if (waiting) detailTimer = setTimeout(() => { if (detailPr === pr) renderPrDetail(el); }, 1500);
}

function render() {
  renderStatus(); renderBatch();
  renderGroup('queue', state.queue); renderGroup('mine', state.mine); renderGroup('others', state.others);
  renderSessions(); renderApproved();
  if (selectedLaunch && !$('#log')) renderDetail();
}

document.addEventListener('click', async (e) => {
  if (handleCopyClick(e)) return;
  const f = e.target.closest('[data-filter]');
  if (f) {
    if (f.dataset.filter === 'small') filters.small = !filters.small;
    else filters.area = filters.area === f.dataset.filter ? null : f.dataset.filter;
    saveFilters(filters); render(); return;
  }
  const run = e.target.closest('button[data-run]');
  if (run) {
    e.stopPropagation();
    const pr = run.dataset.runPr ? Number(run.dataset.runPr) : undefined;
    const l = await postLaunch(run, pr ? { pr } : {});
    if (l && run.dataset.runHow === 'headless') { selectedLaunch = l.id; renderDetail(); }
    load(); return;
  }
  const stop = e.target.closest('[data-stop-launch]');
  if (stop) { e.stopPropagation(); if (confirm('Stop this headless claude process?')) { await fetch(`/api/launches/${stop.dataset.stopLaunch}/stop`, { method: 'POST' }); load(); } return; }
  const llog = e.target.closest('[data-launch-log]');
  if (llog) { e.preventDefault(); detailPr = null; selectedLaunch = llog.dataset.launchLog; renderDetail(); return; }
  const prev = e.target.closest('[data-preview]');
  if (prev) { e.stopPropagation(); openDetail(Number(prev.dataset.preview), 'review'); return; }
  const op = e.target.closest('[data-open-pr]');
  if (op) { e.preventDefault(); openDetail(Number(op.dataset.openPr), 'ticket'); return; }
  const dt = e.target.closest('[data-detail-tab]');
  if (dt) { detailTab = dt.dataset.detailTab; render(); renderDetail(); return; }
  const sp = e.target.closest('[data-scroll-pr]');
  if (sp) { e.preventDefault(); const c = $(`.row[data-pr="${sp.dataset.scrollPr}"]`); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.add('selected'); setTimeout(() => c.classList.remove('selected'), 1500); } return; }
  if (e.target.closest('[data-close]')) { selectedLaunch = null; detailPr = null; render(); renderDetail(); return; }
  const c = e.target.closest('.row[data-pr]');
  if (c && !e.target.closest('a, button, [data-copy]')) openDetail(Number(c.dataset.pr), detailPr === Number(c.dataset.pr) ? detailTab : 'ticket');
});

function openDetail(pr, tab) {
  selectedLaunch = null; detailPr = pr; detailTab = tab;
  render(); renderDetail();
}
document.addEventListener('change', async (e) => {
  const one = e.target.closest('[data-flag]');
  const all = e.target.closest('[data-flag-all]');
  if (!one && !all || !detailPr) return;
  const flags = {};
  if (one) flags[one.dataset.flag] = one.checked;
  else for (const cb of document.querySelectorAll('#detail [data-flag]')) flags[cb.dataset.flag] = all.checked;
  const r = await fetch(`/api/reviews/${detailPr}/publish-flags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flags }) });
  if (!r.ok) alert((await r.json()).error ?? 'could not update review.md');
  renderDetail(); load();
});
$('#hide-bots').addEventListener('change', (e) => { filters.hideBots = e.target.checked; saveFilters(filters); render(); });
$('#refresh').addEventListener('click', async () => { await fetch('/api/refresh', { method: 'POST' }); load(); });

load();
setInterval(load, 10000);
