// Client-facing portal — a separate static deployment from internal-ig-tool.
// No login: the secret token in the URL (/p/<slug>-<token>) is the only
// credential, resolved entirely server-side by the main app's token-scoped
// /api/client-portal/:token/* routes (see server.js). Ported from
// "Outreach Tool redesign prototype/Client Portal.dc.html" — same copy,
// layout and colors, read-only (no editing controls, unlike the admin side).

// The main app's own production domain — this is where every
// /api/client-portal/:token/* call actually goes. One-line change if that
// domain ever changes, same pattern as CLIENT_PORTAL_BASE_URL on the admin
// side (public/client-portal-admin.js).
const API_BASE = 'https://internal-ig-tool.vercel.app';

// crypto.randomBytes(24).toString('base64url') is always exactly 32 chars
// (24 bytes -> 32 base64 chars, no padding) — pulling a fixed-length
// suffix off the end of the path segment avoids any ambiguity from the
// human-readable slug prefix (which may itself contain dashes) or from
// base64url's own '-'/'_' characters.
const TOKEN_LENGTH = 32;

function getPortalToken() {
  const segments = window.location.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  return last.length >= TOKEN_LENGTH ? last.slice(-TOKEN_LENGTH) : '';
}

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchJson(path, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty or non-JSON body */ }
    if (!res.ok) throw new Error((data && data.error) || `Server error (${res.status})`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out.');
    if (e instanceof TypeError) throw new Error('Network error.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const state = {
  token: getPortalToken(),
  page: 'home',
  homePeriod: 'week',
  outreachPeriod: 'week',
  peopleFilter: 'all',
  peopleQuery: '',
  peopleShown: 24,
  profile: null,
  milestones: [],
  outreach: null
};

const CP_HEALTH = [
  { label: 'All systems running', bg: 'var(--purple)', icon: 'M20 6 9 17l-5-5' },
  { label: 'Needs your input', bg: '#9A3A0A', icon: 'M12 8v5M12 16.5v.01' },
  { label: 'Paused', bg: 'var(--muted)', icon: 'M10 6v12M14 6v12' }
];
const CP_PERIOD_DELTA_LABEL = { week: 'vs last week', month: 'vs last month', all: 'since the start' };
const CP_PERSON_STATUS_COLOR = { sent: { bg: 'var(--bg)', fg: 'var(--muted)' }, convo: { bg: '#E6DCEF', fg: 'var(--purple)' }, call: { bg: 'var(--purple)', fg: '#fff' } };
const CP_PERSON_STATUS_LABEL = { sent: 'Messaged', convo: 'In conversation', call: 'Call booked' };
const CP_PERSON_TONES = ['#E8E2DA', '#E9DACB', '#EFDDD0', '#DED6CD', '#E6DCD2', '#F0E3D6'];

init();

async function init() {
  if (!state.token) return showNotFound();
  try {
    const [homeData, outreachData] = await Promise.all([
      fetchJson(`/api/client-portal/${state.token}/home`),
      fetchJson(`/api/client-portal/${state.token}/outreach`)
    ]);
    state.profile = homeData.profile;
    state.milestones = homeData.milestones;
    state.outreach = outreachData;
  } catch (e) {
    return showNotFound();
  }
  $('#cp-app').classList.remove('hidden');
  setupSidebar();
  setupNav();
  setupHomeControls();
  setupOutreachControls();
  renderAll();
}

function showNotFound() {
  $('#cp-not-found').classList.remove('hidden');
}

function setupSidebar() {
  const p = state.profile;
  const firstName = p.clientFirstName || p.name;
  $('#cp-sidebar-initial').textContent = (firstName[0] || '?').toUpperCase();
  $('#cp-sidebar-name').textContent = firstName + (p.clientLastName ? ` ${p.clientLastName}` : '');
  $('#cp-sidebar-since').textContent = p.clientSince
    ? `Client since ${new Date(p.clientSince).toLocaleDateString('en-GB', { month: 'long' })}`
    : '';

  if (p.clientRellaUrl) {
    $('#cp-nav-rella').href = p.clientRellaUrl;
    $('#cp-nav-rella').classList.remove('hidden');
  }
  if (p.clientLandingUrl) {
    const url = /^https?:\/\//i.test(p.clientLandingUrl) ? p.clientLandingUrl : `https://${p.clientLandingUrl}`;
    $('#cp-nav-landing').href = url;
    $('#cp-nav-landing').classList.remove('hidden');
  }

  let collapsed = false;
  try { collapsed = localStorage.getItem('cp.sidebarCollapsed') === '1'; } catch (e) {}
  applySidebarCollapsed(collapsed);
  $('#cp-sidebar-toggle').addEventListener('click', () => {
    applySidebarCollapsed(!$('#cp-sidebar').classList.contains('collapsed'));
  });
}

function applySidebarCollapsed(collapsed) {
  $('#cp-sidebar').classList.toggle('collapsed', collapsed);
  $('#cp-sidebar-chev').innerHTML = collapsed
    ? '<path d="m9 18 6-6-6-6"></path>'
    : '<path d="m15 18-6-6 6-6"></path>';
  try { localStorage.setItem('cp.sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
}

function setupNav() {
  $('#cp-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.cp-nav-btn[data-page]');
    if (!btn) return;
    goTo(btn.dataset.page);
  });
  $('#cp-other-home-btn').addEventListener('click', () => goTo('home'));
  $('#cp-see-outreach-btn').addEventListener('click', () => goTo('outreach'));
}

function goTo(page) {
  state.page = page;
  renderAll();
}

function renderAll() {
  $all('#cp-nav .cp-nav-btn[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === state.page));
  $('#cp-view-home').classList.toggle('hidden', state.page !== 'home');
  $('#cp-view-outreach').classList.toggle('hidden', state.page !== 'outreach');
  $('#cp-view-other').classList.toggle('hidden', state.page === 'home' || state.page === 'outreach');
  if (state.page === 'home') renderHome();
  else if (state.page === 'outreach') renderOutreach();
  else renderOther();
}

function renderOther() {
  const labels = { scripting: 'Scripting' };
  $('#cp-other-label').textContent = labels[state.page] || state.page;
}

// ---------- HOME ----------

function setupHomeControls() {
  $('#cp-home-period-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-tab');
    if (!btn) return;
    state.homePeriod = btn.dataset.period;
    $all('#cp-home-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderMiniStats();
  });
}

function renderHome() {
  const p = state.profile;
  const h = new Date().getHours();
  const greet = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = p.clientFirstName || p.name;
  $('#cp-home-date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#cp-greeting').textContent = `${greet}, ${firstName}.`;
  $('#cp-status-line').textContent = p.clientStatusLine || "Everything is on track. Here's what we've been working on.";

  const health = CP_HEALTH[p.clientHealth || 0];
  $('#cp-health-dot').style.background = health.bg;
  $('#cp-health-dot').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${health.icon}"></path></svg>`;
  $('#cp-health-label').textContent = health.label;

  const done = state.milestones.filter(m => m.status === 'done').length;
  $('#cp-milestones-title').textContent = `${done} of ${state.milestones.length} done this month`;
  $('#cp-milestones-month').textContent = new Date().toLocaleDateString('en-GB', { month: 'long' });
  $('#cp-ms-bar').innerHTML = state.milestones.map(m =>
    `<span style="background:${m.status === 'done' ? 'var(--purple)' : m.status === 'active' ? '#B9A3CC' : 'var(--border)'};"></span>`
  ).join('');
  $('#cp-milestones-list').innerHTML = state.milestones.map((m, i) => renderMilestoneRow(m, i)).join('');

  $all('#cp-home-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b.dataset.period === state.homePeriod));
  renderMiniStats();

  const rellaCard = $('#cp-home-rella-card');
  if (p.clientRellaUrl) { rellaCard.href = p.clientRellaUrl; rellaCard.classList.remove('hidden'); }
  else rellaCard.classList.add('hidden');
  $('#cp-home-rella-note').textContent = '';

  const landingCard = $('#cp-home-landing-card');
  if (p.clientLandingUrl) {
    const url = /^https?:\/\//i.test(p.clientLandingUrl) ? p.clientLandingUrl : `https://${p.clientLandingUrl}`;
    landingCard.href = url;
    landingCard.classList.remove('hidden');
    $('#cp-home-landing-url').textContent = p.clientLandingUrl;
  } else {
    landingCard.classList.add('hidden');
  }
}

function renderMilestoneRow(m, i) {
  const isLast = i === state.milestones.length - 1;
  const dotBg = m.status === 'done' ? 'var(--purple)' : '#fff';
  const dotBorder = m.status === 'next' ? 'var(--border)' : 'var(--purple)';
  const lineC = m.status === 'done' ? 'var(--purple)' : 'var(--border)';
  const fg = m.status === 'next' ? 'var(--muted)' : 'var(--text)';
  const tagBg = m.status === 'active' ? 'var(--purple)' : 'var(--bg)';
  const tagFg = m.status === 'active' ? '#fff' : 'var(--muted)';
  const icon = m.status === 'done'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>'
    : (m.status === 'active' ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--purple);"></span>' : '');
  return `
    <div class="cp-milestone-row">
      <div class="cp-ms-dot-col">
        <span class="cp-ms-dot" style="background:${dotBg};border:1.5px solid ${dotBorder};">${icon}</span>
        ${!isLast ? `<span class="cp-ms-line" style="background:${lineC};"></span>` : ''}
      </div>
      <div class="cp-ms-body">
        <div class="cp-ms-text">
          <span class="title" style="color:${fg};">${escapeHtml(m.title)}</span>
          <span class="sub">${escapeHtml(m.sub)}</span>
        </div>
        <span class="cp-ms-tag" style="background:${tagBg};color:${tagFg};">${escapeHtml(m.tag)}</span>
      </div>
    </div>`;
}

function renderMiniStats() {
  if (!state.outreach) { $('#cp-mini-stats').innerHTML = ''; return; }
  const periodData = state.outreach.periods[state.homePeriod];
  const f = periodData.funnel;
  const d = CP_PERIOD_DELTA_LABEL[state.homePeriod];
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

function setupOutreachControls() {
  $('#cp-outreach-period-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-tab');
    if (!btn) return;
    state.outreachPeriod = btn.dataset.period;
    $all('#cp-outreach-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b === btn));
    state.peopleShown = 24;
    renderOutreach();
  });
  $('#cp-people-search').addEventListener('input', (e) => {
    state.peopleQuery = e.target.value;
    state.peopleShown = 24;
    renderOutreachPeople();
  });
  $('#cp-people-filter-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-tab');
    if (!btn) return;
    state.peopleFilter = btn.dataset.filter;
    $all('#cp-people-filter-tabs .range-tab').forEach(b => b.classList.toggle('active', b === btn));
    state.peopleShown = 24;
    renderOutreachPeople();
  });
  $('#cp-people-more-btn').addEventListener('click', () => {
    state.peopleShown += 24;
    renderOutreachPeople();
  });
}

function renderOutreach() {
  if (!state.outreach) return;
  $all('#cp-outreach-period-tabs .range-tab').forEach(b => b.classList.toggle('active', b.dataset.period === state.outreachPeriod));
  const o = state.outreach;
  const periodData = o.periods[state.outreachPeriod];
  const f = periodData.funnel;
  const plabel = { week: 'This week', month: 'This month', all: 'Since the start' }[state.outreachPeriod];
  $('#cp-outreach-period-label').textContent = plabel;

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
  renderOutreachPeople();

  $('#cp-total-leads-value').textContent = (o.totalLeadsTarget || 0).toLocaleString('en');
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

function renderOutreachPeople() {
  const o = state.outreach;
  if (!o) return;
  const q = state.peopleQuery.trim().toLowerCase().replace('@', '');
  const filtered = o.people.filter(p => (state.peopleFilter === 'all' || p.status === state.peopleFilter) && (!q || p.handle.toLowerCase().includes(q)));
  const shown = filtered.slice(0, state.peopleShown);
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
