const state = {
  profiles: [],      // parsed from URL input for the current session
  index: 0,           // current profile index
  results: [],         // {profile, status, template, message} for finished profiles this session
  viewsThreshold: Number(localStorage.getItem('viewsThreshold') || 1000)
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
      results: state.results
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

function showView(name) {
  $all('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  if (name === 'home') loadHome();
  if (name === 'analytics') loadAnalytics(currentRange);
}

$all('.navbtn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.nav));
});

// ---------- HOME ----------
async function loadHome() {
  try {
    const res = await fetch('/api/home');
    const data = await res.json();
    $('#streak-value').textContent = data.streak;
    $('#week-value').textContent = data.last7Days;
  } catch (e) {
    $('#streak-value').textContent = '–';
    $('#week-value').textContent = '–';
  }
}

$('#views-threshold').value = state.viewsThreshold;
$('#views-threshold').addEventListener('input', e => {
  state.viewsThreshold = Number(e.target.value || 0);
  localStorage.setItem('viewsThreshold', state.viewsThreshold);
});

$('#url-input').addEventListener('input', () => {
  const n = parseProfilesInput($('#url-input').value).length;
  $('#url-count').textContent = `${n} profiel${n === 1 ? '' : 'en'}`;
});

// Tab-delimited tokenizer that understands spreadsheet-style quoting: a cell
// wrapped in "..." can contain literal tabs/newlines (e.g. a multi-line bio),
// and "" inside a quoted cell is an escaped literal quote. Without this, a
// bio with line breaks would get sliced into several bogus rows.
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

// Accepts either one URL per line, or rows pasted straight out of a
// spreadsheet in the order: Profile URL, Username, Full Name, Bio, Followers
// (select those columns in your sheet and copy/paste directly in).
// A header row (first cell reading "url" or similar) is skipped.
function parseProfilesInput(raw) {
  const rows = parseDelimitedRows(raw.trim(), '\t')
    .map(row => row.map(c => c.trim()))
    .filter(row => row.some(c => c !== ''));

  return rows
    .filter((row, i) => {
      if (i !== 0) return true;
      const firstCell = row[0].toLowerCase();
      const looksLikeHeader = /^(url|username|gebruikersnaam|profiel|naam|name)$/.test(firstCell);
      return !looksLikeHeader;
    })
    .map(cols => {
      const [urlCol = '', usernameCol = '', fullName = '', bio = '', followersRaw = ''] = cols;

      let username = usernameCol.replace('@', '').trim();
      if (!username) {
        const match = urlCol.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
        username = match ? match[1] : urlCol.replace('@', '').trim();
      }
      const profileUrl = urlCol.startsWith('http') ? urlCol : `https://www.instagram.com/${username}/`;

      // Sheets often have "3.2K" / "11,600" style follower counts — normalize what we can.
      let followers = '';
      if (followersRaw) {
        const kMatch = followersRaw.match(/^([\d.,]+)\s*[kK]$/);
        if (kMatch) {
          followers = Math.round(parseFloat(kMatch[1].replace(',', '.')) * 1000);
        } else {
          const digits = followersRaw.replace(/[^\d]/g, '');
          followers = digits ? Number(digits) : '';
        }
      }

      return { username, profileUrl, fullName, bio, followers };
    });
}

$('#start-session-btn').addEventListener('click', () => {
  const profiles = parseProfilesInput($('#url-input').value);
  if (profiles.length === 0) {
    alert('Plak minstens één Instagram URL of sheet-rij.');
    return;
  }
  state.profiles = profiles.map(p => ({
    ...p,
    lastPostWeeks: '',
    postsPerWeek: '',
    avgViews: '',
    template: '',
    message: '',
    done: false,
    status: null
  }));
  state.index = 0;
  state.results = [];
  $('#url-input').value = '';
  $('#url-count').textContent = '0 profielen';
  saveSession();
  showView('dashboard');
  renderProfile();
  openProfileTab(state.profiles[0].profileUrl);
});

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

  $('#progress-current').textContent = state.index + 1;
  $('#progress-total').textContent = state.profiles.length;
  $('#progress-fill').style.width = `${((state.index) / state.profiles.length) * 100}%`;

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
  const views = state.viewsThreshold ? state.viewsThreshold.toLocaleString('nl-NL') : '[X]';
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
  const placeholders = buildPlaceholders(p);
  const text = TEMPLATES[key].text(placeholders);
  p.message = text;
  $('#f-message').value = text;

  const dmLink = $('#dm-link');
  dmLink.href = p.username ? `https://ig.me/m/${p.username}` : '#';
  saveSession();
}

// field listeners -> keep state + message in sync
['f-bio', 'f-followers', 'f-avgviews'].forEach(id => {
  $(`#${id}`).addEventListener('input', syncFieldsToState);
});
// naam placeholder in the message depends on these two, so re-render the message text
['f-fullname', 'f-username'].forEach(id => {
  $(`#${id}`).addEventListener('input', () => { syncFieldsToState(); updateMessage(false); });
});
$('#f-lastpost').addEventListener('input', () => { syncFieldsToState(); updateMessage(true); });
$('#f-postsperweek').addEventListener('input', () => { syncFieldsToState(); updateMessage(true); });
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
  btn.textContent = '✓ Gekopieerd!';
  setTimeout(() => { btn.textContent = original; }, 1200);
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

  // Open (synchronously, before any await) so the browser doesn't treat it as
  // a blocked popup — user-gesture activation can expire once we hit `await`.
  const next = state.profiles[state.index + 1];
  if (next) openProfileTab(next.profileUrl);

  try {
    await fetch('/api/outreach', {
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
    console.error('Kon outreach niet opslaan', e);
  }

  state.results.push({
    username: p.username,
    fullName: p.fullName,
    profileUrl: p.profileUrl,
    template: p.template,
    status
  });

  if (state.index < state.profiles.length - 1) {
    state.index++;
    renderProfile();
  } else {
    showEndScreen();
  }
}

$('#accept-btn').addEventListener('click', () => decide('sent'));
$('#reject-btn').addEventListener('click', () => decide('not_qualified'));

// ---------- END SCREEN ----------
function showEndScreen() {
  const sent = state.results.filter(r => r.status === 'sent');
  const rejected = state.results.filter(r => r.status === 'not_qualified');

  clearSession();
  $('#progress-fill').style.width = '100%';
  $('#end-sent-count').textContent = sent.length;
  $('#end-rejected-count').textContent = rejected.length;

  const lines = [
    `Je bent door alle ${state.results.length} profielen heen.`,
    sent.length > 0 ? `${sent.length} bericht${sent.length === 1 ? '' : 'en'} verstuurd — mooi werk.` : `Vandaag geen berichten verstuurd — soms zit de kwaliteit er gewoon niet in.`
  ];
  $('#end-summary-line').textContent = lines.join(' ');

  const sentList = $('#end-sent-list');
  sentList.innerHTML = sent.length
    ? sent.map(r => `<li><strong>@${r.username}</strong> ${r.fullName ? `(${r.fullName})` : ''} — ${TEMPLATES[r.template]?.label || r.template}</li>`).join('')
    : '<li class="muted">Geen</li>';

  const rejList = $('#end-rejected-list');
  rejList.innerHTML = rejected.length
    ? rejected.map(r => `<li><strong>@${r.username}</strong> ${r.fullName ? `(${r.fullName})` : ''}</li>`).join('')
    : '<li class="muted">Geen</li>';

  showView('end');
}

$('#back-home-btn').addEventListener('click', () => {
  state.profiles = [];
  state.results = [];
  state.index = 0;
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
  today: 'vs gisteren',
  week: 'vs vorige week',
  month: 'vs vorige maand',
  '3months': 'vs vorige 3 maanden',
  year: 'vs vorig jaar',
  all: ''
};

async function loadAnalytics(range) {
  try {
    const res = await fetch(`/api/analytics?range=${range}`);
    const data = await res.json();
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
  } catch (e) {
    console.error('Analytics laden mislukt', e);
  }
}

function renderChart(series) {
  const svg = $('#an-chart');
  svg.innerHTML = '';
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
(function init() {
  const saved = loadSession();
  if (saved && Array.isArray(saved.profiles) && saved.profiles.length > 0 && saved.index < saved.profiles.length) {
    state.profiles = saved.profiles;
    state.index = saved.index;
    state.results = saved.results || [];
    showView('dashboard');
    renderProfile();
  } else {
    showView('home');
  }
})();
