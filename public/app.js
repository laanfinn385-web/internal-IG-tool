const state = {
  profiles: [],      // parsed from URL input for the current session
  index: 0,           // current profile index
  results: [],         // {profile, status, template, message} for finished profiles this session
  viewsThreshold: 1000,  // overwritten from the server (Settings page) during init
  // Which session UI this is: 'ig_message' | 'li_message' (full swipeable
  // dashboard, with or without the IG-specific stats/suggestion UI) or
  // 'li_engagement' | 'li_connection' (the simple name+link+2-buttons card).
  sessionKind: 'ig_message',
  // Home's "reach N sent" flow vs the Leads page's "selected leads only" flow.
  // 'fixed' = exactly this list, no top-up (leads-selection). 'goal' = keep
  // fetching replacement leads on every disqualify until sentCount reaches
  // sessionTarget, or the available-leads pool runs dry.
  sessionMode: 'fixed',
  sessionTarget: null,
  sentCount: 0,
  outOfLeads: false,
  // Set only for a combi session: { liLeads } — the not-yet-started LinkedIn
  // batch, held here until the Instagram portion (state.profiles) finishes.
  combi: null,
  // True when this session was launched via "Start daily goal session" —
  // tags any resulting quit-save so Home can find it again and offer
  // "Continue" instead of "Start" (see loadHome/renderDailyGoal).
  isDailyGoal: false,
  // The Instagram account currently sending, and today's running count for
  // it — unused for LinkedIn session kinds. todaySentCount comes back from
  // each /api/outreach response so decide() never needs a second round-trip
  // just to check whether that send hit the account's daily cap.
  igAccountId: null,
  igAccountUsername: null,
  igAccountTodaySentCount: 0,
  // Set only while sitting on the "switching accounts" cooldown screen
  // (before it's been handed off to a saved session via "Go back to home") —
  // see showIgAccountLimitPause/renderIgCooldownBanner.
  igCooldownUntil: null,
  igCooldownAccountId: null,
  // In-session pacing (Instagram only) — real people don't send DMs
  // back-to-back for hours, so the active account's assigned Timing
  // sequence's pacing-block pattern (send N, pause, send N, pause...) is
  // walked throughout the session, looping once it reaches the end. Which
  // block is currently accumulating sends is tracked by index into that
  // pattern (looked up live via igAccountId, not duplicated into state);
  // currentBlockThreshold is picked fresh (randomized within that block's
  // min-max) whenever a new send-block starts.
  pacingBlockIndex: 0,
  sendsInCurrentBlock: 0,
  currentBlockThreshold: null,
  pacingBreakUntil: null,
  // Which pause block is currently showing (its label/message/range) — a
  // separate index from pacingBlockIndex, which is already pointing at
  // wherever sending resumes *after* this pause completes.
  activePauseBlockIndex: null,
  // "Always include at least one scroll break" (a Timing sequence setting)
  // — hadPacingBreakThisSession tracks whether any pause (natural or
  // forced) has happened yet, so shouldForceEndOfSessionBreak() only forces
  // one if the session is about to end without ever having had one.
  // pacingBreakIsFinal marks a forced end-of-session pause specifically, so
  // its own "Continue" ends the session instead of resuming the next lead.
  hadPacingBreakThisSession: false,
  pacingBreakIsFinal: false
};

// ---------- WORKSPACES (profiles) ----------
// Client identity for a no-auth, single-user-per-browser app — "workspace"
// internally (variable/header/table names) to avoid colliding with this
// file's own unrelated state.profiles/currentProfile() (the queued leads in
// an active outreach session); the UI-facing label is "Profile", matching
// the sidebar switcher. Sent as the X-Workspace-Id header on every request
// (see fetchJson) — the server falls back to its own seeded default if this
// is ever null, so the app still works before loadWorkspaces() resolves it
// on first load.
const ACTIVE_WORKSPACE_KEY = 'outreach_active_workspace_id';
let activeWorkspaceId = localStorage.getItem(ACTIVE_WORKSPACE_KEY) || null;
let workspacesCache = [];

function setActiveWorkspaceId(id) {
  activeWorkspaceId = id;
  try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, id); } catch (e) { /* storage unavailable — falls back to the server's own default next load */ }
}

function activeWorkspace() {
  return workspacesCache.find(w => w.id === activeWorkspaceId) || null;
}

// Called first thing in init() — resolves which profile is active before
// anything else loads (session restoration, account/sequence caches, etc.
// all key off activeWorkspaceId). If the stored id is stale (archived from
// another tab/device) or this is the very first load ever, falls back to
// whichever workspace the server considers its default.
async function loadWorkspaces() {
  try {
    const data = await fetchJson('/api/workspaces');
    workspacesCache = data.workspaces || [];
  } catch (e) {
    console.error('Could not load profiles', e);
    workspacesCache = [];
  }
  if (!activeWorkspace() && workspacesCache.length > 0) {
    setActiveWorkspaceId(workspacesCache[0].id);
  }
  return workspacesCache;
}

function workspacePhotoHtml(w) {
  if (w.pictureUrl) return `<img class="account-photo" src="${escapeHtml(w.pictureUrl)}" alt="">`;
  const letter = (w.name || '?').charAt(0).toUpperCase();
  return `<div class="account-photo account-photo-placeholder">${escapeHtml(letter)}</div>`;
}

// Replaces the sidebar's old static branding — shows the active profile's
// picture/name and lists every profile in the dropdown. Switching (or
// creating) a profile reloads the whole page rather than trying to
// surgically re-scope this app's many long-lived module-level caches
// (igAccountsCache, messageSequencesCache, leadsState, settingsState, etc.)
// — simplest way to guarantee nothing from the old profile lingers.
function renderSidebarProfileSwitcher() {
  const current = activeWorkspace();
  $('#profile-switcher-avatar').innerHTML = current ? workspacePhotoHtml(current) : '';
  $('#profile-switcher-name').textContent = current ? current.name : 'Choose a profile';
  $('#profile-switcher-list').innerHTML = workspacesCache.map(w => `
    <button type="button" class="profile-switcher-item${w.id === activeWorkspaceId ? ' active' : ''}" data-workspace-id="${w.id}">
      ${workspacePhotoHtml(w)}
      <span>${escapeHtml(w.name)}</span>
    </button>`).join('');
}

// Applied once, right after loadWorkspaces() resolves the active profile —
// switching profiles always reloads the whole page, so this never needs to
// re-run mid-session. Deliberately just hides the disabled platform's own
// option everywhere it appears (tabs, radios, checkboxes, Settings cards)
// rather than also trying to collapse "All"-style umbrella tabs or reset
// each page's own platform-filter default — those still work fine on
// whatever's left since there's nothing on the other platform to show
// anyway; this keeps the change a pure visibility pass, no risk of
// interfering with each page's own distinct filter-state logic.
function applyPlatformVisibility() {
  const ws = activeWorkspace();
  const igOn = !ws || ws.instagramEnabled;
  const liOn = !ws || ws.linkedinEnabled;
  if (igOn && liOn) return;

  $all('[data-platform="instagram"]').forEach(el => el.classList.toggle('hidden', !igOn));
  $all('[data-platform="linkedin"]').forEach(el => el.classList.toggle('hidden', !liOn));
  $all('[data-session-platform="instagram"]').forEach(el => el.classList.toggle('hidden', !igOn));
  $all('[data-session-platform="linkedin"]').forEach(el => el.classList.toggle('hidden', !liOn));
  $all('[data-session-platform="combi"]').forEach(el => el.classList.toggle('hidden', !(igOn && liOn)));
  $all('[data-type-filter="instagram"]').forEach(el => el.classList.toggle('hidden', !igOn));
  $all('[data-type-filter="linkedin"]').forEach(el => el.classList.toggle('hidden', !liOn));
  $all('[data-type-filter="combi"]').forEach(el => el.classList.toggle('hidden', !(igOn && liOn)));
  $all('[data-mode="openers"]').forEach(el => el.classList.toggle('hidden', !igOn)); // Analytics' opener A/B tab — Instagram only

  // Add-lead / CSV-mapping radios default to Instagram in the raw HTML —
  // hiding the disabled one isn't enough if it's also the one still checked.
  if (!igOn) {
    $('#add-platform-instagram').closest('.radio-label').classList.add('hidden');
    $('#add-platform-linkedin').checked = true;
    $('#mapping-platform-instagram').closest('.radio-label').classList.add('hidden');
    $('#mapping-platform-linkedin').checked = true;
  }
  if (!liOn) {
    $('#add-platform-linkedin').closest('.radio-label').classList.add('hidden');
    $('#mapping-platform-linkedin').closest('.radio-label').classList.add('hidden');
  }
  if (!igOn) $('#delete-platform-instagram').closest('.radio-label').classList.add('hidden');
  if (!liOn) $('#delete-platform-linkedin').closest('.radio-label').classList.add('hidden');

  // Settings cards — Instagram-only systems (accounts, Timing/Messaging
  // sequences) vs LinkedIn's own separate follow-up template system.
  if (!igOn) {
    $('#settings-accounts-card').classList.add('hidden');
    $('#settings-timing-sequences-card').classList.add('hidden');
    $('#settings-message-sequences-card').classList.add('hidden');
  }
  if (!liOn) {
    $('#settings-linkedin-followups-card').classList.add('hidden');
  }
}

// position: fixed on #profile-switcher-dropdown (style.css) needs explicit
// px coordinates — computed fresh on every open since the sidebar's own
// width (and so the button's position) differs between expanded/collapsed.
function positionProfileSwitcherDropdown() {
  const btnBox = $('#profile-switcher-btn').getBoundingClientRect();
  const dropdown = $('#profile-switcher-dropdown');
  dropdown.style.left = `${btnBox.left}px`;
  dropdown.style.top = `${btnBox.bottom + 6}px`;
}

function toggleProfileSwitcherDropdown(show) {
  if (show) positionProfileSwitcherDropdown();
  $('#profile-switcher-dropdown').classList.toggle('hidden', !show);
}

$('#profile-switcher-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = $('#profile-switcher-dropdown').classList.contains('hidden');
  toggleProfileSwitcherDropdown(isHidden);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.profile-switcher')) toggleProfileSwitcherDropdown(false);
});

$('#profile-switcher-list').addEventListener('click', (e) => {
  const item = e.target.closest('.profile-switcher-item');
  if (!item) return;
  const id = item.dataset.workspaceId;
  toggleProfileSwitcherDropdown(false);
  if (id === activeWorkspaceId) return;
  setActiveWorkspaceId(id);
  location.reload();
});

// ---------- New profile modal ----------
let pendingNewProfileImageUrl = null;

function resetNewProfileModal() {
  $('#new-profile-name').value = '';
  $('#new-profile-image').value = '';
  $('#new-profile-image-status').classList.add('hidden');
  $('#new-profile-instagram').checked = true;
  $('#new-profile-linkedin').checked = true;
  $('#new-profile-error').classList.add('hidden');
  pendingNewProfileImageUrl = null;
}

$('#profile-switcher-new-btn').addEventListener('click', () => {
  toggleProfileSwitcherDropdown(false);
  resetNewProfileModal();
  $('#new-profile-modal').classList.remove('hidden');
});

$('#new-profile-cancel-btn').addEventListener('click', () => {
  $('#new-profile-modal').classList.add('hidden');
});

// fileToBase64 — defined in public/followups.js (already used there for an
// Instagram account's photo), reused here for a profile picture via the
// same shared-global-scope pattern the rest of this app already relies on.
$('#new-profile-image').addEventListener('change', async () => {
  const file = $('#new-profile-image').files[0];
  const statusEl = $('#new-profile-image-status');
  if (!file) return;
  statusEl.textContent = 'Uploading…';
  statusEl.classList.remove('hidden');
  try {
    const imageBase64 = await fileToBase64(file);
    const data = await fetchJson('/api/workspaces/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, contentType: file.type })
    });
    pendingNewProfileImageUrl = data.url;
    statusEl.textContent = '✓ Uploaded';
  } catch (e) {
    pendingNewProfileImageUrl = null;
    statusEl.textContent = `Could not upload (${e.message})`;
  }
});

$('#new-profile-create-btn').addEventListener('click', async () => {
  const name = $('#new-profile-name').value.trim();
  const errorEl = $('#new-profile-error');
  if (!name) {
    errorEl.textContent = 'A name is required.';
    errorEl.classList.remove('hidden');
    return;
  }
  const instagramEnabled = $('#new-profile-instagram').checked;
  const linkedinEnabled = $('#new-profile-linkedin').checked;
  if (!instagramEnabled && !linkedinEnabled) {
    errorEl.textContent = 'Select at least one platform.';
    errorEl.classList.remove('hidden');
    return;
  }
  const btn = $('#new-profile-create-btn');
  btn.disabled = true;
  try {
    const data = await fetchJson('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pictureUrl: pendingNewProfileImageUrl, instagramEnabled, linkedinEnabled })
    });
    setActiveWorkspaceId(data.id);
    location.reload();
  } catch (e) {
    btn.disabled = false;
    errorEl.textContent = `Could not create profile: ${e.message}`;
    errorEl.classList.remove('hidden');
  }
});

// Both localStorage keys below fold in the active workspace id — each
// profile's in-progress session (and its opener/wording-rotation memory)
// is completely independent, exactly like everything else about a profile.
function sessionStorageKey() {
  return `outreach_session_v1__${activeWorkspaceId || 'default'}`;
}

// Persist the in-progress session so an accidental refresh/tab-close doesn't
// wipe unsaved profile data (already-decided profiles are safe server-side;
// this covers the one currently being filled in).
function saveSession() {
  try {
    localStorage.setItem(sessionStorageKey(), JSON.stringify({
      profiles: state.profiles,
      index: state.index,
      results: state.results,
      sessionKind: state.sessionKind,
      sessionMode: state.sessionMode,
      sessionTarget: state.sessionTarget,
      sentCount: state.sentCount,
      outOfLeads: state.outOfLeads,
      combi: state.combi,
      isDailyGoal: state.isDailyGoal,
      igAccountId: state.igAccountId,
      igAccountUsername: state.igAccountUsername,
      igAccountTodaySentCount: state.igAccountTodaySentCount,
      igCooldownUntil: state.igCooldownUntil,
      igCooldownAccountId: state.igCooldownAccountId,
      pacingBlockIndex: state.pacingBlockIndex,
      sendsInCurrentBlock: state.sendsInCurrentBlock,
      currentBlockThreshold: state.currentBlockThreshold,
      pacingBreakUntil: state.pacingBreakUntil,
      activePauseBlockIndex: state.activePauseBlockIndex,
      hadPacingBreakThisSession: state.hadPacingBreakThisSession,
      pacingBreakIsFinal: state.pacingBreakIsFinal
    }));
  } catch (e) { /* storage full or unavailable — non-fatal */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(sessionStorageKey());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(sessionStorageKey());
}

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

// ---------- Shared platform helpers ----------
// LinkedIn leads have no username (there's no equivalent handle concept) and
// no public DM deep-link scheme the way ig.me/m/ exists for Instagram — these
// two helpers are the one place that distinction lives, used everywhere the
// code would otherwise hardcode "@username" or an ig.me link (leads table,
// follow-up cards, end-screen/saved-session result lists, the dashboard DM
// button). `entry` is any lead-shaped object (a lead record, a session
// profile, a follow-up-due row) with platform/username/fullName/profileUrl.
function leadDisplayName(entry) {
  if (entry.platform === 'linkedin') return entry.fullName || entry.profileUrl || 'Unknown';
  return entry.username ? `@${entry.username}` : (entry.fullName || 'Unknown');
}

function leadDmUrl(entry) {
  if (entry.platform === 'linkedin') return entry.profileUrl || '#';
  return entry.username ? `https://ig.me/m/${entry.username}` : (entry.profileUrl || '#');
}

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
function partRotationStorageKey() {
  return `template_part_rotation_v1__${activeWorkspaceId || 'default'}`;
}

function loadPartRotation() {
  try {
    return JSON.parse(localStorage.getItem(partRotationStorageKey())) || {};
  } catch (e) {
    return {};
  }
}

function savePartRotation(rotation) {
  try {
    localStorage.setItem(partRotationStorageKey(), JSON.stringify(rotation));
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

// Instagram no longer has an equivalent category system (see templates.js) —
// this only ever resolves LinkedIn's TEMPLATES_LINKEDIN now, but still takes
// a platform param since pickPart/renderMessageText are written generically.
function templatesFor(platform) {
  return platform === 'linkedin' ? TEMPLATES_LINKEDIN : {};
}

// Picks the next wording id for one slot (opener/hook/value/cta) of one
// template category, drawing from a shuffled "bag" that's refilled (and
// reshuffled) once emptied.
function pickPart(key, slot, platform) {
  const templates = templatesFor(platform);
  const parts = templates[key] && templates[key].parts && templates[key].parts[slot];
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
function pickAllParts(key, platform) {
  const partIds = {};
  MESSAGE_SLOTS.forEach(slot => { partIds[slot] = pickPart(key, slot, platform); });
  return partIds;
}

// Fetches JSON, applies a timeout, and throws a readable Error on any
// network failure, timeout, or non-2xx response (using the server's
// { error } message when present) instead of failing silently.
async function fetchJson(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // X-Workspace-Id scopes every request to the active profile — the one
    // change every one of this app's ~90 call sites gets for free, since
    // they all already funnel through here. Omitted when unknown (falls
    // back to the server's own seeded default) — never sent as an empty
    // string, which the server would just trim away anyway.
    const headers = { ...(options && options.headers) };
    if (activeWorkspaceId) headers['X-Workspace-Id'] = activeWorkspaceId;
    const res = await fetch(url, { ...(options || {}), headers, signal: controller.signal });
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
  if (name === 'home') { loadHome(); loadNotifications(); refreshHomeSessionAccountRow(); }
  if (name === 'leads') { loadLeads(); loadNotifications(); }
  if (name === 'analytics') loadAnalytics(currentRange);
  if (name === 'settings') loadSettingsPage();
  if (name === 'saved-sessions') loadSavedSessions();
  if (name === 'timing-sequences') loadTimingSequences();
  if (name === 'message-sequences') loadMessageSequences();
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
  { key: 'engaged', label: 'Engaged', color: 'var(--stage-engaged)' },
  { key: 'connection_sent', label: 'Connection sent', color: 'var(--stage-connection-sent)' },
  { key: 'phase1', label: 'Phase 1', color: 'var(--stage-phase1)' },
  { key: 'phase2', label: 'Phase 2', color: 'var(--stage-phase2)' },
  { key: 'phase3', label: 'Phase 3', color: 'var(--stage-phase3)' },
  { key: 'in_conversation', label: 'In conversation', color: 'var(--stage-in-conversation)' },
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

let homePlatformFilter = 'all';

$('#home-platform-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#home-platform-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  homePlatformFilter = btn.dataset.platform;
  loadHome();
});

// Purely presentational, computed client-side from the visitor's own clock
// — no server data needed, so it's set once per loadHome() call rather than
// living in /api/home's response.
function renderHomeGreeting() {
  const now = new Date();
  $('#home-date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const hour = now.getHours();
  const greeting = hour < 5 ? 'Still up?' : hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  $('#home-greeting').textContent = greeting;
}

async function loadHome() {
  renderHomeGreeting();
  try {
    const data = await fetchJson(`/api/home?platform=${homePlatformFilter}`);
    $('#streak-value').textContent = data.streak;
    $('#streak-flame').classList.toggle('lit', !!data.streakTodayMet);
    $('#week-value').textContent = data.last7Days;
    $('#available-leads-value').textContent = data.availableLeads.toLocaleString('en-US');
    $('#reply-rate-value').textContent = pctText(data.replyRate);
    $('#prr-value').textContent = pctText(data.prr);
    $('#asr-value').textContent = pctText(data.asr);
    $('#connections-sent-value').textContent = data.connectionsSent.toLocaleString('en-US');
    $('#connections-accepted-value').textContent = data.connectionsAccepted.toLocaleString('en-US');
    $('#car-value').textContent = pctText(data.car);
    renderSendsTrendDelta(data.last7DaysPctChange);
    renderPipelineDonut(data.stageCounts);
    renderSendsSparkline(data.sendsTrend);
    renderDailyGoal(data.dailyGoal);
  } catch (e) {
    $('#streak-value').textContent = '–';
    $('#streak-flame').classList.remove('lit');
    $('#week-value').textContent = '–';
    $('#available-leads-value').textContent = '–';
    $('#reply-rate-value').textContent = '–';
    $('#prr-value').textContent = '–';
    $('#asr-value').textContent = '–';
    $('#connections-sent-value').textContent = '–';
    $('#connections-accepted-value').textContent = '–';
    $('#car-value').textContent = '–';
  }
}

// ---------- Daily goal ----------
let homeDailyGoalData = null;
const DAILY_GOAL_RING_CIRCUMFERENCE = 2 * Math.PI * 150; // r=150, matches the SVG circle in index.html

function renderDailyGoal(dailyGoal) {
  homeDailyGoalData = dailyGoal;
  const igGoal = dailyGoal.instagram;
  const liGoal = dailyGoal.linkedin;
  const totalGoal = igGoal + liGoal;
  const card = $('#daily-goal-card');
  const emptyState = $('#daily-goal-empty-state');
  const btn = $('#daily-goal-session-btn');
  const restEls = [$('.home-goal-ring-wrap'), $('#daily-goal-stats'), $('#home-goal-streak'), btn];

  if (totalGoal === 0) {
    restEls.forEach(el => el && el.classList.add('hidden'));
    emptyState.classList.remove('hidden');
    return;
  }
  restEls.forEach(el => el && el.classList.remove('hidden'));
  emptyState.classList.add('hidden');

  const igDone = dailyGoal.todaySentInstagram;
  const liDone = dailyGoal.todayEngagedLinkedin;
  const totalDone = igDone + liDone;
  const fraction = Math.min(1, totalGoal > 0 ? totalDone / totalGoal : 0);
  $('#daily-goal-ring-fill').style.strokeDashoffset = `${DAILY_GOAL_RING_CIRCUMFERENCE * (1 - fraction)}`;
  $('#daily-goal-ring-done').textContent = totalDone.toLocaleString('en-US');
  $('#daily-goal-ring-total').textContent = `of ${totalGoal.toLocaleString('en-US')} sent`;

  $('#daily-goal-ig-stat').classList.toggle('hidden', igGoal === 0);
  $('#daily-goal-ig-text').textContent = `${igDone}/${igGoal}${dailyGoal.instagramSynced ? ' (synced)' : ''}`;
  $('#daily-goal-li-stat').classList.toggle('hidden', liGoal === 0);
  $('#daily-goal-li-text').textContent = `${liDone}/${liGoal}`;

  const igRemaining = Math.max(0, igGoal - igDone);
  const liRemaining = Math.max(0, liGoal - liDone);
  const goalReached = igRemaining === 0 && liRemaining === 0;
  card.classList.toggle('goal-reached', goalReached);
  if (goalReached) {
    $('#daily-goal-ring-label').textContent = 'Goal reached';
    btn.textContent = '🎉 Goal reached';
    btn.disabled = true;
  } else {
    $('#daily-goal-ring-label').textContent = 'On track';
    btn.disabled = false;
    btn.textContent = dailyGoal.savedSession ? 'Continue daily goal session →' : 'Start daily goal session →';
  }
}

// A daily-goal Instagram leg is sized to whichever is smaller: what's still
// needed to hit today's combined goal, or this one account's own remaining
// capacity for today — so a leg always ends exactly when one of those runs
// out, never partway through an oversized shared batch.
async function startLegForAccount(accountId, igRemaining, liRemaining) {
  const account = findIgAccount(accountId);
  const legTarget = Math.min(igRemaining, account ? account.effectiveRemainingForNewSends : igRemaining);
  if (liRemaining > 0) {
    await startCombiSession(legTarget, liRemaining, true, accountId);
  } else {
    await startSinglePlatformSession('instagram', legTarget, true, accountId);
  }
  // Both of the above silently write an insufficient-leads message into
  // #home-session-error and return (instead of throwing) when there aren't
  // enough leads — fine when called from the Home view itself, but this can
  // now also be called from the account-picker screen, where that banner is
  // invisible. Surface it as a real error so the caller can show it.
  const homeError = $('#home-session-error');
  if (!homeError.classList.contains('hidden')) {
    const message = homeError.textContent.trim();
    homeError.classList.add('hidden');
    throw new Error(message || 'Not enough leads available right now.');
  }
}

// Shared by the very first "Start daily goal session" click (isHandoff:
// false) and by finishInstagramPortion() once one account's own leg finishes
// (isHandoff: true) — decides whether the Instagram side of today's goal
// needs another leg at all, and if so, either auto-starts the one usable
// account (first click, single account — today's original one-click
// convenience) or shows the account-picker screen so the choice (or the
// "done, switching" handoff) is always visible. Returns true if this call
// handled things (started a leg, showed the picker, or showed the "no
// accounts" alert) — false only means "nothing more to do here", so the
// caller falls through to its own normal end screen.
async function beginOrContinueDailyGoalIg(liRemaining, isHandoff) {
  await loadHome();
  const igRemaining = Math.max(0, homeDailyGoalData.instagram - homeDailyGoalData.todaySentInstagram);
  if (igRemaining <= 0) return false;

  const accounts = await loadIgAccounts(true);
  const usable = accounts.filter(a => accountCanSendToday(a));
  if (usable.length === 0) {
    if (isHandoff) return false;
    alert(accounts.length === 0
      ? 'Add an Instagram account in Settings before starting an Instagram session.'
      : "None of your Instagram accounts can send right now — they're either still warming up or already at today's limit.");
    return true;
  }
  if (!isHandoff && usable.length === 1) {
    await startLegForAccount(usable[0].id, igRemaining, liRemaining);
    return true;
  }
  showIgAccountPickerScreen({ isHandoff, igRemaining, liRemaining, usable });
  return true;
}

// Stashed target numbers for whichever account card gets clicked next —
// set fresh every time the picker is shown, read once by the click handler.
let igAccountPickerState = null;

function showIgAccountPickerScreen({ isHandoff, igRemaining, liRemaining, usable }) {
  igAccountPickerState = { igRemaining, liRemaining };
  const banner = $('#ig-account-picker-banner');
  const title = $('#ig-account-picker-title');
  const emoji = $('#ig-account-picker-emoji');
  if (isHandoff) {
    emoji.textContent = '✅';
    title.textContent = 'Switching accounts';
    banner.textContent = `Finished with @${state.igAccountUsername || 'that account'} for today — ${state.sentCount} sent. ${igRemaining} more needed to hit today's Instagram goal.`;
    banner.classList.remove('hidden');
  } else {
    emoji.textContent = '🎯';
    title.textContent = 'Choose an account to start with';
    banner.classList.add('hidden');
  }
  // accountPhotoHtml/formatAccountAge — defined in followups.js, callable
  // here since every public/*.js file shares one global scope.
  $('#ig-account-picker-list').innerHTML = usable.map(a => {
    const seq = (messageSequencesCache || []).find(s => s.id === a.messageSequenceId);
    const seqName = seq ? seq.name : 'No sequence assigned';
    return `
      <button type="button" class="daily-goal-account-card" data-id="${a.id}">
        ${accountPhotoHtml(a)}
        <div class="daily-goal-account-card-main">
          <div class="daily-goal-account-card-username">@${escapeHtml(a.username)}</div>
          <div class="daily-goal-account-card-meta">
            ${escapeHtml(seqName)} · ${formatAccountAge(a.ageDays)}<br>
            ${a.todaySentCount}/${a.dailyLimit} sent today · ${a.effectiveRemainingForNewSends} left today
          </div>
        </div>
      </button>`;
  }).join('');
  showView('ig-account-picker');
}

$('#ig-account-picker-list').addEventListener('click', async (e) => {
  const card = e.target.closest('.daily-goal-account-card');
  if (!card || !igAccountPickerState) return;
  const { igRemaining, liRemaining } = igAccountPickerState;
  $all('.daily-goal-account-card').forEach(c => c.disabled = true);
  try {
    await startLegForAccount(card.dataset.id, igRemaining, liRemaining);
  } catch (err) {
    alert(`Could not start this account's session: ${err.message}`);
    $all('.daily-goal-account-card').forEach(c => c.disabled = false);
  }
});

$('#ig-account-picker-home-btn').addEventListener('click', () => {
  igAccountPickerState = null;
  showView('home');
});

$('#daily-goal-session-btn').addEventListener('click', async () => {
  if (!homeDailyGoalData) return;
  if (homeDailyGoalData.savedSession) {
    resumeSavedSession(homeDailyGoalData.savedSession);
    return;
  }
  const igRemaining = Math.max(0, homeDailyGoalData.instagram - homeDailyGoalData.todaySentInstagram);
  const liRemaining = Math.max(0, homeDailyGoalData.linkedin - homeDailyGoalData.todayEngagedLinkedin);
  if (igRemaining === 0 && liRemaining === 0) return;

  if (igRemaining > 0 && isIgCooldownActive()) {
    alert(`Instagram is on a switch cooldown for another ${formatCountdown(igCooldownState.until - Date.now())} — new Instagram sessions are blocked until then.`);
    return;
  }

  const btn = $('#daily-goal-session-btn');
  btn.disabled = true;
  try {
    if (igRemaining > 0) {
      await beginOrContinueDailyGoalIg(liRemaining, false);
    } else {
      await startSinglePlatformSession('linkedin', liRemaining, true, null);
    }
  } catch (e) {
    alert(`Could not start the daily goal session: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

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

function showHomeError(available, requested, customMessage) {
  const el = $('#home-session-error');
  if (customMessage) {
    el.textContent = customMessage;
    el.classList.remove('hidden');
    return;
  }
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

// ---------- Instagram accounts (rotation, daily limits) ----------
// Shared across the Home starter, the Leads-page selection-start modal, and
// the mid-session limit-hit pause screen — loaded once and cached, refreshed
// (loadIgAccounts(true)) whenever a send might have changed a count.
let igAccountsCache = null;

async function loadIgAccounts(force) {
  if (igAccountsCache && !force) return igAccountsCache;
  // Loaded alongside accounts (not lazily inside decide()) so an account's
  // pacing-block pattern and Messaging sequence are always ready
  // synchronously by the time a session actually needs to check them.
  try {
    const [data] = await Promise.all([
      fetchJson('/api/accounts'),
      loadTimingSequencesForSession(force),
      loadMessageSequencesForSession(force)
    ]);
    igAccountsCache = data.accounts || [];
  } catch (e) {
    console.error('Could not load accounts', e);
    igAccountsCache = [];
  }
  return igAccountsCache;
}

function findIgAccount(id) {
  return (igAccountsCache || []).find(a => a.id === id) || null;
}

// Populates a <select> with every account not in excludeIds, showing each
// one's live today/limit count so a maxed-out account is obvious before
// picking it. Returns the list actually shown (so callers can tell if it's
// empty).
function populateAccountSelect(selectEl, accounts, excludeIds = []) {
  const usable = accounts.filter(a => !excludeIds.includes(a.id));
  selectEl.innerHTML = usable.map(a => {
    const followupNote = a.pendingPhase1FollowupCount > 0 ? `, ${a.pendingPhase1FollowupCount} follow-up${a.pendingPhase1FollowupCount === 1 ? '' : 's'} due` : '';
    return `<option value="${a.id}">@${escapeHtml(a.username)} (${a.todaySentCount}/${a.dailyLimit} today${followupNote})</option>`;
  }).join('');
  return usable;
}

// True only once the account is past its warmup (dailyLimit is still 0
// during warmup, which already fails this the same way a maxed-out account
// does — no separate phase check needed), and there's still room for a new
// send once today's already-sent count *and* today's still-pending phase-1
// follow-ups (which will also draw from this same daily cap) are accounted
// for — otherwise the account looks available right up until the follow-up
// backlog for the day pushes it over.
function accountCanSendToday(account) {
  return !!account && account.effectiveRemainingForNewSends > 0;
}

function accountBlockedReason(account) {
  if (!account) return '';
  if (account.dailyLimit === 0) {
    return `@${account.username} is still warming up${account.warmupDay != null ? ` (day ${account.warmupDay} of ${account.warmupDays})` : ''} and can't send yet.`;
  }
  if (account.pendingPhase1FollowupCount > 0 && account.effectiveRemainingForNewSends === 0) {
    return `@${account.username} has ${account.todaySentCount}/${account.dailyLimit} sent today plus ${account.pendingPhase1FollowupCount} follow-up${account.pendingPhase1FollowupCount === 1 ? '' : 's'} still due — no room left for new sends today.`;
  }
  return `@${account.username} has already hit its daily limit today (${account.todaySentCount}/${account.dailyLimit}).`;
}

// Shared by every "pick an account, then start/continue" spot (Home, the
// Leads-page selection modal, the mid-session limit pause screen) — keeps
// the action button disabled with an inline reason until the currently
// selected account can actually send today, rather than only checking once
// the button's already been clicked.
function applyAccountSelectionValidation(selectEl, btnEl, errorEl) {
  const account = findIgAccount(selectEl.value);
  const canSend = accountCanSendToday(account);
  btnEl.disabled = !canSend;
  if (account && !canSend) {
    errorEl.textContent = accountBlockedReason(account);
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
  }
  return canSend;
}

// Which of the three "Start new session" tabs is active. LinkedIn always
// means an engagement session (per the user's spec — connection/message
// sessions are notification- or selection-driven, never started from here).
let homeSessionPlatform = 'instagram';

async function refreshHomeSessionAccountRow() {
  const needsAccount = homeSessionPlatform === 'instagram' || homeSessionPlatform === 'combi';
  $('#home-session-account-row').classList.toggle('hidden', !needsAccount);
  const startBtn = $('#start-session-btn');
  if (!needsAccount) {
    startBtn.disabled = false;
    $('#home-session-account-error').classList.add('hidden');
    return;
  }
  // Disabled up front (not just once the account list resolves) — the button
  // should never look clickable before a usable account is actually
  // confirmed selected, not even for the brief moment while this loads.
  startBtn.disabled = true;
  const accounts = await loadIgAccounts();
  const select = $('#home-session-account-select');
  const usable = populateAccountSelect(select, accounts);
  $('#home-session-no-accounts').classList.toggle('hidden', usable.length > 0);
  select.classList.toggle('hidden', usable.length === 0);
  if (usable.length === 0) {
    $('#home-session-account-error').classList.add('hidden');
    return;
  }
  applyAccountSelectionValidation(select, startBtn, $('#home-session-account-error'));
}

$('#home-session-account-select').addEventListener('change', () => {
  applyAccountSelectionValidation($('#home-session-account-select'), $('#start-session-btn'), $('#home-session-account-error'));
});

$('#home-session-platform-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#home-session-platform-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  homeSessionPlatform = btn.dataset.sessionPlatform;
  $('#home-session-single').classList.toggle('hidden', homeSessionPlatform === 'combi');
  $('#home-session-combi').classList.toggle('hidden', homeSessionPlatform !== 'combi');
  hideHomeError();
  refreshHomeSessionAccountRow();
});

async function startSinglePlatformSession(platform, explicitCount, isDailyGoal, accountId) {
  // `|| 15` would treat an explicit "0" in the field as unset and silently
  // start a 15-profile session instead of rejecting/clamping it.
  const rawCount = explicitCount ?? Number($('#session-size-input').value);
  const count = Math.max(1, Number.isFinite(rawCount) && rawCount > 0 ? Math.round(rawCount) : 15);
  const data = await fetchJson('/api/leads/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, platform })
  });
  const leads = data.leads || [];
  if (leads.length < count) {
    if (count > MAX_SESSION_SIZE && leads.length === MAX_SESSION_SIZE) {
      showHomeError(`${MAX_SESSION_SIZE}+ (capped at ${MAX_SESSION_SIZE} per session)`, count);
    } else {
      showHomeError(leads.length, count);
    }
    return;
  }
  // Home means "reach N sent/engaged", not "show me N profiles" — decide()/
  // decideSimple() keeps topping this session up with fresh leads on every
  // disqualify until sentCount hits `count`, or the available-leads pool
  // runs dry.
  await beginSessionWithLeads(leads, { mode: 'goal', target: count, kind: platform === 'linkedin' ? 'li_engagement' : 'ig_message', isDailyGoal, accountId });
}

// Fetches both batches up front (rather than pulling LinkedIn leads only once
// the Instagram portion finishes) so "Save LinkedIn leads for later" on the
// interstitial screen has concrete leads to save — not just a number.
async function startCombiSession(explicitIgCount, explicitLiCount, isDailyGoal, accountId) {
  const rawIgCount = explicitIgCount ?? Number($('#combi-ig-size-input').value);
  const igCount = Math.max(1, Number.isFinite(rawIgCount) && rawIgCount > 0 ? Math.round(rawIgCount) : 15);
  const rawLiCount = explicitLiCount ?? Number($('#combi-li-size-input').value);
  const liCount = Math.max(1, Number.isFinite(rawLiCount) && rawLiCount > 0 ? Math.round(rawLiCount) : 15);

  const [igData, liData] = await Promise.all([
    fetchJson('/api/leads/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: igCount, platform: 'instagram' }) }),
    fetchJson('/api/leads/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: liCount, platform: 'linkedin' }) })
  ]);
  const igLeads = igData.leads || [];
  const liLeads = liData.leads || [];
  if (igLeads.length < igCount) {
    showHomeError(igLeads.length, igCount);
    return;
  }
  if (liLeads.length < liCount) {
    showHomeError(liLeads.length, liCount);
    return;
  }

  // The LinkedIn batch sits here — already converted to profile shape, same
  // shape every other state.combi.liLeads consumer expects (see
  // resumeSavedSession's 'combi' branch, which reconstructs this same shape
  // from a saved session) — untouched until the Instagram portion ends (see
  // the goalReached/hasNext branch in decide()).
  state.combi = { liLeads: liLeads.map(leadToProfile) };
  await beginSessionWithLeads(igLeads, { mode: 'goal', target: igCount, kind: 'ig_message', isDailyGoal, accountId });
}

$('#start-session-btn').addEventListener('click', async () => {
  hideHomeError();
  const needsAccount = homeSessionPlatform === 'instagram' || homeSessionPlatform === 'combi';
  if (needsAccount && isIgCooldownActive()) {
    showHomeError(0, 0, `Instagram is on a switch cooldown for another ${formatCountdown(igCooldownState.until - Date.now())} — new Instagram sessions are blocked until then. LinkedIn sessions are unaffected.`);
    return;
  }
  let accountId = null;
  if (needsAccount) {
    accountId = $('#home-session-account-select').value;
    if (!accountId) {
      showHomeError(0, 0, 'Add an Instagram account in Settings before starting an Instagram session.');
      return;
    }
  }
  const btn = $('#start-session-btn');
  btn.disabled = true;
  // No tab reservation here (there used to be one) — no tab opens anywhere
  // until the video preload's "GO!" button is clicked, so reserving one
  // this early would just sit there unused, which is exactly the stray
  // about:blank tab this used to leave behind.
  try {
    if (homeSessionPlatform === 'combi') {
      await startCombiSession(undefined, undefined, false, accountId);
    } else {
      await startSinglePlatformSession(homeSessionPlatform, undefined, false, accountId);
    }
  } catch (e) {
    alert(`Could not start session: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

function leadToProfile(l) {
  return {
    leadId: l.id,
    platform: l.platform || 'instagram',
    username: l.username,
    profileUrl: l.profileUrl,
    fullName: l.fullName,
    headline: l.headline || '',
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

// 'message' kinds (ig_message/li_message) go through the video-preload
// screen (if applicable) then the full swipeable dashboard. 'simple' kinds
// (LinkedIn engagement/connection) skip straight to the lightweight
// swipeable card — neither renders a video or composes a message.
const SIMPLE_SESSION_KINDS = ['li_engagement', 'li_connection'];

// Shared by the home "next N" flow (goal mode — opts = {mode:'goal', target})
// and the Leads page's "start session with selected" flow (fixed mode —
// opts omitted, exactly this list, no top-up). opts.kind selects which UI
// this session uses (default ig_message, the original/only kind before
// LinkedIn support existed). opts.alreadyProfiles skips the leadToProfile
// mapping for callers that already have profile-shaped objects (the combi
// "move on to LinkedIn" transition — see state.combi.liLeads).
// In-session pacing (Instagram sends only) — see the state object's
// comment. Driven by the active account's assigned Timing sequence's
// pacing-block pattern rather than a fixed global range, so different
// accounts (or the same account after a sequence edit) can behave
// differently — randomized fresh within each block's own min-max so there's
// no fixed, inferable count.
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Separate small cache from followups.js's own timingSeqState (that one's
// scoped to the Timing-sequences settings page) — this is just what the
// session engine needs to look up an account's pacing pattern.
let timingSequencesCache = null;
async function loadTimingSequencesForSession(force) {
  if (timingSequencesCache && !force) return timingSequencesCache;
  try {
    const data = await fetchJson('/api/timing-sequences');
    timingSequencesCache = data.sequences || [];
  } catch (e) {
    console.error('Could not load timing sequences', e);
    timingSequencesCache = [];
  }
  return timingSequencesCache;
}

function pacingBlocksForAccount(account) {
  if (!account || !account.timingSequenceId || !timingSequencesCache) return [];
  const seq = timingSequencesCache.find(s => s.id === account.timingSequenceId);
  return seq ? seq.pacingBlocks : [];
}

// Whole sequence (not just its blocks) — needed for guaranteeMinOnePause,
// see shouldForceEndOfSessionBreak().
function timingSequenceForAccount(account) {
  if (!account || !account.timingSequenceId || !timingSequencesCache) return null;
  return timingSequencesCache.find(s => s.id === account.timingSequenceId) || null;
}

// Same pattern as timingSequencesCache — the active account's assigned
// Messaging sequence (first message text/video flag + follow-up steps),
// used by updateMessage() to render an Instagram lead's first message.
let messageSequencesCache = null;
async function loadMessageSequencesForSession(force) {
  if (messageSequencesCache && !force) return messageSequencesCache;
  try {
    const data = await fetchJson('/api/message-sequences');
    messageSequencesCache = data.sequences || [];
  } catch (e) {
    console.error('Could not load message sequences', e);
    messageSequencesCache = [];
  }
  return messageSequencesCache;
}

function messageSequenceForAccount(account) {
  if (!account || !account.messageSequenceId || !messageSequencesCache) return null;
  return messageSequencesCache.find(s => s.id === account.messageSequenceId) || null;
}

// Next block of the given type at or after fromIndex, wrapping — -1 if the
// pattern has none of that type at all (a misconfigured/edited-mid-session
// sequence shouldn't hang the session, just skip pacing until it's fixed).
function findNextBlockOfType(blocks, fromIndex, type) {
  for (let i = 0; i < blocks.length; i++) {
    const idx = (fromIndex + i) % blocks.length;
    if (blocks[idx].blockType === type) return idx;
  }
  return -1;
}

async function beginSessionWithLeads(leads, opts = {}) {
  state.profiles = opts.alreadyProfiles ? leads : leads.map(leadToProfile);
  state.index = 0;
  state.results = [];
  state.sessionKind = opts.kind || 'ig_message';
  // Force-refresh accounts + Timing/Messaging sequences right as a real
  // session begins — igAccountsCache/timingSequencesCache/messageSequencesCache
  // are otherwise only reloaded on a full page load or an account-limit
  // event, so an opener/pacing edit made in Settings earlier in the same
  // tab would silently keep being ignored (always using whatever was
  // cached at page-load) without this.
  if (state.sessionKind === 'ig_message') {
    await loadIgAccounts(true);
  }
  state.sessionMode = opts.mode || 'fixed';
  state.sessionTarget = opts.target || null;
  state.sentCount = 0;
  state.outOfLeads = false;
  state.isDailyGoal = !!opts.isDailyGoal;
  state.igCooldownUntil = null;
  state.igCooldownAccountId = null;
  state.pacingBlockIndex = 0;
  state.sendsInCurrentBlock = 0;
  state.currentBlockThreshold = null;
  state.pacingBreakUntil = null;
  state.activePauseBlockIndex = null;
  state.hadPacingBreakThisSession = false;
  state.pacingBreakIsFinal = false;
  if (opts.accountId && state.sessionKind === 'ig_message') {
    const account = findIgAccount(opts.accountId);
    state.igAccountId = opts.accountId;
    state.igAccountUsername = account ? account.username : null;
    state.igAccountTodaySentCount = account ? account.todaySentCount : 0;
  } else {
    state.igAccountId = null;
    state.igAccountUsername = null;
    state.igAccountTodaySentCount = 0;
  }
  saveSession();
  if (SIMPLE_SESSION_KINDS.includes(state.sessionKind)) {
    enterSimpleSession();
    return;
  }
  // No tab is opened here at all — preloadSessionVideos() shows a "GO!"
  // button once rendering is actually ready, and that click (a fresh,
  // direct user gesture) is what opens the first profile's tab. Opening
  // anything eagerly, even a placeholder tab, was still visibly happening
  // before the user was ready for it.
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
  const isLinkedin = p.platform === 'linkedin';

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
  $('#profile-link').textContent = isLinkedin ? 'Open profile on LinkedIn ↗' : 'Open profile on Instagram ↗';
  $('#f-fullname').value = p.fullName;
  $('#f-username').value = p.username || '';
  $('#f-headline').value = p.headline || '';
  $('#f-bio').value = p.bio;
  $('#f-bio-label').textContent = isLinkedin ? 'Additional info' : 'Bio';
  $('#f-followers').value = p.followers;
  $('#f-lastpost').value = p.lastPostWeeks;
  $('#f-postsperweek').value = p.postsPerWeek;
  $('#f-avgviews').value = p.avgViews;

  // LinkedIn leads have no username/stats/multi-template-suggestion —
  // Instagram's fields for those don't apply, so the rows are hidden rather
  // than shown empty. See leadDmUrl/leadDisplayName (app.js) for the same
  // per-platform split applied everywhere else in the app.
  $('#f-username-row').classList.toggle('hidden', isLinkedin);
  $('#f-headline-row').classList.toggle('hidden', !isLinkedin);
  $('.stats-card').classList.toggle('hidden', isLinkedin);
  // No public LinkedIn DM deep link exists (see leadDmUrl) — "Open DM" would
  // just duplicate the profile-link button above for a LinkedIn profile.
  $('#dm-link').classList.toggle('hidden', isLinkedin);

  updateMessage();
  // The video card only makes sense for Instagram, and only when the active
  // account's assigned Messaging sequence actually calls for a video — no
  // point offering video generation for a sequence that's text-only.
  const seq = isLinkedin ? null : messageSequenceForAccount(findIgAccount(state.igAccountId));
  $('.video-card').classList.toggle('hidden', !seq || !seq.firstMessageHasVideo);
  renderVideoSection();
  renderLeadStatusSection();
  updateSwitchAccountsButtonVisibility();

  $('#prev-btn').disabled = state.index === 0;
  $('#next-btn').disabled = state.index === state.profiles.length - 1;
}

function buildPlaceholders(p) {
  const naam = (p.fullName || p.username || '').trim().split(' ')[0] || p.username;
  const months = p.lastPostWeeks ? Math.max(1, Math.round(Number(p.lastPostWeeks) / 4.345)) : '[X]';
  // `? :` on the raw number would treat a deliberate threshold of 0 as unset
  // and print the literal placeholder text "[X]" straight into a real DM.
  const views = state.viewsThreshold != null ? state.viewsThreshold.toLocaleString('en-US') : '[X]';
  return { naam, months, views };
}

function updateMessage() {
  const p = currentProfile();
  if (!p) return;

  // LinkedIn has exactly one template and no stats to suggest from — always
  // that one key.
  if (p.platform === 'linkedin') {
    const key = Object.keys(TEMPLATES_LINKEDIN)[0];
    p.template = key;
    if (key && (p.partsKey !== key || !p.partIds)) {
      p.partIds = pickAllParts(key, 'linkedin');
      p.partsKey = key;
    }
    renderMessageText();
    return;
  }

  // Instagram — the first message comes from the active account's assigned
  // Messaging sequence (Settings → Messaging sequences): a uniform-random
  // pick among up to 4 opening-line variants, for A/B testing. Picked once
  // per profile and cached (p.openerId) so revisiting the same lead mid-
  // session doesn't re-roll the wording out from under you — the exact
  // caching approach p.template/p.partIds used before this system replaced
  // the old category logic. decide() sends p.openerId along with the
  // phase1-entry PATCH so which variant this lead got is a permanent record.
  const seq = messageSequenceForAccount(findIgAccount(state.igAccountId));
  const openers = seq && seq.openers && seq.openers.length ? seq.openers : null;
  if (openers && (!p.openerId || !openers.some(o => o.id === p.openerId))) {
    p.openerId = openers[randomInt(0, openers.length - 1)].id;
    p.resolvedOpenerTemplate = null; // a new opener was just picked — needs a fresh spintax roll
  } else if (!openers) {
    p.openerId = null;
    p.resolvedOpenerTemplate = null;
  }
  const opener = openers && p.openerId ? openers.find(o => o.id === p.openerId) : null;
  // Spintax ({option1|option2|...} — see Messaging sequences' opener editor)
  // resolves once per opener pick, not on every render, so the specific
  // wording a lead ends up with stays fixed while paging back and forth —
  // same reasoning p.openerId itself is cached for. {naam}/{views}/{months}
  // placeholders resolve fresh every render on top of that (so editing the
  // name field still live-updates the message), via renderTemplateString.
  // Also re-resolves if the opener's own raw text changed since the cached
  // resolve — PUT /api/message-sequences/:id/openers updates a kept variant
  // in place (same id, new text) so leads already assigned it stay correctly
  // attributed, which means an id match alone doesn't mean "still the same
  // wording": a session quit-saved before an in-place wording edit (or a
  // sequence swap that happens to reuse an id) would otherwise keep showing
  // the pre-edit text forever once resumed.
  if (opener && (p.resolvedOpenerTemplate == null || p.resolvedOpenerSourceText !== opener.text)) {
    p.resolvedOpenerTemplate = resolveSpintax(opener.text);
    p.resolvedOpenerSourceText = opener.text;
  }
  const text = opener ? renderTemplateString(p.resolvedOpenerTemplate, buildPlaceholders(p)) : '';
  p.message = text;
  $('#f-message').value = text;
  $('#dm-link').href = leadDmUrl(p);
  saveSession();
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
  const templates = templatesFor(p.platform);
  const parts = templates[key] && templates[key].parts;
  // Guards against TEMPLATES_LINKEDIN still being {} if loadTemplatesFromServer()
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

  // Hidden for LinkedIn (see renderProfile) — nothing to point it at anyway.
  if (p.platform !== 'linkedin') {
    $('#dm-link').href = leadDmUrl(p);
  }
  saveSession();
}

// field listeners -> keep state + message in sync
['f-bio', 'f-followers', 'f-headline'].forEach(id => {
  $(`#${id}`).addEventListener('input', syncFieldsToState);
});
// naam placeholder in the message depends on these two, so re-render the message text
['f-fullname', 'f-username'].forEach(id => {
  $(`#${id}`).addEventListener('input', () => { syncFieldsToState(); updateMessage(); });
});
// {months} in a message depends on lastPostWeeks — postsPerWeek/avgViews no
// longer feed any placeholder (they used to only feed the now-removed
// category suggestion) but stay as plain lead metadata, still worth tracking
// even though nothing recomposes from them anymore.
$('#f-lastpost').addEventListener('input', () => { syncFieldsToState(); updateMessage(); });
$('#f-postsperweek').addEventListener('input', syncFieldsToState);
$('#f-avgviews').addEventListener('input', syncFieldsToState);
$('#f-message').addEventListener('input', () => { currentProfile().message = $('#f-message').value; saveSession(); });

function syncFieldsToState() {
  const p = currentProfile();
  if (!p) return;
  p.fullName = $('#f-fullname').value;
  p.username = $('#f-username').value;
  p.headline = $('#f-headline').value;
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

// Resolves the name to put in the video without assuming p is the profile
// currently on screen — batch/preload rendering calls this for profiles
// that have never been displayed yet, so their p.videoName is still empty
// (that only gets seeded by renderVideoSection when a profile is actually
// shown). Falls back to the same auto-detected first name the message's
// {naam} placeholder uses.
function resolveVideoName(p) {
  if (p === currentProfile()) {
    const live = $('#f-video-name').value.trim();
    if (live) return live;
  }
  if (p.videoName && p.videoName.trim()) return p.videoName.trim();
  return (buildPlaceholders(p).naam || '').trim();
}

async function renderVideoForProfile(p) {
  const name = resolveVideoName(p);
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

// Rough warm-instance average with the current preset — used only for the
// up-front estimate shown before any real timing data exists. A cold start
// (ffmpeg binary re-download) runs well past this; the estimate corrects
// itself using actual elapsed time as soon as the first video finishes.
const ASSUMED_SECONDS_PER_VIDEO = 8;

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function openFirstProfileTab() {
  const first = state.profiles[0];
  if (first) openProfileTab(first.profileUrl);
}

// Opens the first profile's tab and moves into the dashboard — called only
// from a direct click (either "Skip waiting" mid-render or "GO!" once
// rendering's done), never automatically. A `window.open` call outside a
// fresh, direct user gesture like this either gets popup-blocked or (if
// pre-opened as a blank placeholder) is itself premature visible tab
// activity the user didn't ask for yet — both tried before this and both
// were wrong. A real click sidesteps the problem entirely.
function enterDashboard() {
  videoPreloadSkipped = true;
  openFirstProfileTab();
  showView('dashboard');
  renderProfile();
}

async function preloadSessionVideos() {
  // Video is a per-Messaging-sequence choice (the "with/without video"
  // toggle next to the opener variants) — a session whose assigned account's
  // sequence has it off (or a LinkedIn session, which never has video at
  // all — see the isLinkedin check in renderProfile) has nothing to
  // preload, full stop, regardless of what leads are in the queue.
  const seq = messageSequenceForAccount(findIgAccount(state.igAccountId));
  const videoEnabled = !!(seq && seq.firstMessageHasVideo);
  const targets = videoEnabled
    ? state.profiles.filter(p => p.leadId && p.platform === 'instagram' && p.videoStatus !== 'done' && p.videoStatus !== 'rendering')
    : [];
  if (targets.length === 0) {
    // Nothing to wait for — same fast path as before this feature existed,
    // no button needed since there's no rendering delay to protect against.
    openFirstProfileTab();
    showView('dashboard');
    renderProfile();
    return;
  }

  videoPreloadSkipped = false;
  showView('video-preload');
  const fillEl = $('#preload-progress-fill');
  const textEl = $('#preload-progress-text');
  const etaEl = $('#preload-eta-text');
  const continueBtn = $('#preload-continue-btn');
  fillEl.style.width = '0%';
  textEl.textContent = `Generating 0/${targets.length}`;
  continueBtn.textContent = 'Skip waiting →';
  continueBtn.classList.remove('btn-primary');
  continueBtn.classList.add('btn-secondary');
  const initialEstimateSec = Math.ceil((targets.length / VIDEO_BATCH_CONCURRENCY) * ASSUMED_SECONDS_PER_VIDEO);
  etaEl.textContent = `Estimated time: about ${formatDuration(initialEstimateSec)}`;

  const batchStart = Date.now();
  await renderVideoBatch(targets, (done, failed, total) => {
    const completed = done + failed;
    fillEl.style.width = `${Math.round((completed / total) * 100)}%`;
    textEl.textContent = `Generating ${completed}/${total}`;

    const remainingCount = total - completed;
    if (completed > 0 && remainingCount > 0) {
      // Replaces the up-front guess with a live estimate from actual timing
      // once there's real data to base it on. elapsed/completed is already
      // a concurrency-adjusted rate (with 4 running in parallel, 4
      // completions land in ~1 video's worth of wall-clock time, not 4x
      // that) — dividing by VIDEO_BATCH_CONCURRENCY again here was double
      // counting it, shrinking the estimate down to roughly a single
      // video's render time instead of the true remaining total.
      const secPerCompletionWallClock = (Date.now() - batchStart) / 1000 / completed;
      const remainingSec = secPerCompletionWallClock * remainingCount;
      etaEl.textContent = `About ${formatDuration(remainingSec)} left`;
    }
  });

  // Already left via "Skip waiting" — don't yank them back or overwrite a
  // button they're not looking at anymore (possibly a different session
  // entirely by now).
  if (videoPreloadSkipped) return;

  etaEl.textContent = 'All done.';
  continueBtn.textContent = '✅ GO! →';
  continueBtn.classList.remove('btn-secondary');
  continueBtn.classList.add('btn-primary');
}

$('#preload-continue-btn').addEventListener('click', enterDashboard);

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
  let hitAccountLimit = false;
  if (status !== 'cant_message') {
    try {
      const outreachData = await fetchJson('/api/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: p.platform,
          accountId: p.platform === 'instagram' ? state.igAccountId : null,
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
      // Server returns the account's live today-count in the same response —
      // no second round-trip just to check whether this send hit the cap.
      if (outreachData.accountTodaySentCount !== null && outreachData.accountTodaySentCount !== undefined) {
        state.igAccountTodaySentCount = outreachData.accountTodaySentCount;
        const account = findIgAccount(state.igAccountId);
        if (account && state.igAccountTodaySentCount >= account.dailyLimit) hitAccountLimit = true;
      }
    } catch (e) {
      console.error('Could not save outreach', e);
      alert(`This one didn't save to your analytics (${e.message}). The decision still went through locally — you may want to note it down.`);
    }
  }

  // In-session pacing — only real Instagram sends count (matches what an
  // outside observer would actually see as DM activity), not disqualifies or
  // "can't message" decisions. Walks the active account's assigned Timing
  // sequence's pacing-block pattern (send N, pause, send N, pause...),
  // looping once it reaches the end. No account/sequence/blocks assigned
  // (e.g. a misconfigured sequence, or somehow no account at all) just means
  // no pacing gets enforced rather than a broken session.
  let needsPacingBreak = false;
  if (status === 'sent' && p.platform === 'instagram') {
    const pacingBlocks = pacingBlocksForAccount(findIgAccount(state.igAccountId));
    if (pacingBlocks.length > 0) {
      const sendIdx = pacingBlocks[state.pacingBlockIndex]?.blockType === 'send'
        ? state.pacingBlockIndex
        : findNextBlockOfType(pacingBlocks, state.pacingBlockIndex, 'send');
      if (sendIdx !== -1) {
        state.pacingBlockIndex = sendIdx;
        if (state.currentBlockThreshold == null) {
          const block = pacingBlocks[sendIdx];
          state.currentBlockThreshold = randomInt(block.minValue, block.maxValue);
        }
        state.sendsInCurrentBlock++;
        if (state.sendsInCurrentBlock >= state.currentBlockThreshold) {
          const pauseIdx = findNextBlockOfType(pacingBlocks, sendIdx + 1, 'pause');
          state.sendsInCurrentBlock = 0;
          state.currentBlockThreshold = null;
          if (pauseIdx !== -1) {
            needsPacingBreak = true;
            state.activePauseBlockIndex = pauseIdx;
            const nextSendIdx = findNextBlockOfType(pacingBlocks, pauseIdx + 1, 'send');
            state.pacingBlockIndex = nextSendIdx !== -1 ? nextSendIdx : sendIdx;
          }
        }
      }
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
          headline: p.headline,
          bio: p.bio,
          followers: p.followers,
          stage: 'phase1',
          accountId: p.platform === 'instagram' ? state.igAccountId : undefined,
          openerId: p.platform === 'instagram' ? p.openerId : undefined
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
    platform: p.platform,
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
        body: JSON.stringify({ count: 1, excludeIds, platform: p.platform })
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

  // Takes priority over everything below — even if the goal was also just
  // reached, or this was the last queued profile, the account being maxed
  // out for the day is the more urgent fact to surface.
  if (hitAccountLimit) {
    showIgAccountLimitPause();
    return;
  }

  // Lower priority than the account limit (a maxed-out account is the more
  // urgent fact either way) but still ahead of the normal end-of-session
  // branching — a pacing break can land on what would otherwise have been
  // the very last profile too.
  if (needsPacingBreak) {
    showSendPacingBreak();
    return;
  }

  const goalReached = state.sessionMode === 'goal' && state.sentCount >= state.sessionTarget;
  const hasNext = state.index < state.profiles.length - 1;
  if (!goalReached && hasNext) {
    state.index++;
    renderProfile();
  } else if (shouldForceEndOfSessionBreak()) {
    // The session's about to end without ever having naturally hit the
    // pacing pattern's send-block threshold — force one pause in before it
    // actually ends, so a low-volume session (warming up, a small daily
    // goal) still gets at least one "go be a real person" gap.
    state.pacingBreakIsFinal = true;
    showSendPacingBreak();
  } else {
    finishInstagramPortion();
  }
}

// What decide() does once the Instagram portion of a session is truly done
// (goal reached, ran out of leads, and — if guaranteeMinOnePause applies —
// the forced final break already happened). Also what a forced final
// break's own "Continue" click falls through to, instead of resuming the
// next lead like a mid-session break does.
async function finishInstagramPortion() {
  // A daily-goal leg that reached its own target (not one that simply ran
  // dry — switching accounts wouldn't conjure up more leads) may still have
  // more of today's combined Instagram goal left to send, from a different
  // account. liRemaining is always 0 here: a combi session's LinkedIn half,
  // if any, is already sitting untouched in state.combi.liLeads and only
  // gets picked up once Instagram is *truly* done (goal met, or no account
  // left that can send) — never re-derived at each handoff.
  if (state.isDailyGoal && state.sessionKind === 'ig_message' && !state.outOfLeads) {
    try {
      const handled = await beginOrContinueDailyGoalIg(0, true);
      if (handled) return;
    } catch (e) {
      alert(`Could not start the next account's session: ${e.message}`);
    }
  }
  if (state.combi && state.sessionKind === 'ig_message') {
    // Instagram portion of a combi session just ended (goal reached, or ran
    // out of Instagram leads) — the LinkedIn batch is already fetched and
    // waiting in state.combi.liLeads (see startCombiSession).
    showCombiInterstitial();
  } else {
    showEndScreen();
  }
}

// "Always include at least one scroll break" (a Timing sequence setting) —
// only forces one if this specific session had real sends to begin with
// (nothing to "act human" around otherwise), the active account's sequence
// actually has the setting on, no pause (natural or forced) has already
// happened this session, and there's actually a pause block in the pattern
// to use.
function shouldForceEndOfSessionBreak() {
  if (state.sessionKind !== 'ig_message' || state.hadPacingBreakThisSession || state.sentCount === 0) return false;
  const seq = timingSequenceForAccount(findIgAccount(state.igAccountId));
  if (!seq || !seq.guaranteeMinOnePause) return false;
  const pauseIdx = findNextBlockOfType(seq.pacingBlocks, 0, 'pause');
  if (pauseIdx === -1) return false;
  state.activePauseBlockIndex = pauseIdx;
  return true;
}

$('#accept-btn').addEventListener('click', () => decide('sent'));
$('#reject-btn').addEventListener('click', () => decide('not_qualified'));
$('#next-unreachable-btn').addEventListener('click', () => decide('cant_message'));

// ---------- END SCREEN ----------
function showEndScreen(opts = {}) {
  const sent = state.results.filter(r => r.status === 'sent');
  const rejected = state.results.filter(r => r.status === 'not_qualified');
  const cantMessage = state.results.filter(r => r.status === 'cant_message');

  clearSession();
  $('#progress-fill').style.width = '100%';
  $('#end-sent-count').textContent = sent.length;
  $('#end-rejected-count').textContent = rejected.length;
  $('#end-cant-message-count').textContent = cantMessage.length;

  let lines;
  if (opts.combiLinkedInSaved) {
    lines = [
      `Instagram portion done — ${sent.length} message${sent.length === 1 ? '' : 's'} sent.`,
      `Your LinkedIn leads are saved — pick them up anytime from Saved Sessions.`
    ];
  } else if (opts.savedForLater) {
    lines = [
      `Here's what you got through before quitting — ${state.results.length} profile${state.results.length === 1 ? '' : 's'} decided.`,
      `The rest of this session is saved — pick it up anytime from Saved Sessions.`
    ];
  } else if (state.sessionMode === 'goal' && state.sentCount >= state.sessionTarget) {
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
    ? sent.map(r => {
        // Instagram no longer has a template category to show (one fixed
        // first message per Messaging sequence now) — only LinkedIn still
        // has a label worth surfacing here.
        const templateLabel = r.platform === 'linkedin' ? (templatesFor('linkedin')[r.template]?.label || r.template) : null;
        return `<li><strong>${escapeHtml(leadDisplayName(r))}</strong> ${r.fullName && r.platform !== 'linkedin' ? `(${escapeHtml(r.fullName)})` : ''}${templateLabel ? ` — ${escapeHtml(templateLabel)}` : ''}</li>`;
      }).join('')
    : '<li class="muted">None</li>';

  const rejList = $('#end-rejected-list');
  rejList.innerHTML = rejected.length
    ? rejected.map(r => `<li><strong>${escapeHtml(leadDisplayName(r))}</strong> ${r.fullName && r.platform !== 'linkedin' ? `(${escapeHtml(r.fullName)})` : ''}</li>`).join('')
    : '<li class="muted">None</li>';

  const cantMessageList = $('#end-cant-message-list');
  cantMessageList.innerHTML = cantMessage.length
    ? cantMessage.map(r => `<li><strong>${escapeHtml(leadDisplayName(r))}</strong> ${r.fullName && r.platform !== 'linkedin' ? `(${escapeHtml(r.fullName)})` : ''}</li>`).join('')
    : '<li class="muted">None</li>';

  showView('end');
}

// ---------- COMBI INTERSTITIAL ----------
// Shown once the Instagram half of a combi session ends (goal reached or ran
// out of Instagram leads) — the LinkedIn batch is already sitting fetched in
// state.combi.liLeads, waiting for one of these two choices.
function showCombiInterstitial() {
  const liCount = state.combi.liLeads.length;
  $('#combi-interstitial-summary').textContent =
    `${state.sentCount} sent on Instagram. ${liCount} LinkedIn lead${liCount === 1 ? '' : 's'} ready to go whenever you are.`;
  showView('combi-interstitial');
}

$('#combi-continue-li-btn').addEventListener('click', () => {
  const liProfiles = state.combi.liLeads; // already profile-shaped — see startCombiSession
  const target = liProfiles.length;
  // Captured before beginSessionWithLeads resets state.isDailyGoal — a
  // daily-goal combi session's LinkedIn half is still part of that same goal.
  const wasDailyGoal = state.isDailyGoal;
  state.combi = null;
  beginSessionWithLeads(liProfiles, { mode: 'goal', target, kind: 'li_engagement', alreadyProfiles: true, isDailyGoal: wasDailyGoal });
});

$('#combi-save-li-btn').addEventListener('click', async () => {
  const btn = $('#combi-save-li-btn');
  btn.disabled = true;
  try {
    await fetchJson('/api/saved-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKind: 'li_engagement',
        sessionMode: 'goal',
        sessionTarget: state.combi.liLeads.length,
        sentCount: 0,
        results: [],
        remainingProfiles: state.combi.liLeads,
        isDailyGoal: state.isDailyGoal
      })
    });
  } catch (e) {
    btn.disabled = false;
    alert(`Could not save the LinkedIn leads for later (${e.message}). Try again.`);
    return;
  }
  state.combi = null;
  btn.disabled = false;
  showEndScreen({ combiLinkedInSaved: true });
});

// ---------- IG account daily-limit pause + switch cooldown ----------

const IG_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// The single source of truth for "is Instagram blocked from starting a new
// session right now" — populated by loadNotifications() (followups.js)
// piggybacking on the /api/notifications call every view change already
// makes, not a separate poll.
let igCooldownState = null;
let igCooldownBannerInterval = null;

function isIgCooldownActive() {
  return !!(igCooldownState && !igCooldownState.expired);
}

function renderIgCooldownBanner() {
  const banner = $('#ig-cooldown-banner');
  clearInterval(igCooldownBannerInterval);
  if (!igCooldownState) {
    banner.classList.add('hidden');
    document.body.classList.remove('has-ig-cooldown-banner');
    return;
  }
  banner.classList.remove('hidden');
  document.body.classList.add('has-ig-cooldown-banner');
  const continueBtn = $('#ig-cooldown-banner-continue-btn');
  const username = igCooldownState.accountUsername || 'your account';

  function tick() {
    const remaining = new Date(igCooldownState.until).getTime() - Date.now();
    if (remaining <= 0) {
      $('#ig-cooldown-banner-text').textContent = `✅ Ready to continue with @${username}`;
      continueBtn.classList.remove('hidden');
      clearInterval(igCooldownBannerInterval);
    } else {
      $('#ig-cooldown-banner-text').textContent = `⏳ Switching Instagram accounts — @${username} ready in ${formatCountdown(remaining)}`;
      continueBtn.classList.add('hidden');
    }
  }
  tick();
  igCooldownBannerInterval = setInterval(tick, 1000);
}

async function resumeIgCooldownSession(savedSessionId) {
  try {
    const data = await fetchJson('/api/saved-sessions');
    const session = (data.sessions || []).find(s => s.id === savedSessionId);
    if (!session) {
      alert("Could not find that saved session — it may already have been resumed elsewhere.");
      return;
    }
    resumeSavedSession(session);
  } catch (e) {
    alert(`Could not resume: ${e.message}`);
  }
}

$('#ig-cooldown-banner-continue-btn').addEventListener('click', () => {
  if (igCooldownState && igCooldownState.savedSessionId) resumeIgCooldownSession(igCooldownState.savedSessionId);
});

$('#ig-cooldown-banner-skip-btn').addEventListener('click', () => {
  if (!confirm('Skipping this makes account-switching look automated — Instagram may notice the pattern. Skip anyway?')) return;
  if (igCooldownState && igCooldownState.savedSessionId) resumeIgCooldownSession(igCooldownState.savedSessionId);
});

// Shown instead of the normal goalReached/hasNext/combi-interstitial/
// end-screen branch in decide() once an Instagram send pushes the active
// account to its daily cap.
function showIgAccountLimitPause() {
  const account = findIgAccount(state.igAccountId);
  const username = account ? account.username : (state.igAccountUsername || 'This account');
  const limit = account ? account.dailyLimit : state.igAccountTodaySentCount;
  $('#ig-limit-title').textContent = 'Daily limit reached';
  $('#ig-limit-summary').textContent = `@${username} has hit its ${limit}/day limit. Pick a different account to keep going.`;
  $('#ig-limit-picker-card').classList.remove('hidden');
  $('#ig-limit-cooldown-card').classList.add('hidden');
  $('#ig-limit-continue-li-btn').classList.toggle('hidden', !state.combi);

  $('#ig-limit-continue-btn').disabled = true;
  loadIgAccounts(true).then(accounts => {
    const select = $('#ig-limit-account-select');
    const usable = populateAccountSelect(select, accounts, [state.igAccountId]);
    $('#ig-limit-no-accounts').classList.toggle('hidden', usable.length > 0);
    select.classList.toggle('hidden', usable.length === 0);
    const errorEl = $('#ig-limit-account-error');
    if (usable.length === 0) {
      errorEl.classList.add('hidden');
      return;
    }
    applyAccountSelectionValidation(select, $('#ig-limit-continue-btn'), errorEl);
  });

  showView('ig-account-limit');
}

$('#ig-limit-account-select').addEventListener('change', () => {
  applyAccountSelectionValidation($('#ig-limit-account-select'), $('#ig-limit-continue-btn'), $('#ig-limit-account-error'));
});

let igLimitCountdownInterval = null;
function startIgLimitCountdown() {
  clearInterval(igLimitCountdownInterval);
  function tick() {
    const remaining = state.igCooldownUntil - Date.now();
    if (remaining <= 0) {
      clearInterval(igLimitCountdownInterval);
      $('#ig-limit-countdown').textContent = 'Ready!';
      return;
    }
    $('#ig-limit-countdown').textContent = formatCountdown(remaining);
  }
  tick();
  igLimitCountdownInterval = setInterval(tick, 1000);
}

$('#ig-limit-continue-btn').addEventListener('click', () => {
  const newAccountId = $('#ig-limit-account-select').value;
  if (!newAccountId) return;
  const account = findIgAccount(newAccountId);
  state.igAccountId = newAccountId;
  state.igAccountUsername = account ? account.username : null;
  state.igAccountTodaySentCount = account ? account.todaySentCount : 0;
  state.igCooldownUntil = Date.now() + IG_COOLDOWN_MS;
  state.igCooldownAccountId = newAccountId;
  // A different account may have a different (or no) Timing sequence
  // assigned — its pacing pattern is independent, so progress against the
  // old account's blocks doesn't carry over.
  state.pacingBlockIndex = 0;
  state.sendsInCurrentBlock = 0;
  state.currentBlockThreshold = null;
  saveSession();

  $('#ig-limit-title').textContent = 'Switching accounts';
  $('#ig-limit-summary').textContent = `Ready to continue with @${state.igAccountUsername}.`;
  $('#ig-limit-picker-card').classList.add('hidden');
  $('#ig-limit-cooldown-card').classList.remove('hidden');
  startIgLimitCountdown();
});

// Bypasses the cooldown entirely — the account-limit system is Instagram-
// only, so a mid-combi pause doesn't need to hold the LinkedIn half hostage.
$('#ig-limit-continue-li-btn').addEventListener('click', () => {
  const liProfiles = state.combi.liLeads;
  const target = liProfiles.length;
  const wasDailyGoal = state.isDailyGoal;
  state.combi = null;
  beginSessionWithLeads(liProfiles, { mode: 'goal', target, kind: 'li_engagement', alreadyProfiles: true, isDailyGoal: wasDailyGoal });
});

$('#ig-limit-skip-btn').addEventListener('click', () => {
  if (!confirm('Skipping this makes account-switching look automated — Instagram may notice the pattern. Skip anyway?')) return;
  clearInterval(igLimitCountdownInterval);
  state.igCooldownUntil = null;
  state.igCooldownAccountId = null;
  saveSession();
  showView('dashboard');
  renderProfile();
});

$('#ig-limit-home-btn').addEventListener('click', async () => {
  const btn = $('#ig-limit-home-btn');
  btn.disabled = true;
  const remainingProfiles = state.combi
    ? state.profiles.slice(state.index).map(p => ({ ...p, sessionKind: 'ig_message' }))
        .concat(state.combi.liLeads.map(p => ({ ...p, sessionKind: 'li_engagement' })))
    : state.profiles.slice(state.index);
  try {
    await fetchJson('/api/saved-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKind: state.combi ? 'combi' : state.sessionKind,
        sessionMode: state.sessionMode,
        sessionTarget: state.sessionTarget,
        sentCount: state.sentCount,
        results: state.results,
        remainingProfiles,
        isDailyGoal: state.isDailyGoal,
        igCooldownUntil: new Date(state.igCooldownUntil).toISOString(),
        igCooldownAccountId: state.igCooldownAccountId
      })
    });
  } catch (e) {
    btn.disabled = false;
    alert(`Could not save the session (${e.message}). Nothing was lost — you're still where you were, try again.`);
    return;
  }
  clearInterval(igLimitCountdownInterval);
  resetSessionState();
  clearSession();
  showView('home');
  loadNotifications();
});

// ---------- Send pacing break (Instagram only) ----------

let pacingBreakCountdownInterval = null;

// The active pause block's own label/message/range drives this screen —
// falls back to generic copy if a block somehow has neither set (a bare
// "pause" block with no custom text).
function activePauseBlock() {
  const blocks = pacingBlocksForAccount(findIgAccount(state.igAccountId));
  return state.activePauseBlockIndex != null ? blocks[state.activePauseBlockIndex] : null;
}

function showSendPacingBreak() {
  state.hadPacingBreakThisSession = true;
  const block = activePauseBlock();
  const minutes = block ? randomInt(block.minValue, block.maxValue) : randomInt(8, 12);
  state.pacingBreakUntil = Date.now() + minutes * 60 * 1000;
  saveSession();
  showView('send-pacing-break');
  startPacingBreakCountdown();
}

function startPacingBreakCountdown() {
  clearInterval(pacingBreakCountdownInterval);
  const continueBtn = $('#pacing-break-continue-btn');
  const block = activePauseBlock();
  function tick() {
    const remaining = state.pacingBreakUntil - Date.now();
    if (remaining <= 0) {
      clearInterval(pacingBreakCountdownInterval);
      $('#pacing-break-countdown').textContent = 'Ready!';
      $('#pacing-break-status').textContent = "Whenever you're ready — hit continue.";
      continueBtn.classList.remove('hidden');
    } else {
      $('#pacing-break-countdown').textContent = formatCountdown(remaining);
    }
  }
  continueBtn.classList.add('hidden');
  $('#pacing-break-title').textContent = (block && block.label) ? block.label : 'Take a quick break';
  $('#pacing-break-status').textContent = (block && block.message)
    ? block.message
    : 'Go scroll your feed, check a few stories, like a couple posts — anything that isn\'t sending another DM.';
  tick();
  pacingBreakCountdownInterval = setInterval(tick, 1000);
}

$('#pacing-break-continue-btn').addEventListener('click', () => {
  clearInterval(pacingBreakCountdownInterval);
  state.pacingBreakUntil = null;
  const wasFinal = state.pacingBreakIsFinal;
  state.pacingBreakIsFinal = false;
  saveSession();
  if (wasFinal) {
    // This was the forced "guarantee at least one break" pause at the very
    // end of the session (see shouldForceEndOfSessionBreak) — there's no
    // next lead to resume to, finish the session the same way decide()
    // would have if the break hadn't been needed.
    finishInstagramPortion();
  } else {
    showView('dashboard');
    renderProfile();
  }
});

$('#pacing-break-home-btn').addEventListener('click', async () => {
  const btn = $('#pacing-break-home-btn');
  btn.disabled = true;
  const remainingProfiles = state.combi
    ? state.profiles.slice(state.index).map(p => ({ ...p, sessionKind: 'ig_message' }))
        .concat(state.combi.liLeads.map(p => ({ ...p, sessionKind: 'li_engagement' })))
    : state.profiles.slice(state.index);
  try {
    await fetchJson('/api/saved-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKind: state.combi ? 'combi' : state.sessionKind,
        sessionMode: state.sessionMode,
        sessionTarget: state.sessionTarget,
        sentCount: state.sentCount,
        results: state.results,
        remainingProfiles,
        isDailyGoal: state.isDailyGoal,
        igCooldownAccountId: state.igAccountId || null
      })
    });
  } catch (e) {
    btn.disabled = false;
    alert(`Could not save the session (${e.message}). Nothing was lost — you're still where you were, try again.`);
    return;
  }
  clearInterval(pacingBreakCountdownInterval);
  resetSessionState();
  clearSession();
  btn.disabled = false;
  showView('home');
  loadNotifications();
});

// ---------- Warmup engagement session (scroll & engage, warmup-phase accounts only) ----------
//
// Deliberately isolated from the big lead-swiping `state` object (like
// igCooldownState/pacingBreakCountdownInterval above) — this is a standalone
// per-task timer, not a session over a list of leads. Time genuinely accrues
// server-side (accumulated_seconds + now-run_started_at), so there's no need
// to keep a background ticker running once you navigate away — reopening the
// notification just re-fetches the current computed state.

let warmupEngageState = { taskId: null };
let warmupEngageTickerInterval = null;

async function openWarmupEngageSession(taskId) {
  warmupEngageState.taskId = taskId;
  showView('warmup-engage');
  try {
    const task = await fetchJson(`/api/warmup-tasks/${taskId}`);
    renderWarmupEngageTask(task);
  } catch (e) {
    alert(`Could not load that session: ${e.message}`);
    showView('home');
  }
}

function renderWarmupEngageTask(task) {
  clearInterval(warmupEngageTickerInterval);
  $('#warmup-engage-title').textContent = `Scroll & engage — @${task.accountUsername}`;
  const startBtn = $('#warmup-engage-start-btn');
  const pauseBtn = $('#warmup-engage-pause-btn');
  const doneEl = $('#warmup-engage-done');
  const countdownEl = $('#warmup-engage-countdown');

  if (task.completed) {
    countdownEl.textContent = '';
    startBtn.classList.add('hidden');
    pauseBtn.classList.add('hidden');
    doneEl.classList.remove('hidden');
    return;
  }
  doneEl.classList.add('hidden');

  if (task.running) {
    startBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    startWarmupEngageTicker(task);
  } else {
    pauseBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
    startBtn.textContent = task.elapsedSeconds > 0 ? 'Resume scrolling session →' : 'Start scrolling session →';
    countdownEl.textContent = formatCountdown((task.targetSeconds - task.elapsedSeconds) * 1000);
  }
}

function startWarmupEngageTicker(task) {
  clearInterval(warmupEngageTickerInterval);
  const deadline = Date.now() + (task.targetSeconds - task.elapsedSeconds) * 1000;
  const countdownEl = $('#warmup-engage-countdown');
  function tick() {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      clearInterval(warmupEngageTickerInterval);
      countdownEl.textContent = 'Done!';
      fetchJson(`/api/warmup-tasks/${warmupEngageState.taskId}/pause`, { method: 'POST' })
        .then(renderWarmupEngageTask)
        .catch(() => {});
      return;
    }
    countdownEl.textContent = formatCountdown(remaining);
  }
  tick();
  warmupEngageTickerInterval = setInterval(tick, 1000);
}

$('#warmup-engage-start-btn').addEventListener('click', async () => {
  const btn = $('#warmup-engage-start-btn');
  btn.disabled = true;
  try {
    const task = await fetchJson(`/api/warmup-tasks/${warmupEngageState.taskId}/start`, { method: 'POST' });
    renderWarmupEngageTask(task);
  } catch (e) {
    alert(`Could not start: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#warmup-engage-pause-btn').addEventListener('click', async () => {
  const btn = $('#warmup-engage-pause-btn');
  btn.disabled = true;
  clearInterval(warmupEngageTickerInterval);
  try {
    const task = await fetchJson(`/api/warmup-tasks/${warmupEngageState.taskId}/pause`, { method: 'POST' });
    renderWarmupEngageTask(task);
  } catch (e) {
    alert(`Could not pause: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#warmup-engage-home-btn').addEventListener('click', () => {
  // Deliberately doesn't pause — if it's running, it keeps genuinely
  // accruing server-side while you're away, same as actually going to
  // scroll Instagram in another tab.
  clearInterval(warmupEngageTickerInterval);
  showView('home');
  loadNotifications();
});

function resetSessionState() {
  state.profiles = [];
  state.results = [];
  state.index = 0;
  state.sessionKind = 'ig_message';
  state.sessionMode = 'fixed';
  state.sessionTarget = null;
  state.sentCount = 0;
  state.outOfLeads = false;
  state.combi = null;
  state.isDailyGoal = false;
  state.igAccountId = null;
  state.igAccountUsername = null;
  state.igAccountTodaySentCount = 0;
  state.igCooldownUntil = null;
  state.igCooldownAccountId = null;
  state.pacingBlockIndex = 0;
  state.sendsInCurrentBlock = 0;
  state.currentBlockThreshold = null;
  state.pacingBreakUntil = null;
  state.activePauseBlockIndex = null;
  state.hadPacingBreakThisSession = false;
  state.pacingBreakIsFinal = false;
}

$('#back-home-btn').addEventListener('click', () => {
  resetSessionState();
  showView('home');
});

// ---------- QUIT & SAVE ----------

// Persists whatever's left of the active Instagram-dashboard session,
// combi-aware (bundling any untouched LinkedIn batch in alongside it) — used
// by #quit-save-btn itself, a genuine exit where nothing keeps running.
// NOT used by the "Switch accounts" flow below: that flow keeps one half of
// a combi live (either the new Instagram account, or LinkedIn) while only
// the OTHER half gets parked, so it needs savePartialInstagramLeg's
// narrower, non-bundling save instead — bundling here too would let the
// still-live half get resumed a second time later and worked twice.
async function saveCurrentDashboardLeg() {
  // Mid-combi, "remaining" spans two different session kinds: whatever's
  // left of the Instagram portion, plus the LinkedIn batch that hasn't
  // started at all yet. Each profile is tagged with its own sessionKind so
  // resumeSavedSession can split them back apart later — see the 'combi'
  // branch there.
  const remainingProfiles = state.combi
    ? state.profiles.slice(state.index).map(p => ({ ...p, sessionKind: 'ig_message' }))
        .concat(state.combi.liLeads.map(p => ({ ...p, sessionKind: 'li_engagement' }))) // already profile-shaped — see startCombiSession
    : state.profiles.slice(state.index);
  if (remainingProfiles.length === 0) return { saved: false };
  await fetchJson('/api/saved-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionKind: state.combi ? 'combi' : state.sessionKind,
      sessionMode: state.sessionMode,
      sessionTarget: state.sessionTarget,
      sentCount: state.sentCount,
      results: state.results,
      remainingProfiles,
      isDailyGoal: state.isDailyGoal,
      // Doubles as "resume with this account" even without an actual
      // cooldown — see resumeSavedSession, which passes it straight
      // through to enterResumedSession either way.
      igCooldownAccountId: state.igAccountId || null
    })
  });
  return { saved: true };
}

// Used by "Switch accounts" when leaving the Instagram dashboard (to
// another Instagram account, or to LinkedIn) — only the not-yet-decided
// Instagram leads for the account being left, never bundled with
// state.combi.liLeads, since that batch is about to keep going (either
// carried over into the new account's leg, or started live as its own
// LinkedIn session) rather than being parked too.
async function savePartialInstagramLeg() {
  const remainingProfiles = state.profiles.slice(state.index);
  if (remainingProfiles.length === 0) return { saved: false };
  await fetchJson('/api/saved-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionKind: 'ig_message',
      sessionMode: state.sessionMode,
      sessionTarget: state.sessionTarget,
      sentCount: state.sentCount,
      results: state.results,
      remainingProfiles,
      isDailyGoal: state.isDailyGoal,
      igCooldownAccountId: state.igAccountId || null
    })
  });
  return { saved: true };
}

$('#quit-save-btn').addEventListener('click', async () => {
  // Nothing decided yet — there's nothing worth saving, and nothing should
  // be touched. Just leave.
  if (state.results.length === 0) {
    resetSessionState();
    clearSession();
    showView('home');
    return;
  }

  const btn = $('#quit-save-btn');
  btn.disabled = true;
  let result;
  try {
    result = await saveCurrentDashboardLeg();
  } catch (e) {
    btn.disabled = false;
    alert(`Could not save the rest of this session (${e.message}). Nothing was lost — you're still where you were, try again.`);
    return;
  }
  btn.disabled = false;
  showEndScreen({ savedForLater: result.saved });
});

// ---------- SIMPLE SESSION (LinkedIn engagement / connection) ----------
// Both kinds share this exact same UI (name + clickable link + two buttons)
// — only the labels and the stage the positive button targets differ. The
// negative button is always a soft-delete, same "not qualified" semantics
// the message-session dashboard already uses.
const SIMPLE_SESSION_CONFIG = {
  li_engagement: { title: 'Engagement session', positiveLabel: '✓ Engaged', negativeLabel: '✕ Not qualified', positiveStage: 'engaged' },
  li_connection: { title: 'Connection session', positiveLabel: '✓ Connected', negativeLabel: '✕ Delete', positiveStage: 'connection_sent' }
};

function currentSimpleConfigFor(kind) {
  return SIMPLE_SESSION_CONFIG[kind] || SIMPLE_SESSION_CONFIG.li_engagement;
}
function currentSimpleConfig() {
  return currentSimpleConfigFor(state.sessionKind);
}

function enterSimpleSession() {
  showView('simple-session');
  renderSimpleSessionProfile();
}

function renderSimpleSessionProfile() {
  const p = currentProfile();
  if (!p) return;
  const cfg = currentSimpleConfig();

  if (state.sessionMode === 'goal') {
    $('#simple-progress-current').textContent = state.sentCount;
    $('#simple-progress-total').textContent = state.sessionTarget;
    $('#simple-progress-fill').style.width = `${Math.min(100, (state.sentCount / state.sessionTarget) * 100)}%`;
  } else {
    $('#simple-progress-current').textContent = state.index + 1;
    $('#simple-progress-total').textContent = state.profiles.length;
    $('#simple-progress-fill').style.width = `${(state.index / state.profiles.length) * 100}%`;
  }

  $('#simple-session-title').textContent = cfg.title;
  $('#simple-session-fullname').textContent = p.fullName || 'Unknown';
  $('#simple-session-link').href = p.profileUrl || '#';
  $('#simple-positive-btn').textContent = cfg.positiveLabel;
  $('#simple-negative-btn').textContent = cfg.negativeLabel;
  updateSwitchAccountsButtonVisibility();
}

async function decideSimple(positive) {
  const p = currentProfile();
  if (!p) return;
  const cfg = currentSimpleConfig();
  const status = positive ? cfg.positiveStage : 'not_qualified';

  const positiveBtn = $('#simple-positive-btn');
  const negativeBtn = $('#simple-negative-btn');
  positiveBtn.disabled = true;
  negativeBtn.disabled = true;

  // Goal mode (Home's "reach N engaged") tops the queue back up on a
  // disqualify the same way the message-session dashboard's decide() does —
  // see the comment there for why the tab-reservation dance isn't needed
  // here (no tab is opened automatically in a simple session at all).
  const sentCountAfterThis = state.sentCount + (positive ? 1 : 0);
  const willNeedTopUp = state.sessionMode === 'goal'
    && state.index >= state.profiles.length - 1
    && sentCountAfterThis < state.sessionTarget;

  if (p.leadId) {
    try {
      if (positive) {
        await fetchJson(`/api/leads/${p.leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: cfg.positiveStage })
        });
      } else {
        await deleteLeads([p.leadId]);
      }
    } catch (e) {
      alert(`Could not save that: ${e.message}`);
      positiveBtn.disabled = false;
      negativeBtn.disabled = false;
      return;
    }
  }
  loadNotifications();

  state.results.push({ platform: p.platform, fullName: p.fullName, profileUrl: p.profileUrl, status });
  if (positive) state.sentCount++;

  if (willNeedTopUp) {
    try {
      const excludeIds = state.profiles.map(pr => pr.leadId).filter(Boolean);
      const data = await fetchJson('/api/leads/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1, excludeIds, platform: p.platform })
      });
      const newLeads = data.leads || [];
      if (newLeads.length > 0) {
        state.profiles.push(leadToProfile(newLeads[0]));
      } else {
        state.outOfLeads = true;
      }
    } catch (e) {
      console.error('Could not fetch more leads to keep this session going', e);
      state.outOfLeads = true;
    }
  }

  positiveBtn.disabled = false;
  negativeBtn.disabled = false;

  const goalReached = state.sessionMode === 'goal' && state.sentCount >= state.sessionTarget;
  const hasNext = state.index < state.profiles.length - 1;
  if (!goalReached && hasNext) {
    state.index++;
    saveSession();
    renderSimpleSessionProfile();
  } else {
    showSimpleSessionEndScreen();
  }
}

$('#simple-positive-btn').addEventListener('click', () => decideSimple(true));
$('#simple-negative-btn').addEventListener('click', () => decideSimple(false));

function showSimpleSessionEndScreen(opts = {}) {
  const cfg = currentSimpleConfig();
  const positive = state.results.filter(r => r.status === cfg.positiveStage);
  const negative = state.results.filter(r => r.status !== cfg.positiveStage);

  clearSession();
  $('#simple-progress-fill').style.width = '100%';
  $('#simple-end-positive-count').textContent = positive.length;
  $('#simple-end-positive-label').textContent = cfg.positiveLabel.replace(/^[^\w]*/, '').toLowerCase();
  $('#simple-end-negative-count').textContent = negative.length;
  $('#simple-end-negative-label').textContent = cfg.negativeLabel.replace(/^[^\w]*/, '').toLowerCase();

  let line;
  if (opts.savedForLater) {
    line = `Here's what you got through before quitting — ${state.results.length} lead${state.results.length === 1 ? '' : 's'} decided. The rest of this session is saved — pick it up anytime from Saved Sessions.`;
  } else if (state.sessionMode === 'goal' && state.sentCount >= state.sessionTarget) {
    line = `Goal reached — ${cfg.positiveLabel.replace(/^[^\w]*/, '').toLowerCase()} ${state.sentCount} of your target ${state.sessionTarget}.`;
  } else if (state.sessionMode === 'goal' && state.outOfLeads) {
    line = `Ran out of available leads before reaching your target — ${cfg.positiveLabel.replace(/^[^\w]*/, '').toLowerCase()} ${state.sentCount} of ${state.sessionTarget}. Import more leads to keep going.`;
  } else {
    line = `You've made it through all ${state.results.length} lead${state.results.length === 1 ? '' : 's'}.`;
  }
  $('#simple-end-summary-line').textContent = line;

  showView('simple-end');
}

// Shared by #simple-quit-save-btn and "Switch accounts" when leaving the
// LinkedIn simple session (always to Instagram — see
// updateSwitchAccountsButtonVisibility, LinkedIn has no further "switch"
// destination of its own).
async function saveCurrentSimpleLeg() {
  const remainingProfiles = state.profiles.slice(state.index);
  if (remainingProfiles.length === 0) return { saved: false };
  await fetchJson('/api/saved-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionKind: state.sessionKind,
      sessionMode: state.sessionMode,
      sessionTarget: state.sessionTarget,
      sentCount: state.sentCount,
      results: state.results,
      remainingProfiles,
      isDailyGoal: state.isDailyGoal
    })
  });
  return { saved: true };
}

$('#simple-quit-save-btn').addEventListener('click', async () => {
  if (state.results.length === 0) {
    resetSessionState();
    clearSession();
    showView('home');
    return;
  }
  const btn = $('#simple-quit-save-btn');
  btn.disabled = true;
  let result;
  try {
    result = await saveCurrentSimpleLeg();
  } catch (e) {
    btn.disabled = false;
    alert(`Could not save the rest of this session (${e.message}). Nothing was lost — you're still where you were, try again.`);
    return;
  }
  btn.disabled = false;
  showSimpleSessionEndScreen({ savedForLater: result.saved });
});

$('#simple-end-back-btn').addEventListener('click', () => {
  resetSessionState();
  showView('home');
});

// ---------- SWITCH ACCOUNTS (mid-session, deliberate — no anti-detection
// cooldown, unlike the reactive "daily limit reached" flow) ----------
// Reachable from both the Instagram dashboard (switch to another due
// Instagram account, or to LinkedIn if this is a combi session) and the
// LinkedIn simple session (switch to a due Instagram account). Whichever
// leg is active gets saved for later first, exactly like "Quit & save"
// already does, so nothing is ever lost.

// account id -> its pending saved_sessions row, refreshed every time the
// modal opens.
let switchAccountsPendingByAccount = {};
// { accountId } while the leads-count step is showing, cleared once
// confirmed/cancelled/backed-out-of.
let switchAccountsSizeStepFor = null;

async function openSwitchAccountsModal() {
  const accounts = await loadIgAccounts(true);
  const currentAccountId = state.sessionKind === 'ig_message' ? state.igAccountId : null;
  const usable = accounts.filter(a => a.id !== currentAccountId && accountCanSendToday(a));

  switchAccountsPendingByAccount = {};
  try {
    const data = await fetchJson('/api/saved-sessions');
    (data.sessions || []).forEach(s => {
      if (s.sessionKind === 'ig_message' && s.igCooldownAccountId) {
        switchAccountsPendingByAccount[s.igCooldownAccountId] = s;
      }
    });
  } catch (e) {
    console.error('Could not check for pending saved sessions', e);
  }

  const showLinkedInOption = state.sessionKind === 'ig_message' && !!state.combi;
  const cards = [];
  if (showLinkedInOption) {
    const liCount = state.combi.liLeads.length;
    cards.push(`
      <button type="button" class="daily-goal-account-card" data-switch-li="1">
        <div class="account-photo account-photo-placeholder">in</div>
        <div class="daily-goal-account-card-main">
          <div class="daily-goal-account-card-username">Switch to LinkedIn</div>
          <div class="daily-goal-account-card-meta">${liCount} lead${liCount === 1 ? '' : 's'} ready to go</div>
        </div>
      </button>`);
  }
  // accountPhotoHtml/formatAccountAge — defined in followups.js, callable
  // here since every public/*.js file shares one global scope (same reuse
  // already relied on by the daily-goal account picker).
  usable.forEach(a => {
    const seq = (messageSequencesCache || []).find(s => s.id === a.messageSequenceId);
    const seqName = seq ? seq.name : 'No sequence assigned';
    const pending = switchAccountsPendingByAccount[a.id];
    cards.push(`
      <button type="button" class="daily-goal-account-card" data-account-id="${a.id}">
        ${accountPhotoHtml(a)}
        <div class="daily-goal-account-card-main">
          <div class="daily-goal-account-card-username">@${escapeHtml(a.username)}</div>
          <div class="daily-goal-account-card-meta">
            ${escapeHtml(seqName)} · ${formatAccountAge(a.ageDays)}<br>
            ${pending ? 'Resume paused session →' : `${a.todaySentCount}/${a.dailyLimit} sent today · ${a.effectiveRemainingForNewSends} left today`}
          </div>
        </div>
      </button>`);
  });

  $('#switch-accounts-list').innerHTML = cards.join('');
  $('#switch-accounts-list').classList.toggle('hidden', cards.length === 0);
  $('#switch-accounts-empty').classList.toggle('hidden', cards.length > 0);
  $('#switch-accounts-size-step').classList.add('hidden');
  switchAccountsSizeStepFor = null;
  $('#switch-accounts-modal').classList.remove('hidden');
}

$('#switch-accounts-btn').addEventListener('click', openSwitchAccountsModal);
$('#simple-switch-accounts-btn').addEventListener('click', openSwitchAccountsModal);

$('#switch-accounts-list').addEventListener('click', (e) => {
  if (e.target.closest('[data-switch-li]')) {
    switchToLinkedIn();
    return;
  }
  const card = e.target.closest('[data-account-id]');
  if (!card) return;
  const accountId = card.dataset.accountId;
  const pending = switchAccountsPendingByAccount[accountId];
  if (pending) {
    switchToInstagramAccount(accountId, null, pending);
    return;
  }
  switchAccountsSizeStepFor = accountId;
  const account = findIgAccount(accountId);
  $('#switch-accounts-size-title').textContent = `How many leads for @${account ? account.username : 'this account'}?`;
  $('#switch-accounts-list').classList.add('hidden');
  $('#switch-accounts-empty').classList.add('hidden');
  $('#switch-accounts-size-step').classList.remove('hidden');
});

$('#switch-accounts-size-back-btn').addEventListener('click', () => {
  switchAccountsSizeStepFor = null;
  $('#switch-accounts-size-step').classList.add('hidden');
  $('#switch-accounts-list').classList.remove('hidden');
});

$all('.switch-size-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $all('.switch-size-preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('#switch-accounts-size-input').value = btn.dataset.size;
  });
});
$('#switch-accounts-size-input').addEventListener('input', () => {
  const val = $('#switch-accounts-size-input').value;
  $all('.switch-size-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.size === val));
});

$('#switch-accounts-size-confirm-btn').addEventListener('click', async () => {
  if (!switchAccountsSizeStepFor) return;
  const rawCount = Number($('#switch-accounts-size-input').value);
  const count = Math.max(1, Number.isFinite(rawCount) && rawCount > 0 ? Math.round(rawCount) : 15);
  const accountId = switchAccountsSizeStepFor;
  switchAccountsSizeStepFor = null;
  await switchToInstagramAccount(accountId, count, null);
});

$('#switch-accounts-cancel-btn').addEventListener('click', () => {
  switchAccountsSizeStepFor = null;
  $('#switch-accounts-modal').classList.add('hidden');
});

function closeSwitchAccountsModal() {
  $('#switch-accounts-modal').classList.add('hidden');
}

async function switchToInstagramAccount(accountId, count, existingSession) {
  try {
    if (SIMPLE_SESSION_KINDS.includes(state.sessionKind)) {
      await saveCurrentSimpleLeg();
    } else {
      await savePartialInstagramLeg();
    }
  } catch (e) {
    alert(`Could not save your progress before switching (${e.message}). Nothing was lost — you're still where you were, try again.`);
    return;
  }
  closeSwitchAccountsModal();
  try {
    if (existingSession) {
      resumeSavedSession(existingSession);
    } else {
      await startSinglePlatformSession('instagram', count, state.isDailyGoal, accountId);
      // startSinglePlatformSession silently writes an insufficient-leads
      // message into #home-session-error and returns (rather than
      // throwing) when there aren't enough leads — invisible here since
      // Home isn't the active view. Surface it as a real error instead of
      // leaving the screen stuck on the leg that was just saved away (same
      // fix as the daily-goal account picker's startLegForAccount).
      const homeError = $('#home-session-error');
      if (!homeError.classList.contains('hidden')) {
        const message = homeError.textContent.trim();
        homeError.classList.add('hidden');
        throw new Error(message || 'Not enough leads available right now.');
      }
    }
  } catch (e) {
    alert(`Could not switch accounts: ${e.message}`);
  }
}

async function switchToLinkedIn() {
  try {
    await savePartialInstagramLeg();
  } catch (e) {
    alert(`Could not save your progress before switching (${e.message}). Nothing was lost — you're still where you were, try again.`);
    return;
  }
  closeSwitchAccountsModal();
  // Same three steps #combi-continue-li-btn's handler runs.
  const liProfiles = state.combi.liLeads;
  const target = liProfiles.length;
  const wasDailyGoal = state.isDailyGoal;
  state.combi = null;
  await beginSessionWithLeads(liProfiles, { mode: 'goal', target, kind: 'li_engagement', alreadyProfiles: true, isDailyGoal: wasDailyGoal });
}

// Toggles #switch-accounts-btn (dashboard) / #simple-switch-accounts-btn
// (LinkedIn simple session) based on the already-cached account list — no
// forced network call on every render; the modal itself force-refreshes
// when actually opened.
function updateSwitchAccountsButtonVisibility() {
  const accounts = igAccountsCache || [];
  if (state.sessionKind === 'ig_message') {
    const hasOtherAccount = accounts.some(a => a.id !== state.igAccountId && accountCanSendToday(a));
    $('#switch-accounts-btn').classList.toggle('hidden', !(hasOtherAccount || !!state.combi));
  } else if (SIMPLE_SESSION_KINDS.includes(state.sessionKind)) {
    const hasAnyAccount = accounts.some(a => accountCanSendToday(a));
    $('#simple-switch-accounts-btn').classList.toggle('hidden', !hasAnyAccount);
  }
}

// ---------- SAVED SESSIONS ----------
const savedSessionsState = { sessions: [], viewingId: null, typeFilter: 'all' };

// Maps the persisted sessionKind to the display type the user asked for
// ("whether it was an Instagram session, a LinkedIn session or a combi
// session"). li_message/li_engagement/li_connection are all "LinkedIn" here
// — the distinction between them only matters once you're inside resuming it.
function savedSessionTypeCategory(session) {
  if (session.sessionKind === 'combi') return 'combi';
  if (session.sessionKind === 'ig_message') return 'instagram';
  return 'linkedin';
}
function savedSessionTypeLabel(session) {
  const cat = savedSessionTypeCategory(session);
  return cat === 'combi' ? 'Combi' : cat === 'instagram' ? 'Instagram' : 'LinkedIn';
}

function savedSessionSummary(session) {
  const parts = [];
  // Simple sessions (engagement/connection) never have a 'sent' status —
  // decideSimple() records the platform-specific positive stage instead
  // (engaged/connection_sent), so they need their own bucket labels rather
  // than the message-session sent/not-qualified/can't-message ones.
  if (SIMPLE_SESSION_KINDS.includes(session.sessionKind)) {
    const cfg = currentSimpleConfigFor(session.sessionKind);
    const positive = session.results.filter(r => r.status === cfg.positiveStage).length;
    const negative = session.results.length - positive;
    if (positive) parts.push(`${positive} ${cfg.positiveLabel.replace(/^[^\w]*/, '').toLowerCase()}`);
    if (negative) parts.push(`${negative} ${cfg.negativeLabel.replace(/^[^\w]*/, '').toLowerCase()}`);
  } else {
    const sent = session.results.filter(r => r.status === 'sent').length;
    const rejected = session.results.filter(r => r.status === 'not_qualified').length;
    const cantMessage = session.results.filter(r => r.status === 'cant_message').length;
    if (sent) parts.push(`${sent} sent`);
    if (rejected) parts.push(`${rejected} not qualified`);
    if (cantMessage) parts.push(`${cantMessage} can't message`);
  }
  parts.push(`${session.remainingProfiles.length} remaining`);
  return parts.join(' · ');
}

async function loadSavedSessions() {
  try {
    const data = await fetchJson('/api/saved-sessions');
    savedSessionsState.sessions = data.sessions || [];
  } catch (e) {
    console.error('Could not load saved sessions', e);
    alert(`Could not load saved sessions: ${e.message}`);
  }
  renderSavedSessionsList();
}

$('#saved-sessions-type-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#saved-sessions-type-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  savedSessionsState.typeFilter = btn.dataset.typeFilter;
  renderSavedSessionsList();
});

function renderSavedSessionsList() {
  const list = $('#saved-sessions-list');
  const empty = $('#saved-sessions-empty');
  const filtered = savedSessionsState.typeFilter === 'all'
    ? savedSessionsState.sessions
    : savedSessionsState.sessions.filter(s => savedSessionTypeCategory(s) === savedSessionsState.typeFilter);

  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.textContent = savedSessionsState.sessions.length === 0
      ? 'No saved sessions — use "Quit & save" mid-session to pick one up later.'
      : 'No saved sessions match this filter.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  // username/fullName are freely-editable, possibly CSV-imported text —
  // escaped here like everywhere else this app renders lead-supplied text.
  list.innerHTML = filtered.map(s => `
    <div class="saved-session-card" data-id="${s.id}">
      <div class="saved-session-main">
        <div class="saved-session-date-row">
          <span class="saved-session-type-badge saved-session-type-${savedSessionTypeCategory(s)}">${escapeHtml(savedSessionTypeLabel(s))}</span>
          <span class="saved-session-date">${escapeHtml(timeAgo(s.createdAt))}</span>
        </div>
        <div class="saved-session-summary">${escapeHtml(savedSessionSummary(s))}</div>
      </div>
      <div class="saved-session-card-actions">
        <button type="button" class="saved-session-continue-btn" data-id="${s.id}">Continue →</button>
        <button type="button" class="saved-session-delete-btn" data-id="${s.id}" title="Delete this saved session">🗑</button>
      </div>
    </div>
  `).join('');
}

// Deleting a saved session only discards the saved copy of the queue — the
// leads in it are untouched (still sit at stage='new', same as any other
// undecided lead) and can be picked up again through a normal session.
async function deleteSavedSession(id) {
  if (!confirm("Delete this saved session? The leads in it aren't affected — they'll stay as they are and can still be reached through a normal session.")) return;
  try {
    await fetchJson(`/api/saved-sessions/${id}`, { method: 'DELETE' });
  } catch (e) {
    alert(`Could not delete: ${e.message}`);
    return;
  }
  savedSessionsState.sessions = savedSessionsState.sessions.filter(s => s.id !== id);
  renderSavedSessionsList();
  if (savedSessionsState.viewingId === id) {
    savedSessionsState.viewingId = null;
    showView('saved-sessions');
  }
}

$('#saved-sessions-list').addEventListener('click', (e) => {
  const continueBtn = e.target.closest('.saved-session-continue-btn');
  if (continueBtn) {
    e.stopPropagation();
    const session = savedSessionsState.sessions.find(s => s.id === continueBtn.dataset.id);
    if (session) resumeSavedSession(session);
    return;
  }
  const deleteBtn = e.target.closest('.saved-session-delete-btn');
  if (deleteBtn) {
    e.stopPropagation();
    deleteSavedSession(deleteBtn.dataset.id);
    return;
  }
  const card = e.target.closest('.saved-session-card');
  if (card) showSavedSessionDetail(card.dataset.id);
});

function showSavedSessionDetail(id) {
  const session = savedSessionsState.sessions.find(s => s.id === id);
  if (!session) return;
  savedSessionsState.viewingId = id;
  $('#saved-session-summary').innerHTML = `
    <span class="saved-session-type-badge saved-session-type-${savedSessionTypeCategory(session)}">${escapeHtml(savedSessionTypeLabel(session))}</span>
    <h3>${escapeHtml(timeAgo(session.createdAt))}</h3>
    <p class="muted">${escapeHtml(savedSessionSummary(session))}</p>
  `;
  const list = $('#saved-session-remaining-list');
  list.innerHTML = session.remainingProfiles.length
    ? session.remainingProfiles.map(p => `<li><strong>${escapeHtml(leadDisplayName(p))}</strong></li>`).join('')
    : '<li class="muted">None</li>';
  $('#saved-session-combi-actions').classList.toggle('hidden', session.sessionKind !== 'combi');
  showView('saved-session-detail');
}

$('#saved-session-back-btn').addEventListener('click', () => showView('saved-sessions'));

$('#saved-session-continue-btn').addEventListener('click', () => {
  const session = savedSessionsState.sessions.find(s => s.id === savedSessionsState.viewingId);
  if (session) resumeSavedSession(session);
});

$('#saved-session-delete-btn').addEventListener('click', () => {
  if (savedSessionsState.viewingId) deleteSavedSession(savedSessionsState.viewingId);
});

// Combi detail view only — resumes just one half of a saved combi session.
// The other half (if any profiles remain on that side) is re-saved as its
// own fresh saved session first, so choosing "only IG" never silently drops
// the LinkedIn leads still sitting there.
async function resumeSavedSessionPortion(kind) {
  const session = savedSessionsState.sessions.find(s => s.id === savedSessionsState.viewingId);
  if (!session) return;
  const chosen = session.remainingProfiles.filter(p => p.sessionKind === kind);
  const other = session.remainingProfiles.filter(p => p.sessionKind !== kind);
  if (chosen.length === 0) {
    alert("There's nothing on that side to continue.");
    return;
  }

  if (other.length > 0) {
    const otherKind = other[0].sessionKind;
    // The Instagram side may already have partial progress from before this
    // was quit-saved (session.sentCount/sessionTarget/results always refer
    // to the Instagram portion — see the quit-save-btn handler); the
    // LinkedIn side never does, since it hadn't started yet.
    const otherIsIg = otherKind === 'ig_message';
    try {
      await fetchJson('/api/saved-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKind: otherKind,
          sessionMode: 'goal',
          sessionTarget: otherIsIg ? session.sessionTarget : other.length,
          sentCount: otherIsIg ? session.sentCount : 0,
          results: otherIsIg ? session.results : [],
          remainingProfiles: other,
          isDailyGoal: session.isDailyGoal
        })
      });
    } catch (e) {
      alert(`Could not save the other portion (${e.message}). Nothing was changed — try again.`);
      return;
    }
  }

  try {
    await fetchJson(`/api/saved-sessions/${session.id}`, { method: 'DELETE' });
  } catch (e) {
    console.error('Could not remove the original combi saved session', e);
  }

  const chosenIsIg = kind === 'ig_message';
  state.results = chosenIsIg ? (session.results || []) : [];
  enterResumedSession(
    chosen, kind, 'goal',
    chosenIsIg ? session.sessionTarget : chosen.length,
    chosenIsIg ? (session.sentCount || 0) : 0,
    session.isDailyGoal,
    session.igCooldownAccountId
  );
}

$('#saved-session-continue-ig-btn').addEventListener('click', () => resumeSavedSessionPortion('ig_message'));
$('#saved-session-continue-li-btn').addEventListener('click', () => resumeSavedSessionPortion('li_engagement'));

// Resumes a plain (non-combi) saved session — always exactly one kind, so
// this is the shared tail end of resumeSavedSession/resumeSavedSessionPortion.
async function enterResumedSession(profiles, sessionKind, sessionMode, sessionTarget, sentCount, isDailyGoal, accountId) {
  state.profiles = profiles;
  state.index = 0;
  state.sessionKind = sessionKind;
  state.sessionMode = sessionMode;
  state.sessionTarget = sessionTarget;
  state.sentCount = sentCount;
  state.outOfLeads = false;
  state.isDailyGoal = !!isDailyGoal;
  state.igCooldownUntil = null;
  state.igCooldownAccountId = null;
  state.pacingBlockIndex = 0;
  state.sendsInCurrentBlock = 0;
  state.currentBlockThreshold = null;
  state.pacingBreakUntil = null;
  state.activePauseBlockIndex = null;
  state.hadPacingBreakThisSession = false;
  state.pacingBreakIsFinal = false;
  if (accountId && sessionKind === 'ig_message') {
    // force:true — see beginSessionWithLeads for why a resumed session can't
    // just trust whatever Timing/Messaging sequence data happened to be
    // cached since the last full page load.
    const accounts = await loadIgAccounts(true);
    const account = accounts.find(a => a.id === accountId);
    state.igAccountId = accountId;
    state.igAccountUsername = account ? account.username : null;
    state.igAccountTodaySentCount = account ? account.todaySentCount : 0;
  } else {
    state.igAccountId = null;
    state.igAccountUsername = null;
    state.igAccountTodaySentCount = 0;
  }
  saveSession();
  if (SIMPLE_SESSION_KINDS.includes(sessionKind)) {
    enterSimpleSession();
    return;
  }
  // No tab opened here — see the note in beginSessionWithLeads. The re-run
  // preload's "GO!" button is what opens it once ready.
  preloadSessionVideos();
}

function resumeSavedSession(session) {
  if (!session.remainingProfiles || session.remainingProfiles.length === 0) {
    fetchJson(`/api/saved-sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
    showView('home');
    return;
  }
  state.results = session.results || [];
  // Consumed — remove it so it doesn't linger in the list while it's being
  // worked on again. Best-effort/not awaited: a failure here just leaves an
  // unused row behind (harmless clutter), not worth blocking on.
  fetchJson(`/api/saved-sessions/${session.id}`, { method: 'DELETE' }).catch(e => console.error('Could not remove saved session', e));

  if (session.sessionKind === 'combi') {
    // Split back apart by the per-profile sessionKind tag set when this was
    // quit-saved (see the quit-save-btn handler) — resume straight into
    // whatever's left of the Instagram portion, with the LinkedIn batch
    // stashed for the interstitial once that finishes, exactly like a fresh
    // combi session.
    const igProfiles = session.remainingProfiles.filter(p => p.sessionKind === 'ig_message');
    const liProfiles = session.remainingProfiles.filter(p => p.sessionKind === 'li_engagement');
    state.combi = { liLeads: liProfiles };
    enterResumedSession(igProfiles, 'ig_message', session.sessionMode || 'goal', session.sessionTarget ?? null, session.sentCount || 0, session.isDailyGoal, session.igCooldownAccountId);
    return;
  }

  // igCooldownAccountId doubles as "the account this saved ig_message
  // session should resume with" whether or not an actual cooldown applied —
  // see the quit-save-btn handler, which sets it on every Instagram save,
  // not just cooldown-forced ones.
  enterResumedSession(session.remainingProfiles, session.sessionKind || 'ig_message', session.sessionMode || 'fixed', session.sessionTarget ?? null, session.sentCount || 0, session.isDailyGoal, session.igCooldownAccountId);
}

// ---------- ANALYTICS ----------
let currentRange = 'today';

// Matches followups.js's own OPENER_LABELS (used on the Messaging sequences
// editor) — duplicated with a distinct name rather than shared across files,
// since plain <script> tags share one global scope and two `const`s with the
// same name across files would be a SyntaxError, not a silent overwrite.
const ANALYTICS_OPENER_LABELS = ['Variant A', 'Variant B', 'Variant C', 'Variant D'];

// Scoped to #range-tabs specifically (not a blanket $all('.range-tab')) —
// that class is now reused by every platform/type toggle across the app
// (Leads, Home, Saved Sessions, Settings' phase tabs), and a page-wide
// selector here would attach this click handler to all of them too.
$('#range-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.range-tab');
  if (!tab) return;
  $all('#range-tabs .range-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentRange = tab.dataset.range;
  loadAnalytics(currentRange);
});

const RANGE_LABELS = {
  today: 'vs yesterday',
  week: 'vs last week',
  month: 'vs last month',
  '3months': 'vs previous 3 months',
  year: 'vs last year',
  all: ''
};

let analyticsPlatformFilter = 'all';

$('#analytics-platform-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#analytics-platform-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  analyticsPlatformFilter = btn.dataset.platform;
  loadAnalytics(currentRange);
});

// "Overview" (the existing date-ranged funnel/chart) vs "Opener A/B test" —
// the latter is deliberately its own tab bar, independent of the
// range/platform tabs above, since opener performance is a cumulative
// all-time comparison, not something scoped to a period (see
// GET /api/analytics/openers).
$('#analytics-mode-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#analytics-mode-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const mode = btn.dataset.mode;
  $('#analytics-overview-section').classList.toggle('hidden', mode !== 'overview');
  $('#analytics-openers-section').classList.toggle('hidden', mode !== 'openers');
  $('#analytics-accounts-section').classList.toggle('hidden', mode !== 'accounts');
  if (mode === 'openers') loadAnalyticsOpeners();
  if (mode === 'accounts') loadAnalyticsAccounts();
});

async function loadAnalyticsOpeners() {
  try {
    const data = await fetchJson('/api/analytics/openers');
    const openers = (data.openers || []).slice().sort((a, b) => (b.prr ?? -1) - (a.prr ?? -1));
    $('#analytics-openers-empty').classList.toggle('hidden', openers.length > 0);
    $('#analytics-openers-tbody').innerHTML = openers.map(o => `
      <tr>
        <td>${escapeHtml(o.sequenceName)}</td>
        <td>${ANALYTICS_OPENER_LABELS[o.position] || `Variant ${o.position + 1}`}</td>
        <td class="analytics-openers-text">${escapeHtml(o.text || '(empty)')}</td>
        <td>${o.sends}</td>
        <td>${o.replies}</td>
        <td>${o.replyRate != null ? o.replyRate + '%' : '–'}</td>
        <td>${o.positiveReplies}</td>
        <td>${o.prr != null ? o.prr + '%' : '–'}</td>
        <td>${o.appointmentsSet}</td>
        <td>${o.asr != null ? o.asr + '%' : '–'}</td>
      </tr>`).join('');
  } catch (e) {
    alert(`Could not load opener performance: ${e.message}`);
  }
}

async function loadAnalyticsAccounts() {
  try {
    const data = await fetchJson('/api/analytics/accounts');
    const leaderboard = (data.leaderboard || []).slice().sort((a, b) => (b.prr ?? -1) - (a.prr ?? -1));
    const notEnoughData = data.notEnoughData || [];
    const totalAccounts = leaderboard.length + notEnoughData.length;

    $('#analytics-accounts-empty').classList.toggle('hidden', totalAccounts > 0 && leaderboard.length > 0);
    $('#analytics-accounts-need-more').classList.toggle('hidden', leaderboard.length !== 1);
    $('#analytics-accounts-leaderboard-card').classList.toggle('hidden', leaderboard.length < 2);
    $('#analytics-accounts-table-card').classList.toggle('hidden', leaderboard.length === 0);

    $('#analytics-accounts-leaderboard').innerHTML = leaderboard.map(a => {
      const delta = a.vsOthersAvgPrr;
      const deltaClass = delta == null ? 'neutral' : delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
      const deltaText = delta == null ? '–' : `${delta > 0 ? '+' : ''}${delta} pts`;
      return `
      <div class="analytics-leaderboard-row">
        ${accountPhotoHtml(a)}
        <div class="analytics-leaderboard-name">${escapeHtml(a.username)}</div>
        <div class="analytics-leaderboard-prr">${a.prr != null ? a.prr + '%' : '–'} PRR</div>
        <div class="overview-chart-delta ${deltaClass}">${deltaText}</div>
      </div>`;
    }).join('');

    $('#analytics-accounts-tbody').innerHTML = leaderboard.map(a => `
      <tr>
        <td>${escapeHtml(a.username)}</td>
        <td>${a.sends}</td>
        <td>${a.replies}</td>
        <td>${a.replyRate != null ? a.replyRate + '%' : '–'}</td>
        <td>${a.positiveReplies}</td>
        <td>${a.prr != null ? a.prr + '%' : '–'}</td>
        <td>${a.appointmentsSet}</td>
        <td>${a.asr != null ? a.asr + '%' : '–'}</td>
      </tr>`).join('');
  } catch (e) {
    alert(`Could not load account performance: ${e.message}`);
  }
}

async function loadAnalytics(range) {
  try {
    const data = await fetchJson(`/api/analytics?range=${range}&platform=${analyticsPlatformFilter}`);
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
  $('#fn-conn-sent').textContent = funnel.connectionsSent;
  $('#fn-conn-accepted').textContent = funnel.connectionsAccepted;
  $('#fn-car').textContent = pctText(funnel.car);
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
  // Resolved first — every localStorage key below (the in-progress session,
  // the wording-rotation memory) and every API call this function makes is
  // scoped to whichever profile this resolves.
  await loadWorkspaces();
  renderSidebarProfileSwitcher();
  applyPlatformVisibility();

  // loadIgAccounts() here too (not just when a session actually starts) so
  // a page reload landing mid-pacing-break (see the restoration block below)
  // has the active account's pacing blocks ready for activePauseBlock().
  // Instagram no longer uses loadTemplatesFromServer()'s category system —
  // only LinkedIn's own fixed template still comes from it.
  await Promise.all([loadTemplatesFromServer('linkedin'), loadViewsThreshold(), loadIgAccounts()]);
  const saved = loadSession();
  if (saved && Array.isArray(saved.profiles) && saved.profiles.length > 0 && saved.index < saved.profiles.length) {
    state.profiles = saved.profiles;
    state.index = saved.index;
    state.results = saved.results || [];
    state.sessionKind = saved.sessionKind || 'ig_message';
    state.sessionMode = saved.sessionMode || 'fixed';
    state.sessionTarget = saved.sessionTarget ?? null;
    state.sentCount = saved.sentCount || 0;
    state.outOfLeads = saved.outOfLeads || false;
    state.combi = saved.combi || null;
    state.isDailyGoal = saved.isDailyGoal || false;
    state.igAccountId = saved.igAccountId || null;
    state.igAccountUsername = saved.igAccountUsername || null;
    state.igAccountTodaySentCount = saved.igAccountTodaySentCount || 0;
    state.igCooldownUntil = saved.igCooldownUntil || null;
    state.igCooldownAccountId = saved.igCooldownAccountId || null;
    state.pacingBlockIndex = saved.pacingBlockIndex || 0;
    state.sendsInCurrentBlock = saved.sendsInCurrentBlock || 0;
    state.currentBlockThreshold = saved.currentBlockThreshold ?? null;
    state.pacingBreakUntil = saved.pacingBreakUntil || null;
    state.activePauseBlockIndex = saved.activePauseBlockIndex ?? null;
    state.hadPacingBreakThisSession = saved.hadPacingBreakThisSession || false;
    state.pacingBreakIsFinal = saved.pacingBreakIsFinal || false;
    if (state.igCooldownUntil) {
      // A reload landed mid-cooldown, before "Go back to home" was ever
      // clicked (that's the only thing that actually persists it server-side)
      // — restore straight into the cooldown card rather than the dashboard.
      $('#ig-limit-title').textContent = 'Switching accounts';
      $('#ig-limit-summary').textContent = `Ready to continue with @${state.igAccountUsername}.`;
      $('#ig-limit-picker-card').classList.add('hidden');
      $('#ig-limit-cooldown-card').classList.remove('hidden');
      $('#ig-limit-continue-li-btn').classList.toggle('hidden', !state.combi);
      showView('ig-account-limit');
      startIgLimitCountdown();
    } else if (state.pacingBreakUntil) {
      // Same idea — a reload mid-break shouldn't skip the rest of it.
      showView('send-pacing-break');
      startPacingBreakCountdown();
    } else if (SIMPLE_SESSION_KINDS.includes(state.sessionKind)) {
      showView('simple-session');
      renderSimpleSessionProfile();
    } else {
      showView('dashboard');
      renderProfile();
    }
  } else {
    showView('home');
  }
})();
