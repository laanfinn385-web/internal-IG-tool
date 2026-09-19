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
    if (n.type === 'warmup_post') {
      // Warmup-only, one-click-to-complete — no separate view, no dismiss
      // (the only way it leaves the list is by actually being done).
      return `
        <div class="notif-row">
          <button type="button" class="notif-item" data-type="warmup_post" data-task-id="${n.taskId}">
            <div class="notif-item-main">
              <span class="notif-item-phase">📸 Post something today</span>
              <span class="notif-item-count">@${escapeHtml(n.accountUsername || '')} is warming up — click to check off</span>
            </div>
            <span class="notif-item-time">${timeAgo(n.earliestDue)}</span>
          </button>
        </div>`;
    }
    if (n.type === 'warmup_engage') {
      const minutes = Math.round(n.targetSeconds / 60);
      let progress = `~${minutes} min`;
      let label = 'Start scrolling session →';
      if (n.running) label = 'Resume →';
      else if (n.elapsedSeconds > 0) { progress = `${Math.floor(n.elapsedSeconds / 60)}m of ~${minutes}m done`; label = 'Continue →'; }
      return `
        <div class="notif-row">
          <button type="button" class="notif-item" data-type="warmup_engage" data-task-id="${n.taskId}">
            <div class="notif-item-main">
              <span class="notif-item-phase">📱 Scroll &amp; engage</span>
              <span class="notif-item-count">@${escapeHtml(n.accountUsername || '')} — ${progress} — ${label}</span>
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
    const accountLabel = n.platform === 'instagram' && n.accountUsername ? ` — @${escapeHtml(n.accountUsername)}` : '';
    return `
      <div class="notif-row">
        <button type="button" class="notif-item" data-type="followup" data-phase="${n.phase}" data-platform="${n.platform}" data-account-id="${n.accountId || ''}">
          <div class="notif-item-main">
            <span class="notif-item-phase">${PLATFORM_LABELS[n.platform]} ${PHASE_NAMES[n.phase]}${accountLabel}</span>
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
  } else if (item.dataset.type === 'warmup_post') {
    try {
      await fetchJson(`/api/warmup-tasks/${item.dataset.taskId}/complete`, { method: 'POST' });
      loadNotifications();
    } catch (err) {
      alert(`Could not mark as posted: ${err.message}`);
    }
  } else if (item.dataset.type === 'warmup_engage') {
    openWarmupEngageSession(item.dataset.taskId);
  } else {
    openFollowupSession(Number(item.dataset.phase), item.dataset.platform, item.dataset.accountId || null);
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

const followupState = { phase: null, platform: 'instagram', accountId: null, leads: [] };

async function openFollowupSession(phase, platform, accountId = null) {
  followupState.phase = phase;
  followupState.platform = platform === 'linkedin' ? 'linkedin' : 'instagram';
  followupState.accountId = followupState.platform === 'instagram' ? accountId : null;
  $('#followup-title').textContent = `${PLATFORM_LABELS[followupState.platform]} ${PHASE_NAMES[phase]} Follow-ups`;
  $('#followup-list').innerHTML = '<p class="muted">Loading…</p>';
  $('#followup-sub').textContent = '';
  $('#followup-empty').classList.add('hidden');
  showView('followup');
  try {
    const accountParam = followupState.accountId ? `&accountId=${encodeURIComponent(followupState.accountId)}` : '';
    const data = await fetchJson(`/api/followups/due?phase=${phase}&platform=${followupState.platform}${accountParam}`);
    followupState.leads = data.leads || [];
    // The notification that opened this session was already scoped to one
    // account (that's how it knew "8 leads to follow up with" in the first
    // place) — surfacing the username here is the "auto-select the right
    // account" requirement, since there's no separate picker step to skip.
    const accountUsername = followupState.leads[0]?.accountUsername;
    $('#followup-sub').textContent = accountUsername ? `Sending as @${accountUsername}` : '';
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
      const result = await fetchJson(`/api/leads/${id}/followup-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: lead.phase, step: lead.step, message: lead.message || '' })
      });
      removeFollowupCard(id);
      loadNotifications();
      // Warn, don't block — the real prevention already happened up front
      // via effectiveRemainingForNewSends when the session was started.
      if (result.accountTodaySentCount != null && result.accountTodaySentCount >= result.accountDailyLimit) {
        const account = findIgAccount(result.accountId);
        const username = account ? account.username : 'This account';
        alert(`⚠️ @${username} is now over its daily limit (${result.accountTodaySentCount}/${result.accountDailyLimit}) — no action needed, just a heads up.`);
      }
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

// followups here are LinkedIn's only — Instagram's own follow-up sequence
// now lives per Messaging sequence (see loadMessageSequences() below).
const settingsState = { followups: [], phase: 1, reminders: [], accounts: [] };

async function loadSettingsPage() {
  renderProfileSettingsCard();
  try {
    const [fuData, appData] = await Promise.all([
      fetchJson('/api/settings/followups?platform=linkedin'),
      fetchJson('/api/settings/app'),
      loadReminders(),
      loadAccounts()
    ]);
    settingsState.followups = fuData.followups || [];
    $('#settings-calendar-link').value = (appData.settings && appData.settings.calendar_link) || '';
    $('#settings-views-threshold').value = (appData.settings && appData.settings.views_threshold) || 1000;
    $('#settings-connection-delay').value = (appData.settings && appData.settings.linkedin_connection_delay_days) ?? 2;
    $('#settings-followup-due-hour').value = (appData.settings && appData.settings.followup_due_hour) ?? 4;
    $('#settings-daily-goal-instagram').value = (appData.settings && appData.settings.daily_goal_instagram) || 0;
    $('#settings-daily-goal-linkedin').value = (appData.settings && appData.settings.daily_goal_linkedin) || 0;
    $('#settings-daily-goal-instagram-sync').checked = !!(appData.settings && appData.settings.daily_goal_instagram_sync === 'true');
    applyDailyGoalSyncState();
    renderSettingsFollowups();
  } catch (e) {
    alert(`Could not load settings: ${e.message}`);
  }
}

// ---------- Settings: Profile card (the active workspace's own name,
// picture, and platform toggles — workspacePhotoHtml/activeWorkspace/
// setActiveWorkspaceId/fileToBase64 all defined in app.js, callable here
// since every public/*.js file shares one global scope) ----------
let pendingProfileSettingsImageUrl = null;

function renderProfileSettingsCard() {
  const ws = activeWorkspace();
  if (!ws) return;
  $('#profile-settings-avatar').innerHTML = workspacePhotoHtml(ws);
  $('#profile-settings-name').value = ws.name;
  $('#profile-settings-instagram').checked = ws.instagramEnabled;
  $('#profile-settings-linkedin').checked = ws.linkedinEnabled;
  $('#profile-settings-image').value = '';
  $('#profile-settings-image-status').classList.add('hidden');
  $('#profile-settings-error').classList.add('hidden');
  pendingProfileSettingsImageUrl = null;
}

$('#profile-settings-image').addEventListener('change', async () => {
  const file = $('#profile-settings-image').files[0];
  const statusEl = $('#profile-settings-image-status');
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
    pendingProfileSettingsImageUrl = data.url;
    statusEl.textContent = '✓ Uploaded';
  } catch (e) {
    pendingProfileSettingsImageUrl = null;
    statusEl.textContent = `Could not upload (${e.message})`;
  }
});

$('#profile-settings-save-btn').addEventListener('click', async () => {
  const ws = activeWorkspace();
  if (!ws) return;
  const name = $('#profile-settings-name').value.trim();
  const errorEl = $('#profile-settings-error');
  if (!name) {
    errorEl.textContent = 'A name is required.';
    errorEl.classList.remove('hidden');
    return;
  }
  const instagramEnabled = $('#profile-settings-instagram').checked;
  const linkedinEnabled = $('#profile-settings-linkedin').checked;
  if (!instagramEnabled && !linkedinEnabled) {
    errorEl.textContent = 'Select at least one platform.';
    errorEl.classList.remove('hidden');
    return;
  }
  const btn = $('#profile-settings-save-btn');
  btn.disabled = true;
  try {
    const body = { name, instagramEnabled, linkedinEnabled };
    if (pendingProfileSettingsImageUrl) body.pictureUrl = pendingProfileSettingsImageUrl;
    await fetchJson(`/api/workspaces/${ws.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    // The switcher's display and every platform-visibility check both need
    // this profile's fresh fields — simplest is the same full reload every
    // other workspace-affecting action already uses.
    location.reload();
  } catch (e) {
    btn.disabled = false;
    errorEl.textContent = `Could not save: ${e.message}`;
    errorEl.classList.remove('hidden');
  }
});

$('#profile-settings-archive-btn').addEventListener('click', async () => {
  const ws = activeWorkspace();
  if (!ws) return;
  if (!confirm(`Archive "${ws.name}"? Its leads/accounts/sequences stay intact but you won't be able to switch to it anymore.`)) return;
  const btn = $('#profile-settings-archive-btn');
  btn.disabled = true;
  try {
    await fetchJson(`/api/workspaces/${ws.id}`, { method: 'DELETE' });
    // Switch to whatever's left before reloading, so the app doesn't come
    // back up still pointed at the profile that was just archived.
    const remaining = workspacesCache.filter(w => w.id !== ws.id);
    if (remaining.length > 0) setActiveWorkspaceId(remaining[0].id);
    location.reload();
  } catch (e) {
    btn.disabled = false;
    alert(`Could not archive this profile: ${e.message}`);
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
      body: JSON.stringify({ [field]: e.target.value, platform: 'linkedin' })
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
    const [data, timingData, messageData] = await Promise.all([
      fetchJson('/api/accounts'),
      fetchJson('/api/timing-sequences'),
      fetchJson('/api/message-sequences')
    ]);
    settingsState.accounts = data.accounts || [];
    // Shared with the dedicated Timing/Messaging sequences pages' own
    // caches — just names/ids are needed here for the per-account
    // assignment dropdowns.
    timingSeqState.sequences = timingData.sequences || [];
    messageSeqState.sequences = messageData.sequences || [];
    // A warmup-just-ended transition may have just fired server-side (see
    // GET /api/accounts) and inserted a reminder announcing it — refresh the
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
          <span>⚠️ Account needs warming up — day ${a.warmupDay} of ${a.warmupDays}</span>
          <div class="account-warmup-badge-actions">
            <button type="button" class="account-skip-warmup-btn" data-id="${a.id}">Skip warmup</button>
          </div>
        </div>`;
    } else if (isRamping) {
      statusHtml = `
        <div class="account-ramp-note">
          <span>🔥 Ramping up — day ${a.rampDay}, ${a.dailyLimit}/day so far (target ${a.plateauLimit}/day)</span>
          <button type="button" class="account-skip-rampup-btn" data-id="${a.id}">Skip ramp up</button>
        </div>`;
    }
    const sequenceOptions = timingSeqState.sequences.map(s =>
      `<option value="${s.id}"${s.id === a.timingSequenceId ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
    const messageSequenceOptions = messageSeqState.sequences.map(s =>
      `<option value="${s.id}"${s.id === a.messageSequenceId ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
    return `
      <div class="account-row${isWarming ? ' account-row-warming' : ''}" data-id="${a.id}">
        <div class="account-row-main">
          ${accountPhotoHtml(a)}
          <div class="account-main">
            <div class="account-username">@${escapeHtml(a.username)}</div>
            <div class="muted account-meta">${formatAccountAge(a.ageDays)} · recommended max ${a.tierCap}/day · sent ${a.todaySentCount} today · ${a.dailyLimit}/day limit</div>
          </div>
          <label class="account-limit-label">Timing sequence
            <select class="account-timing-seq-select" data-id="${a.id}">${sequenceOptions}</select>
          </label>
          <label class="account-limit-label">Messaging sequence
            <select class="account-message-seq-select" data-id="${a.id}">${messageSequenceOptions}</select>
          </label>
          ${a.overTierCap ? '<span class="account-over-cap" title="Above the recommended max for an account this age">⚠️</span>' : '<span class="account-over-cap-spacer"></span>'}
          <button type="button" class="account-restart-warmup-btn" data-id="${a.id}" title="Send this account back into warmup, whatever phase it's in">↩️ Restart warmup</button>
          <button type="button" class="account-archive-btn" data-id="${a.id}" title="Archive this account">🗑</button>
        </div>
        ${statusHtml}
      </div>`;
  }).join('');
}

$('#accounts-list').addEventListener('change', async (e) => {
  const timingSelect = e.target.closest('.account-timing-seq-select');
  const messageSelect = e.target.closest('.account-message-seq-select');
  const select = timingSelect || messageSelect;
  if (!select) return;
  const id = select.dataset.id;
  const account = settingsState.accounts.find(a => a.id === id);
  if (!account) return;
  const field = timingSelect ? 'timingSequenceId' : 'messageSequenceId';
  const previous = account[field];
  const newSequenceId = select.value;
  select.disabled = true;
  try {
    await fetchJson(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: newSequenceId })
    });
    await loadAccounts(); // limit/phase/warmup-days all derive from the new sequence
  } catch (err) {
    select.value = previous;
    alert(`Could not reassign ${timingSelect ? 'Timing' : 'Messaging'} sequence: ${err.message}`);
  } finally {
    select.disabled = false;
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

  const restartWarmupBtn = e.target.closest('.account-restart-warmup-btn');
  if (restartWarmupBtn) {
    const id = restartWarmupBtn.dataset.id;
    const account = settingsState.accounts.find(a => a.id === id);
    if (!account) return;
    if (!confirm(`Restart @${account.username}'s warmup from scratch? Its daily limit resets to 0 and it goes through the full warmup + ramp-up cycle again — use this if something's gone wrong on Instagram's end and the account needs a genuine reset.`)) return;
    restartWarmupBtn.disabled = true;
    try {
      await fetchJson(`/api/accounts/${id}/restart-warmup`, { method: 'POST' });
      await loadAccounts();
    } catch (err) {
      alert(`Could not restart warmup: ${err.message}`);
      restartWarmupBtn.disabled = false;
    }
    return;
  }

  const skipWarmupBtn = e.target.closest('.account-skip-warmup-btn');
  if (skipWarmupBtn) {
    const id = skipWarmupBtn.dataset.id;
    const account = settingsState.accounts.find(a => a.id === id);
    if (!account) return;
    if (!confirm(`Skip @${account.username}'s ${account.warmupDays}-day warmup? Sending right away on a brand-new account is more likely to get it flagged — only do this if you know what you're doing.`)) return;
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
    if (!confirm(`Skip @${account.username}'s ramp-up and jump straight to ${account.plateauLimit}/day? Ramping up gradually is the safer way to grow a new account's sending volume — only do this if you know what you're doing.`)) return;
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

// While syncing, the manual number is server-overridden anyway — disabling
// the input here is just so it doesn't look editable, matching how a
// ramping-up account's daily-limit field is treated in the accounts list.
function applyDailyGoalSyncState() {
  $('#settings-daily-goal-instagram').disabled = $('#settings-daily-goal-instagram-sync').checked;
}
$('#settings-daily-goal-instagram-sync').addEventListener('change', applyDailyGoalSyncState);

$('#settings-daily-goal-save').addEventListener('click', async () => {
  const btn = $('#settings-daily-goal-save');
  btn.disabled = true;
  try {
    await fetchJson('/api/settings/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyGoalInstagram: Number($('#settings-daily-goal-instagram').value) || 0,
        dailyGoalLinkedin: Number($('#settings-daily-goal-linkedin').value) || 0,
        dailyGoalInstagramSync: $('#settings-daily-goal-instagram-sync').checked
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
        linkedinConnectionDelayDays: Number($('#settings-connection-delay').value) || 0,
        followupDueHour: Number($('#settings-followup-due-hour').value) || 0
      })
    });
    state.viewsThreshold = Number($('#settings-views-threshold').value) || 0;
  } catch (err) {
    alert(`Could not save settings: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Timing sequences ----------
// Named, reusable presets bundling a daily-limit ramp curve + an in-session
// send/pause pacing pattern, assignable per Instagram account (see the
// Timing-sequence <select> on each account row, further down). Reached from
// Settings rather than living inline there, so Settings itself doesn't get
// cluttered as this grows.

const timingSeqState = { sequences: [], activeId: null };

function activeTimingSeq() {
  return timingSeqState.sequences.find(s => s.id === timingSeqState.activeId) || null;
}

async function loadTimingSequences(preserveActiveId) {
  try {
    const data = await fetchJson('/api/timing-sequences');
    timingSeqState.sequences = data.sequences || [];
    const wantId = preserveActiveId || timingSeqState.activeId;
    timingSeqState.activeId = timingSeqState.sequences.some(s => s.id === wantId)
      ? wantId
      : (timingSeqState.sequences[0]?.id || null);
    renderTimingSeqPicker();
    renderTimingSeqEditor();
  } catch (e) {
    alert(`Could not load Timing sequences: ${e.message}`);
  }
}

function renderTimingSeqPicker() {
  const select = $('#timing-seq-select');
  const hasAny = timingSeqState.sequences.length > 0;
  select.innerHTML = timingSeqState.sequences.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if (timingSeqState.activeId) select.value = timingSeqState.activeId;
  $('#timing-seq-empty').classList.toggle('hidden', hasAny);
  select.classList.toggle('hidden', !hasAny);
  $('#timing-seq-duplicate-btn').disabled = !hasAny;
  $('#timing-seq-rename-btn').disabled = !hasAny;
  $('#timing-seq-delete-btn').disabled = !hasAny;
}

$('#timing-seq-select').addEventListener('change', () => {
  timingSeqState.activeId = $('#timing-seq-select').value;
  renderTimingSeqEditor();
});

function renderTimingSeqEditor() {
  const seq = activeTimingSeq();
  $('#timing-seq-editor').classList.toggle('hidden', !seq);
  if (!seq) return;
  renderRampDays(seq);
  renderPacingBlocks(seq);
  $('#timing-guarantee-pause-checkbox').checked = !!seq.guaranteeMinOnePause;
}

$('#timing-guarantee-pause-checkbox').addEventListener('change', async (e) => {
  const seq = activeTimingSeq();
  if (!seq) return;
  const checked = e.target.checked;
  e.target.disabled = true;
  try {
    await fetchJson(`/api/timing-sequences/${seq.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guaranteeMinOnePause: checked })
    });
    seq.guaranteeMinOnePause = checked;
  } catch (err) {
    e.target.checked = !checked;
    alert(`Could not save: ${err.message}`);
  } finally {
    e.target.disabled = false;
  }
});

// Edited as "+N days after the previous row" rather than a raw absolute day
// number — day 1 is always the start (nothing to offset from), every row
// after it shows how many days later it kicks in. Editing an offset shifts
// that row and everything after it by the same delta, preserving their
// mutual spacing, then the whole recomputed list is bulk-saved (see
// PUT .../ramp-days) since one offset change cascades to every later day.
function renderRampDays(seq) {
  const rows = [...seq.rampDays].sort((a, b) => a.dayNumber - b.dayNumber);
  $('#timing-ramp-days-list').innerHTML = rows.map((r, i) => `
    <div class="timing-ramp-day-row">
      <span class="timing-ramp-day-label">${i === 0 ? 'Day 1' : `Day ${r.dayNumber}`}</span>
      ${i > 0 ? `<label>+ days after previous
        <input type="number" min="1" class="timing-ramp-day-offset-input" data-index="${i}" value="${r.dayNumber - rows[i - 1].dayNumber}">
      </label>` : ''}
      <label>Daily limit
        <input type="number" min="0" class="timing-ramp-day-input" data-index="${i}" value="${r.dailyLimit}">
      </label>
      <button type="button" class="timing-ramp-day-delete-btn" data-index="${i}" title="Remove this day">🗑</button>
    </div>`).join('');
}

async function saveRampDays(seq) {
  try {
    await fetchJson(`/api/timing-sequences/${seq.id}/ramp-days`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: seq.rampDays })
    });
  } catch (err) {
    alert(`Could not save ramp curve: ${err.message}`);
  }
}

$('#timing-ramp-days-list').addEventListener('change', async (e) => {
  const seq = activeTimingSeq();
  if (!seq) return;
  const offsetInput = e.target.closest('.timing-ramp-day-offset-input');
  const limitInput = e.target.closest('.timing-ramp-day-input');
  if (!offsetInput && !limitInput) return;
  const rows = [...seq.rampDays].sort((a, b) => a.dayNumber - b.dayNumber);
  if (offsetInput) {
    const i = Number(offsetInput.dataset.index);
    const newOffset = Math.max(1, Math.round(Number(offsetInput.value)) || 1);
    const delta = (rows[i - 1].dayNumber + newOffset) - rows[i].dayNumber;
    for (let j = i; j < rows.length; j++) rows[j].dayNumber += delta;
  }
  if (limitInput) {
    rows[Number(limitInput.dataset.index)].dailyLimit = Math.max(0, Math.round(Number(limitInput.value)) || 0);
  }
  seq.rampDays = rows;
  await saveRampDays(seq);
  renderRampDays(seq);
});

$('#timing-ramp-days-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.timing-ramp-day-delete-btn');
  if (!btn) return;
  const seq = activeTimingSeq();
  if (!seq) return;
  const rows = [...seq.rampDays].sort((a, b) => a.dayNumber - b.dayNumber);
  const i = Number(btn.dataset.index);
  if (!confirm(`Remove day ${rows[i].dayNumber} from this curve?`)) return;
  rows.splice(i, 1);
  seq.rampDays = rows;
  await saveRampDays(seq);
  renderRampDays(seq);
});

$('#timing-ramp-day-add-btn').addEventListener('click', async () => {
  const seq = activeTimingSeq();
  if (!seq) return;
  const rows = [...seq.rampDays].sort((a, b) => a.dayNumber - b.dayNumber);
  let dayNumber;
  if (rows.length === 0) {
    dayNumber = 1; // the first row is always day 1 — nothing to offset from yet
  } else {
    const lastDay = rows[rows.length - 1].dayNumber;
    const offsetInput = prompt(`How many days after day ${lastDay}?`, '1');
    if (offsetInput === null) return;
    const offset = Math.max(1, Math.round(Number(offsetInput)) || 1);
    dayNumber = lastDay + offset;
  }
  const limitInput = prompt(`Daily limit starting day ${dayNumber}:`, '0');
  if (limitInput === null) return;
  const dailyLimit = Math.max(0, Math.round(Number(limitInput)) || 0);
  seq.rampDays = [...rows, { dayNumber, dailyLimit }];
  await saveRampDays(seq);
  renderRampDays(seq);
});

function renderPacingBlocks(seq) {
  $('#timing-pacing-blocks-list').innerHTML = seq.pacingBlocks.map((b, i) => `
    <div class="timing-pacing-block-row" draggable="true" data-index="${i}">
      <span class="timing-pacing-drag-handle" title="Drag to reorder">⠿</span>
      <span class="timing-pacing-block-type timing-pacing-block-type-${b.blockType}">${b.blockType === 'send' ? '📤 Send' : '⏸ Pause'}</span>
      <label>Min <input type="number" min="0" class="timing-pacing-min-input" data-index="${i}" value="${b.minValue}"></label>
      <label>Max <input type="number" min="0" class="timing-pacing-max-input" data-index="${i}" value="${b.maxValue}"></label>
      <span class="muted">${b.blockType === 'send' ? 'sends' : 'min'}</span>
      ${b.blockType === 'pause' ? `
        <input type="text" class="timing-pacing-label-input" data-index="${i}" placeholder="Label (e.g. Scroll session)" value="${escapeHtml(b.label || '')}">
        <input type="text" class="timing-pacing-message-input" data-index="${i}" placeholder="Message shown during the pause" value="${escapeHtml(b.message || '')}">
      ` : ''}
      <button type="button" class="timing-pacing-remove-btn" data-index="${i}" title="Remove this block">✕</button>
    </div>`).join('');
}

async function savePacingBlocks(seq) {
  try {
    await fetchJson(`/api/timing-sequences/${seq.id}/pacing-blocks`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: seq.pacingBlocks })
    });
  } catch (err) {
    alert(`Could not save pacing pattern: ${err.message}`);
  }
}

$('#timing-pacing-blocks-list').addEventListener('change', (e) => {
  const seq = activeTimingSeq();
  if (!seq) return;
  const minInput = e.target.closest('.timing-pacing-min-input');
  const maxInput = e.target.closest('.timing-pacing-max-input');
  const labelInput = e.target.closest('.timing-pacing-label-input');
  const messageInput = e.target.closest('.timing-pacing-message-input');
  const target = minInput || maxInput || labelInput || messageInput;
  if (!target) return;
  const b = seq.pacingBlocks[Number(target.dataset.index)];
  if (!b) return;
  if (minInput) b.minValue = Math.max(0, Math.round(Number(minInput.value)) || 0);
  if (maxInput) b.maxValue = Math.max(b.minValue, Math.round(Number(maxInput.value)) || b.minValue);
  if (labelInput) b.label = labelInput.value;
  if (messageInput) b.message = messageInput.value;
  savePacingBlocks(seq);
});

$('#timing-pacing-blocks-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.timing-pacing-remove-btn');
  if (!btn) return;
  const seq = activeTimingSeq();
  if (!seq) return;
  seq.pacingBlocks.splice(Number(btn.dataset.index), 1);
  renderPacingBlocks(seq);
  savePacingBlocks(seq);
});

$('#timing-pacing-add-send-btn').addEventListener('click', () => {
  const seq = activeTimingSeq();
  if (!seq) return;
  seq.pacingBlocks.push({ blockType: 'send', minValue: 8, maxValue: 15, label: null, message: null });
  renderPacingBlocks(seq);
  savePacingBlocks(seq);
});

$('#timing-pacing-add-pause-btn').addEventListener('click', () => {
  const seq = activeTimingSeq();
  if (!seq) return;
  seq.pacingBlocks.push({ blockType: 'pause', minValue: 8, maxValue: 12, label: 'Pause', message: '' });
  renderPacingBlocks(seq);
  savePacingBlocks(seq);
});

// Plain HTML5 drag-and-drop reordering — no library needed for a list this
// short. Saves immediately on drop so a reorder is never lost by navigating
// away without a separate "Save" click.
let timingDragSrcIndex = null;
$('#timing-pacing-blocks-list').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.timing-pacing-block-row');
  if (!row) return;
  timingDragSrcIndex = Number(row.dataset.index);
  e.dataTransfer.effectAllowed = 'move';
});
$('#timing-pacing-blocks-list').addEventListener('dragover', (e) => {
  if (e.target.closest('.timing-pacing-block-row')) e.preventDefault();
});
$('#timing-pacing-blocks-list').addEventListener('drop', (e) => {
  const row = e.target.closest('.timing-pacing-block-row');
  if (!row || timingDragSrcIndex === null) return;
  e.preventDefault();
  const targetIndex = Number(row.dataset.index);
  const seq = activeTimingSeq();
  if (!seq || targetIndex === timingDragSrcIndex) { timingDragSrcIndex = null; return; }
  // Adjacent swaps (the common case for a short list like this) land exactly
  // right in both directions with a plain remove-then-insert-at-target; only
  // longer-distance drags end up slightly direction-dependent (landing just
  // after the target going forward, just before it going backward) — a much
  // rarer case and an easy one-more-drag fix, not worth the adjusted-index
  // version that would make adjacent forward swaps a no-op instead.
  const [moved] = seq.pacingBlocks.splice(timingDragSrcIndex, 1);
  seq.pacingBlocks.splice(targetIndex, 0, moved);
  timingDragSrcIndex = null;
  renderPacingBlocks(seq);
  savePacingBlocks(seq);
});

$('#open-timing-sequences-btn').addEventListener('click', () => showView('timing-sequences'));
$('#timing-seq-back-btn').addEventListener('click', () => showView('settings'));

$('#timing-seq-new-btn').addEventListener('click', async () => {
  const name = prompt('Name for the new sequence:');
  if (!name || !name.trim()) return;
  try {
    const result = await fetchJson('/api/timing-sequences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    await loadTimingSequences(result.id);
  } catch (err) {
    alert(`Could not create sequence: ${err.message}`);
  }
});

$('#timing-seq-duplicate-btn').addEventListener('click', async () => {
  const seq = activeTimingSeq();
  if (!seq) return;
  const name = prompt('Name for the duplicate:', `${seq.name} (copy)`);
  if (!name || !name.trim()) return;
  try {
    const result = await fetchJson('/api/timing-sequences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), duplicateFrom: seq.id })
    });
    await loadTimingSequences(result.id);
  } catch (err) {
    alert(`Could not duplicate sequence: ${err.message}`);
  }
});

$('#timing-seq-rename-btn').addEventListener('click', async () => {
  const seq = activeTimingSeq();
  if (!seq) return;
  const name = prompt('Rename sequence:', seq.name);
  if (!name || !name.trim() || name.trim() === seq.name) return;
  try {
    await fetchJson(`/api/timing-sequences/${seq.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    await loadTimingSequences(seq.id);
  } catch (err) {
    alert(`Could not rename sequence: ${err.message}`);
  }
});

$('#timing-seq-delete-btn').addEventListener('click', async () => {
  const seq = activeTimingSeq();
  if (!seq) return;
  if (seq.accountsUsing.length > 0) {
    alert(`Can't delete "${seq.name}" — ${seq.accountsUsing.map(a => '@' + a.username).join(', ')} ${seq.accountsUsing.length === 1 ? 'is' : 'are'} still using it. Reassign first.`);
    return;
  }
  if (!confirm(`Delete "${seq.name}"? This can't be undone.`)) return;
  try {
    await fetchJson(`/api/timing-sequences/${seq.id}`, { method: 'DELETE' });
    timingSeqState.activeId = null;
    await loadTimingSequences();
  } catch (err) {
    alert(`Could not delete sequence: ${err.message}`);
  }
});

// ---------- Message sequences ----------
// Named, reusable presets bundling one first-message block (text + a
// with/without-video flag) and phase1/2/3 follow-up steps, assignable per
// Instagram account. Mirrors the Timing sequences page structurally — same
// picker/CRUD, same "+N days after the previous row" offset editing the
// ramp curve uses (reorder-by-editing, not drag — a step's position is
// inherently defined by its cumulative day offset, same as a ramp day).
// Instagram-only; LinkedIn keeps its separate single-template + follow-up
// system in the General Settings page, untouched.

const messageSeqState = { sequences: [], activeId: null, phase: 1 };

function activeMessageSeq() {
  return messageSeqState.sequences.find(s => s.id === messageSeqState.activeId) || null;
}

async function loadMessageSequences(preserveActiveId) {
  try {
    const data = await fetchJson('/api/message-sequences');
    messageSeqState.sequences = data.sequences || [];
    const wantId = preserveActiveId || messageSeqState.activeId;
    messageSeqState.activeId = messageSeqState.sequences.some(s => s.id === wantId)
      ? wantId
      : (messageSeqState.sequences[0]?.id || null);
    renderMessageSeqPicker();
    renderMessageSeqEditor();
  } catch (e) {
    alert(`Could not load Messaging sequences: ${e.message}`);
  }
}

function renderMessageSeqPicker() {
  const select = $('#message-seq-select');
  const hasAny = messageSeqState.sequences.length > 0;
  select.innerHTML = messageSeqState.sequences.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if (messageSeqState.activeId) select.value = messageSeqState.activeId;
  $('#message-seq-empty').classList.toggle('hidden', hasAny);
  select.classList.toggle('hidden', !hasAny);
  $('#message-seq-duplicate-btn').disabled = !hasAny;
  $('#message-seq-rename-btn').disabled = !hasAny;
  $('#message-seq-delete-btn').disabled = !hasAny;
}

$('#message-seq-select').addEventListener('change', () => {
  messageSeqState.activeId = $('#message-seq-select').value;
  renderMessageSeqEditor();
});

const OPENER_LABELS = ['Variant A', 'Variant B', 'Variant C', 'Variant D'];

function renderMessageSeqEditor() {
  const seq = activeMessageSeq();
  $('#message-seq-editor').classList.toggle('hidden', !seq);
  if (!seq) return;
  $('#message-seq-first-video').checked = !!seq.firstMessageHasVideo;
  renderMessageSeqOpeners(seq);
  renderMessageSeqSteps(seq);
}

function renderMessageSeqOpeners(seq) {
  const openers = [...seq.openers].sort((a, b) => a.position - b.position);
  $('#message-seq-openers-list').innerHTML = openers.map((o, i) => `
    <div class="timing-ramp-day-row message-seq-opener-row">
      <span class="message-seq-opener-label">${OPENER_LABELS[i]}</span>
      <textarea class="message-seq-opener-text" rows="2" data-index="${i}" placeholder="Opening line for this variant">${escapeHtml(o.text || '')}</textarea>
      <button type="button" class="timing-ramp-day-delete-btn" data-index="${i}" title="Remove this variant"${openers.length <= 1 ? ' disabled' : ''}>🗑</button>
    </div>`).join('');
  $('#message-seq-opener-add-btn').classList.toggle('hidden', openers.length >= 4);
}

async function saveMessageSeqOpeners(seq) {
  const openers = [...seq.openers].sort((a, b) => a.position - b.position);
  try {
    // id included (when one exists) so the server matches by identity, not
    // array position — otherwise removing a variant from the middle of the
    // list would silently overwrite a kept variant's text with the wrong
    // wording. The response's ids are written back onto seq.openers so a
    // variant just added on this save has a real id before the next one.
    const data = await fetchJson(`/api/message-sequences/${seq.id}/openers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openers: openers.map(o => ({ id: o.id, text: o.text })) })
    });
    seq.openers = data.openers;
  } catch (err) {
    alert(`Could not save opener variants: ${err.message}`);
  }
}

$('#message-seq-openers-list').addEventListener('change', async (e) => {
  const textarea = e.target.closest('.message-seq-opener-text');
  if (!textarea) return;
  const seq = activeMessageSeq();
  if (!seq) return;
  const openers = [...seq.openers].sort((a, b) => a.position - b.position);
  openers[Number(textarea.dataset.index)].text = textarea.value;
  seq.openers = openers;
  await saveMessageSeqOpeners(seq);
});

$('#message-seq-openers-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.timing-ramp-day-delete-btn');
  if (!btn || btn.disabled) return;
  const seq = activeMessageSeq();
  if (!seq) return;
  const openers = [...seq.openers].sort((a, b) => a.position - b.position);
  if (openers.length <= 1) return; // at least one variant is required
  if (!confirm('Remove this opener variant?')) return;
  openers.splice(Number(btn.dataset.index), 1);
  seq.openers = openers;
  await saveMessageSeqOpeners(seq);
  renderMessageSeqOpeners(seq);
});

$('#message-seq-opener-add-btn').addEventListener('click', async () => {
  const seq = activeMessageSeq();
  if (!seq) return;
  const openers = [...seq.openers].sort((a, b) => a.position - b.position);
  if (openers.length >= 4) return;
  openers.push({ position: openers.length, text: '' });
  seq.openers = openers;
  await saveMessageSeqOpeners(seq);
  renderMessageSeqOpeners(seq);
});

$('#message-seq-first-save-btn').addEventListener('click', async () => {
  const seq = activeMessageSeq();
  if (!seq) return;
  const btn = $('#message-seq-first-save-btn');
  btn.disabled = true;
  try {
    await fetchJson(`/api/message-sequences/${seq.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessageHasVideo: $('#message-seq-first-video').checked })
    });
    seq.firstMessageHasVideo = $('#message-seq-first-video').checked;
  } catch (err) {
    alert(`Could not save video setting: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#message-seq-phase-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#message-seq-phase-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  messageSeqState.phase = Number(btn.dataset.phase);
  const seq = activeMessageSeq();
  if (seq) renderMessageSeqSteps(seq);
});

function renderMessageSeqSteps(seq) {
  const steps = seq.followups.filter(f => f.phase === messageSeqState.phase).sort((a, b) => a.step - b.step);
  $('#message-seq-steps-list').innerHTML = steps.map((s, i) => `
    <div class="timing-ramp-day-row message-seq-step-row">
      <span class="timing-ramp-day-label">Step ${s.step}</span>
      ${i > 0 ? `<label>+ days after previous
        <input type="number" min="1" class="timing-ramp-day-offset-input" data-index="${i}" value="${s.dayOffset - steps[i - 1].dayOffset}">
      </label>` : `<span class="muted">day ${s.dayOffset}</span>`}
      <select class="message-seq-step-type-input" data-index="${i}">
        <option value="text"${s.type === 'text' ? ' selected' : ''}>Text</option>
        <option value="gif"${s.type === 'gif' ? ' selected' : ''}>GIF</option>
        <option value="meme"${s.type === 'meme' ? ' selected' : ''}>Meme</option>
      </select>
      <input type="text" class="message-seq-step-message-input" data-index="${i}" placeholder="Message" value="${escapeHtml(s.message || '')}">
      ${s.type !== 'text' ? `<input type="text" class="message-seq-step-media-input" data-index="${i}" placeholder="Media description" value="${escapeHtml(s.mediaNote || '')}">` : ''}
      <button type="button" class="timing-ramp-day-delete-btn" data-index="${i}" title="Remove this step">🗑</button>
    </div>`).join('');
}

async function saveMessageSeqSteps(seq) {
  const steps = seq.followups.filter(f => f.phase === messageSeqState.phase).sort((a, b) => a.step - b.step);
  try {
    await fetchJson(`/api/message-sequences/${seq.id}/followups/${messageSeqState.phase}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: steps.map(s => ({ dayOffset: s.dayOffset, type: s.type, message: s.message, mediaNote: s.mediaNote })) })
    });
  } catch (err) {
    alert(`Could not save follow-up steps: ${err.message}`);
  }
}

$('#message-seq-steps-list').addEventListener('change', async (e) => {
  const seq = activeMessageSeq();
  if (!seq) return;
  const offsetInput = e.target.closest('.timing-ramp-day-offset-input');
  const typeInput = e.target.closest('.message-seq-step-type-input');
  const messageInput = e.target.closest('.message-seq-step-message-input');
  const mediaInput = e.target.closest('.message-seq-step-media-input');
  const target = offsetInput || typeInput || messageInput || mediaInput;
  if (!target) return;
  const steps = seq.followups.filter(f => f.phase === messageSeqState.phase).sort((a, b) => a.step - b.step);
  const i = Number(target.dataset.index);
  if (offsetInput) {
    const newOffset = Math.max(1, Math.round(Number(offsetInput.value)) || 1);
    const delta = (steps[i - 1].dayOffset + newOffset) - steps[i].dayOffset;
    for (let j = i; j < steps.length; j++) steps[j].dayOffset += delta;
  }
  if (typeInput) steps[i].type = typeInput.value;
  if (messageInput) steps[i].message = messageInput.value;
  if (mediaInput) steps[i].mediaNote = mediaInput.value;
  await saveMessageSeqSteps(seq);
  if (typeInput) renderMessageSeqSteps(seq); // type change toggles the media-note field's visibility
});

$('#message-seq-steps-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.timing-ramp-day-delete-btn');
  if (!btn) return;
  const seq = activeMessageSeq();
  if (!seq) return;
  if (!confirm('Remove this step?')) return;
  const otherPhaseSteps = seq.followups.filter(f => f.phase !== messageSeqState.phase);
  const thisPhaseSteps = seq.followups.filter(f => f.phase === messageSeqState.phase).sort((a, b) => a.step - b.step);
  thisPhaseSteps.splice(Number(btn.dataset.index), 1);
  seq.followups = [...otherPhaseSteps, ...thisPhaseSteps];
  await saveMessageSeqSteps(seq);
  renderMessageSeqSteps(seq);
});

$('#message-seq-step-add-btn').addEventListener('click', async () => {
  const seq = activeMessageSeq();
  if (!seq) return;
  const steps = seq.followups.filter(f => f.phase === messageSeqState.phase).sort((a, b) => a.step - b.step);
  let dayOffset;
  if (steps.length === 0) {
    const first = prompt('How many days after this phase starts?', '1');
    if (first === null) return;
    dayOffset = Math.max(0, Math.round(Number(first)) || 0);
  } else {
    const lastDay = steps[steps.length - 1].dayOffset;
    const offsetInput = prompt(`How many days after day ${lastDay}?`, '1');
    if (offsetInput === null) return;
    dayOffset = lastDay + Math.max(1, Math.round(Number(offsetInput)) || 1);
  }
  const otherPhaseSteps = seq.followups.filter(f => f.phase !== messageSeqState.phase);
  seq.followups = [...otherPhaseSteps, ...steps, { phase: messageSeqState.phase, step: steps.length + 1, dayOffset, type: 'text', message: '', mediaNote: null }];
  await saveMessageSeqSteps(seq);
  renderMessageSeqSteps(seq);
});

$('#open-message-sequences-btn').addEventListener('click', () => showView('message-sequences'));
$('#message-seq-back-btn').addEventListener('click', () => showView('settings'));

$('#message-seq-new-btn').addEventListener('click', async () => {
  const name = prompt('Name for the new sequence:');
  if (!name || !name.trim()) return;
  try {
    const result = await fetchJson('/api/message-sequences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    await loadMessageSequences(result.id);
  } catch (err) {
    alert(`Could not create sequence: ${err.message}`);
  }
});

$('#message-seq-duplicate-btn').addEventListener('click', async () => {
  const seq = activeMessageSeq();
  if (!seq) return;
  const name = prompt('Name for the duplicate:', `${seq.name} (copy)`);
  if (!name || !name.trim()) return;
  try {
    const result = await fetchJson('/api/message-sequences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), duplicateFrom: seq.id })
    });
    await loadMessageSequences(result.id);
  } catch (err) {
    alert(`Could not duplicate sequence: ${err.message}`);
  }
});

$('#message-seq-rename-btn').addEventListener('click', async () => {
  const seq = activeMessageSeq();
  if (!seq) return;
  const name = prompt('Rename sequence:', seq.name);
  if (!name || !name.trim() || name.trim() === seq.name) return;
  try {
    await fetchJson(`/api/message-sequences/${seq.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    await loadMessageSequences(seq.id);
  } catch (err) {
    alert(`Could not rename sequence: ${err.message}`);
  }
});

$('#message-seq-delete-btn').addEventListener('click', async () => {
  const seq = activeMessageSeq();
  if (!seq) return;
  if (seq.accountsUsing.length > 0) {
    alert(`Can't delete "${seq.name}" — ${seq.accountsUsing.map(a => '@' + a.username).join(', ')} ${seq.accountsUsing.length === 1 ? 'is' : 'are'} still using it. Reassign first.`);
    return;
  }
  if (!confirm(`Delete "${seq.name}"? This can't be undone.`)) return;
  try {
    await fetchJson(`/api/message-sequences/${seq.id}`, { method: 'DELETE' });
    messageSeqState.activeId = null;
    await loadMessageSequences();
  } catch (err) {
    alert(`Could not delete sequence: ${err.message}`);
  }
});

loadNotifications();
