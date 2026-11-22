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
  outreach: null,
  scripts: [],
  formats: [],
  // Checked-but-not-yet-started queue selection on the Scripting hub, and
  // the active 5-step wizard session (null when not writing) — see
  // startSession()/goStep() below.
  scriptingPick: [],
  session: null,
  soundOff: false,
  // Set from profile.clientPortalLanguage once it loads (see init()); t()
  // and dateLocale() (i18n.js) both read this directly.
  lang: 'en'
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
    const [homeData, outreachData, scriptsData, formatsData] = await Promise.all([
      fetchJson(`/api/client-portal/${state.token}/home`),
      fetchJson(`/api/client-portal/${state.token}/outreach`),
      fetchJson(`/api/client-portal/${state.token}/scripts`),
      fetchJson(`/api/client-portal/${state.token}/formats`)
    ]);
    state.profile = homeData.profile;
    state.milestones = homeData.milestones;
    state.outreach = outreachData;
    state.scripts = scriptsData.scripts;
    state.formats = formatsData.formats;
  } catch (e) {
    return showNotFound();
  }
  state.lang = state.profile.clientPortalLanguage === 'nl' ? 'nl' : 'en';
  document.documentElement.lang = state.lang;
  applyStaticI18n();
  $('#cp-app').classList.remove('hidden');
  setupSidebar();
  setupNav();
  setupHomeControls();
  setupOutreachControls();
  setupScriptingControls();
  setupSessionControls();
  renderAll();
}

// Sends a mutating request (POST/PATCH) to a token-scoped client-portal
// route. Mirrors fetchJson's error handling but isn't a GET, so it isn't
// built around that function's own signature.
async function sendJson(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty or non-JSON body */ }
  if (!res.ok) throw new Error((data && data.error) || `Server error (${res.status})`);
  return data;
}

function showNotFound() {
  $('#cp-not-found').classList.remove('hidden');
}

function setupSidebar() {
  const p = state.profile;
  const firstName = p.clientFirstName || p.name;
  const initial = (firstName[0] || '?').toUpperCase();
  $('#cp-sidebar-initial').textContent = initial;
  $('#cp-mobile-avatar').textContent = initial;
  $('#cp-sidebar-name').textContent = firstName + (p.clientLastName ? ` ${p.clientLastName}` : '');

  if (p.clientRellaUrl) {
    $('#cp-nav-rella').href = p.clientRellaUrl;
    $('#cp-nav-rella').classList.remove('hidden');
    $('#cp-nav-rella-mobile').href = p.clientRellaUrl;
    $('#cp-nav-rella-mobile').classList.remove('hidden');
  }
  if (p.clientLandingUrl) {
    const url = /^https?:\/\//i.test(p.clientLandingUrl) ? p.clientLandingUrl : `https://${p.clientLandingUrl}`;
    $('#cp-nav-landing').href = url;
    $('#cp-nav-landing').classList.remove('hidden');
    $('#cp-nav-landing-mobile').href = url;
    $('#cp-nav-landing-mobile').classList.remove('hidden');
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
  // Delegated on body (not scoped to #cp-nav) so the same handler drives
  // both the desktop sidebar nav and the mobile bottom tab bar — they
  // share the .cp-nav-btn[data-page] markup contract.
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.cp-nav-btn[data-page]');
    if (!btn) return;
    goTo(btn.dataset.page);
  });
  $('#cp-see-outreach-btn').addEventListener('click', () => goTo('outreach'));
}

function goTo(page) {
  state.page = page;
  renderAll();
}

function renderAll() {
  // The session wizard is reached only from inside Scripting, so its own
  // nav tab stays highlighted while a session is open — there's no
  // separate "Session" nav item for it to steal the active state from.
  const navPage = state.page === 'session' ? 'scripting' : state.page;
  $all('.cp-nav-btn[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === navPage));
  $('#cp-view-home').classList.toggle('hidden', state.page !== 'home');
  $('#cp-view-outreach').classList.toggle('hidden', state.page !== 'outreach');
  $('#cp-view-scripting').classList.toggle('hidden', state.page !== 'scripting');
  $('#cp-view-session').classList.toggle('hidden', state.page !== 'session');
  if (state.page === 'home') renderHome();
  else if (state.page === 'outreach') renderOutreach();
  else if (state.page === 'scripting') renderScripting();
  else if (state.page === 'session') renderSession();
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
  const greet = h < 5 ? t('Good evening') : h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening');
  const firstName = p.clientFirstName || p.name;
  $('#cp-home-date').textContent = new Date().toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
  $('#cp-greeting').textContent = `${greet}, ${firstName}.`;
  $('#cp-status-line').textContent = p.clientStatusLine || t("Everything is on track. Here's what we've been working on.");

  const health = CP_HEALTH[p.clientHealth || 0];
  $('#cp-health-dot').style.background = health.bg;
  $('#cp-health-dot').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${health.icon}"></path></svg>`;
  $('#cp-health-label').textContent = t(health.label);

  const done = state.milestones.filter(m => m.status === 'done').length;
  $('#cp-milestones-title').textContent = state.lang === 'nl'
    ? `${done} van ${state.milestones.length} klaar deze maand`
    : `${done} of ${state.milestones.length} done this month`;
  $('#cp-milestones-month').textContent = new Date().toLocaleDateString(dateLocale(), { month: 'long' });
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
  const d = t(CP_PERIOD_DELTA_LABEL[state.homePeriod]);
  const pctReplied = (pct) => state.lang === 'nl' ? `${pct}% reageerde` : `${pct}% replied`;
  const pctBookedConvo = (pct) => state.lang === 'nl' ? `${pct}% van de gesprekken boekte een call` : `${pct}% of conversations booked a call`;
  const rows = [
    { label: t('Reach-outs'), desc: t('People we messaged for you'), value: f.totalSends.toLocaleString(dateLocale()), showRate: false, bg: '#fff', fg: 'var(--text)' },
    { label: t('Conversations'), desc: t('People who replied and are talking'), value: `${f.replies}`, showRate: true, rate: f.replyRate != null ? pctReplied(f.replyRate) : '—', bg: '#fff', fg: 'var(--text)' },
    { label: t('Intakes booked'), desc: t('Calls on your calendar'), value: `${f.appointmentsSet}`, showRate: true, rate: f.asr != null ? pctBookedConvo(f.asr) : '—', bg: 'var(--text)', fg: '#fff' }
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
  const locale = dateLocale();
  const plabelMap = { week: 'This week', month: 'This month', all: 'Since the start' };
  const plabelLowerMap = { week: 'this week', month: 'this month', all: 'since the start' };
  const plabel = t(plabelMap[state.outreachPeriod]);
  $('#cp-outreach-period-label').textContent = plabel;
  const pctReachouts = (pct) => state.lang === 'nl' ? `${pct}% van de benaderingen` : `${pct}% of reach-outs`;
  const pctReplied = (pct) => state.lang === 'nl' ? `${pct}% reageerde` : `${pct}% replied`;

  $('#cp-outreach-core').innerHTML = [
    { label: t('Calls booked'), value: f.appointmentsSet, note: f.asr != null ? pctReachouts(f.asr) : '—', bg: 'var(--purple)', fg: '#fff', sub: '#E6DCEF' },
    { label: t('Conversations'), value: f.replies, note: f.replyRate != null ? pctReplied(f.replyRate) : '—', bg: '#fff', fg: 'var(--text)', sub: 'var(--muted)' },
    { label: t('People reached out to'), value: f.totalSends, note: t(plabelLowerMap[state.outreachPeriod]), bg: '#fff', fg: 'var(--text)', sub: 'var(--muted)' }
  ].map(k => `
    <div class="cp-outreach-core-tile" style="background:${k.bg};color:${k.fg};">
      <span class="label">${escapeHtml(k.label)}</span>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <span class="value">${k.value}</span>
        <span class="note" style="color:${k.sub};">${escapeHtml(String(k.note))}</span>
      </div>
    </div>`).join('');

  $('#cp-funnel-title').textContent = f.prr != null
    ? (state.lang === 'nl' ? `${f.prr}% van de mensen die we benaderen boekt een call` : `${f.prr}% of people we message book a call`)
    : t("We’ll see conversion rates once sends start.");
  const funnelSteps = [
    { label: t('Reached out'), value: f.totalSends, desc: t('People we sent a first message to'), w: '100%', bar: 'var(--text)', showRate: false },
    { label: t('Started a conversation'), value: f.replies, desc: t('Replied and are talking with us'), w: `${f.totalSends > 0 ? (f.replies / f.totalSends * 100) : 0}%`, bar: '#8A5BB0', showRate: true, rate: f.replyRate, rateLabel: t('replied') },
    { label: t('Booked a call'), value: f.appointmentsSet, desc: t('Calls on your calendar'), w: `${Math.max(2, f.totalSends > 0 ? (f.appointmentsSet / f.totalSends * 100) : 0)}%`, bar: 'var(--purple)', showRate: true, rate: f.asr, rateLabel: t('booked') }
  ];
  $('#cp-funnel').innerHTML = funnelSteps.map(s => `
    <div class="cp-funnel-item">
      ${s.showRate ? `<div class="cp-funnel-rate"><span class="pct">${s.rate != null ? s.rate + '%' : '—'}</span><span class="lbl">${escapeHtml(s.rateLabel)}</span><span class="arrow">→</span></div>` : ''}
      <div class="cp-funnel-box">
        <span class="label">${escapeHtml(s.label)}</span>
        <span class="value">${s.value.toLocaleString(locale)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${s.w};background:${s.bar};"></div></div>
        <span class="desc">${escapeHtml(s.desc)}</span>
      </div>
    </div>`).join('');

  $('#cp-people-title').textContent = state.lang === 'nl'
    ? `${o.people.length.toLocaleString(locale)} meest recent`
    : `${o.people.length.toLocaleString(locale)} most recent`;
  renderOutreachPeople();

  $('#cp-total-leads-value').textContent = (o.totalLeadsTarget || 0).toLocaleString(locale);
  const reachedPct = o.totalLeadsTarget > 0 ? Math.min(100, Math.max(8, o.reached / o.totalLeadsTarget * 100)) : 100;
  $('#cp-progress-fill').style.width = `${reachedPct}%`;
  $('#cp-progress-fill').textContent = state.lang === 'nl' ? `${o.reached.toLocaleString(locale)} benaderd` : `${o.reached.toLocaleString(locale)} reached`;
  $('#cp-progress-rest').textContent = state.lang === 'nl' ? `Nog ${o.left.toLocaleString(locale)} te gaan` : `${o.left.toLocaleString(locale)} to go`;
  $('#cp-pace-note').textContent = o.perWeek > 0
    ? (state.lang === 'nl'
        ? `Met zo’n ${o.perWeek} per week bereiken we iedereen in ongeveer ${o.weeksRemaining} weken.`
        : `At around ${o.perWeek} a week, we'll reach everyone in about ${o.weeksRemaining} weeks.`)
    : t('Not enough sends yet to estimate a pace.');
  $('#cp-proj-title').textContent = state.lang === 'nl'
    ? `Met je huidige conversie zouden de ${o.left.toLocaleString(locale)} leads die nog komen zo’n ${o.expectedCalls.toLocaleString(locale)} calls moeten opleveren.`
    : `With your current conversion rates, the ${o.left.toLocaleString(locale)} leads still to come should bring in around ${o.expectedCalls.toLocaleString(locale)} calls.`;
  $('#cp-proj-row').innerHTML = [
    { v: o.left.toLocaleString(locale), l: t('Leads still to come'), bg: '#141413', fg: '#fff', sub: '#BDB6AE', arrow: false },
    { v: `≈ ${o.expectedConversations.toLocaleString(locale)}`, l: t('Expected conversations'), bg: '#141413', fg: '#fff', sub: '#BDB6AE', arrow: true, rate: periodData.total > 0 ? Math.round(f.replies / Math.max(1, f.totalSends) * 1000) / 10 + '%' : '—' },
    { v: `≈ ${o.expectedCalls.toLocaleString(locale)}`, l: t('Expected calls'), bg: 'var(--bg)', fg: 'var(--text)', sub: 'var(--muted)', arrow: true, rate: f.asr != null ? f.asr + '%' : '—' }
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
        <span class="date">${p.date ? new Date(p.date).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) : ''}</span>
      </div>
      <span class="cp-person-status" style="background:${c.bg};color:${c.fg};">${escapeHtml(t(CP_PERSON_STATUS_LABEL[p.status]))}</span>
    </div>`;
  }).join('');
  $('#cp-people-empty').classList.toggle('hidden', filtered.length > 0);
  const more = filtered.length - shown.length;
  $('#cp-people-more-btn').classList.toggle('hidden', more <= 0);
  $('#cp-people-more-btn').textContent = state.lang === 'nl' ? `Meer tonen (nog ${more})` : `Show more (${more} left)`;
}

// ---------- SCRIPTING (hub + 5-step writing wizard) ----------
// Backed by GET/PATCH /api/client-portal/:token/scripts and
// /scripts/:id/finish (server.js) — the client only ever sees/queues
// against status='queued' rows; everything past 'written' (review,
// approved, filmed, posted) is an admin-side pipeline detail the client
// doesn't need to track here, so the "Done" list below just shows
// done/not-done, matching what the client actually did.

const MARK_COLORS = { y: ['#F6E7A8', '#5C4A00'], r: ['#F4D5CD', '#9A3A0A'] };
const SESSION_COPY = [null,
  { title: 'Get it all out.', instr: 'Write everything that comes to mind when you read your topic. Don’t edit — just dump. You have three minutes.' },
  { title: 'Shape it into a script.', instr: 'We’ve picked the format for this one — its structure is filled in below. Rewrite it line by line, using your brain dump above.' },
  { title: 'Trim it down.', instr: 'Anything you don’t mark stays. Mark words yellow if they could go, red if they add nothing. Click a line number to mark the whole line at once.' },
  { title: 'Read it aloud.', instr: 'Read your script out loud, start to finish, and time yourself. If something sounds off, it is.' }
];

function scriptsQueued() { return state.scripts.filter(s => s.status === 'queued'); }
function scriptsDone() { return state.scripts.filter(s => s.status !== 'queued'); }

function tpl(formatId) {
  const f = state.formats.find(x => x.id === formatId);
  return (f && Array.isArray(f.structure)) ? f.structure.map(line => t(line)).join('\n') : '';
}
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

// ---------- Scripting hub ----------

function setupScriptingControls() {
  $('#cp-view-scripting').addEventListener('click', (e) => {
    const startOne = e.target.closest('[data-action="start-one"]');
    if (startOne) { startSession([startOne.dataset.id]); return; }
    const toggle = e.target.closest('[data-action="toggle-pick"]');
    if (toggle) {
      const id = toggle.dataset.id;
      const idx = state.scriptingPick.indexOf(id);
      if (idx === -1) state.scriptingPick.push(id); else state.scriptingPick.splice(idx, 1);
      renderScripting();
    }
  });
  $('#cp-scripting-start-btn').addEventListener('click', () => {
    const queued = scriptsQueued();
    const pick = state.scriptingPick.filter(id => queued.some(x => x.id === id));
    if (pick.length) startSession(pick);
    else if (queued.length) startSession([queued[0].id]);
  });
  $('#cp-scripting-select-all-btn').addEventListener('click', () => {
    const queued = scriptsQueued();
    const pick = state.scriptingPick.filter(id => queued.some(x => x.id === id));
    state.scriptingPick = pick.length === queued.length ? [] : queued.map(x => x.id);
    renderScripting();
  });
}

function renderScripting() {
  const queued = scriptsQueued();
  const done = scriptsDone();
  const all = state.scripts;
  const pick = state.scriptingPick.filter(id => queued.some(x => x.id === id));
  const left = queued.length;
  const nSel = pick.length;
  const locale = dateLocale();

  $('#cp-scripting-eyebrow').textContent = left
    ? (state.lang === 'nl' ? `${left} te gaan` : `${left} to go`)
    : t('All done');
  $('#cp-scripting-title').textContent = left
    ? (state.lang === 'nl'
        ? (left === 1 ? 'Nog één script te schrijven' : `${left} scripts nog te schrijven`)
        : (left === 1 ? 'One script left to write' : `${left} scripts left to write`))
    : (state.lang === 'nl' ? 'Elk script is geschreven' : 'Every script is written');

  $('#cp-scripting-seg-bar').innerHTML = all.map(s =>
    `<span style="background:${s.status !== 'queued' ? '#B9A3CC' : (pick.includes(s.id) ? '#F3F0EE' : '#3A3938')};"></span>`
  ).join('');
  $('#cp-scripting-progress-text').textContent = state.lang === 'nl'
    ? `${done.length} van ${all.length} gescript${left ? ` · nog ongeveer ${left * 10} minuten` : ''}`
    : `${done.length} of ${all.length} scripted${left ? ` · about ${left * 10} minutes left` : ''}`;

  $('#cp-scripting-start-wrap').classList.toggle('hidden', left === 0);
  if (left > 0) {
    $('#cp-scripting-start-label').textContent = nSel > 1
      ? (state.lang === 'nl' ? `Deze ${nSel} scripten` : `Script these ${nSel}`)
      : nSel === 1
        ? (state.lang === 'nl' ? 'Dit script schrijven' : 'Script this one')
        : (state.lang === 'nl' ? 'Volgend script starten' : 'Start next script');
    $('#cp-scripting-start-note').textContent = nSel > 1
      ? (state.lang === 'nl' ? `Achter elkaar, in volgorde van de lijst. Ongeveer ${nSel * 10} minuten.` : `Back to back, in list order. About ${nSel * 10} minutes.`)
      : nSel === 1
        ? t('About 10 minutes.')
        : t('Want to do several in one go? Tick them below.');
  }

  const selAllBtn = $('#cp-scripting-select-all-btn');
  selAllBtn.classList.toggle('hidden', left === 0);
  selAllBtn.textContent = (nSel === left && left > 0) ? t('Clear selection') : t('Select all');

  $('#cp-scripting-queue-list').innerHTML = queued.length ? queued.map((s, i) => {
    const selected = pick.includes(s.id);
    return `
    <div class="cp-scripting-row" data-action="toggle-pick" data-id="${s.id}">
      <span class="cp-scripting-ring ${selected ? 'selected' : ''}">${selected ? CHECK_SVG : ''}</span>
      <span class="cp-scripting-num">${String(i + 1).padStart(2, '0')}</span>
      <div class="cp-scripting-row-text">
        <span class="title">${escapeHtml(s.topic)}</span>
        <span class="sub">${s.hook ? `Hook: “${escapeHtml(s.hook)}”` : ''}</span>
      </div>
      <button type="button" class="cp-btn-outline" data-action="start-one" data-id="${s.id}">Script →</button>
    </div>`;
  }).join('') : `<p class="cp-scripting-empty">${escapeHtml(t('Every script’s written. New topics show up here as soon as we add them.'))}</p>`;

  const rellaBanner = $('#cp-scripting-rella-banner');
  if (state.profile.clientRellaUrl) { rellaBanner.href = state.profile.clientRellaUrl; rellaBanner.classList.remove('hidden'); }
  else rellaBanner.classList.add('hidden');

  const doneCard = $('#cp-scripting-done-card');
  if (done.length > 0) {
    doneCard.classList.remove('hidden');
    $('#cp-scripting-done-list').innerHTML = done.slice().reverse().map(s => `
      <div class="cp-scripting-done-row">
        <span class="cp-scripting-done-check">${CHECK_SVG}</span>
        <div class="cp-scripting-row-text">
          <span class="title done">${escapeHtml(s.topic)}</span>
          <span class="sub">${s.hook ? `“${escapeHtml(s.hook)}”` : ''}</span>
        </div>
        <span class="cp-hint">${s.scriptedAt ? new Date(s.scriptedAt).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) : ''}</span>
      </div>`).join('');
  } else {
    doneCard.classList.add('hidden');
  }
}

const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';

// ---------- Session wizard ----------

function startSession(ids) {
  const items = ids.map(id => state.scripts.find(s => s.id === id)).filter(Boolean);
  if (!items.length) return;
  state.scriptingPick = [];
  state.session = {
    ids: items.map(x => x.id),
    topics: items.map(x => x.topic),
    hooks: items.map(x => x.hook),
    idx: 0,
    step: 1,
    phase: 'step',
    brush: 'y',
    cur: curFor(items[0])
  };
  goTo('session');
}

function curFor(item) {
  const format = item.formatId || null;
  return {
    dump: '', dumpStart: null, dumpRang: false,
    format,
    script: item.scriptText || (format ? tpl(format) : ''),
    marks: {}, markedFor: null,
    readStart: null, readAcc: 0,
    copied: false, movedRella: false,
    t0: Date.now(), t1: null,
    finalCount: 0, cut: 0
  };
}

function goStep(n) {
  const ses = state.session;
  if (n === 3 && ses.cur.markedFor !== ses.cur.script) { ses.cur.marks = {}; ses.cur.markedFor = ses.cur.script; }
  ses.step = n;
  try { window.scrollTo({ top: 0 }); } catch (e) {}
  renderSession();
}

function stepCanNext(ses) {
  const c = ses.cur;
  return [!!c.dump.trim(), !!c.script.trim(), true, true][ses.step - 1];
}

function stepNext() {
  const ses = state.session;
  if (!stepCanNext(ses)) return;
  if (ses.step < 4) {
    celebrate(state.lang === 'nl' ? `Stap ${ses.step} klaar` : `Step ${ses.step} done`);
    goStep(ses.step + 1);
    return;
  }
  finishCurrentScript();
}

// Surgical update of the footer's Next button, called from the dump/script
// textarea input handlers — those deliberately skip a full
// renderSessionStepBody() to avoid stealing focus mid-keystroke (see
// below), so without this the button's enabled look never changed as you
// typed and looked like it was gated on the brain-dump timer finishing,
// which it never was.
function updateNextButtonLiveState() {
  const ses = state.session;
  if (!ses) return;
  const btn = document.getElementById('cp-session-next-btn');
  if (!btn) return;
  const canNext = stepCanNext(ses);
  const isLast = ses.step === 4;
  const bg = !canNext ? 'var(--border)' : (isLast ? 'var(--purple)' : 'var(--text)');
  btn.style.background = bg;
  btn.style.borderColor = bg;
  btn.style.cursor = canNext ? 'pointer' : 'not-allowed';
}

function setupSessionControls() {
  $('#cp-session-sound-btn').addEventListener('click', () => { state.soundOff = !state.soundOff; renderSession(); });
  $('#cp-session-quit-btn').addEventListener('click', () => { state.session = null; goTo('scripting'); });

  $('#cp-view-session').addEventListener('click', (e) => {
    const stepBtn = e.target.closest('[data-action="go-step"]');
    if (stepBtn) {
      const n = parseInt(stepBtn.dataset.step, 10);
      if (n < state.session.step) goStep(n);
      return;
    }
    if (e.target.closest('[data-action="dump-timer-toggle"]')) {
      const c = state.session.cur;
      c.dumpStart = Date.now(); c.dumpRang = false;
      renderSessionStepBody();
      return;
    }
    const trimWord = e.target.closest('[data-action="trim-word"]');
    if (trimWord) { paintKeys([`${trimWord.dataset.li}-${trimWord.dataset.wi}`]); return; }
    const trimLine = e.target.closest('[data-action="trim-line"]');
    if (trimLine) {
      const li = parseInt(trimLine.dataset.li, 10);
      const ws = computeTrim(state.session.cur).lines[li] || [];
      paintKeys(ws.map((_, wi) => `${li}-${wi}`));
      return;
    }
    const brushBtn = e.target.closest('[data-action="brush-pick"]');
    if (brushBtn) { state.session.brush = brushBtn.dataset.brush; renderSessionStepBody(); return; }

    if (e.target.closest('[data-action="read-toggle"]')) { readToggle(); return; }
    if (e.target.closest('[data-action="read-reset"]')) { readReset(); return; }
    if (e.target.closest('[data-action="copy-script"]')) { copyScriptToClipboard(); return; }
    if (e.target.closest('[data-action="make-doc"]')) { makeGoogleDoc(); return; }

    if (e.target.closest('[data-action="step-back"]')) { if (state.session.step > 1) goStep(state.session.step - 1); return; }
    if (e.target.closest('[data-action="step-next"]')) { stepNext(); return; }

    if (e.target.closest('[data-action="move-rella"]')) { state.session.cur.movedRella = true; renderDoneScreen(); return; }
    if (e.target.closest('[data-action="finish-script"]')) { finishScriptAndAdvance(); return; }
  });

  $('#cp-view-session').addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'cp-session-dump-textarea') {
      const c = state.session.cur;
      c.dump = el.value;
      if (!c.dumpStart && el.value) {
        c.dumpStart = Date.now(); c.dumpRang = false;
        const wrap = document.getElementById('cp-session-timer-btns');
        if (wrap) wrap.innerHTML = dumpTimerButtonHtml(c);
      }
      updateNextButtonLiveState();
    } else if (el.id === 'cp-session-script-textarea') {
      state.session.cur.script = el.value;
      scheduleDraftSave();
      updateNextButtonLiveState();
    }
  });
}

function renderSession() {
  const ses = state.session;
  if (!ses) return;
  const N = ses.ids.length;
  $('#cp-session-chip').textContent = N > 1
    ? (state.lang === 'nl' ? `Script ${ses.idx + 1} van ${N}` : `Script ${ses.idx + 1} of ${N}`)
    : (state.lang === 'nl' ? 'Los script' : 'Single script');
  $('#cp-session-chip-topic').textContent = ses.topics[ses.idx] || '';
  $('#cp-session-sound-btn').textContent = state.soundOff ? t('Sound off') : t('Sound on');

  const rellaBanner = $('#cp-session-rella-banner');
  if (state.profile.clientRellaUrl) { rellaBanner.href = state.profile.clientRellaUrl; rellaBanner.classList.remove('hidden'); }
  else rellaBanner.classList.add('hidden');

  renderStepper();
  if (ses.phase === 'done') renderDoneScreen();
  else renderSessionStepBody();
}

function renderStepper() {
  const ses = state.session;
  const labels = [t('Brain dump'), t('Script'), t('Trim'), t('Read aloud')];
  $('#cp-stepper').innerHTML = labels.map((label, i) => {
    const n = i + 1;
    const done = ses.phase === 'done' || n < ses.step;
    const cur = ses.phase !== 'done' && n === ses.step;
    const circleBg = done ? 'var(--purple)' : (cur ? 'var(--text)' : '#fff');
    const circleFg = (done || cur) ? '#fff' : 'var(--muted)';
    const circleBorder = done ? 'var(--purple)' : (cur ? 'var(--text)' : 'var(--border)');
    const icon = done ? CHECK_SVG : String(n);
    return `
    <div class="cp-step">
      <button type="button" class="cp-step-btn" data-action="go-step" data-step="${n}" style="cursor:${n < ses.step ? 'pointer' : 'default'};">
        <span class="cp-step-circle" style="background:${circleBg};color:${circleFg};border:1.5px solid ${circleBorder};">${icon}</span>
        <span class="cp-step-label" style="font-weight:${cur ? 600 : 450};color:${(cur || done) ? 'var(--text)' : 'var(--muted)'};">${escapeHtml(label)}</span>
      </button>
      ${i < labels.length - 1 ? `<span class="cp-step-line" style="background:${done ? 'var(--purple)' : 'var(--border)'};"></span>` : ''}
    </div>`;
  }).join('');
}

function stepHeaderHtml(n) {
  const labels = [t('Brain dump'), t('Script'), t('Trim'), t('Read aloud')];
  const copy = SESSION_COPY[n];
  const eyebrow = state.lang === 'nl' ? `Stap ${n} van 4 · ${labels[n - 1]}` : `Step ${n} of 4 · ${labels[n - 1]}`;
  return `
    <header style="display:flex;flex-direction:column;gap:14px;">
      <div class="cp-eyebrow"><span class="cp-dot"></span><span>${escapeHtml(eyebrow)}</span></div>
      <h1 class="cp-h1" style="font-size:2.125rem;">${escapeHtml(t(copy.title))}</h1>
      <p class="cp-lead">${escapeHtml(t(copy.instr))}</p>
    </header>`;
}

function stepFooterHtml(n, canNext) {
  const back = n > 1
    ? `<button type="button" class="cp-link-btn" data-action="step-back">${escapeHtml(state.lang === 'nl' ? `← Terug naar stap ${n - 1}` : `← Back to step ${n - 1}`)}</button>`
    : '<span></span>';
  const isLast = n === 4;
  const nextLabel = isLast ? t('Finish') : (state.lang === 'nl' ? `Door naar stap ${n + 1} →` : `Move on to step ${n + 1} →`);
  const nextBg = !canNext ? 'var(--border)' : (isLast ? 'var(--purple)' : 'var(--text)');
  return `
    <div class="cp-session-footer">
      ${back}
      <button type="button" class="cp-btn-primary" id="cp-session-next-btn" data-action="step-next" style="background:${nextBg};border-color:${nextBg};cursor:${canNext ? 'pointer' : 'not-allowed'};">${escapeHtml(nextLabel)}</button>
    </div>`;
}

function renderSessionStepBody() {
  const ses = state.session;
  const body = $('#cp-session-step-body');
  if (ses.step === 1) body.innerHTML = stepDumpHtml();
  else if (ses.step === 2) body.innerHTML = stepScriptHtml();
  else if (ses.step === 3) body.innerHTML = stepTrimHtml();
  else body.innerHTML = stepReadHtml();
}

function dumpTimerButtonHtml(c) {
  return !c.dumpStart
    ? `<button type="button" class="cp-btn-primary" data-action="dump-timer-toggle">${escapeHtml(t('Start timer'))}</button>`
    : `<button type="button" class="cp-btn-outline" data-action="dump-timer-toggle">${escapeHtml(t('Reset timer'))}</button>`;
}

function stepDumpHtml() {
  const ses = state.session, c = ses.cur;
  const dumpRem = c.dumpStart ? Math.max(0, 180 - (Date.now() - c.dumpStart) / 1000) : 180;
  return stepHeaderHtml(1) + `
    <div class="cp-session-dark-card">
      <span class="eyebrow">${escapeHtml(state.lang === 'nl' ? 'Jouw onderwerp' : 'Your topic')}</span>
      <span class="topic">${escapeHtml(ses.topics[ses.idx] || '')}</span>
      ${ses.hooks[ses.idx] ? `<span class="hook">Hook: “${escapeHtml(ses.hooks[ses.idx])}”</span>` : ''}
    </div>
    <div class="cp-card cp-card-white">
      <div class="cp-session-timer-row">
        <span class="cp-session-timer" id="cp-session-timer" style="color:${c.dumpRang ? 'var(--purple)' : 'var(--text)'};">${escapeHtml(fmtClock(dumpRem))}</span>
        <div class="cp-session-timer-main">
          <span class="cp-hint" id="cp-session-timer-note" style="font-size:0.95rem;color:var(--text);">${escapeHtml(!c.dumpStart ? t('The timer starts when you begin typing.') : (c.dumpRang ? t('Time’s up. Keep going if there’s more — or move on.') : t('Keep writing. Don’t stop to edit.')))}</span>
          <div class="cp-session-timer-track"><div class="cp-session-timer-fill" id="cp-session-timer-fill" style="width:${c.dumpStart ? (100 - dumpRem / 1.8) : 0}%;background:${c.dumpRang ? 'var(--text)' : 'var(--purple)'};"></div></div>
        </div>
        <span id="cp-session-timer-btns">${dumpTimerButtonHtml(c)}</span>
      </div>
      <textarea class="cp-session-textarea" id="cp-session-dump-textarea" placeholder="${escapeHtml(state.lang === 'nl' ? 'Schrijf alles op wat in je opkomt…' : 'Write everything that comes to mind…')}">${escapeHtml(c.dump)}</textarea>
    </div>
  ` + stepFooterHtml(1, !!c.dump.trim());
}

function stepScriptHtml() {
  const ses = state.session, c = ses.cur;
  const sel = state.formats.find(f => f.id === c.format);
  return stepHeaderHtml(2) + `
    <div class="cp-card cp-card-alt">
      <div class="cp-eyebrow"><span class="cp-dot"></span><span>${escapeHtml(t('Your brain dump'))}</span></div>
      <p class="cp-session-dump-preview">${c.dump.trim() ? escapeHtml(c.dump) : '<span style="color:var(--muted);">—</span>'}</p>
    </div>
    <div class="cp-card cp-card-white">
      <div class="cp-card-head">
        <div style="display:flex;flex-direction:column;gap:6px;">
          <h3 class="cp-h2">${escapeHtml(t('Your script'))}</h3>
          <span class="cp-hint">${escapeHtml(t('One beat per line. Replace the guide text with your own words.'))}</span>
        </div>
        ${sel ? `<span class="cp-session-chip">${escapeHtml(t(sel.name))}</span>` : ''}
      </div>
      <textarea class="cp-session-textarea" id="cp-session-script-textarea" style="min-height:300px;">${escapeHtml(c.script)}</textarea>
    </div>
  ` + stepFooterHtml(2, !!c.script.trim());
}

function computeTrim(cur) {
  const lines = cur.script.split('\n').map(l => l.trim().split(/\s+/).filter(Boolean));
  const marks = cur.marks || {};
  let cutCount = 0;
  const finalWords = [];
  const finalLines = [];
  lines.forEach((ws, li) => {
    const kept = ws.map((w, wi) => ({ w, m: marks[`${li}-${wi}`] })).filter(x => {
      if (x.m === 'r') { cutCount++; return false; }
      return true;
    });
    if (ws.length && !kept.length) return;
    finalLines.push({ words: kept.map(x => ({ w: x.w, bg: x.m === 'y' ? '#F6E7A8' : 'transparent' })) });
    kept.forEach(x => finalWords.push(x.w));
  });
  const finalText = lines
    .map((ws, li) => ws.filter((_, wi) => marks[`${li}-${wi}`] !== 'r').join(' '))
    .filter((l, i) => l || !lines[i].length)
    .join('\n');
  return { lines, finalWords, finalLines, finalText, cutCount };
}

function paintKeys(keys) {
  const c = state.session.cur;
  const brush = state.session.brush || 'y';
  const all = keys.every(k => c.marks[k] === brush);
  keys.forEach(k => {
    if (brush === 'x' || all) delete c.marks[k];
    else c.marks[k] = brush;
  });
  renderSessionStepBody();
}

function stepTrimHtml() {
  const ses = state.session, c = ses.cur;
  const trim = computeTrim(c);
  const marks = c.marks || {};
  const brush = ses.brush || 'y';
  let cy = 0, cr = 0;
  Object.values(marks).forEach(v => { if (v === 'y') cy++; else if (v === 'r') cr++; });
  const linesHtml = trim.lines.map((ws, li) => {
    if (!ws.length) return '';
    const keys = ws.map((_, wi) => `${li}-${wi}`);
    const m0 = marks[keys[0]];
    const same = !!m0 && keys.every(k => marks[k] === m0);
    const handleBg = same ? MARK_COLORS[m0][0] : '#fff';
    const handleFg = same ? MARK_COLORS[m0][1] : 'var(--muted)';
    const handleBorder = same ? 'transparent' : 'var(--border)';
    const wordsHtml = ws.map((w, wi) => {
      const m = marks[`${li}-${wi}`];
      const bg = m ? MARK_COLORS[m][0] : 'var(--bg)';
      const fg = m ? MARK_COLORS[m][1] : 'var(--text)';
      const deco = m === 'r' ? 'line-through' : 'none';
      return `<button type="button" class="cp-trim-word" style="background:${bg};color:${fg};text-decoration:${deco};" data-action="trim-word" data-li="${li}" data-wi="${wi}">${escapeHtml(w)}</button>`;
    }).join('');
    return `
    <div class="cp-trim-line">
      <button type="button" class="cp-trim-handle" style="background:${handleBg};color:${handleFg};border-color:${handleBorder};" data-action="trim-line" data-li="${li}">${li + 1}</button>
      <div class="cp-trim-words">${wordsHtml}</div>
    </div>`;
  }).join('');
  const brushNames = { y: t('Yellow'), r: t('Red'), x: t('Erase') };
  return stepHeaderHtml(3) + `
    <div class="cp-trim-legend">
      <div class="cp-trim-legend-item">
        <span class="cp-trim-legend-tag" style="background:${MARK_COLORS.y[0]};color:${MARK_COLORS.y[1]};">${escapeHtml(t('Yellow'))}</span>
        <span class="cp-trim-legend-text">${escapeHtml(t('Adds a touch. You could cut it without breaking the script.'))}</span>
      </div>
      <div class="cp-trim-legend-item">
        <span class="cp-trim-legend-tag" style="background:${MARK_COLORS.r[0]};color:${MARK_COLORS.r[1]};">${escapeHtml(t('Red'))}</span>
        <span class="cp-trim-legend-text">${escapeHtml(t('Adds nothing. It gets deleted automatically when you move on.'))}</span>
      </div>
    </div>
    <div class="cp-card cp-card-white">
      <div class="cp-card-head">
        <div class="cp-brush-row">
          <span style="font-size:0.92rem;font-weight:500;">${escapeHtml(t('Marking with'))}</span>
          ${['y', 'r', 'x'].map(k => `<button type="button" class="cp-brush-btn ${brush === k ? 'active' : ''}" style="background:${k === 'x' ? '#fff' : MARK_COLORS[k][0]};color:${k === 'x' ? 'var(--muted)' : MARK_COLORS[k][1]};" data-action="brush-pick" data-brush="${k}">${escapeHtml(brushNames[k])}</button>`).join('')}
        </div>
        <span class="cp-hint">${cy} ${state.lang === 'nl' ? 'geel' : 'yellow'} · ${cr} ${state.lang === 'nl' ? 'rood' : 'red'}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">${linesHtml}</div>
    </div>
    <div class="cp-trim-note">${escapeHtml(t('Anything marked red is deleted automatically when you move on.'))}</div>
  ` + stepFooterHtml(3, true);
}

function readToggle() {
  const c = state.session.cur;
  if (c.readStart) { c.readAcc += Date.now() - c.readStart; c.readStart = null; }
  else c.readStart = Date.now();
  renderSessionStepBody();
}
function readReset() {
  const c = state.session.cur;
  c.readStart = null; c.readAcc = 0;
  renderSessionStepBody();
}
function copyScriptToClipboard() {
  const trim = computeTrim(state.session.cur);
  try { navigator.clipboard.writeText(trim.finalText); } catch (e) {}
  state.session.cur.copied = true;
  renderSessionStepBody();
}
function makeGoogleDoc() {
  copyScriptToClipboard();
  try { window.open('https://docs.new', '_blank'); } catch (e) {}
}
function driveUrl() {
  return state.profile.clientDriveUrl || 'https://drive.google.com/';
}

function stepReadHtml() {
  const ses = state.session, c = ses.cur;
  const trim = computeTrim(c);
  const readEl = c.readAcc + (c.readStart ? Date.now() - c.readStart : 0);
  return stepHeaderHtml(4) + `
    <div class="cp-final-script">
      ${trim.finalLines.map(ln => `<p class="cp-final-line">${ln.words.map(w => `<span class="cp-final-word" style="background:${w.bg};">${escapeHtml(w.w)}</span>`).join(' ')}</p>`).join('') || `<p class="cp-final-line" style="color:var(--muted);">—</p>`}
      <span class="cp-hint">${trim.finalWords.length} ${state.lang === 'nl' ? 'woorden · gele markeringen staan er nog, zodat jij ze hardop kunt beoordelen' : 'words · yellow marks are still there for you to judge out loud'}</span>
    </div>
    <div class="cp-session-dark-card" style="gap:20px;">
      <div class="cp-session-timer-row" style="gap:16px;">
        <div style="flex:1 1 200px;display:flex;flex-direction:column;gap:4px;">
          <span class="eyebrow">${escapeHtml(t('Read-aloud time'))}</span>
          <span class="cp-session-timer" id="cp-session-timer" style="color:var(--bg);">${escapeHtml(fmtClock(readEl / 1000))}</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="cp-btn-primary" style="background:#F3F0EE;color:var(--text);border-color:#F3F0EE;" data-action="read-toggle">${escapeHtml(c.readStart ? t('Pause') : (readEl ? t('Resume') : t('Start reading')))}</button>
          <button type="button" class="cp-btn-outline" style="background:transparent;color:#F3F0EE;border-color:#F3F0EE;" data-action="read-reset">${escapeHtml(t('Reset'))}</button>
        </div>
      </div>
    </div>
    <div class="cp-handoff-grid">
      <div class="cp-handoff-card cp-card-white">
        <div class="cp-eyebrow"><span class="cp-dot"></span><span>${escapeHtml(t('Google Doc'))}</span></div>
        <span style="font-size:1.375rem;letter-spacing:-0.01em;font-weight:500;">${escapeHtml(t('Make your final changes there.'))}</span>
        <span style="font-size:0.92rem;line-height:1.45;color:var(--muted);">${escapeHtml(t('Paste it into the new Doc and tweak anything that sounded off when reading aloud and make the final finishing touches.'))}</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="cp-btn-primary" data-action="make-doc">${escapeHtml(t('Make the Google Doc ↗'))}</button>
          <button type="button" class="cp-btn-outline" data-action="copy-script">${escapeHtml(c.copied ? t('Copied ✓') : t('Copy script'))}</button>
        </div>
      </div>
      <div class="cp-handoff-card cp-card-alt">
        <div class="cp-eyebrow"><span class="cp-dot"></span><span>${escapeHtml(t('Upload to Drive'))}</span></div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div class="cp-handoff-step"><span class="cp-handoff-step-num">1</span><span class="cp-handoff-step-text">${escapeHtml(t('Finish your edits in the Google Doc and give it your topic as its title.'))}</span></div>
          <div class="cp-handoff-step"><span class="cp-handoff-step-num">2</span><span class="cp-handoff-step-text">${escapeHtml(t('In the Doc, click the folder icon next to the title.'))}</span></div>
          <div class="cp-handoff-step"><span class="cp-handoff-step-num">3</span><span class="cp-handoff-step-text">${escapeHtml(t('Choose “Shared with me” → “A&P — Scripts” and click Move. That’s it — we’ll see it straight away.'))}</span></div>
        </div>
        <a href="${escapeHtml(driveUrl())}" target="_blank" rel="noopener" class="cp-btn-outline cp-align-start">${escapeHtml(t('Open our Drive folder ↗'))}</a>
      </div>
    </div>
  ` + stepFooterHtml(4, true);
}

// ---------- Draft persistence ----------
// Debounced save of the in-progress script text to the one real field the
// backend lets the client persist pre-finish (PATCH .../scripts/:id,
// server.js) — so a closed tab doesn't lose real writing. The brain dump
// is deliberately NOT persisted: it's a scratch warm-up, not the content
// that ends up in client_scripts.

let draftSaveTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftNow, 900);
}
async function saveDraftNow() {
  const ses = state.session;
  if (!ses) return;
  const id = ses.ids[ses.idx];
  const scriptText = ses.cur.script;
  try {
    await sendJson('PATCH', `/api/client-portal/${state.token}/scripts/${id}`, { scriptText });
    const row = state.scripts.find(s => s.id === id);
    if (row) row.scriptText = scriptText;
  } catch (e) { /* best-effort — losing an unsaved delta on a closed tab is an acceptable scope cut */ }
}

async function finishCurrentScript() {
  const ses = state.session, c = ses.cur;
  const id = ses.ids[ses.idx];
  const trim = computeTrim(c);
  const payload = {
    scriptText: c.script,
    finalText: trim.finalText,
    wordCount: trim.finalWords.length,
    cutCount: trim.cutCount,
    readAloudSeconds: Math.round((c.readAcc + (c.readStart ? Date.now() - c.readStart : 0)) / 1000),
    writeSeconds: Math.round((Date.now() - c.t0) / 1000)
  };
  try {
    await sendJson('POST', `/api/client-portal/${state.token}/scripts/${id}/finish`, payload);
  } catch (e) {
    alert((state.lang === 'nl' ? 'Kon je script niet opslaan: ' : 'Could not save your script: ') + e.message);
    return;
  }
  const row = state.scripts.find(s => s.id === id);
  if (row) {
    row.status = 'written'; row.scriptedAt = new Date().toISOString();
    row.finalText = trim.finalText; row.wordCount = payload.wordCount; row.cutCount = payload.cutCount;
  }
  c.t1 = Date.now();
  c.finalCount = trim.finalWords.length;
  c.cut = trim.cutCount;
  ses.phase = 'done';
  celebrate(state.lang === 'nl' ? 'Script afgerond' : 'Script finished', true);
  renderSession();
}

function finishScriptAndAdvance() {
  const ses = state.session;
  if (!ses.cur.movedRella) return;
  const hasNext = ses.idx < ses.ids.length - 1;
  if (hasNext) {
    ses.idx += 1;
    ses.step = 1;
    ses.phase = 'step';
    ses.cur = curFor(state.scripts.find(s => s.id === ses.ids[ses.idx]));
    renderSession();
  } else {
    state.session = null;
    goTo('scripting');
  }
}

function renderDoneScreen() {
  const ses = state.session, c = ses.cur;
  const N = ses.ids.length;
  const hasNext = ses.idx < N - 1;
  const took = c.t1 ? Math.round((c.t1 - c.t0) / 1000) : 0;
  const topic = ses.topics[ses.idx] || '';
  $('#cp-session-step-body').innerHTML = `
    <div class="cp-done-screen">
      <span class="cp-done-check">${CHECK_SVG}</span>
      <div style="display:flex;flex-direction:column;gap:12px;align-items:center;">
        <h1 class="cp-h1" style="font-size:2.375rem;">${escapeHtml(t('Well done.'))}</h1>
        <p class="cp-lead" style="max-width:520px;">${escapeHtml(state.lang === 'nl' ? `“${topic}” is geschreven, hardop gelezen en klaar om gefilmd te worden.` : `“${topic}” is written, read aloud and ready for filming.`)}</p>
      </div>
      <div class="cp-done-stats">
        <div class="cp-done-stat"><span class="value">${Math.floor(took / 60)}m ${took % 60}s</span><span class="label">${escapeHtml(t('Time to write'))}</span></div>
        <div class="cp-done-stat"><span class="value">${c.finalCount || 0}</span><span class="label">${escapeHtml(t('Words in your script'))}</span></div>
        <div class="cp-done-stat"><span class="value">${escapeHtml(fmtClock((c.readAcc || 0) / 1000))}</span><span class="label">${escapeHtml(t('Read-aloud time'))}</span></div>
        <div class="cp-done-stat"><span class="value">${c.cut || 0}</span><span class="label">${escapeHtml(t('Words cut'))}</span></div>
      </div>
      <div class="cp-done-actions">
        <button type="button" style="background:${c.movedRella ? 'transparent' : 'var(--purple)'};color:${c.movedRella ? 'var(--purple)' : '#fff'};border:1.5px solid var(--purple);" data-action="move-rella">${escapeHtml(c.movedRella ? t('Moved to the next stage in Rella ✓') : t('Move post on to next stage in Rella'))}</button>
        <button type="button" style="background:${c.movedRella ? 'var(--text)' : 'var(--border)'};color:#fff;border:1.5px solid ${c.movedRella ? 'var(--text)' : 'var(--border)'};cursor:${c.movedRella ? 'pointer' : 'not-allowed'};" data-action="finish-script">${escapeHtml(hasNext ? (state.lang === 'nl' ? 'Door naar het volgende script →' : 'Move on to next script →') : t('Done'))}</button>
        <span class="cp-hint">${escapeHtml(!c.movedRella ? t('Move the post in Rella first.') : (hasNext ? (state.lang === 'nl' ? `Volgende: ${ses.topics[ses.idx + 1]}` : `Up next: ${ses.topics[ses.idx + 1]}`) : t('Ticked off in your script list.')))}</span>
      </div>
    </div>`;
}

// ---------- Web Audio celebration chimes + overlay (self-contained) ----------

let audioCtx = null;
function chime(kind) {
  if (state.soundOff) return;
  try {
    const ctx = audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') ctx.resume();
    const notes = kind === 'bell'
      ? [[880, 0, 1.8, .22], [1760, 0, 1, .06], [2640, 0, .6, .03], [880, .7, 1.8, .18], [1760, .7, 1, .05]]
      : kind === 'fanfare'
        ? [[523, 0, .5, .16], [659, .12, .5, .16], [784, .24, .5, .16], [1047, .36, 1, .18]]
        : [[659, 0, .35, .16], [988, .1, .55, .16]];
    notes.forEach(([f, d, len, vol]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t0 = ctx.currentTime + d;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + len + 0.05);
    });
  } catch (e) {}
}

let celebrateTimer = null;
function celebrate(label, big) {
  chime(big ? 'fanfare' : 'chime');
  clearTimeout(celebrateTimer);
  const existing = document.getElementById('cp-celebrate-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'cp-celebrate-overlay';
  el.className = 'cp-celebrate-overlay';
  el.innerHTML = `
    <div class="cp-celebrate-inner">
      <div class="cp-celebrate-circle"><svg width="84" height="84" viewBox="0 0 24 24" fill="none" stroke="#F3F0EE" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></div>
      <span class="cp-celebrate-label">${escapeHtml(label)}</span>
    </div>`;
  document.body.appendChild(el);
  celebrateTimer = setTimeout(() => el.remove(), 1100);
}

// Surgical per-tick updates (not a full renderSessionStepBody() re-render)
// so the countdown/clock can update every 250ms without ever touching the
// textarea the client might actively be typing in — a full innerHTML
// replace would steal its focus and cursor position mid-keystroke.
function tickDumpTimer() {
  const ses = state.session;
  if (!ses || ses.step !== 1 || ses.phase === 'done') return;
  const c = ses.cur;
  const timerEl = document.getElementById('cp-session-timer');
  if (!timerEl) return;
  if (c.dumpStart && !c.dumpRang && Date.now() - c.dumpStart >= 180000) {
    c.dumpRang = true;
    chime('bell');
  }
  const dumpRem = c.dumpStart ? Math.max(0, 180 - (Date.now() - c.dumpStart) / 1000) : 180;
  timerEl.textContent = fmtClock(dumpRem);
  timerEl.style.color = c.dumpRang ? 'var(--purple)' : 'var(--text)';
  const fillEl = document.getElementById('cp-session-timer-fill');
  if (fillEl) { fillEl.style.width = (c.dumpStart ? (100 - dumpRem / 1.8) : 0) + '%'; fillEl.style.background = c.dumpRang ? 'var(--text)' : 'var(--purple)'; }
  const noteEl = document.getElementById('cp-session-timer-note');
  if (noteEl) noteEl.textContent = !c.dumpStart ? t('The timer starts when you begin typing.') : (c.dumpRang ? t('Time’s up. Keep going if there’s more — or move on.') : t('Keep writing. Don’t stop to edit.'));
}
function tickReadTimer() {
  const ses = state.session;
  if (!ses || ses.step !== 4 || ses.phase === 'done' || !ses.cur.readStart) return;
  const timerEl = document.getElementById('cp-session-timer');
  if (!timerEl) return;
  timerEl.textContent = fmtClock((ses.cur.readAcc + (Date.now() - ses.cur.readStart)) / 1000);
}
setInterval(() => {
  if (state.page !== 'session' || !state.session) return;
  tickDumpTimer();
  tickReadTimer();
}, 250);
