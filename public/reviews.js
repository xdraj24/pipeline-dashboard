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
    $('#status-row').innerHTML = pill('bad', `server unreachable: ${esc(e.message)}`);
  }
}

const matches = (p) => (!filters.small || p.small) && (!filters.area || p.area === filters.area) && (!filters.hideBots || !p.authorIsBot);

function areaChip(p) {
  const title = `frontend ${p.lines.fe} · backend ${p.lines.be} · other ${p.lines.other} changed lines${p.changedFiles > 100 ? ' (first 100 files only)' : ''}`;
  return pill(p.area === 'frontend' ? 'active' : p.area === 'backend' ? 'ok' : '', p.area, title);
}

function sizeChip(p) {
  return pill(p.small ? 'ok' : '', `${p.small ? 'small · ' : ''}+${p.additions} −${p.deletions} · ${p.changedFiles} files`, p.small ? `≤ ${state.small.maxLines} lines and ≤ ${state.small.maxFiles} files` : '');
}

function draftChip(d) {
  if (!d) return '';
  const cls = d.status === 'published' ? 'done' : d.status === 'verified' ? 'ok' : 'warn';
  return pill(cls, `local review: ${esc(d.status)} · ${d.commentCount} comment(s)`, `${d.dir.replace(/.*\.pr-reviews\//, '.pr-reviews/')} · reviewer ${d.frontmatter.review_model ?? '?'} · verifier ${d.frontmatter.verified_model ?? '—'}`);
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
  if (live) return pill(live.state === 'running' ? 'active' : 'warn', `<span class="dot ${live.state === 'running' ? 'pulse' : ''}"></span> ${esc(live.skill)} ${live.state === 'stalled' ? 'quiet' : 'running'} · ${ago(live.lastActivityAt)}`, `${live.command}${live.prs.length ? '' : ' (every PR in .pr-reviews/candidates.md)'} · started ${ago(live.invokedAt)}`);
  const done = p.sessions[0];
  return done ? pill('', `${esc(done.skill)} finished ${ago(done.finishedAt)}`, done.summary ?? done.command) : '';
}

function previewBtn(p) {
  return p.draft ? `<button class="copy ${detailPr === p.number && detailTab === 'review' ? 'primary' : ''}" data-preview="${p.number}" title="Show .pr-reviews/PR-${p.number}/review.md">preview</button>` : '';
}

function runBtns(p, command) {
  const live = p.launches.find((l) => l.how === 'headless' && !l.endedAt);
  if (live) return `<button class="copy" data-stop-launch="${live.id}" title="SIGTERM the headless claude process">stop</button> <a href="#" data-launch-log="${live.id}">log</a>`;
  const last = p.launches.find((l) => l.logPath);
  return `<button class="copy primary" data-run="${esc(command)}" data-run-pr="${p.number}" data-run-how="headless" title="Run claude -p with this command from the repo root">▶ run</button><button class="copy" data-run="${esc(command)}" data-run-pr="${p.number}" data-run-how="terminal" title="Open Terminal.app with an interactive claude session running this command">terminal</button>${last ? ` <a href="#" data-launch-log="${last.id}">last log</a>` : ''}`;
}

function nextHtml(p) {
  const n = p.next;
  const urgency = n.command ? 'now' : n.label === 'published' ? 'done' : 'wait';
  return `<div class="next ${urgency}"><span class="urg ${urgency}">${esc(n.label)}</span><div>${n.command ? `<span class="cmd" data-copy="${esc(n.command)}" title="click to copy">${esc(n.command)}</span> ${copyBtn(n.command)} ${runBtns(p, n.command)}<br>` : ''}<span>${esc(n.reason)}</span></div></div>`;
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
  return `<div class="card ${mine ? 'mine' : ''} ${p.launches.some((l) => l.how === 'headless' && !l.endedAt) || p.sessions.some((s) => s.state === 'running') ? 'running' : ''} ${detailPr === p.number ? 'selected' : ''}" data-pr="${p.number}" title="Click for ticket details and the review file">
    <div class="head"><div><a class="id" href="${p.url}" target="_blank">#${p.number}</a> <span class="title">${esc(p.title)}</span></div><span class="muted small" title="last updated">${ago(p.updatedAt)}</span></div>
    <div class="chips">
      ${pill(p.authorIsBot ? 'warn' : '', `${esc(p.author ?? '?')}${p.authorIsBot ? ' · bot' : ''}`)}
      ${areaChip(p)} ${sizeChip(p)}
      ${p.ticket ? `<a href="https://welligence.atlassian.net/browse/${p.ticket}" target="_blank">${pill('', p.ticket)}</a>` : ''}
      ${extras.join('')} ${sessionChip(p)} ${draftChip(p.draft)} ${previewBtn(p)} ${launchChip(p)}
    </div>
    ${nextHtml(p)}
    <div class="muted small mono">${esc(p.headRefName)} → ${esc(p.baseRefName)} · opened ${ago(p.createdAt)}</div>
  </div>`;
}

function renderGroup(id, list) {
  const shown = list.filter(matches);
  $(`#${id}-n`).textContent = shown.length === list.length ? `(${list.length})` : `(${shown.length} of ${list.length})`;
  $(`#${id}`).innerHTML = shown.length ? shown.map(card).join('') : `<div class="empty small">${list.length ? 'Nothing matches the filter.' : 'Nothing here.'}</div>`;
}

function renderBatch() {
  const nums = state.queue.filter(matches).map((p) => p.number);
  if (!nums.length) { $('#batch').innerHTML = ''; return; }
  const cmd = `/w-21-review-prs ${nums.join(' ')}`;
  $('#batch').innerHTML = `<span class="muted small">all ${nums.length} waiting:</span> <span class="cmd" data-copy="${esc(cmd)}" title="click to copy">${esc(cmd)}</span> ${copyBtn(cmd)} <button class="copy primary" data-run="${esc(cmd)}" data-run-how="headless">▶ run</button><button class="copy" data-run="${esc(cmd)}" data-run-how="terminal">terminal</button>`;
}

function renderApproved() {
  const a = state.approved;
  $('#approved-n').textContent = a.prs.length ? `(${a.prs.length})` : '';
  if (a.error) { $('#approved').innerHTML = `<div class="muted small">${pill('bad', 'error')} ${esc(a.error)}</div>`; return; }
  if (!a.prs.length) { $('#approved').innerHTML = `<div class="empty small">${a.loading ? 'Loading…' : 'No PR carries your approval.'}</div>`; return; }
  $('#approved').innerHTML = `<table class="grid"><tr><th>PR</th><th>Title</th><th>Author</th><th>JIRA</th><th>State</th><th>Updated</th><th>Local review</th></tr>${a.prs.map((p) => `<tr>
    <td><a href="${p.url}" target="_blank">#${p.number}</a></td><td><a href="#" data-open-pr="${p.number}" title="Ticket details and the review file">${esc(p.title)}</a></td><td>${esc(p.author ?? '?')}</td>
    <td>${p.ticket ? `<a href="https://welligence.atlassian.net/browse/${p.ticket}" target="_blank">${p.ticket}</a>` : '—'}</td>
    <td>${pill(p.state === 'MERGED' ? 'done' : p.state === 'CLOSED' ? 'bad' : 'ok', p.state === 'MERGED' ? `merged ${ago(p.mergedAt)}` : p.state === 'CLOSED' ? 'closed' : 'open · approved')}</td>
    <td>${ago(p.updatedAt)}</td><td>${p.draft ? draftChip(p.draft) + ' ' + previewBtn(p) : '—'}</td></tr>`).join('')}</table>`;
}

function renderSessions() {
  const list = state.sessions;
  const live = list.filter((s) => s.state !== 'finished').length;
  $('#sessions-n').textContent = list.length ? `(${live} live · ${list.length - live} finished today)` : '';
  if (!list.length) { $('#sessions').innerHTML = '<div class="empty small">No review skill ran in the last 12 hours.</div>'; return; }
  $('#sessions').innerHTML = `<table class="grid"><tr><th>State</th><th>Command</th><th>PRs</th><th>Started</th><th>Last activity</th><th>Tool calls</th><th>Outcome</th></tr>${list.map((s) => `<tr>
    <td>${s.state === 'running' ? pill('active', '<span class="dot pulse"></span> running') : s.state === 'stalled' ? pill('warn', 'quiet 15m+', 'no transcript activity for 15 minutes and the turn has not ended') : pill('ok', `finished ${ago(s.finishedAt)}`)}</td>
    <td class="mono">${esc(s.command)}</td>
    <td>${s.prs.length ? s.prs.map((n) => `<a href="#" data-scroll-pr="${n}">#${n}</a>`).join(' ') : s.skill === 'w-21-review-prs' ? '<span class="muted">candidates.md</span>' : '—'}</td>
    <td>${ago(s.invokedAt)}</td><td>${ago(s.lastActivityAt)}</td><td>${s.toolCalls}</td>
    <td class="small">${s.summary ? esc(s.summary.slice(0, 220)) : '<span class="muted">—</span>'}</td></tr>`).join('')}</table>`;
}

function renderStatus() {
  $('#repo').textContent = state.repo.value ? ` · ${state.repo.value}` : '';
  $('#queue-count').textContent = state.queue.length ? `(${state.queue.length})` : '';
  document.title = `${state.queue.length ? `(${state.queue.length}) ` : ''}Skills Dashboard · Reviews`;
  const o = state.open;
  $('#status-row').innerHTML = [
    pill(state.gh.value?.ok ? 'ok' : 'bad', `gh ${state.gh.value?.ok ? `as ${esc(state.viewer.value ?? '?')}` : state.gh.value ? 'not logged in' : '…'}`, state.gh.value?.detail ?? ''),
    o.error ? pill('bad', 'PR list error', o.error) : pill(o.loading && !o.fetchedAt ? 'active' : '', o.fetchedAt ? `${state.queue.length + state.mine.length + state.others.length} open by others · ${o.drafts} draft${o.drafts === 1 ? '' : 's'} skipped · ${o.mine} yours` : 'loading PRs…'),
    `<span class="muted small" style="align-self:center">PRs fetched ${o.fetchedAt ? ago(o.fetchedAt) : '—'}</span>`,
  ].join('');
  for (const b of document.querySelectorAll('[data-filter]')) b.classList.toggle('on', b.dataset.filter === 'small' ? filters.small : filters.area === b.dataset.filter);
  $('#hide-bots').checked = filters.hideBots;
}

function renderDetail() {
  const el = $('#detail');
  $('main').classList.toggle('with-detail', !!(selectedLaunch || detailPr));
  el.classList.toggle('hidden', !(selectedLaunch || detailPr));
  clearInterval(logTimer); clearTimeout(detailTimer);
  if (detailPr) { renderPrDetail(el); return; }
  if (!selectedLaunch) return;
  el.innerHTML = `<div class="head"><div><b>Launch log</b> <span class="muted mono small">${esc(selectedLaunch)}</span></div><button data-close>close</button></div><div id="log-meta" class="muted small"></div><pre class="log" id="log"></pre>`;
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
  if (!d.ticket) return `<h3>JIRA</h3><div class="muted">No XWWP ticket in the PR title, branch or review file.</div>`;
  const link = `<a href="https://${cfg.site}/browse/${d.ticket}" target="_blank">${d.ticket}</a>`;
  if (!cfg.configured) return `<h3>JIRA ${link}</h3><div class="muted small">${pill('warn', 'JIRA off')} ${esc(cfg.reason)}</div>`;
  const c = d.jira.issue;
  const j = c?.value;
  if (!j) return `<h3>JIRA ${link}</h3><div class="muted small">${c?.error ? pill('bad', 'error') + ' ' + esc(c.error) : 'Loading issue…'}</div>`;
  const statusCls = j.statusCategory === 'done' ? 'done' : j.statusCategory === 'indeterminate' ? 'active' : '';
  return `<h3>JIRA ${link}</h3>
    <div class="title" style="font-size:14px;margin-bottom:6px">${esc(j.summary)}</div>
    <dl class="kv">
      <dt>Status</dt><dd>${pill(statusCls, esc(j.status))} ${j.resolution ? `<span class="muted small">resolution ${esc(j.resolution)}</span>` : ''}</dd>
      <dt>Type</dt><dd>${esc(j.issueType)}${j.priority ? ` · priority ${esc(j.priority)}` : ''}</dd>
      <dt>Assignee</dt><dd>${esc(j.assignee ?? 'unassigned')}${j.reporter ? ` <span class="muted small">· reported by ${esc(j.reporter)}</span>` : ''}</dd>
      <dt>Sprint</dt><dd>${esc(j.sprint ?? '—')}</dd>
      ${j.parent ? `<dt>Parent</dt><dd><a href="https://${cfg.site}/browse/${j.parent}" target="_blank">${j.parent}</a> ${esc(j.parentSummary ?? '')}</dd>` : ''}
      ${j.labels.length ? `<dt>Labels</dt><dd>${j.labels.map((l) => pill('', esc(l))).join(' ')}</dd>` : ''}
      <dt>Created</dt><dd>${fmDate(j.created)}</dd>
      <dt>Updated</dt><dd>${fmDate(j.updated)}</dd>
    </dl>
    <h3>Description</h3>
    ${j.descriptionHtml ? `<div class="jira-desc">${sanitize(j.descriptionHtml)}</div>` : '<div class="muted">No description.</div>'}
    ${c.error ? `<div class="muted small">${pill('warn', 'stale')} last refresh failed: ${esc(c.error)}</div>` : ''}`;
}

function prSection(d) {
  const p = d.card;
  if (!p) {
    const a = d.approved;
    return `<h3>Pull request</h3>${a ? `<dl class="kv"><dt>Title</dt><dd><a href="${a.url}" target="_blank">#${a.number}</a> ${esc(a.title)}</dd><dt>Author</dt><dd>${esc(a.author ?? '?')}</dd><dt>State</dt><dd>${esc(a.state)}${a.mergedAt ? ` · merged ${ago(a.mergedAt)}` : ''}</dd><dt>Branch</dt><dd class="mono">${esc(a.headRefName ?? '—')}</dd></dl>` : '<div class="muted">Not among the open PRs by others right now.</div>'}`;
  }
  return `<h3>Pull request</h3>
    <dl class="kv">
      <dt>Author</dt><dd>${esc(p.author ?? '?')}${p.authorIsBot ? ' · bot' : ''}</dd>
      <dt>Branch</dt><dd class="mono">${esc(p.headRefName)} → ${esc(p.baseRefName)}</dd>
      <dt>Size</dt><dd>${sizeChip(p)} ${areaChip(p)}</dd>
      <dt>CI</dt><dd>${p.checksState ? pill(p.checksState === 'success' ? 'ok' : p.checksState === 'failure' ? 'bad' : 'warn', esc(p.checksState)) : '—'}${p.mergeable === 'CONFLICTING' ? ' ' + pill('bad', 'conflicts') : ''}</dd>
      <dt>Reviews</dt><dd>${p.others === 'none' ? 'no other human yet' : `${esc(p.others.replace('_', ' '))} by ${esc(p.otherHumans.join(', '))}`}${p.mine !== 'none' ? ` · you ${esc(p.mine.replace('_', ' '))} ${ago(p.myLastAt)}` : ''}</dd>
      <dt>Opened</dt><dd>${fmDate(p.createdAt)}</dd>
      <dt>Last commit</dt><dd>${fmDate(p.lastCommitAt)}</dd>
    </dl>
    <h3>Next step</h3>${nextHtml(p)}
    ${p.sessions.length || p.launches.length ? `<div class="chips" style="margin-top:6px">${sessionChip(p)} ${launchChip(p)}</div>` : ''}`;
}

const mdInline = (text) => (window.marked ? marked.parseInline(text ?? '') : esc(text));

function snippetHtml(c) {
  if (!c.line) return '';
  const sn = c.snippet;
  if (!sn) return '<div class="muted small">No branch to fetch the code from.</div>';
  if (!sn.value) return `<div class="muted small">${sn.error ? pill('bad', 'code unavailable', sn.error) + ' ' + esc(sn.error) : 'Loading code…'}</div>`;
  const w = String(sn.value.startLine + sn.value.lines.length - 1).length;
  return `<pre class="snippet">${sn.value.lines.map((l, i) => { const n = sn.value.startLine + i; return `<span class="ln ${n === sn.value.focus ? 'focus' : ''}"><span class="no">${String(n).padStart(w)}</span>${esc(l)}</span>`; }).join('')}</pre>`;
}

function reviewFileSection(d) {
  if (!d.file) return '<div class="muted">No review.md for this PR yet. Run <span class="mono">/w-21-review-prs ' + d.pr + '</span> to draft one.</div>';
  const fm = (d.file.text.match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [])[1] ?? '';
  const body = d.file.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const kv = fm.split(/\r?\n/).map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean);
  const head = `<div class="muted mono small" style="margin-bottom:6px">${esc(d.file.path)}</div>
    <dl class="kv">${kv.map((m) => `<dt>${esc(m[1])}</dt><dd>${/^https?:/.test(m[2]) ? `<a href="${esc(m[2])}" target="_blank">${esc(m[2])}</a>` : esc(m[2] || '—')}</dd>`).join('')}</dl><hr>`;
  const cm = d.comments;
  if (!cm || !cm.rows.length) return head + md(body);
  const ticked = cm.rows.filter((r) => r.publish).length;
  const published = (d.card?.draft ?? d.approved?.draft)?.status === 'published';
  const bar = `<div class="pubbar">
      <label><input type="checkbox" data-flag-all="1" ${ticked === cm.rows.length ? 'checked' : ''} ${published ? 'disabled' : ''}> <b>${cm.hasPublishColumn ? `${ticked} of ${cm.rows.length}` : 'none of the ' + cm.rows.length}</b> ticked for publishing</label>
      <span class="muted small">${published ? 'already published' : cm.hasPublishColumn ? `/w-23-publish-review ${d.pr} posts only the ticked rows (the Publish column in review.md)` : `tick the comments to post; /w-23-publish-review ${d.pr} then posts only those`}</span>
    </div>`;
  const rows = cm.rows.map((c) => `<div class="rc ${c.publish ? 'on' : ''}">
      <label class="rc-head"><input type="checkbox" data-flag="${c.index}" ${c.publish ? 'checked' : ''} ${published ? 'disabled' : ''}>
        ${c.blobUrl ? `<a class="mono" href="${esc(c.blobUrl)}" target="_blank" onclick="event.stopPropagation()">${esc(c.path)}${c.line ? `:${c.line}` : ''}</a>` : `<span class="mono">${esc(c.path)}${c.line ? `:${c.line}` : ''}</span>`}</label>
      ${snippetHtml(c)}
      <div class="rc-body">${mdInline(c.body)}</div>
    </div>`).join('');
  const h1 = body.match(/^#\s+(.+)$/m);
  return head + (h1 ? `<h3>${esc(h1[1])}</h3>` : '') + bar + rows;
}

async function renderPrDetail(el) {
  const pr = detailPr;
  const r = await fetch(`/api/reviews/${pr}/detail`);
  if (pr !== detailPr) return;
  if (!r.ok) { el.innerHTML = `<div class="head"><div><b>#${pr}</b></div><button data-close>close</button></div><div class="muted">${esc((await r.json()).error ?? 'failed to load')}</div>`; return; }
  const d = await r.json();
  const title = d.card?.title ?? d.approved?.title ?? d.card?.draft?.title ?? '';
  const url = d.card?.url ?? d.approved?.url ?? `https://github.com/${state?.repo?.value ?? ''}/pull/${pr}`;
  const draft = d.card?.draft ?? d.approved?.draft ?? null;
  const tabs = [['ticket', d.ticket ? `Ticket ${d.ticket}` : 'Ticket'], ['review', `Review file${draft ? ` · ${esc(draft.status)}` : ''}`]];
  const scroll = el.scrollTop;
  el.innerHTML = `<div class="head"><div><a class="id" href="${url}" target="_blank">#${pr}</a> <span class="muted">${esc(title)}</span></div><button data-close>close</button></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${detailTab === k ? 'on' : ''}" data-detail-tab="${k}">${l}</button>`).join('')}</div>
    ${detailTab === 'ticket' ? jiraSection(d) + prSection(d) : reviewFileSection(d)}`;
  el.scrollTop = scroll;
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
  const run = e.target.closest('[data-run]');
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
  if (sp) { e.preventDefault(); const c = $(`.card[data-pr="${sp.dataset.scrollPr}"]`); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.add('selected'); setTimeout(() => c.classList.remove('selected'), 1500); } return; }
  if (e.target.closest('[data-close]')) { selectedLaunch = null; detailPr = null; render(); renderDetail(); return; }
  const c = e.target.closest('.card[data-pr]');
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
