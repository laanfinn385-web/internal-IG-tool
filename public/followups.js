const PHASE_NAMES = { 1: 'Phase 1', 2: 'Phase 2', 3: 'Phase 3' };

function timeAgo(dateStr) {
  const diffMs = Math.max(0, Date.now() - new Date(dateStr).getTime());
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------- Notification bell ----------

async function loadNotifications() {
  try {
    const data = await fetchJson('/api/notifications');
    renderNotifications(data.notifications || []);
    // igCooldownState/renderIgCooldownBanner live in app.js — piggybacking on
    // this call (already made everywhere on every view change) instead of a
    // second /api/notifications fetch just for the banner.
    igCooldownState = data.igCooldown || null;
    renderIgCooldownBanner();
  } catch (e) {
    console.error('Could not load notifications', e);
  }
}

const PLATFORM_LABELS = { instagram: 'Instagram', linkedin: 'LinkedIn' };

function renderNotifications(notifications) {
  const badge = $('#notif-badge');
  const list = $('#notif-list');
  const empty = $('#notif-empty');

  if (notifications.length === 0) {
    badge.classList.add('hidden');
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  badge.classList.remove('hidden');
  badge.textContent = notifications.length;
  empty.classList.add('hidden');
  list.innerHTML = notifications.map(n => {
    // Grouped notifications (followup/connections) aren't real records —
    // their bin dismisses the group (hides it until leads newly become due;
    // see POST /api/notifications/dismiss). Reminders are real records, so
    // theirs deletes outright.
    if (n.type === 'connections') {
      return `
        <div class="notif-row">
          <button type="button" class="notif-item" data-type="connections" data-platform="${n.platform}">
            <div class="notif-item-main">
              <span class="notif-item-phase">LinkedIn connections</span>
              <span class="notif-item-count">${n.count} lead${n.count === 1 ? '' : 's'} ready for a connection request</span>
            </div>
            <span class="notif-item-time">${timeAgo(n.earliestDue)}</span>
          </button>
          <button type="button" class="notif-item-delete" data-group-key="${n.groupKey}" title="Dismiss for now">🗑</button>
        </div>`;
    }
    if (n.type === 'ig_cooldown_ready') {
      // No delete/dismiss here (unlike everything else) — the paused session
      // is still sitting there either way, dismissing wouldn't accomplish
      // anything, so this is click-to-resume only.
      return `
        <div class="notif-row">
          <button type="button" class="notif-item" data-type="ig_cooldown_ready" data-saved-session-id="${n.savedSessionId}">
            <div class="notif-item-main">
              <span class="notif-item-phase">✅ Ready to continue</span>
              <span class="notif-item-count">The switch cooldown for @${escapeHtml(n.accountUsername || '')} is over</span>
            </div>
            <span class="notif-item-time">${timeAgo(n.earliestDue)}</span>
          </button>
        </div>`;
    }
    if (n.type === 'reminder') {
      // Linked reminders get an explicit "Take me to lead" action alongside
      // the usual "click the card to manage it in Settings" — the leadId
      // alone can't be trusted here (it survives the lead being soft-deleted,
      // at which point the server's LEFT JOIN nulls the rest out).
      const isLinked = n.leadId && (n.leadUsername || n.leadFullName);
      const gotoBtn = isLinked
        ? `<button type="button" class="notif-reminder-goto-btn" data-lead-search="${escapeHtml(leadDisplayName({ platform: n.leadPlatform, username: n.leadUsername, fullName: n.leadFullName }).replace(/^@/, ''))}">Take me to lead →</button>`
        : '';
      return `
        <div class="notif-row">
          <div class="notif-item" data-type="reminder" data-id="${n.id}">
            <div class="notif-item-main">
              <span class="notif-item-phase">🔔 Reminder</span>
              <span class="notif-item-count">${escapeHtml(n.text)}</span>
              ${gotoBtn}
            </div>
            <span class="notif-item-time">${timeAgo(n.earliestDue)}</span>
          </div>
          <button type="button" class="notif-item-delete" data-reminder-id="${n.id}" title="Delete reminder">🗑</button>
        </div>`;
    }
    return `
      <div class="notif-row">
        <button type="button" class="notif-item" data-type="followup" data-phase="${n.phase}" data-platform="${n.platform}">
          <div class="notif-item-main">
            <span class="notif-item-phase">${PLATFORM_LABELS[n.platform]} ${PHASE_NAMES[n.phase]}</span>
            <span class="notif-item-count">${n.count} lead${n.count === 1 ? '' : 's'} to follow up with</span>
          </div>
          <span class="notif-item-time">${timeAgo(n.earliestDue)}</span>
        </button>
        <button type="button" class="notif-item-delete" data-group-key="${n.groupKey}" title="Dismiss for now">🗑</button>
      </div>`;
  }).join('');
}

$('#notif-list').addEventListener('click', async (e) => {
  const gotoBtn = e.target.closest('.notif-reminder-goto-btn');
  if (gotoBtn) {
    e.stopPropagation();
    $('#notif-dropdown').classList.add('hidden');
    showView('leads');
    leadsState.search = gotoBtn.dataset.leadSearch;
    $('#leads-search').value = leadsState.search;
    leadsState.page = 0;
    renderLeadsTable();
    return;
  }

  const deleteBtn = e.target.closest('.notif-item-delete');
  if (deleteBtn) {
    e.stopPropagation();
    deleteBtn.disabled = true;
    try {
      if (deleteBtn.dataset.groupKey) {
        await fetchJson('/api/notifications/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupKey: deleteBtn.dataset.groupKey })
        });
      } else if (deleteBtn.dataset.reminderId) {
        await fetchJson(`/api/reminders/${deleteBtn.dataset.reminderId}`, { method: 'DELETE' });
      }
      loadNotifications();
    } catch (err) {
      alert(`Could not remove that notification: ${err.message}`);
      deleteBtn.disabled = false;
    }
    return;
  }

  const item = e.target.closest('.notif-item');
  if (!item) return;
  $('#notif-dropdown').classList.add('hidden');
  if (item.dataset.type === 'connections') {
    openConnectionSession();
  } else if (item.dataset.type === 'reminder') {
    showView('settings');
    const card = $('#settings-reminders-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (item.dataset.type === 'ig_cooldown_ready') {
    resumeIgCooldownSession(item.dataset.savedSessionId);
  } else {
    openFollowupSession(Number(item.dataset.phase), item.dataset.platform);
  }
});

$('#notif-add-reminder-btn').addEventListener('click', () => {
  $('#notif-dropdown').classList.add('hidden');
  showView('settings');
  const card = $('#settings-reminders-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#reminder-text').focus();
});

$('#notif-bell').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#notif-dropdown').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.notif-wrap')) $('#notif-dropdown').classList.add('hidden');
});

// ---------- Follow-up session ----------

const followupState = { phase: null, platform: 'instagram', leads: [] };

async function openFollowupSession(phase, platform) {
  followupState.phase = phase;
  followupState.platform = platform === 'linkedin' ? 'linkedin' : 'instagram';
  $('#followup-title').textContent = `${PLATFORM_LABELS[followupState.platform]} ${PHASE_NAMES[phase]} Follow-ups`;
  $('#followup-list').innerHTML = '<p class="muted">Loading…</p>';
  $('#followup-sub').textContent = '';
  $('#followup-empty').classList.add('hidden');
  showView('followup');
  try {
    const data = await fetchJson(`/api/followups/due?phase=${phase}&platform=${followupState.platform}`);
    followupState.leads = data.leads || [];
    renderFollowupList();
  } catch (e) {
    $('#followup-list').innerHTML = `<p class="import-error">Could not load follow-ups: ${escapeHtml(e.message)}</p>`;
  }
}

// LinkedIn's connection-request session — notification-driven only, uses the
// same simple swipeable session view as engagement sessions (see app.js).
async function openConnectionSession() {
  try {
    const data = await fetchJson('/api/linkedin/connections/due');
    const leads = data.leads || [];
    if (leads.length === 0) {
      alert('No LinkedIn connection requests due right now.');
      loadNotifications();
      return;
    }
    beginSessionWithLeads(leads.map(l => ({ ...l, platform: 'linkedin' })), { kind: 'li_connection' });
  } catch (e) {
    alert(`Could not load due connection requests: ${e.message}`);
  }
}

function followupCardHtml(lead) {
  const isMedia = lead.type !== 'text';
  // The message accompanying a media step is optional ("sent alongside the
  // media"), so a GIF/meme step can have no message at all — the media note
  // itself needs to be clickable-to-open-DM too, or a message-less media
  // step renders with nothing to click anywhere on the card.
  const mediaLine = isMedia
    ? `<button type="button" class="followup-media-note followup-open-dm" data-id="${lead.id}">🎬 Send a ${escapeHtml(lead.type)}: ${escapeHtml(lead.mediaNote || '')}</button>`
    : '';
  const messageLine = lead.message
    ? `<button type="button" class="followup-message followup-open-dm" data-id="${lead.id}">${escapeHtml(lead.message)}</button>`
    : '';
  // Belt-and-suspenders: if a step somehow has neither (shouldn't happen for
  // text steps, which require a message), still give the card a way to open
  // the DM rather than being silently unclickable.
  const fallbackLine = (!mediaLine && !messageLine)
    ? `<button type="button" class="followup-message followup-open-dm" data-id="${lead.id}">Open DM →</button>`
    : '';
  return `
    <div class="card followup-card" data-id="${lead.id}">
      <div class="followup-card-head">
        <span class="followup-username">${escapeHtml(leadDisplayName(lead))}</span>
        <span class="muted">Step ${lead.step}</span>
      </div>
      ${mediaLine}
      ${messageLine}
      ${fallbackLine}
      <div class="followup-card-actions">
        <button type="button" class="btn-accept followup-sent-btn" data-id="${lead.id}">✓ Sent</button>
        <button type="button" class="followup-in-conversation-btn" data-id="${lead.id}">💬 In conversation</button>
        <button type="button" class="btn-reject followup-delete-btn" data-id="${lead.id}">✕ Delete lead</button>
      </div>
    </div>`;
}

function renderFollowupList() {
  const list = $('#followup-list');
  const n = followupState.leads.length;
  $('#followup-sub').textContent = n === 0
    ? ''
    : `${n} lead${n === 1 ? '' : 's'} — click a message or media note to open the DM (and copy the message, if there is one), then mark it Sent or delete the lead.`;

  if (n === 0) {
    list.innerHTML = '';
    $('#followup-empty').classList.remove('hidden');
    return;
  }
  $('#followup-empty').classList.add('hidden');
  list.innerHTML = followupState.leads.map(followupCardHtml).join('');
}

function removeFollowupCard(id) {
  const card = document.querySelector(`.followup-card[data-id="${id}"]`);
  if (card) card.classList.add('removing');
  followupState.leads = followupState.leads.filter(l => l.id !== id);
  setTimeout(renderFollowupList, card ? 280 : 0);
}

$('#followup-list').addEventListener('click', async (e) => {
  const openBtn = e.target.closest('.followup-open-dm');
  if (openBtn) {
    const lead = followupState.leads.find(l => l.id === openBtn.dataset.id);
    if (lead) {
      // Start the clipboard write (if there's a message to copy) BEFORE
      // window.open() — Chrome throws "Document is not focused" if
      // writeText() is called after the new tab already has focus, which is
      // exactly what happened when this was ordered the other way: the DM
      // tab opened but nothing got copied. We don't await the write itself;
      // calling window.open() in the same synchronous tick (rather than
      // after an await) keeps this click's user-gesture activation intact
      // for the popup blocker, and the write still completes in the
      // background since it was *initiated* while this document had focus.
      if (lead.message) {
        navigator.clipboard.writeText(lead.message)
          .then(() => {
            openBtn.classList.add('copied');
            setTimeout(() => openBtn.classList.remove('copied'), 900);
          })
          .catch(err => console.error('Clipboard write failed', err));
      }
      window.open(leadDmUrl(lead), 'ig_preview');
    }
    return;
  }

  const sentBtn = e.target.closest('.followup-sent-btn');
  if (sentBtn) {
    const id = sentBtn.dataset.id;
    const lead = followupState.leads.find(l => l.id === id);
    if (!lead) return;
    sentBtn.disabled = true;
    try {
      await fetchJson(`/api/leads/${id}/followup-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: lead.phase, step: lead.step, message: lead.message || '' })
      });
      removeFollowupCard(id);
      loadNotifications();
    } catch (err) {
      alert(`Could not mark as sent: ${err.message}`);
      sentBtn.disabled = false;
    }
    return;
  }

  const conversationBtn = e.target.closest('.followup-in-conversation-btn');
  if (conversationBtn) {
    const id = conversationBtn.dataset.id;
    conversationBtn.disabled = true;
    try {
      await fetchJson(`/api/leads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'in_conversation' })
      });
      removeFollowupCard(id);
      loadNotifications();
    } catch (err) {
      alert(`Could not update stage: ${err.message}`);
      conversationBtn.disabled = false;
    }
    return;
  }

  const delBtn = e.target.closest('.followup-delete-btn');
  if (delBtn) {
    const id = delBtn.dataset.id;
    // deleteLeads() defers its actual server-side call by ~300ms for the row
    // fade-out, so refreshing notifications right away would read stale
    // pre-delete state and leave the bell badge wrong until the next
    // unrelated reload. deleteLeads() returns a promise that resolves after
    // the real delete completes, so await that instead.
    deleteLeads([id]).then(() => loadNotifications());
    removeFollowupCard(id);
  }
});

$('#followup-back-btn').addEventListener('click', () => showView('home'));
$('#followup-done-btn').addEventListener('click', () => showView('home'));

// ---------- Settings ----------

const settingsState = { templates: [], followups: [], phase: 1, followupPlatform: 'instagram', reminders: [], accounts: [] };

async function loadSettingsPage() {
  try {
    const [tplData, fuData, appData] = await Promise.all([
      fetchJson('/api/settings/templates'),
      fetchJson(`/api/settings/followups?platform=${settingsState.followupPlatform}`),
      fetchJson('/api/settings/app'),
      loadReminders(),
      loadAccounts()
    ]);
    settingsState.templates = tplData.templates || [];
    settingsState.followups = fuData.followups || [];
    $('#settings-calendar-link').value = (appData.settings && appData.settings.calendar_link) || '';
    $('#settings-views-threshold').value = (appData.settings && appData.settings.views_threshold) || 1000;
    $('#settings-connection-delay').value = (appData.settings && appData.settings.linkedin_connection_delay_days) ?? 2;
    $('#settings-daily-goal-instagram').value = (appData.settings && appData.settings.daily_goal_instagram) || 0;
    $('#settings-daily-goal-linkedin').value = (appData.settings && appData.settings.daily_goal_linkedin) || 0;
    renderSettingsTemplates();
    renderSettingsFollowups();
  } catch (e) {
    alert(`Could not load settings: ${e.message}`);
  }
}

async function loadFollowupsForPlatform() {
  try {
    const fuData = await fetchJson(`/api/settings/followups?platform=${settingsState.followupPlatform}`);
    settingsState.followups = fuData.followups || [];
  } catch (e) {
    alert(`Could not load ${settingsState.followupPlatform} follow-ups: ${e.message}`);
    return;
  }
  renderSettingsFollowups();
}

$('#settings-followup-platform-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#settings-followup-platform-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  settingsState.followupPlatform = btn.dataset.platform;
  loadFollowupsForPlatform();
});

// The actual wording (opener/hook/value/cta per category) lives in the
// database and is composed + rotated behind the scenes by app.js — only the
// category label is exposed here to edit.
function renderSettingsTemplates() {
  const wrap = $('#settings-templates');
  wrap.innerHTML = settingsState.templates.map(t => `
    <div class="settings-template-item">
      <label>Label
        <input type="text" value="${escapeHtml(t.label)}" data-tpl-id="${t.id}" data-field="label">
      </label>
    </div>
  `).join('');
}

$('#settings-templates').addEventListener('change', async (e) => {
  const field = e.target.dataset.field;
  if (field !== 'label') return;
  const id = e.target.dataset.tplId;
  try {
    await fetchJson(`/api/settings/templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: e.target.value })
    });
  } catch (err) {
    alert(`Could not save template: ${err.message}`);
  }
});

$('#settings-phase-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-phase]');
  if (!btn) return;
  $all('#settings-phase-tabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  settingsState.phase = Number(btn.dataset.phase);
  renderSettingsFollowups();
});

function renderSettingsFollowups() {
  const wrap = $('#settings-followups');
  const steps = settingsState.followups
    .filter(f => f.phase === settingsState.phase)
    .sort((a, b) => a.step - b.step);

  wrap.innerHTML = steps.map(s => `
    <div class="settings-followup-item">
      <div class="settings-followup-head">
        <span class="settings-followup-step">Step ${s.step}</span>
        <label class="settings-followup-day">Day
          <input type="number" min="0" value="${s.dayOffset}" data-phase="${s.phase}" data-step="${s.step}" data-field="dayOffset">
        </label>
        <label class="settings-followup-type">Type
          <select data-phase="${s.phase}" data-step="${s.step}" data-field="type">
            <option value="text"${s.type === 'text' ? ' selected' : ''}>Text</option>
            <option value="gif"${s.type === 'gif' ? ' selected' : ''}>GIF</option>
            <option value="meme"${s.type === 'meme' ? ' selected' : ''}>Meme</option>
          </select>
        </label>
      </div>
      ${s.type !== 'text' ? `<label>Media description
        <input type="text" value="${escapeHtml(s.mediaNote || '')}" data-phase="${s.phase}" data-step="${s.step}" data-field="mediaNote" placeholder="What GIF/meme to send">
      </label>` : ''}
      ${s.message ? `<p class="muted settings-followup-composed-note">Wording is composed automatically from several phrasings for this step.</p>` : ''}
    </div>
  `).join('');
  $all('#settings-followups textarea.auto-resize').forEach(autoResizeTextarea);
}

$('#settings-followups').addEventListener('change', async (e) => {
  const { phase, step, field } = e.target.dataset;
  if (!phase || !step || !field) return;
  const entry = settingsState.followups.find(f => f.phase === Number(phase) && f.step === Number(step));
  const previousValue = entry ? entry[field] : undefined;
  if (entry) entry[field] = e.target.value;
  try {
    await fetchJson(`/api/settings/followups/${phase}/${step}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: e.target.value, platform: settingsState.followupPlatform })
    });
    if (field === 'type') renderSettingsFollowups();
  } catch (err) {
    // Revert the optimistic in-memory update so a failed save doesn't leave
    // settingsState (and, on the next re-render, the form) silently out of
    // sync with what's actually persisted — matches leads.js's updateLeadField.
    if (entry) entry[field] = previousValue;
    alert(`Could not save follow-up step: ${err.message}`);
    renderSettingsFollowups();
  }
});
$('#settings-followups').addEventListener('input', (e) => {
  if (e.target.classList.contains('auto-resize')) autoResizeTextarea(e.target);
});

// ---------- Reminders ----------

async function loadReminders() {
  try {
    const data = await fetchJson('/api/reminders');
    settingsState.reminders = data.reminders || [];
  } catch (e) {
    console.error('Could not load reminders', e);
  }
  renderRemindersList();
}

function formatReminderDue(dueAt) {
  const d = new Date(dueAt);
  const text = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return d <= new Date() ? `⏰ Due ${text}` : `Due ${text}`;
}

// Reuses the same leadDisplayName (app.js) every other page uses for
// @username-vs-full-name — the search value strips the leading "@" since
// the Leads page's search filter matches against the raw username column.
function reminderLeadTag(r) {
  // r.leadId alone isn't enough — it survives even after the linked lead is
  // soft-deleted (the server's LEFT JOIN excludes deleted leads, nulling out
  // the rest), which would otherwise render as a confusing "📎 Unknown" tag.
  if (!r.leadUsername && !r.leadFullName) return '';
  const name = leadDisplayName({ platform: r.leadPlatform, username: r.leadUsername, fullName: r.leadFullName });
  return `<button type="button" class="reminder-lead-tag" data-lead-search="${escapeHtml(name.replace(/^@/, ''))}">📎 ${escapeHtml(name)}</button>`;
}

function renderRemindersList() {
  const wrap = $('#reminders-list');
  if (settingsState.reminders.length === 0) {
    wrap.innerHTML = '<p class="muted">No reminders set.</p>';
    return;
  }
  wrap.innerHTML = settingsState.reminders.map(r => `
    <div class="reminder-row" data-id="${r.id}">
      <div class="reminder-row-main">
        <div class="reminder-row-text">${escapeHtml(r.text)}</div>
        <div class="muted reminder-row-meta"><span>${formatReminderDue(r.dueAt)}</span>${reminderLeadTag(r)}</div>
      </div>
      <button type="button" class="reminder-delete-btn" data-id="${r.id}" title="Delete reminder">🗑</button>
    </div>
  `).join('');
}

$('#reminders-list').addEventListener('click', async (e) => {
  const tagBtn = e.target.closest('.reminder-lead-tag');
  if (tagBtn) {
    showView('leads');
    leadsState.search = tagBtn.dataset.leadSearch;
    $('#leads-search').value = leadsState.search;
    leadsState.page = 0;
    renderLeadsTable();
    return;
  }
  const delBtn = e.target.closest('.reminder-delete-btn');
  if (delBtn) {
    delBtn.disabled = true;
    try {
      await fetchJson(`/api/reminders/${delBtn.dataset.id}`, { method: 'DELETE' });
      settingsState.reminders = settingsState.reminders.filter(r => r.id !== delBtn.dataset.id);
      renderRemindersList();
      loadNotifications();
    } catch (err) {
      alert(`Could not delete reminder: ${err.message}`);
      delBtn.disabled = false;
    }
  }
});

// Lazily loaded once, not on every keystroke — same "load everything, filter
// client-side" approach the Leads page itself already uses at this lead-list
// size (the picker modal below only ever renders a capped slice of it).
let reminderLeadsCache = null;

async function ensureReminderLeadsCache() {
  if (reminderLeadsCache) return reminderLeadsCache;
  try {
    const data = await fetchJson('/api/leads');
    reminderLeadsCache = data.leads || [];
  } catch (e) {
    reminderLeadsCache = [];
  }
  return reminderLeadsCache;
}

// ---------- Reminder lead picker (platform + search + stage, like Leads) ----------

const REMINDER_PICKER_MAX_ROWS = 50;
const reminderPickerState = { platform: 'all', search: '', stage: '' };
let reminderSelectedLead = null; // { id, name }

function updateReminderLeadSelectedDisplay() {
  $('#reminder-lead-picker-btn').classList.toggle('hidden', !!reminderSelectedLead);
  $('#reminder-lead-selected').classList.toggle('hidden', !reminderSelectedLead);
  if (reminderSelectedLead) $('#reminder-lead-selected-name').textContent = reminderSelectedLead.name;
}

function populateReminderPickerStageOptions() {
  const sel = $('#reminder-picker-stage');
  const options = stageOptionsFor(reminderPickerState.platform === 'all' ? 'all' : reminderPickerState.platform);
  sel.innerHTML = '<option value="">All stages</option>' + options.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
  sel.value = reminderPickerState.stage;
}

function renderReminderPickerList() {
  const q = reminderPickerState.search.trim().toLowerCase();
  const matches = (reminderLeadsCache || []).filter(l => {
    if (reminderPickerState.platform !== 'all' && l.platform !== reminderPickerState.platform) return false;
    if (reminderPickerState.stage && l.stage !== reminderPickerState.stage) return false;
    if (q && !leadDisplayName(l).toLowerCase().includes(q)) return false;
    return true;
  });
  const shown = matches.slice(0, REMINDER_PICKER_MAX_ROWS);
  $('#reminder-picker-count').textContent = matches.length > REMINDER_PICKER_MAX_ROWS
    ? `Showing ${REMINDER_PICKER_MAX_ROWS} of ${matches.length} — narrow your search to see more`
    : `${matches.length} lead${matches.length === 1 ? '' : 's'}`;
  $('#reminder-picker-list').innerHTML = shown.length
    ? shown.map(l => `
        <button type="button" class="reminder-picker-row" data-id="${l.id}" data-name="${escapeHtml(leadDisplayName(l))}">
          <span class="reminder-picker-row-name">${escapeHtml(leadDisplayName(l))}</span>
          <span class="reminder-picker-row-stage">${escapeHtml(stageLabel(l))}</span>
        </button>`).join('')
    : '<p class="muted" style="padding:14px;">No leads match.</p>';
}

async function openReminderLeadPicker() {
  await ensureReminderLeadsCache();
  reminderPickerState.platform = 'all';
  reminderPickerState.search = '';
  reminderPickerState.stage = '';
  $('#reminder-picker-search').value = '';
  $all('#reminder-picker-platform-tabs .range-tab').forEach(b => b.classList.toggle('active', b.dataset.platform === 'all'));
  populateReminderPickerStageOptions();
  renderReminderPickerList();
  $('#reminder-lead-picker-modal').classList.remove('hidden');
}

$('#reminder-lead-picker-btn').addEventListener('click', openReminderLeadPicker);
$('#reminder-picker-cancel-btn').addEventListener('click', () => $('#reminder-lead-picker-modal').classList.add('hidden'));
$('#reminder-lead-selected-clear').addEventListener('click', () => {
  reminderSelectedLead = null;
  updateReminderLeadSelectedDisplay();
});

$('#reminder-picker-platform-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#reminder-picker-platform-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  reminderPickerState.platform = btn.dataset.platform;
  reminderPickerState.stage = '';
  populateReminderPickerStageOptions();
  renderReminderPickerList();
});
$('#reminder-picker-search').addEventListener('input', (e) => {
  reminderPickerState.search = e.target.value;
  renderReminderPickerList();
});
$('#reminder-picker-stage').addEventListener('change', (e) => {
  reminderPickerState.stage = e.target.value;
  renderReminderPickerList();
});
$('#reminder-picker-list').addEventListener('click', (e) => {
  const row = e.target.closest('.reminder-picker-row');
  if (!row) return;
  reminderSelectedLead = { id: row.dataset.id, name: row.dataset.name };
  $('#reminder-lead-picker-modal').classList.add('hidden');
  updateReminderLeadSelectedDisplay();
});

$('#reminder-add-btn').addEventListener('click', async () => {
  const text = $('#reminder-text').value.trim();
  const days = Number($('#reminder-due-days').value);
  if (!text) { alert('Enter some reminder text.'); return; }
  if (!Number.isFinite(days) || days < 0) { alert('Enter a valid number of days (0 or more).'); return; }
  const dueAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const btn = $('#reminder-add-btn');
  btn.disabled = true;
  try {
    await fetchJson('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, dueAt: dueAt.toISOString(), leadId: reminderSelectedLead ? reminderSelectedLead.id : null })
    });
    $('#reminder-text').value = '';
    $('#reminder-due-days').value = '1';
    reminderSelectedLead = null;
    updateReminderLeadSelectedDisplay();
    await loadReminders();
    loadNotifications();
  } catch (err) {
    alert(`Could not add reminder: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Instagram accounts ----------

async function loadAccounts() {
  try {
    const data = await fetchJson('/api/accounts');
    settingsState.accounts = data.accounts || [];
    // A lazy auto-upgrade may have just fired server-side (see GET
    // /api/accounts) and inserted a reminder announcing it — refresh the
    // bell so it shows up without waiting for the next unrelated reload.
    if (data.upgraded && data.upgraded.length > 0) loadNotifications();
  } catch (e) {
    console.error('Could not load accounts', e);
  }
  renderAccountsList();
}

function formatAccountAge(ageDays) {
  if (ageDays < 30) return `${ageDays} day${ageDays === 1 ? '' : 's'} old`;
  const months = Math.floor(ageDays / 30);
  return `${months} month${months === 1 ? '' : 's'} old`;
}

function accountPhotoHtml(a) {
  if (a.profileImageUrl) return `<img class="account-photo" src="${escapeHtml(a.profileImageUrl)}" alt="">`;
  const letter = (a.username || '?').charAt(0).toUpperCase();
  return `<div class="account-photo account-photo-placeholder">${escapeHtml(letter)}</div>`;
}

function renderAccountsList() {
  const wrap = $('#accounts-list');
  if (settingsState.accounts.length === 0) {
    wrap.innerHTML = '<p class="muted">No accounts yet — add one to start tracking daily send limits.</p>';
    return;
  }
  wrap.innerHTML = settingsState.accounts.map(a => {
    const isWarming = a.phase === 'warming_up';
    const isRamping = a.phase === 'ramping_up';
    let statusHtml = '';
    if (isWarming) {
      statusHtml = `
        <div class="account-warmup-badge">
          <span>⚠️ Account needs warming up — day ${a.warmupDay} of 7</span>
          <button type="button" class="account-skip-warmup-btn" data-id="${a.id}">Skip warmup</button>
        </div>`;
    } else if (isRamping) {
      statusHtml = `
        <div class="account-ramp-note">
          <span>🔥 Ramping up — day ${a.rampDay}, ${a.dailyLimit}/day so far (target ${a.tierCap}/day)</span>
          <button type="button" class="account-skip-rampup-btn" data-id="${a.id}">Skip ramp up</button>
        </div>`;
    }
    return `
      <div class="account-row${isWarming ? ' account-row-warming' : ''}" data-id="${a.id}">
        <div class="account-row-main">
          ${accountPhotoHtml(a)}
          <div class="account-main">
            <div class="account-username">@${escapeHtml(a.username)}</div>
            <div class="muted account-meta">${formatAccountAge(a.ageDays)} · tier cap ${a.tierCap}/day · sent ${a.todaySentCount} today</div>
          </div>
          <label class="account-limit-label">Daily limit
            <input type="number" min="1" class="account-limit-input" data-id="${a.id}" value="${a.dailyLimit}"${isWarming || isRamping ? ' disabled' : ''}>
          </label>
          ${a.overTierCap ? '<span class="account-over-cap" title="Above the recommended limit for an account this age">⚠️</span>' : '<span class="account-over-cap-spacer"></span>'}
          <button type="button" class="account-archive-btn" data-id="${a.id}" title="Archive this account">🗑</button>
        </div>
        ${statusHtml}
      </div>`;
  }).join('');
}

$('#accounts-list').addEventListener('change', async (e) => {
  const input = e.target.closest('.account-limit-input');
  if (!input) return;
  const id = input.dataset.id;
  const account = settingsState.accounts.find(a => a.id === id);
  if (!account) return;
  const newValue = Math.max(1, Math.round(Number(input.value)) || 1);

  if (newValue > account.tierCap) {
    const ok = confirm(`This is above the recommended ${account.tierCap}/day limit for an account ${formatAccountAge(account.ageDays)} — Instagram may flag unusually high send volume. Set it anyway?`);
    if (!ok) {
      input.value = account.dailyLimit;
      return;
    }
  }

  const previous = account.dailyLimit;
  account.dailyLimit = newValue;
  input.value = newValue;
  try {
    await fetchJson(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyLimit: newValue })
    });
    account.overTierCap = newValue > account.tierCap;
    renderAccountsList();
  } catch (err) {
    account.dailyLimit = previous;
    input.value = previous;
    alert(`Could not save daily limit: ${err.message}`);
  }
});

$('#accounts-list').addEventListener('click', async (e) => {
  const archiveBtn = e.target.closest('.account-archive-btn');
  if (archiveBtn) {
    const id = archiveBtn.dataset.id;
    const account = settingsState.accounts.find(a => a.id === id);
    if (!account) return;
    if (!confirm(`Archive @${account.username}? It'll stop showing up when starting new sessions, but its send history stays intact.`)) return;
    archiveBtn.disabled = true;
    try {
      await fetchJson(`/api/accounts/${id}`, { method: 'DELETE' });
      settingsState.accounts = settingsState.accounts.filter(a => a.id !== id);
      renderAccountsList();
    } catch (err) {
      alert(`Could not archive account: ${err.message}`);
      archiveBtn.disabled = false;
    }
    return;
  }

  const skipWarmupBtn = e.target.closest('.account-skip-warmup-btn');
  if (skipWarmupBtn) {
    const id = skipWarmupBtn.dataset.id;
    const account = settingsState.accounts.find(a => a.id === id);
    if (!account) return;
    if (!confirm(`Skip @${account.username}'s 7-day warmup? Sending right away on a brand-new account is more likely to get it flagged — only do this if you know what you're doing.`)) return;
    skipWarmupBtn.disabled = true;
    try {
      await fetchJson(`/api/accounts/${id}/skip-warmup`, { method: 'POST' });
      await loadAccounts();
    } catch (err) {
      alert(`Could not skip warmup: ${err.message}`);
      skipWarmupBtn.disabled = false;
    }
    return;
  }

  const skipRampupBtn = e.target.closest('.account-skip-rampup-btn');
  if (skipRampupBtn) {
    const id = skipRampupBtn.dataset.id;
    const account = settingsState.accounts.find(a => a.id === id);
    if (!account) return;
    if (!confirm(`Skip @${account.username}'s ramp-up and jump straight to ${account.tierCap}/day? Ramping up gradually is the safer way to grow a new account's sending volume — only do this if you know what you're doing.`)) return;
    skipRampupBtn.disabled = true;
    try {
      await fetchJson(`/api/accounts/${id}/skip-rampup`, { method: 'POST' });
      await loadAccounts();
    } catch (err) {
      alert(`Could not skip ramp-up: ${err.message}`);
      skipRampupBtn.disabled = false;
    }
  }
});

let pendingAccountImageUrl = null;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$('#accounts-add-btn').addEventListener('click', () => {
  $('#add-account-username').value = '';
  $('#add-account-created-on').value = '';
  $('#add-account-image').value = '';
  $('#add-account-image-status').textContent = '';
  $('#add-account-error').style.display = 'none';
  pendingAccountImageUrl = null;
  $('#add-account-modal').classList.remove('hidden');
});

$('#add-account-cancel-btn').addEventListener('click', () => $('#add-account-modal').classList.add('hidden'));

$('#add-account-image').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = $('#add-account-image-status');
  statusEl.textContent = 'Uploading…';
  try {
    const base64 = await fileToBase64(file);
    const data = await fetchJson('/api/accounts/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64, contentType: file.type })
    }, 30000);
    pendingAccountImageUrl = data.url;
    statusEl.textContent = '✓ Uploaded';
  } catch (err) {
    statusEl.textContent = `Could not upload image: ${err.message}`;
    pendingAccountImageUrl = null;
  }
});

$('#add-account-confirm-btn').addEventListener('click', async () => {
  const username = $('#add-account-username').value.trim().replace('@', '');
  const createdOn = $('#add-account-created-on').value;
  const errorEl = $('#add-account-error');
  errorEl.style.display = 'none';
  if (!username) { errorEl.textContent = 'Enter a username.'; errorEl.style.display = 'block'; return; }
  if (!createdOn) { errorEl.textContent = 'Enter the date this account was created.'; errorEl.style.display = 'block'; return; }

  const btn = $('#add-account-confirm-btn');
  btn.disabled = true;
  try {
    await fetchJson('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, createdOn, profileImageUrl: pendingAccountImageUrl })
    });
    $('#add-account-modal').classList.add('hidden');
    await loadAccounts();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

$('#settings-daily-goal-save').addEventListener('click', async () => {
  const btn = $('#settings-daily-goal-save');
  btn.disabled = true;
  try {
    await fetchJson('/api/settings/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyGoalInstagram: Number($('#settings-daily-goal-instagram').value) || 0,
        dailyGoalLinkedin: Number($('#settings-daily-goal-linkedin').value) || 0
      })
    });
  } catch (err) {
    alert(`Could not save daily goal: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#settings-general-save').addEventListener('click', async () => {
  const btn = $('#settings-general-save');
  btn.disabled = true;
  try {
    await fetchJson('/api/settings/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarLink: $('#settings-calendar-link').value,
        viewsThreshold: Number($('#settings-views-threshold').value) || 0,
        linkedinConnectionDelayDays: Number($('#settings-connection-delay').value) || 0
      })
    });
    state.viewsThreshold = Number($('#settings-views-threshold').value) || 0;
  } catch (err) {
    alert(`Could not save settings: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

loadNotifications();
