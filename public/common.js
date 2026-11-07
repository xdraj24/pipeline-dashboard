const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const md = (text) => (window.marked ? `<div class="md">${marked.parse(text ?? '')}</div>` : `<pre class="md">${esc(text)}</pre>`);
const pill = (cls, text, title = '') => `<span class="pill ${cls}" title="${esc(title)}">${text}</span>`;
const copyBtn = (text) => `<button class="copy" data-copy="${esc(text)}" title="Copy">Copy</button>`;
const cmdBox = (command, buttons) => `<div class="cmdbox"><code data-copy="${esc(command)}" title="${esc(command)} (click to copy)">${esc(command)}</code>${copyBtn(command)}${buttons}</div>`;
const hs = (cls, label, title = '') => `<span class="hs" title="${esc(title)}"><span class="sq ${cls}"></span>${label}</span>`;

function docHtml(text) {
  const m = (text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return md(text);
  const pairs = m[1].split(/\r?\n/).map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean);
  const fm = `<div class="fm">${pairs.map(([, k, v]) => `<span><span class="k">${esc(k.replace(/_/g, ' '))}</span> <b>${/^https?:/.test(v) ? `<a href="${esc(v)}" target="_blank">${esc(v)}</a>` : esc(v || '—')}</b></span>`).join('')}</div>`;
  return fm + md(text.slice(m[0].length));
}

function showDrawer(open) {
  $('#detail').classList.toggle('hidden', !open);
  $('#scrim').classList.toggle('hidden', !open);
}

async function postLaunch(btn, extra = {}) {
  const { run: command, runHow: how } = btn.dataset;
  if (how === 'headless' && !confirm(`Run headlessly from the repo root?\n\nclaude -p "${command}"\n\nIt will act without asking for permissions; questions for you show up on the board.`)) return null;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Starting…';
  const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, how, ...extra }) });
  if (!r.ok) { alert((await r.json()).error ?? 'launch failed'); btn.disabled = false; btn.textContent = label; return null; }
  return r.json();
}

function handleCopyClick(e) {
  const copy = e.target.closest('[data-copy]');
  if (!copy) return false;
  e.stopPropagation();
  navigator.clipboard.writeText(copy.dataset.copy);
  if (copy.classList.contains('copy')) { copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200); }
  else { copy.classList.add('flash'); setTimeout(() => copy.classList.remove('flash'), 600); }
  return true;
}

async function pollLaunchLog(id) {
  const r = await fetch(`/api/launches/${id}/log`);
  const pre = $('#log'); const meta = $('#log-meta');
  if (!pre) return;
  if (!r.ok) { pre.textContent = ''; meta.textContent = 'No log.'; return; }
  const d = await r.json();
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const running = !d.endedAt;
  meta.innerHTML = `<code>${esc(d.logPath.replace(/.*\/pipeline-dashboard\//, 'pipeline-dashboard/'))}</code> · ${(d.size / 1024).toFixed(0)} KB ${running ? pill('active', `<span class="dot pulse"></span> running · pid ${d.pid}`) + ` <button data-stop-launch="${d.id}">Stop</button>` : d.exitCode === 0 ? pill('done solid', 'finished ok') : pill('bad', d.error ? esc(d.error) : `exit ${d.exitCode ?? '?'}`)}${d.truncated ? ' · showing the tail' : ''}`;
  pre.textContent = d.text;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#scrim').classList.contains('hidden')) $('#scrim').click(); });
