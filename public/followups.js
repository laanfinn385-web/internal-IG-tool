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
  } catch (e) {
    console.error('Could not load notifications', e);
  }
}

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
  list.innerHTML = notifications.map(n => `
    <button type="button" class="notif-item" data-phase="${n.phase}">
      <div class="notif-item-main">
        <span class="notif-item-phase">${PHASE_NAMES[n.phase]}</span>
        <span class="notif-item-count">${n.count} lead${n.count === 1 ? '' : 's'} to follow up with</span>
      </div>
      <span class="notif-item-time">${timeAgo(n.earliestDue)}</span>
    </button>
  `).join('');
}

$('#notif-list').addEventListener('click', (e) => {
  const item = e.target.closest('.notif-item');
  if (!item) return;
  $('#notif-dropdown').classList.add('hidden');
  openFollowupSession(Number(item.dataset.phase));
});

$('#notif-bell').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#notif-dropdown').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.notif-wrap')) $('#notif-dropdown').classList.add('hidden');
});

// ---------- Follow-up session ----------

const followupState = { phase: null, leads: [] };

async function openFollowupSession(phase) {
  followupState.phase = phase;
  $('#followup-title').textContent = `${PHASE_NAMES[phase]} Follow-ups`;
  $('#followup-list').innerHTML = '<p class="muted">Loading…</p>';
  $('#followup-sub').textContent = '';
  $('#followup-empty').classList.add('hidden');
  showView('followup');
  try {
    const data = await fetchJson(`/api/followups/due?phase=${phase}`);
    followupState.leads = data.leads || [];
    renderFollowupList();
  } catch (e) {
    $('#followup-list').innerHTML = `<p class="import-error">Could not load follow-ups: ${escapeHtml(e.message)}</p>`;
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
        <span class="followup-username">@${escapeHtml(lead.username)}</span>
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
      window.open(lead.username ? `https://ig.me/m/${lead.username}` : lead.profileUrl, 'ig_preview');
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

const settingsState = { templates: [], followups: [], phase: 1 };

async function loadSettingsPage() {
  try {
    const [tplData, fuData, appData] = await Promise.all([
      fetchJson('/api/settings/templates'),
      fetchJson('/api/settings/followups'),
      fetchJson('/api/settings/app')
    ]);
    settingsState.templates = tplData.templates || [];
    settingsState.followups = fuData.followups || [];
    $('#settings-calendar-link').value = (appData.settings && appData.settings.calendar_link) || '';
    $('#settings-views-threshold').value = (appData.settings && appData.settings.views_threshold) || 1000;
    renderSettingsTemplates();
    renderSettingsFollowups();
  } catch (e) {
    alert(`Could not load settings: ${e.message}`);
  }
}

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
      body: JSON.stringify({ [field]: e.target.value })
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

$('#settings-general-save').addEventListener('click', async () => {
  const btn = $('#settings-general-save');
  btn.disabled = true;
  try {
    await fetchJson('/api/settings/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarLink: $('#settings-calendar-link').value,
        viewsThreshold: Number($('#settings-views-threshold').value) || 0
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
