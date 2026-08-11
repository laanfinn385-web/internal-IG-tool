const state = {
  profiles: [],      // parsed from URL input for the current session
  index: 0,           // current profile index
  results: [],         // {profile, status, template, message} for finished profiles this session
  viewsThreshold: 1000,  // overwritten from the server (Settings page) during init
  // Home's "reach N sent" flow vs the Leads page's "selected leads only" flow.
  // 'fixed' = exactly this list, no top-up (leads-selection). 'goal' = keep
  // fetching replacement leads on every disqualify until sentCount reaches
  // sessionTarget, or the available-leads pool runs dry.
  sessionMode: 'fixed',
  sessionTarget: null,
  sentCount: 0,
  outOfLeads: false
};

const SESSION_KEY = 'outreach_session_v1';

// Persist the in-progress session so an accidental refresh/tab-close doesn't
// wipe unsaved profile data (already-decided profiles are safe server-side;
// this covers the one currently being filled in).
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      profiles: state.profiles,
      index: state.index,
      results: state.results,
      sessionMode: state.sessionMode,
      sessionTarget: state.sessionTarget,
      sentCount: state.sentCount,
      outOfLeads: state.outOfLeads
    }));
  } catch (e) { /* storage full or unavailable — non-fatal */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

// ---------- Message composition & wording rotation ----------
// Instagram can flag near-identical DMs sent over and over. Each template
// category is split into 4 sentence slots — opener/hook/value/cta — each with
// several independently-worded versions written specifically for that
// category (see templates.js/pickPart's callers). A message is composed by
// drawing one version per slot, so a category with 4 versions per slot alone
// has 4^4 = 256 possible renderings — recombination does far more for
// variety than picking among whole pre-written messages ever could, while
// still keeping every slot's wording specific to its own category (an opener
// from one category can never end up in another).
//
// Each slot is drawn from its own shuffled "bag": every version in that slot
// gets used once before any repeat, and a repeat is never dealt back-to-back
// across a reshuffle. Persisted in localStorage (not sessionStorage) because
// the pattern Instagram sees spans every session you've ever sent from, not
// just today's batch.
const MESSAGE_PART_ROTATION_KEY = 'template_part_rotation_v1';

function loadPartRotation() {
  try {
    return JSON.parse(localStorage.getItem(MESSAGE_PART_ROTATION_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function savePartRotation(rotation) {
  try {
    localStorage.setItem(MESSAGE_PART_ROTATION_KEY, JSON.stringify(rotation));
  } catch (e) { /* storage full or unavailable — non-fatal */ }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks the next wording id for one slot (opener/hook/value/cta) of one
// template category, drawing from a shuffled "bag" that's refilled (and
// reshuffled) once emptied.
function pickPart(key, slot) {
  const parts = TEMPLATES[key] && TEMPLATES[key].parts && TEMPLATES[key].parts[slot];
  if (!parts || parts.length === 0) return null;
  const allIds = parts.map(p => p.id);
  if (allIds.length === 1) return allIds[0];

  const rotation = loadPartRotation();
  const rotationKey = `${key}::${slot}`;
  let entry = rotation[rotationKey];
  if (!entry || !Array.isArray(entry.bag) || entry.bag.length === 0) {
    let bag = shuffle(allIds);
    // Avoid dealing the same wording twice in a row across a reshuffle boundary.
    if (entry && entry.last && bag[0] === entry.last) {
      [bag[0], bag[1]] = [bag[1], bag[0]];
    }
    entry = { bag, last: entry ? entry.last : null };
  }
  const id = entry.bag.shift();
  entry.last = id;
  rotation[rotationKey] = entry;
  savePartRotation(rotation);
  return id;
}

// Draws a fresh id for every slot of a template category — used whenever the
// category changes or the user asks for a different wording.
function pickAllParts(key) {
  const partIds = {};
  MESSAGE_SLOTS.forEach(slot => { partIds[slot] = pickPart(key, slot); });
  return partIds;
}

// Fetches JSON, applies a timeout, and throws a readable Error on any
// network failure, timeout, or non-2xx response (using the server's
// { error } message when present) instead of failing silently.
async function fetchJson(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...(options || {}), signal: controller.signal });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty or non-JSON body */ }
    if (!res.ok) {
      throw new Error((data && data.error) || `Server error (${res.status})`);
    }
    return data;
  } catch (e) {
    // The timeout/abort signal covers the whole request including body
    // parsing (a stalled body download used to slip past the old timeout).
    if (e.name === 'AbortError') throw new Error('Request timed out. Check your connection and try again.');
    if (e instanceof TypeError) throw new Error('Network error — check your connection and try again.');
    throw e; // already a descriptive Error (e.g. from the res.ok check above)
  } finally {
    clearTimeout(timer);
  }
}

function showView(name) {
  $all('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  $all('.navbtn').forEach(btn => btn.classList.toggle('active', btn.dataset.nav === name));
  if (name === 'home') { loadHome(); loadNotifications(); }
  if (name === 'leads') { loadLeads(); loadNotifications(); }
  if (name === 'analytics') loadAnalytics(currentRange);
  if (name === 'settings') loadSettingsPage();
}

$('#settings-btn').addEventListener('click', () => showView('settings'));

$all('.navbtn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.nav));
});

const SIDEBAR_COLLAPSED_KEY = 'outreach_sidebar_collapsed';
if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') $('#sidebar').classList.add('collapsed');
$('#sidebar-toggle').addEventListener('click', () => {
  const collapsed = $('#sidebar').classList.toggle('collapsed');
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
});

// ---------- HOME ----------
const PHASE_BREAKDOWN_STAGES = [
  { key: 'new', label: 'New', color: 'var(--stage-new)' },
  { key: 'phase1', label: 'Phase 1', color: 'var(--stage-phase1)' },
  { key: 'phase2', label: 'Phase 2', color: 'var(--stage-phase2)' },
  { key: 'phase3', label: 'Phase 3', color: 'var(--stage-phase3)' },
  { key: 'call_booked', label: 'Call booked', color: 'var(--stage-call-booked)' },
  { key: 'dead', label: 'Dead', color: 'var(--stage-dead)' },
  { key: 'cant_message', label: "Can't receive messages", color: 'var(--stage-cant-message)' }
];

function showOverviewTooltip(tooltipEl, wrapEl, x, y, html) {
  const wrapBox = wrapEl.getBoundingClientRect();
  tooltipEl.innerHTML = html;
  tooltipEl.style.left = `${x - wrapBox.left}px`;
  tooltipEl.style.top = `${y - wrapBox.top}px`;
  tooltipEl.classList.remove('hidden');
}

// A ring built from one <circle> per non-zero stage, using stroke-dasharray
// to carve out each arc — the standard SVG-donut technique. Segments are
// hoverable (mouse position drives the tooltip, since a segment's own
// bounding box is the full circle, not just its visible arc).
function renderPipelineDonut(stageCounts) {
  const svg = $('#pipeline-donut');
  const legend = $('#pipeline-donut-legend');
  const tooltip = $('#pipeline-donut-tooltip');
  const wrap = $('#pipeline-donut-wrap');
  svg.innerHTML = '';
  tooltip.classList.add('hidden');

  const counts = stageCounts || {};
  const total = PHASE_BREAKDOWN_STAGES.reduce((sum, s) => sum + (counts[s.key] || 0), 0);
  const cx = 60, cy = 60, r = 46, strokeWidth = 16;
  const circumference = 2 * Math.PI * r;

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('cx', cx); track.setAttribute('cy', cy); track.setAttribute('r', r);
  track.setAttribute('fill', 'none');
  track.style.stroke = 'var(--border)';
  track.setAttribute('stroke-width', strokeWidth);
  svg.appendChild(track);

  let cumulative = 0;
  PHASE_BREAKDOWN_STAGES.filter(s => (counts[s.key] || 0) > 0).forEach(s => {
    const count = counts[s.key] || 0;
    const pct = total > 0 ? count / total : 0;
    const dash = pct * circumference;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', r);
    circle.setAttribute('fill', 'none');
    circle.style.stroke = s.color;
    circle.setAttribute('stroke-width', strokeWidth);
    circle.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
    circle.setAttribute('stroke-dashoffset', String(-cumulative));
    circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
    circle.style.cursor = 'pointer';
    circle.addEventListener('mouseenter', (e) => {
      showOverviewTooltip(tooltip, wrap, e.clientX, e.clientY - 10,
        `<strong>${count.toLocaleString('en-US')}</strong> (${Math.round(pct * 100)}%)<span class="tooltip-sub">${escapeHtml(s.label)}</span>`);
    });
    circle.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
    svg.appendChild(circle);
    cumulative += dash;
  });

  const totalText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  totalText.setAttribute('x', cx); totalText.setAttribute('y', cy - 2);
  totalText.setAttribute('text-anchor', 'middle');
  totalText.setAttribute('font-size', '20');
  totalText.setAttribute('font-weight', '800');
  totalText.style.fill = 'var(--text)';
  totalText.textContent = total.toLocaleString('en-US');
  svg.appendChild(totalText);
  const subText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  subText.setAttribute('x', cx); subText.setAttribute('y', cy + 15);
  subText.setAttribute('text-anchor', 'middle');
  subText.setAttribute('font-size', '8');
  subText.style.fill = 'var(--muted)';
  subText.textContent = 'active leads';
  svg.appendChild(subText);

  legend.innerHTML = PHASE_BREAKDOWN_STAGES.map(s => `
    <div class="donut-legend-item">
      <span class="donut-legend-dot" style="background:${s.color}"></span>
      <span class="donut-legend-label">${s.label}</span>
      <span class="donut-legend-count">${(counts[s.key] || 0).toLocaleString('en-US')}</span>
    </div>`).join('');
}

function renderSendsSparkline(series) {
  const svg = $('#sends-sparkline');
  const tooltip = $('#sends-sparkline-tooltip');
  const wrap = $('#sends-sparkline-wrap');
  svg.innerHTML = '';
  tooltip.classList.add('hidden');
  if (!series || series.length === 0) return;

  const W = 300, H = 110, PAD_X = 20, PAD_Y = 16;
  const max = Math.max(1, ...series.map(s => s.count));
  const stepX = series.length > 1 ? (W - PAD_X * 2) / (series.length - 1) : 0;
  const points = series.map((s, i) => ({
    x: PAD_X + i * stepX,
    y: H - PAD_Y - (s.count / max) * (H - PAD_Y * 2),
    ...s
  }));

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' '));
  path.setAttribute('fill', 'none');
  path.style.stroke = 'var(--accent)';
  path.setAttribute('stroke-width', 2.5);
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  points.forEach(p => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); dot.setAttribute('r', 3);
    dot.style.fill = 'var(--accent)';
    svg.appendChild(dot);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', p.x); label.setAttribute('y', H - 2);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '8');
    label.style.fill = 'var(--muted)';
    label.textContent = p.date.slice(5);
    svg.appendChild(label);

    // Oversized invisible hit target — the 3px dot alone is hard to hover precisely.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hit.setAttribute('cx', p.x); hit.setAttribute('cy', p.y); hit.setAttribute('r', 12);
    hit.setAttribute('fill', 'transparent');
    hit.style.cursor = 'pointer';
    hit.addEventListener('mouseenter', (e) => {
      showOverviewTooltip(tooltip, wrap, e.clientX, e.clientY - 10,
        `<strong>${p.count}</strong> sent<span class="tooltip-sub">${escapeHtml(p.date.slice(5))}</span>`);
    });
    hit.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
    svg.appendChild(hit);
  });
}

function renderSendsTrendDelta(pctChange) {
  const el = $('#sends-trend-delta');
  if (pctChange === null || pctChange === undefined) { el.textContent = ''; el.className = 'overview-chart-delta'; return; }
  const sign = pctChange > 0 ? '+' : '';
  el.textContent = `${sign}${pctChange}% vs last week`;
  el.className = 'overview-chart-delta ' + (pctChange > 0 ? 'positive' : pctChange < 0 ? 'negative' : 'neutral');
}

async function loadHome() {
  try {
    const data = await fetchJson('/api/home');
    $('#streak-value').textContent = data.streak;
    $('#week-value').textContent = data.last7Days;
    $('#available-leads-value').textContent = data.availableLeads.toLocaleString('en-US');
    $('#reply-rate-value').textContent = pctText(data.replyRate);
    $('#prr-value').textContent = pctText(data.prr);
    $('#asr-value').textContent = pctText(data.asr);
    renderSendsTrendDelta(data.last7DaysPctChange);
    renderPipelineDonut(data.stageCounts);
    renderSendsSparkline(data.sendsTrend);
  } catch (e) {
    $('#streak-value').textContent = '–';
    $('#week-value').textContent = '–';
    $('#available-leads-value').textContent = '–';
    $('#reply-rate-value').textContent = '–';
    $('#prr-value').textContent = '–';
    $('#asr-value').textContent = '–';
  }
}

// Tab-delimited tokenizer that understands spreadsheet-style quoting: a cell
// wrapped in "..." can contain literal tabs/newlines (e.g. a multi-line bio),
// and "" inside a quoted cell is an escaped literal quote. Without this, a
// bio with line breaks would get sliced into several bogus rows. Shared with
// leads.js for CSV parsing.
function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += char; i++; continue;
    }
    if (char === '"' && field === '') { inQuotes = true; i++; continue; }
    if (char === delimiter) { row.push(field); field = ''; i++; continue; }
    if (char === '\r') { i++; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += char; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- Session start (home "next N" queue + leads-page selection) ----------

$all('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $all('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('#session-size-input').value = btn.dataset.size;
  });
});
$('#session-size-input').addEventListener('input', () => {
  const val = $('#session-size-input').value;
  $all('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.size === val));
});

// The "Leads" mention in the home card's helper text is a real nav link.
$all('a[data-nav]').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); showView(a.dataset.nav); });
});

function showHomeError(available, requested) {
  const el = $('#home-session-error');
  el.innerHTML = `You only have <strong>${available}</strong> lead${available === 1 ? '' : 's'} ready to contact, but asked for ${requested}. `;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'btn-secondary';
  link.textContent = 'Go to Leads →';
  link.addEventListener('click', () => showView('leads'));
  el.appendChild(link);
  el.classList.remove('hidden');
}
function hideHomeError() { $('#home-session-error').classList.add('hidden'); }

// Server clamps to this too (MAX_NEXT_COUNT in server.js) — mirrored here so
// the client can tell "you asked for more than the server ever hands back in
// one go" apart from "you genuinely don't have that many uncontacted leads".
const MAX_SESSION_SIZE = 500;

$('#start-session-btn').addEventListener('click', async () => {
  hideHomeError();
  // `|| 15` would treat an explicit "0" in the field as unset and silently
  // start a 15-profile session instead of rejecting/clamping it.
  const rawCount = Number($('#session-size-input').value);
  const count = Math.max(1, Number.isFinite(rawCount) && rawCount > 0 ? Math.round(rawCount) : 15);
  const btn = $('#start-session-btn');
  btn.disabled = true;
  // Open the shared preview tab synchronously, before the await below, so
  // the browser doesn't treat it as a blocked popup — user-gesture
  // activation can lapse once we hit an `await` (same rule as openProfileTab).
  const previewTab = window.open('', 'ig_preview');
  try {
    const data = await fetchJson('/api/leads/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count })
    });
    const leads = data.leads || [];
    if (leads.length < count) {
      if (count > MAX_SESSION_SIZE && leads.length === MAX_SESSION_SIZE) {
        showHomeError(`${MAX_SESSION_SIZE}+ (capped at ${MAX_SESSION_SIZE} per session)`, count);
      } else {
        showHomeError(leads.length, count);
      }
      if (previewTab) previewTab.close();
      return;
    }
    // Home means "reach N sent messages", not "show me N profiles" — decide()
    // keeps topping this session up with fresh leads on every disqualify
    // until sentCount hits `count`, or the available-leads pool runs dry.
    beginSessionWithLeads(leads, { mode: 'goal', target: count });
  } catch (e) {
    if (previewTab) previewTab.close();
    alert(`Could not start session: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

function leadToProfile(l) {
  return {
    leadId: l.id,
    username: l.username,
    profileUrl: l.profileUrl,
    fullName: l.fullName,
    bio: l.bio,
    followers: l.followers ?? '',
    lastPostWeeks: '',
    postsPerWeek: '',
    avgViews: '',
    template: '',
    message: '',
    done: false,
    status: null,
    videoUrl: l.personalizedVideoUrl || null,
    videoStatus: l.personalizedVideoStatus || null,
    videoError: l.personalizedVideoError || null,
    videoName: l.personalizedVideoName || '',
    notes: l.notes || '',
    notesSavedValue: l.notes || '',
    // Always starts on for a freshly-shown profile — reassessed per lead,
    // not remembered from whatever the last profile was left at.
    canReceiveMessages: true
  };
}

// Shared by the home "next N" flow (goal mode — opts = {mode:'goal', target})
// and the Leads page's "start session with selected" flow (fixed mode —
// opts omitted, exactly this list, no top-up).
function beginSessionWithLeads(leads, opts = {}) {
  state.profiles = leads.map(leadToProfile);
  state.index = 0;
  state.results = [];
  state.sessionMode = opts.mode || 'fixed';
  state.sessionTarget = opts.target || null;
  state.sentCount = 0;
  state.outOfLeads = false;
  saveSession();
  // Must happen synchronously, before any await — including the one inside
  // preloadSessionVideos() — or the browser's popup blocker silently kills
  // it once this click's user-gesture activation lapses.
  openProfileTab(state.profiles[0].profileUrl);
  preloadSessionVideos();
}

// ---------- DASHBOARD ----------
function currentProfile() {
  return state.profiles[state.index];
}

// Reuses a single named tab for every profile instead of piling up a new one
// per lead. Must be called synchronously from a click handler (not after an
// `await`) or browsers will treat it as a popup and block it.
function openProfileTab(url) {
  if (!url) return;
  window.open(url, 'ig_preview');
}

function renderProfile() {
  const p = currentProfile();
  if (!p) return;

  // Goal mode's profile count grows as the queue tops itself up, so "current
  // / total profiles" would be a moving, confusing target — show progress
  // toward the actual goal (sent / target) instead.
  if (state.sessionMode === 'goal') {
    $('#progress-current').textContent = state.sentCount;
    $('#progress-total').textContent = state.sessionTarget;
    $('#progress-fill').style.width = `${Math.min(100, (state.sentCount / state.sessionTarget) * 100)}%`;
  } else {
    $('#progress-current').textContent = state.index + 1;
    $('#progress-total').textContent = state.profiles.length;
    $('#progress-fill').style.width = `${((state.index) / state.profiles.length) * 100}%`;
  }

  $('#profile-link').href = p.profileUrl;
  $('#f-fullname').value = p.fullName;
  $('#f-username').value = p.username;
  $('#f-bio').value = p.bio;
  $('#f-followers').value = p.followers;
  $('#f-lastpost').value = p.lastPostWeeks;
  $('#f-postsperweek').value = p.postsPerWeek;
  $('#f-avgviews').value = p.avgViews;

  populateTemplateSelect();
  // Only auto-suggest for a profile that hasn't had a template chosen yet —
  // otherwise navigating away and back would silently discard a manual override.
  $('#f-template').value = p.template || Object.keys(TEMPLATES)[0];
  updateMessage(!p.template);
  renderVideoSection();
  renderLeadStatusSection();

  $('#prev-btn').disabled = state.index === 0;
  $('#next-btn').disabled = state.index === state.profiles.length - 1;
}

function populateTemplateSelect() {
  const sel = $('#f-template');
  sel.innerHTML = '';
  Object.entries(TEMPLATES).forEach(([key, t]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = t.label;
    sel.appendChild(opt);
  });
}

function buildPlaceholders(p) {
  const naam = (p.fullName || p.username || '').trim().split(' ')[0] || p.username;
  const months = p.lastPostWeeks ? Math.max(1, Math.round(Number(p.lastPostWeeks) / 4.345)) : '[X]';
  // `? :` on the raw number would treat a deliberate threshold of 0 as unset
  // and print the literal placeholder text "[X]" straight into a real DM.
  const views = state.viewsThreshold != null ? state.viewsThreshold.toLocaleString('en-US') : '[X]';
  return { naam, months, views };
}

function updateMessage(useSuggestion) {
  const p = currentProfile();
  if (!p) return;

  if (useSuggestion) {
    const suggestion = suggestTemplate({
      lastPostWeeks: p.lastPostWeeks,
      postsPerWeek: p.postsPerWeek,
      avgViews: p.avgViews,
      viewsThreshold: state.viewsThreshold
    });
    p.template = suggestion.key;
    $('#f-template').value = suggestion.key;
    $('#suggestion-reason').textContent = '💡 ' + suggestion.reason;
  }

  const key = $('#f-template').value || p.template;
  p.template = key;
  // The category (which of the 6 templates fits this account) only changes
  // when the suggestion re-runs or the user picks a different one manually —
  // draw fresh wording in those cases, but keep whatever's already cached on
  // this profile otherwise (so paging back/forth or editing an unrelated
  // field doesn't keep reshuffling the wording under you).
  if (p.partsKey !== key || !p.partIds) {
    p.partIds = pickAllParts(key);
    p.partsKey = key;
  }
  renderMessageText();
}

// Renders p.template + p.partIds into #f-message by composing one wording per
// slot (opener/hook/value/cta). Split out from updateMessage() so the
// "different wording" button can re-render without re-running the suggestion
// or touching which category is selected.
function renderMessageText() {
  const p = currentProfile();
  if (!p) return;
  const key = p.template;
  const placeholders = buildPlaceholders(p);
  const parts = TEMPLATES[key] && TEMPLATES[key].parts;
  // Guards against TEMPLATES still being {} if loadTemplatesFromServer()
  // hasn't resolved yet (or failed), or a cached part id no longer existing —
  // without this a stray click during that window throws mid-render and
  // leaves the message/template UI broken. Falls back to each slot's first
  // available wording.
  const text = parts
    ? MESSAGE_SLOTS
        .map(slot => {
          const options = parts[slot] || [];
          const chosen = options.find(o => p.partIds && o.id === p.partIds[slot]) || options[0];
          return chosen ? chosen.render(placeholders) : '';
        })
        .filter(Boolean)
        .join(' ')
    : '';
  p.message = text;
  $('#f-message').value = text;

  const dmLink = $('#dm-link');
  dmLink.href = p.username ? `https://ig.me/m/${p.username}` : '#';
  saveSession();
}

// field listeners -> keep state + message in sync
['f-bio', 'f-followers'].forEach(id => {
  $(`#${id}`).addEventListener('input', syncFieldsToState);
});
// naam placeholder in the message depends on these two, so re-render the message text
['f-fullname', 'f-username'].forEach(id => {
  $(`#${id}`).addEventListener('input', () => { syncFieldsToState(); updateMessage(false); });
});
// These three all feed suggestTemplate() (lastPostWeeks/postsPerWeek/avgViews),
// so any of them can change which template is suggested — avgViews used to be
// left out here, so filling it in last (after the other two) never re-ran the
// suggestion even when it should have won by priority.
$('#f-lastpost').addEventListener('input', () => { syncFieldsToState(); updateMessage(true); });
$('#f-postsperweek').addEventListener('input', () => { syncFieldsToState(); updateMessage(true); });
$('#f-avgviews').addEventListener('input', () => { syncFieldsToState(); updateMessage(true); });
$('#f-template').addEventListener('change', () => { syncFieldsToState(); updateMessage(false); });
$('#f-message').addEventListener('input', () => { currentProfile().message = $('#f-message').value; saveSession(); });

function syncFieldsToState() {
  const p = currentProfile();
  if (!p) return;
  p.fullName = $('#f-fullname').value;
  p.username = $('#f-username').value;
  p.bio = $('#f-bio').value;
  p.followers = $('#f-followers').value;
  p.lastPostWeeks = $('#f-lastpost').value;
  p.postsPerWeek = $('#f-postsperweek').value;
  p.avgViews = $('#f-avgviews').value;
  saveSession();
}

$('#copy-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#f-message').value);
  const btn = $('#copy-btn');
  const original = btn.textContent;
  btn.textContent = '✓ Copied!';
  setTimeout(() => { btn.textContent = original; }, 1200);
});

$('#reshuffle-btn').addEventListener('click', () => {
  const p = currentProfile();
  if (!p || !p.template) return;
  // Redraws all 4 slots from the same rotation used automatically, so a
  // manual reshuffle here still counts toward "every wording gets used before
  // any repeat" instead of just picking uniformly at random.
  p.partIds = pickAllParts(p.template);
  p.partsKey = p.template;
  renderMessageText();
});

// ---------- Personalized video ----------

function renderVideoSection() {
  const p = currentProfile();
  if (!p) return;

  // Only seed the field the first time this profile is shown — once the
  // user's edited it (or a render has set it), navigating away and back
  // shouldn't silently discard that in favor of the auto-detected name.
  if (!p.videoName) p.videoName = buildPlaceholders(p).naam || '';
  $('#f-video-name').value = p.videoName;

  const statusEl = $('#video-status');
  const preview = $('#video-preview');
  const downloadLink = $('#video-download-link');
  const generateBtn = $('#video-generate-btn');

  statusEl.classList.remove('is-error');
  if (p.videoStatus === 'rendering') {
    statusEl.textContent = 'Rendering…';
    generateBtn.disabled = true;
  } else if (p.videoStatus === 'error') {
    statusEl.textContent = `Render failed: ${p.videoError || 'unknown error'}`;
    statusEl.classList.add('is-error');
    generateBtn.disabled = false;
  } else if (p.videoUrl) {
    statusEl.textContent = `Ready (as "${p.videoName}").`;
    generateBtn.disabled = false;
  } else {
    statusEl.textContent = 'Not generated yet.';
    generateBtn.disabled = false;
  }
  generateBtn.textContent = p.videoUrl ? '🎬 Regenerate' : '🎬 Generate video';

  if (p.videoUrl) {
    preview.src = p.videoUrl;
    preview.classList.remove('hidden');
    downloadLink.href = p.videoUrl;
    downloadLink.classList.remove('hidden');
  } else {
    preview.removeAttribute('src');
    preview.classList.add('hidden');
    downloadLink.classList.add('hidden');
  }
}

async function renderVideoForProfile(p) {
  const name = (p === currentProfile() ? $('#f-video-name').value : p.videoName || '').trim();
  if (!name) {
    p.videoStatus = 'error';
    p.videoError = 'No name to put in the video.';
    if (p === currentProfile()) renderVideoSection();
    return;
  }
  if (!p.leadId) {
    p.videoStatus = 'error';
    p.videoError = 'This profile has no lead record to attach a video to.';
    if (p === currentProfile()) renderVideoSection();
    return;
  }

  p.videoName = name;
  p.videoStatus = 'rendering';
  p.videoError = null;
  if (p === currentProfile()) renderVideoSection();

  try {
    const data = await fetchJson(`/api/leads/${p.leadId}/render-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }, 280000);
    p.videoUrl = data.url;
    p.videoStatus = 'done';
    p.videoError = null;
  } catch (e) {
    p.videoStatus = 'error';
    p.videoError = e.message;
  }
  saveSession();
  if (p === currentProfile()) renderVideoSection();
}

$('#f-video-name').addEventListener('input', () => {
  const p = currentProfile();
  if (!p) return;
  p.videoName = $('#f-video-name').value;
  saveSession();
});

$('#video-generate-btn').addEventListener('click', () => {
  const p = currentProfile();
  if (p) renderVideoForProfile(p);
});

// How many renders to have in flight at once during a batch. Vercel/Blob's
// rate limits are far above this, so the ceiling here is really "how many
// concurrent ffmpeg cold starts is reasonable" rather than any hard limit.
const VIDEO_BATCH_CONCURRENCY = 4;

// Shared by the manual "Generate videos for this session" button and the
// automatic preload screen shown when a session starts. Simple
// concurrency-limited worker pool: each worker pulls the next profile off
// the shared queue as soon as it finishes its own render.
async function renderVideoBatch(targets, onProgress) {
  let done = 0;
  let failed = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < targets.length) {
      const p = targets[nextIndex++];
      await renderVideoForProfile(p);
      if (p.videoStatus === 'error') failed++; else done++;
      if (onProgress) onProgress(done, failed, targets.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(VIDEO_BATCH_CONCURRENCY, targets.length) }, worker)
  );
  return { done, failed };
}

$('#video-batch-generate-btn').addEventListener('click', async () => {
  const btn = $('#video-batch-generate-btn');
  const statusEl = $('#video-batch-status');
  const targets = state.profiles.filter(p => p.videoStatus !== 'done' && p.videoStatus !== 'rendering');
  if (targets.length === 0) {
    statusEl.textContent = 'Every profile in this session already has a video.';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = `Generating… 0/${targets.length}`;
  const { done, failed } = await renderVideoBatch(targets, (d, f, total) => {
    statusEl.textContent = `Generating… ${d + f}/${total}`;
  });
  statusEl.textContent = failed === 0
    ? `Done — generated ${done} video${done === 1 ? '' : 's'}.`
    : `Generated ${done}, ${failed} failed — check each profile's status.`;
  btn.disabled = false;
});

// Shown between starting a session and the dashboard appearing — renders
// every profile's video up front (with the auto-detected name, right most of
// the time per the user) so they're already sitting there once the session
// actually starts, rather than making the user wait mid-session per profile.
let videoPreloadSkipped = false;

async function preloadSessionVideos() {
  const targets = state.profiles.filter(p => p.leadId && p.videoStatus !== 'done' && p.videoStatus !== 'rendering');
  if (targets.length === 0) {
    showView('dashboard');
    renderProfile();
    return;
  }

  videoPreloadSkipped = false;
  showView('video-preload');
  const fillEl = $('#preload-progress-fill');
  const textEl = $('#preload-progress-text');
  fillEl.style.width = '0%';
  textEl.textContent = `Generating 0/${targets.length}`;

  await renderVideoBatch(targets, (done, failed, total) => {
    const completed = done + failed;
    fillEl.style.width = `${Math.round((completed / total) * 100)}%`;
    textEl.textContent = `Generating ${completed}/${total}`;
  });

  // The skip button may have already moved the user on (possibly into a
  // different session entirely) by the time every render settles — don't
  // yank them back to the dashboard out from under whatever they're doing.
  if (!videoPreloadSkipped) {
    showView('dashboard');
    renderProfile();
  }
}

$('#preload-skip-btn').addEventListener('click', () => {
  videoPreloadSkipped = true;
  showView('dashboard');
  renderProfile();
});

// ---------- Lead status: "can receive messages" toggle + notes ----------

function renderLeadStatusSection() {
  const p = currentProfile();
  if (!p) return;
  $('#f-can-receive').checked = p.canReceiveMessages !== false;
  $('#f-session-notes').value = p.notes || '';
  autoResizeTextarea($('#f-session-notes'));
  updateDecisionButtons();
}

// Swaps the normal Sent/Not qualified pair for a single grey Next button
// when the lead can't receive messages at all — there's no outreach
// decision to make on an account you can't message.
function updateDecisionButtons() {
  const p = currentProfile();
  if (!p) return;
  const canReceive = p.canReceiveMessages !== false;
  $('#accept-btn').classList.toggle('hidden', !canReceive);
  $('#reject-btn').classList.toggle('hidden', !canReceive);
  $('#next-unreachable-btn').classList.toggle('hidden', canReceive);
}

$('#f-can-receive').addEventListener('change', () => {
  const p = currentProfile();
  if (!p) return;
  p.canReceiveMessages = $('#f-can-receive').checked;
  saveSession();
  updateDecisionButtons();
});

$('#f-session-notes').addEventListener('input', (e) => {
  autoResizeTextarea(e.target);
  const p = currentProfile();
  if (!p) return;
  p.notes = e.target.value;
  saveSession();
});

// Fires on blur-after-edit (matches the Leads page's own notes field), and
// also called explicitly from decide() so a note typed but not yet blurred
// isn't lost — especially for "not qualified", which soft-deletes the lead
// right after and would otherwise silently drop it (PATCH requires
// deleted_at IS NULL).
async function saveNotesForProfile(p) {
  if (!p || !p.leadId || p.notes === p.notesSavedValue) return;
  try {
    await fetchJson(`/api/leads/${p.leadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: p.notes })
    });
    p.notesSavedValue = p.notes;
  } catch (e) {
    console.error('Could not save notes', e);
  }
}

$('#f-session-notes').addEventListener('change', () => {
  const p = currentProfile();
  if (p) saveNotesForProfile(p);
});

$('#prev-btn').addEventListener('click', () => {
  syncFieldsToState();
  if (state.index > 0) {
    state.index--;
    openProfileTab(currentProfile().profileUrl);
    renderProfile();
  }
});
$('#next-btn').addEventListener('click', () => {
  syncFieldsToState();
  if (state.index < state.profiles.length - 1) {
    state.index++;
    openProfileTab(currentProfile().profileUrl);
    renderProfile();
  }
});

async function decide(status) {
  syncFieldsToState();
  const p = currentProfile();
  p.status = status;
  p.done = true;

  // Flush any note typed but not yet blurred — matters most for "not
  // qualified", which soft-deletes the lead right after (a PATCH sent after
  // that would silently no-op, since it requires deleted_at IS NULL).
  await saveNotesForProfile(p);

  // Goal mode (home's "reach N sent") tops the queue back up whenever we're
  // about to run out of queued profiles and haven't hit the target yet —
  // that's true whether THIS decision was a disqualify (doesn't count toward
  // the target, so the queue needs to grow to make up for it) or an accept
  // that just happens to be the last profile already queued (still need a
  // next profile to show). If it's the last profile already queued we don't
  // know the replacement's URL yet — that needs an async fetch below. We
  // still have to reserve the shared tab synchronously (before any await)
  // or the popup blocker silently swallows it once user-gesture activation
  // lapses; we just navigate it later once we know where.
  const sentCountAfterThis = state.sentCount + (status === 'sent' ? 1 : 0);
  const willNeedTopUp = state.sessionMode === 'goal'
    && state.index >= state.profiles.length - 1
    && sentCountAfterThis < state.sessionTarget;
  const knownNext = state.profiles[state.index + 1];
  let reservedTab = null;
  if (knownNext) {
    openProfileTab(knownNext.profileUrl);
  } else if (willNeedTopUp) {
    reservedTab = window.open('', 'ig_preview');
  }

  // Guard against a double-click firing this twice before the first request
  // resolves — that would insert two outreach rows and skip a profile.
  const acceptBtn = $('#accept-btn');
  const rejectBtn = $('#reject-btn');
  const nextUnreachableBtn = $('#next-unreachable-btn');
  acceptBtn.disabled = true;
  rejectBtn.disabled = true;
  nextUnreachableBtn.disabled = true;

  // "Can't receive messages" means no message was ever sent — there's
  // nothing real to log in outreach analytics for it.
  if (status !== 'cant_message') {
    try {
      await fetchJson('/api/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: p.username,
          profileUrl: p.profileUrl,
          fullName: p.fullName,
          bio: p.bio,
          followers: p.followers,
          lastPostWeeks: p.lastPostWeeks,
          postsPerWeek: p.postsPerWeek,
          avgViews: p.avgViews,
          template: p.template,
          message: p.message,
          status
        })
      });
    } catch (e) {
      console.error('Could not save outreach', e);
      alert(`This one didn't save to your analytics (${e.message}). The decision still went through locally — you may want to note it down.`);
    }
  }
  acceptBtn.disabled = false;
  rejectBtn.disabled = false;
  nextUnreachableBtn.disabled = false;

  // Keep the underlying lead in sync: sent -> enters Phase 1 follow-up
  // tracking (and any in-session edits saved back); not qualified -> the
  // lead is removed from the list entirely (soft-deleted, so the leads-page
  // undo toast still covers it); can't receive messages -> tagged with its
  // own stage but kept around (it's not a rejection, just unreachable for now).
  if (p.leadId) {
    if (status === 'sent') {
      fetchJson(`/api/leads/${p.leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileUrl: p.profileUrl,
          username: p.username,
          fullName: p.fullName,
          bio: p.bio,
          followers: p.followers,
          stage: 'phase1'
        })
      }).then(() => loadNotifications()).catch(e => console.error('Could not update lead stage', e));
    } else if (status === 'cant_message') {
      fetchJson(`/api/leads/${p.leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'cant_message' })
      }).catch(e => console.error('Could not update lead stage', e));
    } else {
      deleteLeads([p.leadId]);
    }
  }

  state.results.push({
    username: p.username,
    fullName: p.fullName,
    profileUrl: p.profileUrl,
    template: p.template,
    status
  });
  if (status === 'sent') state.sentCount++;

  if (willNeedTopUp) {
    try {
      // Exclude every lead already in this session (decided or not) — they're
      // all still `stage = 'new'` in the DB until their own PATCH/delete
      // resolves, so without this the same lead could get queued twice.
      const excludeIds = state.profiles.map(pr => pr.leadId).filter(Boolean);
      const data = await fetchJson('/api/leads/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1, excludeIds })
      });
      const newLeads = data.leads || [];
      if (newLeads.length > 0) {
        const newProfile = leadToProfile(newLeads[0]);
        state.profiles.push(newProfile);
        openProfileTab(newProfile.profileUrl); // navigates the reserved tab
        // Not awaited — starts rendering in the background so the video is
        // likely ready by the time the user gets here, without a second
        // loading screen interrupting the session for just one profile.
        renderVideoForProfile(newProfile);
      } else {
        state.outOfLeads = true;
        if (reservedTab) reservedTab.close();
      }
    } catch (e) {
      console.error('Could not fetch more leads to keep this session going', e);
      state.outOfLeads = true;
      if (reservedTab) reservedTab.close();
    }
  }

  const goalReached = state.sessionMode === 'goal' && state.sentCount >= state.sessionTarget;
  const hasNext = state.index < state.profiles.length - 1;
  if (!goalReached && hasNext) {
    state.index++;
    renderProfile();
  } else {
    showEndScreen();
  }
}

$('#accept-btn').addEventListener('click', () => decide('sent'));
$('#reject-btn').addEventListener('click', () => decide('not_qualified'));
$('#next-unreachable-btn').addEventListener('click', () => decide('cant_message'));

// ---------- END SCREEN ----------
function showEndScreen() {
  const sent = state.results.filter(r => r.status === 'sent');
  const rejected = state.results.filter(r => r.status === 'not_qualified');
  const cantMessage = state.results.filter(r => r.status === 'cant_message');

  clearSession();
  $('#progress-fill').style.width = '100%';
  $('#end-sent-count').textContent = sent.length;
  $('#end-rejected-count').textContent = rejected.length;
  $('#end-cant-message-count').textContent = cantMessage.length;

  let lines;
  if (state.sessionMode === 'goal' && state.sentCount >= state.sessionTarget) {
    lines = [
      `Goal reached — you sent ${state.sentCount} of your target ${state.sessionTarget}.`,
      `${rejected.length} profile${rejected.length === 1 ? '' : 's'} along the way didn't qualify.`
    ];
  } else if (state.sessionMode === 'goal' && state.outOfLeads) {
    lines = [
      `Ran out of available leads before reaching your target — sent ${state.sentCount} of ${state.sessionTarget}.`,
      `Import more leads to keep going.`
    ];
  } else {
    lines = [
      `You've made it through all ${state.results.length} profiles.`,
      sent.length > 0 ? `${sent.length} message${sent.length === 1 ? '' : 's'} sent — nice work.` : `No messages sent today — sometimes the quality just isn't there.`
    ];
  }
  $('#end-summary-line').textContent = lines.join(' ');

  // username/fullName come from freely-editable dashboard fields (and can
  // originate from an imported CSV), so they're escaped here exactly like
  // every other place in the app that renders lead-supplied text.
  const sentList = $('#end-sent-list');
  sentList.innerHTML = sent.length
    ? sent.map(r => `<li><strong>@${escapeHtml(r.username)}</strong> ${r.fullName ? `(${escapeHtml(r.fullName)})` : ''} — ${escapeHtml(TEMPLATES[r.template]?.label || r.template)}</li>`).join('')
    : '<li class="muted">None</li>';

  const rejList = $('#end-rejected-list');
  rejList.innerHTML = rejected.length
    ? rejected.map(r => `<li><strong>@${escapeHtml(r.username)}</strong> ${r.fullName ? `(${escapeHtml(r.fullName)})` : ''}</li>`).join('')
    : '<li class="muted">None</li>';

  const cantMessageList = $('#end-cant-message-list');
  cantMessageList.innerHTML = cantMessage.length
    ? cantMessage.map(r => `<li><strong>@${escapeHtml(r.username)}</strong> ${r.fullName ? `(${escapeHtml(r.fullName)})` : ''}</li>`).join('')
    : '<li class="muted">None</li>';

  showView('end');
}

$('#back-home-btn').addEventListener('click', () => {
  state.profiles = [];
  state.results = [];
  state.index = 0;
  state.sessionMode = 'fixed';
  state.sessionTarget = null;
  state.sentCount = 0;
  state.outOfLeads = false;
  showView('home');
});

// ---------- ANALYTICS ----------
let currentRange = 'today';

$all('.range-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $all('.range-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentRange = tab.dataset.range;
    loadAnalytics(currentRange);
  });
});

const RANGE_LABELS = {
  today: 'vs yesterday',
  week: 'vs last week',
  month: 'vs last month',
  '3months': 'vs previous 3 months',
  year: 'vs last year',
  all: ''
};

async function loadAnalytics(range) {
  try {
    const data = await fetchJson(`/api/analytics?range=${range}`);
    $('#an-total').textContent = data.total;
    $('#an-change-label').textContent = RANGE_LABELS[range] || '';
    if (data.pctChange === null) {
      $('#an-change').textContent = '—';
    } else {
      const sign = data.pctChange > 0 ? '+' : '';
      $('#an-change').textContent = `${sign}${data.pctChange}%`;
      $('#an-change').className = 'stat-value ' + (data.pctChange > 0 ? 'positive' : data.pctChange < 0 ? 'negative' : '');
    }
    renderChart(data.series);
    renderFunnel(data.funnel);
  } catch (e) {
    console.error('Failed to load analytics', e);
  }
}

function pctText(v) { return v === null || v === undefined ? '—' : `${v}%`; }

function renderFunnel(funnel) {
  if (!funnel) return;
  $('#fn-sends').textContent = funnel.totalSends;
  $('#fn-followups').textContent = funnel.followups;
  $('#fn-replies').textContent = funnel.replies;
  $('#fn-rr').textContent = pctText(funnel.replyRate);
  $('#fn-positive').textContent = funnel.positiveReplies;
  $('#fn-prr').textContent = pctText(funnel.prr);
  $('#fn-appts').textContent = funnel.appointmentsSet;
  $('#fn-asr').textContent = pctText(funnel.asr);
}

function showChartTooltip(barEl, s) {
  const tooltip = $('#an-tooltip');
  const card = $('#an-chart').closest('.chart-card');
  const cardBox = card.getBoundingClientRect();
  const barBox = barEl.getBoundingClientRect();
  tooltip.innerHTML = `${s.count} reach-out${s.count === 1 ? '' : 's'}<span class="tooltip-sub">${escapeHtml(s.label)}</span>`;
  tooltip.style.left = `${barBox.left + barBox.width / 2 - cardBox.left}px`;
  tooltip.style.top = `${barBox.top - cardBox.top}px`;
  tooltip.classList.remove('hidden');
}

function hideChartTooltip() {
  $('#an-tooltip').classList.add('hidden');
}

function renderChart(series) {
  const svg = $('#an-chart');
  svg.innerHTML = '';
  hideChartTooltip();
  if (!series || series.length === 0) return;

  const W = 800, H = 300, PAD = 30;
  const max = Math.max(1, ...series.map(s => s.count));
  const barW = (W - PAD * 2) / series.length;

  series.forEach((s, i) => {
    const barH = (s.count / max) * (H - PAD * 2);
    const x = PAD + i * barW;
    const y = H - PAD - barH;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x + barW * 0.15);
    rect.setAttribute('y', y);
    rect.setAttribute('width', barW * 0.7);
    rect.setAttribute('height', Math.max(barH, s.count > 0 ? 2 : 0));
    rect.setAttribute('rx', 3);
    rect.setAttribute('fill', 'var(--accent)');
    svg.appendChild(rect);

    if (series.length <= 20 || i % Math.ceil(series.length / 15) === 0) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x + barW / 2);
      text.setAttribute('y', H - PAD + 14);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '9');
      text.setAttribute('fill', 'var(--muted)');
      text.textContent = s.label;
      svg.appendChild(text);
    }

    // An invisible full-height, full-lane hit area — hovering a short (or
    // zero-count) bar would otherwise be nearly impossible to target.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hit.setAttribute('x', x);
    hit.setAttribute('y', 0);
    hit.setAttribute('width', barW);
    hit.setAttribute('height', H - PAD);
    hit.setAttribute('fill', 'transparent');
    hit.classList.add('chart-hit-area');
    hit.addEventListener('mouseenter', () => {
      rect.setAttribute('fill', 'var(--purple-light)');
      showChartTooltip(rect, s);
    });
    hit.addEventListener('mouseleave', () => {
      rect.setAttribute('fill', 'var(--accent)');
      hideChartTooltip();
    });
    svg.appendChild(hit);
  });

  const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  baseline.setAttribute('x1', PAD);
  baseline.setAttribute('y1', H - PAD);
  baseline.setAttribute('x2', W - PAD);
  baseline.setAttribute('y2', H - PAD);
  baseline.setAttribute('stroke', 'var(--border)');
  svg.appendChild(baseline);
}

// ---------- INIT ----------
async function loadViewsThreshold() {
  try {
    const data = await fetchJson('/api/settings/app');
    // `|| 1000` would silently overwrite a deliberately-set threshold of 0
    // back to 1000 on every reload — only fall back when the setting is
    // genuinely missing.
    const raw = data.settings && data.settings.views_threshold;
    state.viewsThreshold = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : 1000;
  } catch (e) {
    console.error('Could not load views threshold setting', e);
  }
}

(async function init() {
  await Promise.all([loadTemplatesFromServer(), loadViewsThreshold()]);
  const saved = loadSession();
  if (saved && Array.isArray(saved.profiles) && saved.profiles.length > 0 && saved.index < saved.profiles.length) {
    state.profiles = saved.profiles;
    state.index = saved.index;
    state.results = saved.results || [];
    state.sessionMode = saved.sessionMode || 'fixed';
    state.sessionTarget = saved.sessionTarget ?? null;
    state.sentCount = saved.sentCount || 0;
    state.outOfLeads = saved.outOfLeads || false;
    showView('dashboard');
    renderProfile();
  } else {
    showView('home');
  }
})();
