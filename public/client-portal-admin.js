// ---------- CLIENT PORTAL (admin side) ----------
// Ported from "Outreach Tool redesign prototype/Client Portal Backend.dc.html"
// — same copy/layout/colors, plain DOM rendering instead of the prototype's
// own template runtime. fetchJson/$/$all/escapeHtml/activeWorkspace all come
// from app.js (loaded first), same shared-global-scope pattern every other
// page script in this app already uses.

const cpState = {
  mode: 'home',
  homePeriod: 'week',
  outreachPeriod: 'week',
  profile: null,
  milestones: [],
  formats: [],
  scripts: [],
  outreach: null,
  peopleFilter: 'all',
  peopleQuery: '',
  peopleShown: 24
};

const CP_HEALTH = [
  { label: 'All systems running', bg: 'var(--purple)', icon: 'M20 6 9 17l-5-5' },
  { label: 'Needs your input', bg: '#9A3A0A', icon: 'M12 8v5M12 16.5v.01' },
  { label: 'Paused', bg: 'var(--muted)', icon: 'M10 6v12M14 6v12' }
];
const CP_SCRIPT_STATUS_LABEL = { queued: 'Queued', written: 'Written', review: 'With us', approved: 'Approved', filmed: 'Filmed', posted: 'Posted' };
const CP_SCRIPT_STATUS_COLOR = {
  queued: { bg: 'var(--bg)', fg: 'var(--muted)' },
  written: { bg: '#E6DCEF', fg: 'var(--purple)' },
  review: { bg: '#B9A3CC', fg: '#141413' },
  approved: { bg: 'var(--purple)', fg: '#fff' },
  filmed: { bg: '#141413', fg: '#fff' },
  posted: { bg: 'var(--bg)', fg: 'var(--muted)' }
};

async function loadClientPortalAdmin() {
  const ws = activeWorkspace();
  $('#cp-client-name-heading').textContent = ws ? ws.name : 'Client';
  try {
    const [profileData, milestonesData, formatsData, scriptsData] = await Promise.all([
      fetchJson('/api/client/profile'),
      fetchJson('/api/client/milestones'),
      fetchJson('/api/client/formats'),
      fetchJson('/api/client/scripts')
    ]);
    cpState.profile = profileData.profile;
    cpState.milestones = milestonesData.milestones;
    cpState.formats = formatsData.formats;
    cpState.scripts = scriptsData.scripts;
  } catch (e) {
    console.error('Could not load client portal data', e);
    alert(`Could not load client portal: ${e.message}`);
    return;
  }
  const firstName = cpState.profile.clientFirstName || cpState.profile.name;
  $('#cp-banner-text').textContent = `You're editing ${firstName}'s portal. Dashed fields are editable — ${firstName} sees changes right away.`;
  await loadCpOutreach(); // needed by both Home's mini stats and the Outreach tab
  renderCpAll();
}

async function loadCpOutreach() {
  try {
    cpState.outreach = await fetchJson('/api/client/outreach-stats');
  } catch (e) {
    console.error('Could not load outreach stats', e);
  }
}

function renderCpAll() {
  $all('#cp-mode-tabs .range-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === cpState.mode));
  $('#cp-home-section').classList.toggle('hidden', cpState.mode !== 'home');
  $('#cp-outreach-section').classList.toggle('hidden', cpState.mode !== 'outreach');
  $('#cp-scripts-section').classList.toggle('hidden', cpState.mode !== 'scripts');
  if (cpState.mode === 'home') renderCpHome();
  if (cpState.mode === 'outreach') renderCpOutreach();
  if (cpState.mode === 'scripts') renderCpScripts();
}

$('#cp-mode-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  cpState.mode = btn.dataset.mode;
  renderCpAll();
});

$('#cp-copy-link-btn').addEventListener('click', async () => {
  const token = cpState.profile.clientPortalToken;
  if (!token) return;
  const url = `${CLIENT_PORTAL_BASE_URL}/p/${encodeURIComponent(slugify(cpState.profile.clientFirstName || cpState.profile.name))}-${token}`;
  try {
    await navigator.clipboard.writeText(url);
    const btn = $('#cp-copy-link-btn');
    const original = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (e) {
    prompt('Copy this link:', url);
  }
});

// The client-facing project's real deployed domain (its own Vercel
// project, root directory client-portal — see the client-portal plan's
// step 5).
const CLIENT_PORTAL_BASE_URL = 'https://ap-media-client-portal.vercel.app';
function slugify(name) {
  return String(name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'client';
}

// ---------- HOME ----------

async function cpPatchProfile(body) {
  await fetchJson('/api/client/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function renderCpHome() {
  const p = cpState.profile;
  const h = new Date().getHours();
  const greet = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = p.clientFirstName || p.name;
  $('#cp-home-date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#cp-greeting').textContent = `${greet}, ${firstName}.`;
  $('#cp-status-line').value = p.clientStatusLine || '';
  const health = CP_HEALTH[p.clientHealth || 0];
  $('#cp-health-dot').style.background = health.bg;
  $('#cp-health-dot').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${health.icon}"></path></svg>`;
  $('#cp-health-label').textContent = health.label;

  const done = cpState.milestones.filter(m => m.status === 'done').length;
  $('#cp-milestones-title').textContent = `${done} of ${cpState.milestones.length} done this month`;
  $('#cp-ms-bar').innerHTML = cpState.milestones.map(m =>
    `<span style="background:${m.status === 'done' ? 'var(--purple)' : m.status === 'active' ? '#B9A3CC' : 'var(--border)'};"></span>`
  ).join('');
  $('#cp-milestones-list').innerHTML = cpState.milestones.map((m, i) => renderCpMilestoneRow(m, i)).join('');

  $all('#cp-home-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b.dataset.period === cpState.homePeriod));
  renderCpMiniStats();

  $('#cp-link-rella').value = p.clientRellaUrl || '';
  $('#cp-link-landing').value = p.clientLandingUrl || '';
  $('#cp-link-drive').value = p.clientDriveUrl || '';
}

function renderCpMilestoneRow(m, i) {
  const isLast = i === cpState.milestones.length - 1;
  const dotBg = m.status === 'done' ? 'var(--purple)' : '#fff';
  const dotBorder = m.status === 'next' ? 'var(--border)' : 'var(--purple)';
  const lineC = m.status === 'done' ? 'var(--purple)' : 'var(--border)';
  const fg = m.status === 'next' ? 'var(--muted)' : 'var(--text)';
  const tagBg = m.status === 'active' ? 'var(--purple)' : 'var(--bg)';
  const tagFg = m.status === 'active' ? '#fff' : 'var(--muted)';
  const statusTitle = { done: 'Done', active: 'In progress', next: 'Up next' }[m.status] + ' — click to change';
  const icon = m.status === 'done'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>'
    : (m.status === 'active' ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--purple);"></span>' : '');
  return `
    <div class="cp-milestone-row" data-id="${m.id}">
      <div class="cp-ms-dot-col">
        <button type="button" class="cp-ms-dot cp-ms-cycle" title="${escapeHtml(statusTitle)}" style="background:${dotBg};border-color:${dotBorder};color:#fff;">${icon}</button>
        ${!isLast ? `<span class="cp-ms-line" style="background:${lineC};"></span>` : ''}
      </div>
      <div class="cp-ms-body">
        <div class="cp-ms-text">
          <input class="cp-ms-title-input cp-ms-title" value="${escapeHtml(m.title)}" placeholder="Milestone" style="color:${fg};">
          <input class="cp-ms-sub-input cp-ms-sub" value="${escapeHtml(m.sub)}" placeholder="Short description">
        </div>
        <input class="cp-ms-tag cp-ms-tag-input" value="${escapeHtml(m.tag)}" placeholder="Date" style="background:${tagBg};color:${tagFg};">
        <div class="cp-ms-actions">
          <button type="button" class="cp-icon-btn cp-ms-up" title="Move up">↑</button>
          <button type="button" class="cp-icon-btn cp-ms-down" title="Move down">↓</button>
          <button type="button" class="cp-icon-btn cp-ms-remove" title="Remove">×</button>
        </div>
      </div>
    </div>`;
}

$('#cp-milestones-list').addEventListener('click', async (e) => {
  const row = e.target.closest('.cp-milestone-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.cp-ms-cycle')) {
    const m = cpState.milestones.find(x => x.id === id);
    const next = { done: 'active', active: 'next', next: 'done' }[m.status];
    m.status = next;
    renderCpHome();
    try { await fetchJson(`/api/client/milestones/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) }); }
    catch (err) { alert(`Could not update: ${err.message}`); }
  } else if (e.target.closest('.cp-ms-up') || e.target.closest('.cp-ms-down')) {
    const direction = e.target.closest('.cp-ms-up') ? 'up' : 'down';
    try {
      await fetchJson(`/api/client/milestones/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) });
      cpState.milestones = (await fetchJson('/api/client/milestones')).milestones;
      renderCpHome();
    } catch (err) { alert(`Could not reorder: ${err.message}`); }
  } else if (e.target.closest('.cp-ms-remove')) {
    if (!confirm('Remove this milestone?')) return;
    try {
      await fetchJson(`/api/client/milestones/${id}`, { method: 'DELETE' });
      cpState.milestones = cpState.milestones.filter(x => x.id !== id);
      renderCpHome();
    } catch (err) { alert(`Could not remove: ${err.message}`); }
  }
});

$('#cp-milestones-list').addEventListener('change', async (e) => {
  const row = e.target.closest('.cp-milestone-row');
  if (!row) return;
  const id = row.dataset.id;
  const field = e.target.classList.contains('cp-ms-title') ? 'title' : e.target.classList.contains('cp-ms-sub') ? 'sub' : e.target.classList.contains('cp-ms-tag-input') ? 'tag' : null;
  if (!field) return;
  try { await fetchJson(`/api/client/milestones/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: e.target.value }) }); }
  catch (err) { alert(`Could not save: ${err.message}`); }
});

$('#cp-add-milestone-btn').addEventListener('click', async () => {
  try {
    await fetchJson('/api/client/milestones', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'next', title: '', sub: '' }) });
    cpState.milestones = (await fetchJson('/api/client/milestones')).milestones;
    renderCpHome();
  } catch (err) { alert(`Could not add milestone: ${err.message}`); }
});

$('#cp-status-line').addEventListener('change', (e) => cpPatchProfile({ clientStatusLine: e.target.value }).catch(err => alert(`Could not save: ${err.message}`)));
$('#cp-health-btn').addEventListener('click', async () => {
  const next = ((cpState.profile.clientHealth || 0) + 1) % CP_HEALTH.length;
  cpState.profile.clientHealth = next;
  renderCpHome();
  try { await cpPatchProfile({ clientHealth: next }); } catch (err) { alert(`Could not save: ${err.message}`); }
});
$('#cp-link-rella').addEventListener('change', (e) => cpPatchProfile({ clientRellaUrl: e.target.value }).catch(err => alert(`Could not save: ${err.message}`)));
$('#cp-link-landing').addEventListener('change', (e) => cpPatchProfile({ clientLandingUrl: e.target.value }).catch(err => alert(`Could not save: ${err.message}`)));
$('#cp-link-drive').addEventListener('change', (e) => cpPatchProfile({ clientDriveUrl: e.target.value }).catch(err => alert(`Could not save: ${err.message}`)));

$('#cp-home-period-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  cpState.homePeriod = btn.dataset.period;
  $all('#cp-home-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b === btn));
  renderCpMiniStats();
});
$('#cp-see-outreach-btn').addEventListener('click', () => {
  cpState.mode = 'outreach';
  $all('#cp-mode-tabs .range-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === 'outreach'));
  renderCpAll();
});

const CP_PERIOD_DELTA_LABEL = { week: 'vs last week', month: 'vs last month', all: 'since the start' };
function renderCpMiniStats() {
  if (!cpState.outreach) { $('#cp-mini-stats').innerHTML = ''; return; }
  const periodData = cpState.outreach.periods[cpState.homePeriod];
  const f = periodData.funnel;
  const d = CP_PERIOD_DELTA_LABEL[cpState.homePeriod];
  const rows = [
    { label: 'Reach-outs', desc: 'People we messaged for you', value: f.totalSends.toLocaleString('en'), showRate: false, bg: '#fff', fg: 'var(--text)' },
    { label: 'Conversations', desc: 'People who replied and are talking', value: `${f.replies}`, showRate: true, rate: f.replyRate != null ? `${f.replyRate}% replied` : '—', bg: '#fff', fg: 'var(--text)' },
    { label: 'Intakes booked', desc: 'Calls on your calendar', value: `${f.appointmentsSet}`, showRate: true, rate: f.asr != null ? `${f.asr}% of conversations booked a call` : '—', bg: 'var(--text)', fg: '#fff' }
  ];
  $('#cp-mini-stats').innerHTML = rows.map(r => `
    <div>
      ${r.showRate ? `<div class="cp-mini-stat-rate"><span class="sep"></span><span style="font-size:0.82rem;color:var(--muted);">${escapeHtml(r.rate)}</span></div>` : ''}
      <div class="cp-mini-stat-row" style="background:${r.bg};color:${r.fg};">
        <div class="cp-mini-stat-main">
          <span class="label">${escapeHtml(r.label)}</span>
          <span class="desc" style="color:${r.bg === 'var(--text)' ? '#BDB6AE' : 'var(--muted)'};">${escapeHtml(r.desc)}</span>
        </div>
        <div class="cp-mini-stat-num">
          <span class="value">${escapeHtml(r.value)}</span>
          <span class="delta" style="color:${r.bg === 'var(--text)' ? '#BDB6AE' : 'var(--muted)'};">${escapeHtml(d)}</span>
        </div>
      </div>
    </div>`).join('');
}

// ---------- OUTREACH ----------

$('#cp-outreach-period-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  cpState.outreachPeriod = btn.dataset.period;
  $all('#cp-outreach-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b === btn));
  cpState.peopleShown = 24;
  renderCpOutreach();
});
$('#cp-people-search').addEventListener('input', (e) => { cpState.peopleQuery = e.target.value; cpState.peopleShown = 24; renderCpOutreachPeople(); });
$('#cp-people-filter-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  cpState.peopleFilter = btn.dataset.filter;
  $all('#cp-people-filter-tabs .range-tab').forEach(b => b.classList.toggle('active', b === btn));
  cpState.peopleShown = 24;
  renderCpOutreachPeople();
});
$('#cp-people-more-btn').addEventListener('click', () => { cpState.peopleShown += 24; renderCpOutreachPeople(); });
$('#cp-total-leads-input').addEventListener('change', async (e) => {
  const value = Math.max(0, parseInt(e.target.value, 10) || 0);
  try {
    await cpPatchProfile({ clientTotalLeadsTarget: value });
    cpState.profile.clientTotalLeadsTarget = value;
    await loadCpOutreach();
    renderCpOutreach();
  } catch (err) { alert(`Could not save: ${err.message}`); }
});

function renderCpOutreach() {
  if (!cpState.outreach) return;
  $all('#cp-outreach-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b.dataset.period === cpState.outreachPeriod));
  const o = cpState.outreach;
  const periodData = o.periods[cpState.outreachPeriod];
  const f = periodData.funnel;
  const plabel = { week: 'This week', month: 'This month', all: 'Since the start' }[cpState.outreachPeriod];

  $('#cp-outreach-core').innerHTML = [
    { label: 'Calls booked', value: f.appointmentsSet, note: f.asr != null ? `${f.asr}% of reach-outs` : '—', bg: 'var(--purple)', fg: '#fff', sub: '#E6DCEF' },
    { label: 'Conversations', value: f.replies, note: f.replyRate != null ? `${f.replyRate}% replied` : '—', bg: '#fff', fg: 'var(--text)', sub: 'var(--muted)' },
    { label: 'People reached out to', value: f.totalSends, note: plabel.toLowerCase(), bg: '#fff', fg: 'var(--text)', sub: 'var(--muted)' }
  ].map(k => `
    <div class="cp-outreach-core-tile" style="background:${k.bg};color:${k.fg};">
      <span class="label">${escapeHtml(k.label)}</span>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <span class="value">${k.value}</span>
        <span class="note" style="color:${k.sub};">${escapeHtml(String(k.note))}</span>
      </div>
    </div>`).join('');

  $('#cp-funnel-title').textContent = f.prr != null ? `${f.prr}% of people we message book a call` : "We'll see conversion rates once sends start.";
  const funnelSteps = [
    { label: 'Reached out', value: f.totalSends, desc: 'People we sent a first message to', w: '100%', bar: 'var(--text)', showRate: false },
    { label: 'Started a conversation', value: f.replies, desc: 'Replied and are talking with us', w: `${f.totalSends > 0 ? (f.replies / f.totalSends * 100) : 0}%`, bar: '#8A5BB0', showRate: true, rate: f.replyRate, rateLabel: 'replied' },
    { label: 'Booked a call', value: f.appointmentsSet, desc: 'Calls on your calendar', w: `${Math.max(2, f.totalSends > 0 ? (f.appointmentsSet / f.totalSends * 100) : 0)}%`, bar: 'var(--purple)', showRate: true, rate: f.asr, rateLabel: 'booked' }
  ];
  $('#cp-funnel').innerHTML = funnelSteps.map(s => `
    <div class="cp-funnel-item">
      ${s.showRate ? `<div class="cp-funnel-rate"><span class="pct">${s.rate != null ? s.rate + '%' : '—'}</span><span class="lbl">${escapeHtml(s.rateLabel)}</span><span class="arrow">→</span></div>` : ''}
      <div class="cp-funnel-box">
        <span class="label">${escapeHtml(s.label)}</span>
        <span class="value">${s.value.toLocaleString('en')}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${s.w};background:${s.bar};"></div></div>
        <span class="desc">${escapeHtml(s.desc)}</span>
      </div>
    </div>`).join('');

  $('#cp-people-title').textContent = `${o.people.length.toLocaleString('en')} most recent`;
  renderCpOutreachPeople();

  $('#cp-total-leads-input').value = o.totalLeadsTarget || '';
  const reachedPct = o.totalLeadsTarget > 0 ? Math.min(100, Math.max(8, o.reached / o.totalLeadsTarget * 100)) : 100;
  $('#cp-progress-fill').style.width = `${reachedPct}%`;
  $('#cp-progress-fill').textContent = `${o.reached.toLocaleString('en')} reached`;
  $('#cp-progress-rest').textContent = `${o.left.toLocaleString('en')} to go`;
  $('#cp-pace-note').textContent = o.perWeek > 0
    ? `At around ${o.perWeek} a week, we'll reach everyone in about ${o.weeksRemaining} weeks.`
    : 'Not enough sends yet to estimate a pace.';
  $('#cp-proj-title').textContent = `With your current conversion rates, the ${o.left.toLocaleString('en')} leads still to come should bring in around ${o.expectedCalls.toLocaleString('en')} calls.`;
  $('#cp-proj-row').innerHTML = [
    { v: o.left.toLocaleString('en'), l: 'Leads still to come', bg: '#141413', fg: '#fff', sub: '#BDB6AE', arrow: false },
    { v: `≈ ${o.expectedConversations.toLocaleString('en')}`, l: 'Expected conversations', bg: '#141413', fg: '#fff', sub: '#BDB6AE', arrow: true, rate: periodData.total > 0 ? Math.round(f.replies / Math.max(1, f.totalSends) * 1000) / 10 + '%' : '—' },
    { v: `≈ ${o.expectedCalls.toLocaleString('en')}`, l: 'Expected calls', bg: 'var(--bg)', fg: 'var(--text)', sub: 'var(--muted)', arrow: true, rate: f.asr != null ? f.asr + '%' : '—' }
  ].map(p => `
    <div class="cp-proj-item">
      ${p.arrow ? `<div class="cp-proj-arrow"><span>${escapeHtml(p.rate)}</span><span class="big">→</span></div>` : ''}
      <div class="cp-proj-tile" style="background:${p.bg};color:${p.fg};">
        <span class="value">${escapeHtml(p.v)}</span>
        <span class="label" style="color:${p.sub};">${escapeHtml(p.l)}</span>
      </div>
    </div>`).join('');
}

const CP_PERSON_STATUS_COLOR = { sent: { bg: 'var(--bg)', fg: 'var(--muted)' }, convo: { bg: '#E6DCEF', fg: 'var(--purple)' }, call: { bg: 'var(--purple)', fg: '#fff' } };
const CP_PERSON_STATUS_LABEL = { sent: 'Messaged', convo: 'In conversation', call: 'Call booked' };
const CP_PERSON_TONES = ['#E8E2DA', '#E9DACB', '#EFDDD0', '#DED6CD', '#E6DCD2', '#F0E3D6'];
function renderCpOutreachPeople() {
  const o = cpState.outreach;
  if (!o) return;
  const q = cpState.peopleQuery.trim().toLowerCase().replace('@', '');
  const filtered = o.people.filter(p => (cpState.peopleFilter === 'all' || p.status === cpState.peopleFilter) && (!q || p.handle.toLowerCase().includes(q)));
  const shown = filtered.slice(0, cpState.peopleShown);
  $('#cp-people-grid').innerHTML = shown.map((p, i) => {
    const c = CP_PERSON_STATUS_COLOR[p.status];
    return `
    <div class="cp-person">
      <span class="cp-person-avatar" style="background:${CP_PERSON_TONES[i % CP_PERSON_TONES.length]};">${escapeHtml((p.handle[1] || p.handle[0] || '?').toUpperCase())}</span>
      <div class="cp-person-info">
        <span class="handle">${escapeHtml(p.handle)}</span>
        <span class="date">${p.date ? new Date(p.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</span>
      </div>
      <span class="cp-person-status" style="background:${c.bg};color:${c.fg};">${escapeHtml(CP_PERSON_STATUS_LABEL[p.status])}</span>
    </div>`;
  }).join('');
  $('#cp-people-empty').classList.toggle('hidden', filtered.length > 0);
  const more = filtered.length - shown.length;
  $('#cp-people-more-btn').classList.toggle('hidden', more <= 0);
  $('#cp-people-more-btn').textContent = `Show more (${more} left)`;
}

// ---------- SCRIPTS (queue management) ----------

function renderCpScripts() {
  const queued = cpState.scripts.filter(s => s.status === 'queued');
  const pipeline = cpState.scripts.filter(s => s.status !== 'queued');
  const firstName = cpState.profile.clientFirstName || cpState.profile.name;
  $('#cp-scripts-title').textContent = `${firstName}'s script list`;
  $('#cp-scripts-meta').textContent = `${pipeline.length} of ${cpState.scripts.length} scripted`;
  $('#cp-scripts-queue-title').textContent = queued.length ? `${queued.length} waiting for ${firstName}` : 'All caught up';

  $('#cp-script-format').innerHTML = cpState.formats.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  updateCpFormatDesc();

  $('#cp-scripts-queue-list').innerHTML = queued.map((s, i) => `
    <div class="cp-script-row" data-id="${s.id}">
      <span class="num">${String(i + 1).padStart(2, '0')}</span>
      <div class="cp-script-main">
        <input class="cp-script-inline-input cp-script-topic-input cp-script-topic-edit" value="${escapeHtml(s.topic)}">
        <div class="cp-script-hook-row"><span class="lbl">Hook:</span><input class="cp-script-inline-input cp-script-hook-input cp-script-hook-edit" value="${escapeHtml(s.hook)}"></div>
      </div>
      <select class="cp-script-format-select cp-script-format-edit">
        ${cpState.formats.map(f => `<option value="${f.id}" ${f.id === s.formatId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
      </select>
      <div class="cp-script-actions">
        <button type="button" class="cp-icon-btn cp-script-up" title="Move up" ${i === 0 ? 'style="visibility:hidden"' : ''}>↑</button>
        <button type="button" class="cp-icon-btn cp-script-down" title="Move down" ${i === queued.length - 1 ? 'style="visibility:hidden"' : ''}>↓</button>
        <button type="button" class="cp-icon-btn cp-script-remove" title="Remove">×</button>
      </div>
    </div>`).join('');
  $('#cp-scripts-queue-empty').classList.toggle('hidden', queued.length > 0);

  $('#cp-scripts-pipeline-list').innerHTML = pipeline.map(s => {
    const c = CP_SCRIPT_STATUS_COLOR[s.status];
    const date = s.statusChangedAt || s.scriptedAt;
    return `
    <div class="cp-script-row" data-id="${s.id}">
      <span class="cp-script-status-icon" style="background:${c.bg};color:${c.fg};"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span>
      <div class="cp-script-main">
        <span class="topic">${escapeHtml(s.topic)}</span>
        <span class="hook">${escapeHtml(s.hook)}</span>
      </div>
      <span class="cp-script-status-pill" style="background:${c.bg};color:${c.fg};">${escapeHtml(CP_SCRIPT_STATUS_LABEL[s.status])}</span>
      <span class="cp-script-date">${date ? new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</span>
      <div class="cp-script-actions">
        <select class="cp-script-status-select">
          ${CLIENT_SCRIPT_STATUSES_ADMIN.map(st => `<option value="${st}" ${st === s.status ? 'selected' : ''}>${CP_SCRIPT_STATUS_LABEL[st]}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }).join('') || '<p class="cp-hint">Nothing here yet.</p>';
}
const CLIENT_SCRIPT_STATUSES_ADMIN = ['written', 'review', 'approved', 'filmed', 'posted'];

function updateCpFormatDesc() {
  const f = cpState.formats.find(x => x.id === $('#cp-script-format').value) || cpState.formats[0];
  $('#cp-script-format-desc').textContent = f ? f.description : '';
}
$('#cp-script-format').addEventListener('change', updateCpFormatDesc);

$('#cp-script-add-btn').addEventListener('click', async () => {
  const topic = $('#cp-script-topic').value.trim();
  if (!topic) return;
  const hook = $('#cp-script-hook').value.trim();
  const formatId = $('#cp-script-format').value;
  try {
    await fetchJson('/api/client/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, hook, formatId }) });
    $('#cp-script-topic').value = '';
    $('#cp-script-hook').value = '';
    cpState.scripts = (await fetchJson('/api/client/scripts')).scripts;
    renderCpScripts();
  } catch (err) { alert(`Could not add topic: ${err.message}`); }
});

$('#cp-scripts-queue-list').addEventListener('click', async (e) => {
  const row = e.target.closest('.cp-script-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.cp-script-up') || e.target.closest('.cp-script-down')) {
    const direction = e.target.closest('.cp-script-up') ? 'up' : 'down';
    try {
      await fetchJson(`/api/client/scripts/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) });
      cpState.scripts = (await fetchJson('/api/client/scripts')).scripts;
      renderCpScripts();
    } catch (err) { alert(`Could not reorder: ${err.message}`); }
  } else if (e.target.closest('.cp-script-remove')) {
    if (!confirm('Remove this topic?')) return;
    try {
      await fetchJson(`/api/client/scripts/${id}`, { method: 'DELETE' });
      cpState.scripts = cpState.scripts.filter(x => x.id !== id);
      renderCpScripts();
    } catch (err) { alert(`Could not remove: ${err.message}`); }
  }
});

$('#cp-scripts-queue-list').addEventListener('change', async (e) => {
  const row = e.target.closest('.cp-script-row');
  if (!row) return;
  const id = row.dataset.id;
  const field = e.target.classList.contains('cp-script-topic-edit') ? 'topic'
    : e.target.classList.contains('cp-script-hook-edit') ? 'hook'
    : e.target.classList.contains('cp-script-format-edit') ? 'formatId' : null;
  if (!field) return;
  const value = e.target.value;
  try {
    await fetchJson(`/api/client/scripts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }) });
    const s = cpState.scripts.find(x => x.id === id);
    if (s) s[field] = value;
  } catch (err) { alert(`Could not save: ${err.message}`); }
});

$('#cp-scripts-pipeline-list').addEventListener('change', async (e) => {
  const select = e.target.closest('.cp-script-status-select');
  if (!select) return;
  const row = e.target.closest('.cp-script-row');
  const id = row.dataset.id;
  const status = select.value;
  select.disabled = true;
  try {
    await fetchJson(`/api/client/scripts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    const s = cpState.scripts.find(x => x.id === id);
    if (s) s.status = status;
    renderCpScripts();
  } catch (err) {
    alert(`Could not update status: ${err.message}`);
    select.disabled = false;
  }
});
