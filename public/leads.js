const PAGE_SIZE = 200;
const IMPORT_CHUNK_SIZE = 500;

const leadsState = {
  leads: [],
  expanded: new Set(),
  selected: new Set(),
  page: 0,
  search: '',
  platformFilter: 'all', // 'instagram' | 'linkedin' | 'all'
  stageFilter: new Set(), // empty = no filter, show every stage
  remindersByLead: {} // leadId -> reminder (soonest, if a lead somehow has more than one)
};

// Full list of {lead, originalIndex} pairs matching the current search,
// platform, and stage filters — originalIndex keeps the "#" column anchored
// to true row position even while the view is narrowed or reordered.
function getFilteredLeads() {
  const q = leadsState.search.trim().toLowerCase();
  let items = leadsState.leads.map((lead, i) => ({ lead, originalIndex: i }));
  if (leadsState.platformFilter !== 'all') {
    items = items.filter(({ lead }) => lead.platform === leadsState.platformFilter);
  }
  if (q) {
    items = items.filter(({ lead }) => (lead.username || '').toLowerCase().includes(q) || (lead.fullName || '').toLowerCase().includes(q));
  }

  if (leadsState.stageFilter.size > 0) {
    items = items.filter(({ lead }) => leadsState.stageFilter.has(lead.stage));
    // Group by stage — lowest stage first, regardless of the order the
    // checkboxes were ticked in — while keeping each stage's own leads in
    // their original relative order (stable sort).
    items = items
      .map((item, i) => ({ ...item, _order: i }))
      .sort((a, b) => (STAGE_ORDER[a.lead.stage] ?? 99) - (STAGE_ORDER[b.lead.stage] ?? 99) || a._order - b._order);
  }
  return items;
}

const csvState = { platform: 'instagram', headers: [], rows: [], mapping: {}, leadsToImport: null, importedCount: 0, duplicatesSkipped: 0 };

let pendingUndo = null; // { ids, timer }
// fetchJson is defined in app.js (loaded first) and shared globally.

const LEAD_FIELDS_BY_PLATFORM = {
  instagram: [
    { key: 'profileUrl', label: 'Profile URL', required: true, patterns: [/profile.?url/i, /^url$/i, /link/i] },
    { key: 'username', label: 'Username', required: true, patterns: [/username/i, /handle/i, /^user$/i] },
    { key: 'fullName', label: 'Full name', required: false, patterns: [/full.?name/i, /^name$/i] },
    { key: 'bio', label: 'Bio', required: false, patterns: [/bio/i, /about/i] },
    { key: 'followers', label: 'Followers', required: false, patterns: [/follower/i] }
  ],
  linkedin: [
    { key: 'profileUrl', label: 'Profile URL', required: true, patterns: [/profile.?url/i, /^url$/i, /link/i] },
    { key: 'fullName', label: 'Full name', required: true, patterns: [/full.?name/i, /^name$/i] },
    { key: 'headline', label: 'Headline', required: false, patterns: [/headline/i, /title/i] },
    { key: 'additionalInfo', label: 'Additional info', required: false, patterns: [/additional/i, /info/i, /note/i] }
  ]
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PHASE_MAX_STEP_BY_PLATFORM = {
  instagram: { 1: 2, 2: 9, 3: 9 },
  linkedin: { 1: 2, 2: 2, 3: 3 }
};

const STAGE_OPTIONS_BY_PLATFORM = {
  instagram: [
    { value: 'new', label: 'New' },
    { value: 'phase1', label: 'Phase 1' },
    { value: 'phase2', label: 'Phase 2' },
    { value: 'phase3', label: 'Phase 3' },
    { value: 'in_conversation', label: 'In conversation' },
    { value: 'call_booked', label: 'Call booked' },
    { value: 'dead', label: 'Dead' },
    { value: 'cant_message', label: "Can't receive messages" }
  ],
  linkedin: [
    { value: 'new', label: 'New' },
    { value: 'engaged', label: 'Engaged' },
    { value: 'connection_sent', label: 'Connection sent' },
    { value: 'phase1', label: 'Phase 1' },
    { value: 'phase2', label: 'Phase 2' },
    { value: 'phase3', label: 'Phase 3' },
    { value: 'in_conversation', label: 'In conversation' },
    { value: 'call_booked', label: 'Call booked' },
    { value: 'dead', label: 'Dead' },
    { value: 'cant_message', label: "Can't receive messages" }
  ]
};
// 'All' needs every stage either platform can have — LinkedIn's list is
// already that superset (Instagram has no stage LinkedIn doesn't).
STAGE_OPTIONS_BY_PLATFORM.all = STAGE_OPTIONS_BY_PLATFORM.linkedin;

function stageOptionsFor(platform) {
  return STAGE_OPTIONS_BY_PLATFORM[platform] || STAGE_OPTIONS_BY_PLATFORM.instagram;
}

// Pipeline position, lowest first — drives the group ordering when the
// stage filter has multiple stages selected. Built from the superset list so
// it's a single flat lookup regardless of which platform a given lead is.
const STAGE_ORDER = Object.fromEntries(STAGE_OPTIONS_BY_PLATFORM.all.map((o, i) => [o.value, i]));

function stageLabel(lead) {
  const stage = lead.stage;
  if (stage === 'phase1' || stage === 'phase2' || stage === 'phase3') {
    const phase = Number(stage.slice(-1));
    const maxSteps = PHASE_MAX_STEP_BY_PLATFORM[lead.platform] || PHASE_MAX_STEP_BY_PLATFORM.instagram;
    const max = maxSteps[phase];
    const step = Math.min(lead.phaseStep || 0, max);
    return `Phase ${phase} · ${step}/${max}`;
  }
  if (stage === 'call_booked') return 'Call booked';
  if (stage === 'dead') return 'Dead';
  if (stage === 'cant_message') return "Can't receive messages";
  if (stage === 'in_conversation') return 'In conversation';
  if (stage === 'engaged') return 'Engaged';
  if (stage === 'connection_sent') return 'Connection sent';
  return 'New';
}

// Maps a stage to the CSS class that colors its badge / row.
function stageClass(stage) {
  if (stage === 'phase1' || stage === 'phase2' || stage === 'phase3') return stage;
  if (stage === 'call_booked') return 'call-booked';
  if (stage === 'dead') return 'dead';
  if (stage === 'in_conversation') return 'in-conversation';
  if (stage === 'cant_message') return 'cant-message';
  if (stage === 'engaged') return 'engaged';
  if (stage === 'connection_sent') return 'connection-sent';
  return '';
}

function normalizeFollowers(raw) {
  if (!raw) return '';
  const suffixMatch = String(raw).trim().match(/^([\d.,]+)\s*([kKmMbB])$/);
  if (suffixMatch) {
    const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffixMatch[2].toLowerCase()];
    return Math.round(parseFloat(suffixMatch[1].replace(',', '.')) * multiplier);
  }
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits ? Number(digits) : '';
}

// stageChangedAt updates on every stage transition (server-side), regardless
// of which stage — unlike phaseStartedAt, which only tracks phase1/2/3/
// engaged for follow-up due-date scheduling.
function formatStageChangedDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------- Load & render ----------

async function loadLeads() {
  try {
    const data = await fetchJson('/api/leads');
    leadsState.leads = (data && data.leads) || [];
  } catch (e) {
    console.error('Could not load leads', e);
    alert(`Could not load leads: ${e.message}`);
  }
  await loadRemindersByLead();
  renderLeadsTable();
}

// Powers both the yellow reminder dot and the "existing reminder" state of
// the per-lead widget below — best-effort (a failure here just means no
// dots/existing-reminder display, not a broken leads list).
async function loadRemindersByLead() {
  leadsState.remindersByLead = {};
  try {
    const data = await fetchJson('/api/reminders');
    (data.reminders || []).forEach(r => {
      if (!r.leadId) return;
      const existing = leadsState.remindersByLead[r.leadId];
      if (!existing || new Date(r.dueAt) < new Date(existing.dueAt)) {
        leadsState.remindersByLead[r.leadId] = r;
      }
    });
  } catch (e) {
    console.error('Could not load reminders', e);
  }
}

// Default view: the URL itself is a clickable link (opens the profile),
// with a small pencil button that swaps this cell into an editable input.
function urlCellHtml(lead) {
  const url = lead.profileUrl || '';
  const display = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="url-link">${escapeHtml(url)}</a>`
    : `<span class="muted url-link-empty">No URL</span>`;
  return `<div class="url-view">${display}<button type="button" class="url-edit-btn" title="Edit URL">✏️</button></div>`;
}

// Quick per-lead reminder, distinct from the general Settings one — no text
// field (the lead itself already has Notes for that), just "remind me in N
// days/weeks/months". Auto-generates the reminder text and links it to this
// lead so it shows a "Take me to lead" action once due (see followups.js).
function reminderWidgetHtml(lead) {
  const existing = leadsState.remindersByLead[lead.id];
  // A lead sticks with one reminder slot at a time, same as its one Note —
  // an existing one shows as a persistent summary (not just a "✓ set" flash
  // that reverts and looks like nothing happened) with its own remove
  // button, rather than letting another one stack on top of it.
  if (existing) {
    return `
      <div class="lead-detail-full lead-reminder-widget" data-lead-id="${lead.id}">
        <div class="lead-reminder-existing">
          <span>⏰ ${escapeHtml(formatReminderDue(existing.dueAt))}</span>
          <button type="button" class="lead-reminder-remove-btn" data-reminder-id="${existing.id}" title="Remove reminder">🗑</button>
        </div>
      </div>`;
  }
  return `
    <div class="lead-detail-full lead-reminder-widget" data-lead-id="${lead.id}">
      <button type="button" class="lead-reminder-toggle-btn">🔔 Add reminder</button>
      <div class="lead-reminder-form hidden">
        <input type="number" min="1" step="1" value="1" class="lead-reminder-amount">
        <select class="lead-reminder-unit">
          <option value="days">Days</option>
          <option value="weeks">Weeks</option>
          <option value="months">Months</option>
        </select>
        <button type="button" class="lead-reminder-save-btn btn-secondary">Set reminder</button>
        <button type="button" class="lead-reminder-cancel-btn">Cancel</button>
      </div>
    </div>`;
}

function leadRowHtml(lead, index) {
  const expanded = leadsState.expanded.has(lead.id);
  const selected = leadsState.selected.has(lead.id);
  const stageCls = stageClass(lead.stage);
  const hasNote = !!(lead.notes && lead.notes.trim());
  const hasReminder = !!leadsState.remindersByLead[lead.id];
  const isLinkedin = lead.platform === 'linkedin';
  const rowClasses = ['leads-row', 'leads-row-body', stageCls, selected ? 'selected' : ''].filter(Boolean).join(' ');
  // LinkedIn leads have no username — the same column position instead edits
  // full name directly, since that's the closest equivalent identifier.
  const nameField = isLinkedin
    ? `<input type="text" value="${escapeHtml(lead.fullName)}" data-field="fullName" placeholder="Full name">`
    : `<input type="text" value="${escapeHtml(lead.username)}" data-field="username" placeholder="username">`;
  const options = stageOptionsFor(lead.platform);
  const row = `
    <div class="${rowClasses}" data-id="${lead.id}">
      <div class="lc lc-check"><input type="checkbox" class="row-select" ${selected ? 'checked' : ''}></div>
      <div class="lc lc-num">${index + 1}</div>
      <div class="lc lc-url">${urlCellHtml(lead)}</div>
      <div class="lc lc-username">
        ${nameField}
        ${hasNote ? '<span class="note-dot" title="Has a note"></span>' : ''}
        ${hasReminder ? '<span class="reminder-dot" title="Has a reminder"></span>' : ''}
      </div>
      <div class="lc lc-expand"><button type="button" class="expand-btn${expanded ? ' expanded' : ''}" title="Show details">&rsaquo;</button></div>
      <div class="lc lc-stage">
        <select class="stage-badge${stageCls ? ' ' + stageCls : ''}" data-field="stage">
          ${options.map(o => {
            const isSelected = lead.stage === o.value;
            // The selected option's own text is what a closed <select> shows,
            // so give it the step-aware label ("Phase 2 · 4/9"); the rest of
            // the list keeps plain labels.
            const label = isSelected ? stageLabel(lead) : o.label;
            return `<option value="${o.value}"${isSelected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="lc lc-trash"><button type="button" class="trash-btn" title="Delete lead">🗑</button></div>
    </div>`;
  // Full name already lives in the main row for LinkedIn (see nameField
  // above), so its detail panel shows Headline + Additional info instead —
  // no Followers field either, LinkedIn leads don't have one.
  const detail = isLinkedin ? `
    <div class="lead-detail${expanded ? '' : ' hidden'}" data-detail-id="${lead.id}">
      <label class="lead-detail-full">Headline
        <input type="text" value="${escapeHtml(lead.headline)}" data-field="headline">
      </label>
      <label class="lead-detail-full">Additional info
        <textarea rows="2" data-field="bio" class="auto-resize">${escapeHtml(lead.bio)}</textarea>
      </label>
      <label class="lead-detail-full">Note
        <textarea rows="2" data-field="notes" class="auto-resize" placeholder="Anything worth remembering about this lead...">${escapeHtml(lead.notes)}</textarea>
      </label>
      <p class="lead-detail-full lead-stage-changed muted">Stage last changed: ${escapeHtml(formatStageChangedDate(lead.stageChangedAt))}</p>
      ${reminderWidgetHtml(lead)}
    </div>` : `
    <div class="lead-detail${expanded ? '' : ' hidden'}" data-detail-id="${lead.id}">
      <label>Full name
        <input type="text" value="${escapeHtml(lead.fullName)}" data-field="fullName">
      </label>
      <label>Followers
        <input type="number" min="0" value="${lead.followers ?? ''}" data-field="followers">
      </label>
      <label class="lead-detail-full">Bio
        <textarea rows="2" data-field="bio" class="auto-resize">${escapeHtml(lead.bio)}</textarea>
      </label>
      <label class="lead-detail-full">Note
        <textarea rows="2" data-field="notes" class="auto-resize" placeholder="Anything worth remembering about this lead...">${escapeHtml(lead.notes)}</textarea>
      </label>
      <p class="lead-detail-full lead-stage-changed muted">Stage last changed: ${escapeHtml(formatStageChangedDate(lead.stageChangedAt))}</p>
      ${reminderWidgetHtml(lead)}
    </div>`;
  return row + detail;
}

// Grows a textarea to fit its content instead of scrolling internally.
function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function renderLeadsTable() {
  const wrap = $('#leads-table-wrap');
  const dropzone = $('#leads-dropzone');
  const searchRow = $('#leads-search-row');
  const total = leadsState.leads.length;

  $('#leads-total-count').textContent = `${total} total lead${total === 1 ? '' : 's'}`;

  if (total === 0) {
    wrap.classList.add('hidden');
    searchRow.classList.add('hidden');
    dropzone.classList.remove('hidden');
    return;
  }
  dropzone.classList.add('hidden');
  searchRow.classList.remove('hidden');
  wrap.classList.remove('hidden');

  const filtered = getFilteredLeads();

  // Only the current page is rendered into the DOM — with lead lists up to
  // ~20k rows, rendering everything at once makes the page sluggish.
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  leadsState.page = Math.min(Math.max(leadsState.page, 0), totalPages - 1);

  const start = leadsState.page * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  $('#leads-rows').innerHTML = pageItems.length
    ? pageItems.map(({ lead, originalIndex }) => leadRowHtml(lead, originalIndex)).join('')
    : `<div class="leads-empty-search">${emptyStateMessage()}</div>`;

  // Expanded detail rows render visible (not display:none), so their bio
  // textarea can be measured and grown to fit right away.
  $all('.lead-detail:not(.hidden) textarea.auto-resize').forEach(autoResizeTextarea);
  updateSelectAllCheckbox();
  updateSelectionBar();

  const pagination = $('#leads-pagination');
  const matchSuffix = (leadsState.search || leadsState.stageFilter.size > 0) ? ' matching' : '';
  const end = Math.min(start + PAGE_SIZE, filtered.length);
  $('#leads-pagination-info').textContent = filtered.length
    ? `Showing ${start + 1}–${end} of ${filtered.length}${matchSuffix}`
    : `No leads${matchSuffix}`;
  if (filtered.length <= PAGE_SIZE) {
    pagination.classList.add('hidden');
  } else {
    pagination.classList.remove('hidden');
    $('#leads-prev-page').disabled = leadsState.page === 0;
    $('#leads-next-page').disabled = leadsState.page >= totalPages - 1;
  }
}

function emptyStateMessage() {
  if (leadsState.search) return `No leads match "${escapeHtml(leadsState.search)}"`;
  if (leadsState.stageFilter.size > 0) return 'No leads match the selected stage filter.';
  return 'No leads.';
}

$('#leads-prev-page').addEventListener('click', () => { leadsState.page--; renderLeadsTable(); });
$('#leads-next-page').addEventListener('click', () => { leadsState.page++; renderLeadsTable(); });

$('#leads-search').addEventListener('input', (e) => {
  leadsState.search = e.target.value;
  leadsState.page = 0;
  renderLeadsTable();
});

// ---------- Platform filter ----------

$('#leads-platform-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-tab');
  if (!btn) return;
  $all('#leads-platform-tabs .range-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  leadsState.platformFilter = btn.dataset.platform;
  // The stage set differs per platform (LinkedIn has engaged/connection_sent
  // Instagram doesn't) — a stage filter carried over from the other platform
  // could silently hide everything, so it's cleared on every switch.
  leadsState.stageFilter.clear();
  leadsState.page = 0;
  updateStageFilterButton();
  renderLeadsTable();
});

// ---------- Stage filter ----------

function updateStageFilterButton() {
  const n = leadsState.stageFilter.size;
  const btn = $('#stage-filter-btn');
  const badge = $('#stage-filter-badge');
  btn.classList.toggle('active', n > 0);
  badge.classList.toggle('hidden', n === 0);
  badge.textContent = n;
}

function closeStageFilterDropdown() {
  $('#stage-filter-dropdown').classList.add('hidden');
}

// The available stages depend on the active platform tab (LinkedIn has
// engaged/connection_sent, Instagram doesn't) — rendered fresh whenever the
// platform tab changes rather than a static list that would drift out of
// sync with STAGE_OPTIONS_BY_PLATFORM.
function renderStageFilterOptions() {
  const options = stageOptionsFor(leadsState.platformFilter);
  $('#stage-filter-options').innerHTML = options.map(o => `
    <label class="stage-filter-option">
      <input type="checkbox" value="${o.value}"${leadsState.stageFilter.has(o.value) ? ' checked' : ''}> ${escapeHtml(o.label)}
    </label>
  `).join('');
}

$('#stage-filter-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = $('#stage-filter-dropdown');
  if (!dropdown.classList.contains('hidden')) {
    closeStageFilterDropdown();
    return;
  }
  renderStageFilterOptions();
  // position:fixed, placed from the button's own rect — independent of
  // any ancestor's overflow/clipping, so a short or filtered-down table
  // can never cut it off.
  const btnRect = e.currentTarget.getBoundingClientRect();
  const dropdownWidth = 190;
  dropdown.style.top = `${btnRect.bottom + 8}px`;
  dropdown.style.left = `${Math.max(8, btnRect.right - dropdownWidth)}px`;
  dropdown.classList.remove('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#stage-filter-dropdown') && !e.target.closest('#stage-filter-btn')) {
    closeStageFilterDropdown();
  }
});
// A fixed-position dropdown would otherwise drift out of place under the
// button if the page scrolls while it's open.
window.addEventListener('scroll', closeStageFilterDropdown, true);

$('#stage-filter-dropdown').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  if (e.target.checked) leadsState.stageFilter.add(e.target.value);
  else leadsState.stageFilter.delete(e.target.value);
  leadsState.page = 0;
  updateStageFilterButton();
  renderLeadsTable();
});

$('#stage-filter-clear').addEventListener('click', () => {
  leadsState.stageFilter.clear();
  $all('#stage-filter-dropdown input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  leadsState.page = 0;
  updateStageFilterButton();
  renderLeadsTable();
});

// ---------- Inline editing ----------

async function updateLeadField(id, field, value) {
  const lead = leadsState.leads.find(l => l.id === id);
  if (!lead) return;
  const previous = lead[field];
  const previousPhaseStep = lead.phaseStep;
  lead[field] = value;
  // Mirror the server's reset-on-phase-change so the badge shows "· 0/N"
  // immediately instead of a stale step count from the old phase.
  if (field === 'stage' && value !== previous && ['phase1', 'phase2', 'phase3'].includes(value)) {
    lead.phaseStep = 0;
  }
  try {
    // PATCH is a true partial update server-side, so sending just the one
    // changed field can't clobber anything else on the lead.
    await fetchJson(`/api/leads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value })
    });
    if (field === 'notes') updateNoteDot(id, !!(value && value.trim()));
    if (field === 'stage') { updateStageStyling(id, lead); loadNotifications(); }
  } catch (e) {
    console.error('Could not save lead', e);
    lead[field] = previous;
    if (field === 'stage') lead.phaseStep = previousPhaseStep;
    alert(`Could not save that change: ${e.message}`);
    renderLeadsTable();
  }
}

function updateStageStyling(id, lead) {
  const row = document.querySelector(`.leads-row-body[data-id="${id}"]`);
  if (!row) return;
  const stageCls = stageClass(lead.stage);
  row.className = ['leads-row', 'leads-row-body', stageCls, leadsState.selected.has(id) ? 'selected' : ''].filter(Boolean).join(' ');

  const select = row.querySelector('.stage-badge');
  if (!select) return;
  select.className = 'stage-badge' + (stageCls ? ` ${stageCls}` : '');
  select.innerHTML = stageOptionsFor(lead.platform).map(o => {
    const isSelected = lead.stage === o.value;
    const label = isSelected ? stageLabel(lead) : o.label;
    return `<option value="${o.value}"${isSelected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function updateNoteDot(id, hasNote) {
  const usernameCell = document.querySelector(`.leads-row-body[data-id="${id}"] .lc-username`);
  if (!usernameCell) return;
  let dot = usernameCell.querySelector('.note-dot');
  if (hasNote && !dot) {
    dot = document.createElement('span');
    dot.className = 'note-dot';
    dot.title = 'Has a note';
    usernameCell.appendChild(dot);
  } else if (!hasNote && dot) {
    dot.remove();
  }
}

function toggleExpand(id) {
  const btn = document.querySelector(`.leads-row-body[data-id="${id}"] .expand-btn`);
  const detail = document.querySelector(`.lead-detail[data-detail-id="${id}"]`);
  if (!btn || !detail) return;
  const expanded = leadsState.expanded.has(id);
  if (expanded) {
    leadsState.expanded.delete(id);
    detail.classList.add('hidden');
    btn.classList.remove('expanded');
  } else {
    leadsState.expanded.add(id);
    detail.classList.remove('hidden');
    btn.classList.add('expanded');
    const bioEl = detail.querySelector('textarea.auto-resize');
    if (bioEl) autoResizeTextarea(bioEl);
  }
}

$('#leads-rows').addEventListener('change', (e) => {
  if (e.target.classList.contains('row-select')) {
    const id = e.target.closest('.leads-row-body').dataset.id;
    setLeadSelected(id, e.target.checked);
    return;
  }
  const field = e.target.dataset.field;
  if (!field) return;
  const container = e.target.closest('[data-id], [data-detail-id]');
  const id = container.dataset.id || container.dataset.detailId;
  updateLeadField(id, field, e.target.value);
});

$('#leads-rows').addEventListener('input', (e) => {
  if (e.target.classList.contains('auto-resize')) autoResizeTextarea(e.target);
});

$('#leads-rows').addEventListener('click', (e) => {
  const trashBtn = e.target.closest('.trash-btn');
  if (trashBtn) {
    deleteLeads([trashBtn.closest('.leads-row-body').dataset.id]);
    return;
  }
  const expandBtn = e.target.closest('.expand-btn');
  if (expandBtn) {
    toggleExpand(expandBtn.closest('.leads-row-body').dataset.id);
    return;
  }
  const urlEditBtn = e.target.closest('.url-edit-btn');
  if (urlEditBtn) {
    const id = urlEditBtn.closest('.leads-row-body').dataset.id;
    const lead = leadsState.leads.find(l => l.id === id);
    if (!lead) return;
    const cell = urlEditBtn.closest('.lc-url');
    cell.innerHTML = `<input type="text" value="${escapeHtml(lead.profileUrl)}" data-field="profileUrl" class="url-edit-input" placeholder="Profile URL">`;
    const input = cell.querySelector('input');
    input.focus();
    input.select();
    return;
  }

  const reminderToggleBtn = e.target.closest('.lead-reminder-toggle-btn');
  if (reminderToggleBtn) {
    reminderToggleBtn.classList.add('hidden');
    reminderToggleBtn.nextElementSibling.classList.remove('hidden');
    return;
  }
  const reminderCancelBtn = e.target.closest('.lead-reminder-cancel-btn');
  if (reminderCancelBtn) {
    const widget = reminderCancelBtn.closest('.lead-reminder-widget');
    widget.querySelector('.lead-reminder-form').classList.add('hidden');
    widget.querySelector('.lead-reminder-toggle-btn').classList.remove('hidden');
    return;
  }
  const reminderSaveBtn = e.target.closest('.lead-reminder-save-btn');
  if (reminderSaveBtn) {
    saveLeadReminder(reminderSaveBtn);
    return;
  }
  const reminderRemoveBtn = e.target.closest('.lead-reminder-remove-btn');
  if (reminderRemoveBtn) {
    removeLeadReminder(reminderRemoveBtn);
  }
});

function updateReminderDot(id, hasReminder) {
  const usernameCell = document.querySelector(`.leads-row-body[data-id="${id}"] .lc-username`);
  if (!usernameCell) return;
  let dot = usernameCell.querySelector('.reminder-dot');
  if (hasReminder && !dot) {
    dot = document.createElement('span');
    dot.className = 'reminder-dot';
    dot.title = 'Has a reminder';
    usernameCell.appendChild(dot);
  } else if (!hasReminder && dot) {
    dot.remove();
  }
}

async function saveLeadReminder(saveBtn) {
  const widget = saveBtn.closest('.lead-reminder-widget');
  const lead = leadsState.leads.find(l => l.id === widget.dataset.leadId);
  if (!lead) return;
  const amount = Number(widget.querySelector('.lead-reminder-amount').value);
  if (!Number.isFinite(amount) || amount <= 0) {
    alert('Enter a valid number.');
    return;
  }
  const unit = widget.querySelector('.lead-reminder-unit').value;
  const days = amount * (unit === 'days' ? 1 : unit === 'weeks' ? 7 : 30);
  const dueAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  saveBtn.disabled = true;
  try {
    const data = await fetchJson('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Reminder for ${leadDisplayName(lead)}`, dueAt: dueAt.toISOString(), leadId: lead.id })
    });
    // Sticks around like the lead's Note does, rather than flashing a
    // confirmation and reverting to "+ Add reminder" as if nothing happened.
    leadsState.remindersByLead[lead.id] = { id: data.id, text: `Reminder for ${leadDisplayName(lead)}`, dueAt: dueAt.toISOString(), leadId: lead.id };
    updateReminderDot(lead.id, true);
    widget.outerHTML = reminderWidgetHtml(lead);
    loadNotifications();
  } catch (e) {
    alert(`Could not set reminder: ${e.message}`);
  } finally {
    saveBtn.disabled = false;
  }
}

async function removeLeadReminder(removeBtn) {
  const widget = removeBtn.closest('.lead-reminder-widget');
  const leadId = widget.dataset.leadId;
  const lead = leadsState.leads.find(l => l.id === leadId);
  if (!lead) return;
  removeBtn.disabled = true;
  try {
    await fetchJson(`/api/reminders/${removeBtn.dataset.reminderId}`, { method: 'DELETE' });
    delete leadsState.remindersByLead[leadId];
    updateReminderDot(leadId, false);
    widget.outerHTML = reminderWidgetHtml(lead);
    loadNotifications();
  } catch (e) {
    alert(`Could not remove reminder: ${e.message}`);
    removeBtn.disabled = false;
  }
}

// Pressing Enter in the URL edit field just blurs it — the existing
// focusout handler below takes care of saving + swapping back to link view.
$('#leads-rows').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('url-edit-input')) {
    e.target.blur();
  }
});

$('#leads-rows').addEventListener('focusout', (e) => {
  if (!e.target.classList.contains('url-edit-input')) return;
  const id = e.target.closest('.leads-row-body').dataset.id;
  const lead = leadsState.leads.find(l => l.id === id);
  if (!lead) return;
  e.target.closest('.lc-url').innerHTML = urlCellHtml(lead);
});

// ---------- Selection ----------

function setLeadSelected(id, selected) {
  if (selected) leadsState.selected.add(id);
  else leadsState.selected.delete(id);

  const row = document.querySelector(`.leads-row-body[data-id="${id}"]`);
  if (row) row.classList.toggle('selected', selected);

  updateSelectAllCheckbox();
  updateSelectionBar();
}

// The header checkbox reflects (and toggles) only the leads on the current
// page — selecting "all" across a paginated 20k-row list would be a trap.
function updateSelectAllCheckbox() {
  const start = leadsState.page * PAGE_SIZE;
  const pageIds = getFilteredLeads().slice(start, start + PAGE_SIZE).map(({ lead }) => lead.id);
  const allSelected = pageIds.length > 0 && pageIds.every(id => leadsState.selected.has(id));
  $('#leads-select-all').checked = allSelected;
}

function updateSelectionBar() {
  const bar = $('#leads-selection-bar');
  const n = leadsState.selected.size;
  if (n === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('#leads-selection-count').textContent = `${n} lead${n === 1 ? '' : 's'} selected`;
}

$('#leads-select-all').addEventListener('change', (e) => {
  const start = leadsState.page * PAGE_SIZE;
  const pageItems = getFilteredLeads().slice(start, start + PAGE_SIZE);
  pageItems.forEach(({ lead }) => {
    if (e.target.checked) leadsState.selected.add(lead.id);
    else leadsState.selected.delete(lead.id);
  });
  renderLeadsTable();
  updateSelectionBar();
});

$('#leads-selection-clear').addEventListener('click', () => {
  leadsState.selected.clear();
  renderLeadsTable();
  updateSelectionBar();
});

$('#leads-selection-delete').addEventListener('click', () => {
  const ids = Array.from(leadsState.selected);
  leadsState.selected.clear();
  updateSelectionBar();
  deleteLeads(ids);
});

$('#leads-selection-start').addEventListener('click', async () => {
  const selectedLeads = leadsState.leads.filter(l => leadsState.selected.has(l.id));
  if (selectedLeads.length === 0) return;

  // A session is one kind of UI for its whole run — mixing platforms (or
  // LinkedIn stages that imply different session kinds) has no single right
  // answer, so it's rejected outright rather than guessed at.
  const platforms = new Set(selectedLeads.map(l => l.platform));
  if (platforms.size > 1) {
    alert('Select leads from only one platform at a time to start a session.');
    return;
  }
  const platform = selectedLeads[0].platform;

  let kind = 'ig_message';
  if (platform === 'linkedin') {
    const stages = new Set(selectedLeads.map(l => l.stage));
    if (stages.size > 1) {
      alert('Select leads that are all in the same stage to start a session.');
      return;
    }
    const stage = selectedLeads[0].stage;
    if (stage === 'new') {
      kind = 'li_engagement';
    } else if (stage === 'connection_sent') {
      kind = 'li_message';
    } else {
      alert("Select either brand-new leads (for an engagement session) or leads whose connection request was accepted (for a phase 1 message session) to start a session here. Other stages don't have a session — use the stage dropdown to move a lead directly.");
      return;
    }
  }

  // Instagram sends need an account attributed to them — same limit/cooldown
  // system as the Home starter, so a selection-started session here also
  // pauses/blocks correctly once an account is maxed out.
  if (kind === 'ig_message') {
    if (isIgCooldownActive()) {
      alert(`Instagram is on a switch cooldown for another ${formatCountdown(igCooldownState.until - Date.now())} — new Instagram sessions are blocked until then.`);
      return;
    }
    pendingLeadsSessionSelection = selectedLeads;
    const accounts = await loadIgAccounts();
    const usable = populateAccountSelect($('#leads-session-account-select'), accounts);
    $('#leads-session-no-accounts').classList.toggle('hidden', usable.length > 0);
    $('#leads-session-account-select').classList.toggle('hidden', usable.length === 0);
    $('#leads-session-account-confirm-btn').disabled = usable.length === 0;
    $('#leads-session-account-modal').classList.remove('hidden');
    return;
  }

  leadsState.selected.clear();
  updateSelectionBar();
  beginSessionWithLeads(selectedLeads, { kind });
});

let pendingLeadsSessionSelection = null;

$('#leads-session-account-cancel-btn').addEventListener('click', () => {
  $('#leads-session-account-modal').classList.add('hidden');
  pendingLeadsSessionSelection = null;
});

$('#leads-session-account-confirm-btn').addEventListener('click', () => {
  const accountId = $('#leads-session-account-select').value;
  if (!accountId || !pendingLeadsSessionSelection) return;
  const selectedLeads = pendingLeadsSessionSelection;
  pendingLeadsSessionSelection = null;
  $('#leads-session-account-modal').classList.add('hidden');
  leadsState.selected.clear();
  updateSelectionBar();
  beginSessionWithLeads(selectedLeads, { kind: 'ig_message', accountId });
});

// ---------- Delete + undo ----------

// Returns a promise that resolves once the server-side delete has actually
// completed (after the 300ms row fade-out) — callers that need to refresh
// something dependent on lead state (e.g. the follow-up notification badge)
// should await this instead of assuming the delete is done synchronously.
function deleteLeads(ids) {
  if (!ids || ids.length === 0) return Promise.resolve();
  ids.forEach(id => {
    const row = document.querySelector(`.leads-row-body[data-id="${id}"]`);
    const detail = document.querySelector(`.lead-detail[data-detail-id="${id}"]`);
    if (row) row.classList.add('removing');
    if (detail) detail.classList.add('hidden');
  });

  return new Promise(resolve => {
    setTimeout(async () => {
      leadsState.leads = leadsState.leads.filter(l => !ids.includes(l.id));
      ids.forEach(id => { leadsState.expanded.delete(id); leadsState.selected.delete(id); });
      renderLeadsTable();

      try {
        const data = await fetchJson('/api/leads/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        showUndoToast(data.deletedIds && data.deletedIds.length ? data.deletedIds : ids);
      } catch (e) {
        console.error('Could not delete leads', e);
        alert(`Could not delete: ${e.message}. Reloading your leads to stay in sync.`);
        await loadLeads();
      }
      resolve();
    }, 300);
  });
}

function showUndoToast(ids) {
  const toast = $('#undo-toast');
  const fill = $('#undo-progress-fill');

  if (pendingUndo) {
    clearTimeout(pendingUndo.timer);
    pendingUndo.ids = pendingUndo.ids.concat(ids);
  } else {
    pendingUndo = { ids: [...ids], timer: null };
  }

  const n = pendingUndo.ids.length;
  $('#undo-toast-text').textContent = `${n} lead${n === 1 ? '' : 's'} deleted`;
  toast.classList.remove('hidden');

  fill.style.transition = 'none';
  fill.style.width = '100%';
  void fill.offsetWidth;
  fill.style.transition = 'width 5s linear';
  requestAnimationFrame(() => { fill.style.width = '0%'; });

  pendingUndo.timer = setTimeout(() => {
    toast.classList.add('hidden');
    pendingUndo = null;
  }, 5000);
}

$('#undo-btn').addEventListener('click', async () => {
  if (!pendingUndo) return;
  clearTimeout(pendingUndo.timer);
  const ids = pendingUndo.ids;
  pendingUndo = null;
  $('#undo-toast').classList.add('hidden');
  try {
    await fetchJson('/api/leads/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
  } catch (e) {
    console.error('Could not restore leads', e);
    alert(`Could not undo: ${e.message}`);
  }
  loadLeads();
});

// ---------- Delete modal ----------

// Which platform checkboxes are currently checked, as an array of
// 'instagram'/'linkedin' values (0, 1, or 2 entries).
function checkedDeletePlatforms() {
  const platforms = [];
  if ($('#delete-platform-instagram').checked) platforms.push('instagram');
  if ($('#delete-platform-linkedin').checked) platforms.push('linkedin');
  return platforms;
}

// The leads a delete would apply to, scoped to whichever platform box(es)
// are checked — everything below (the "all leads" count, the range bounds,
// and the actual delete) operates on this list, not leadsState.leads directly.
function deleteModalMatchingLeads() {
  const platforms = checkedDeletePlatforms();
  if (platforms.length === 0) return [];
  return leadsState.leads.filter(l => platforms.includes(l.platform));
}

// Range-delete only makes sense scoped to exactly one platform — with both
// checked, "row 5" is ambiguous (5th Instagram lead? 5th LinkedIn lead? 5th
// overall?), so that option disappears entirely rather than guessing.
function updateDeleteModalState() {
  const platforms = checkedDeletePlatforms();
  const matching = deleteModalMatchingLeads();
  const igCount = leadsState.leads.filter(l => l.platform === 'instagram').length;
  const liCount = leadsState.leads.filter(l => l.platform === 'linkedin').length;
  $('#delete-platform-instagram-count').textContent = `(${igCount})`;
  $('#delete-platform-linkedin-count').textContent = `(${liCount})`;
  $('#delete-all-count').textContent = `(${matching.length})`;

  const rangeAvailable = platforms.length === 1;
  $('#delete-mode-range-row').classList.toggle('hidden', !rangeAvailable);
  $('#delete-range-unavailable-note').classList.toggle('hidden', rangeAvailable);
  if (!rangeAvailable && $('#delete-mode-range').checked) {
    $('#delete-mode-all').checked = true;
    $('#delete-range-inputs').classList.add('hidden');
  }

  const errorEl = $('#delete-error');
  if (platforms.length === 0) {
    errorEl.textContent = 'Select at least one platform.';
    errorEl.style.display = 'block';
    $('#delete-confirm-btn').disabled = true;
  } else {
    errorEl.style.display = 'none';
    $('#delete-confirm-btn').disabled = false;
  }
}

$('#leads-delete-btn').addEventListener('click', () => {
  // Pre-checked to match whatever platform tab is currently active on the
  // Leads page — "All" pre-checks both, which correctly also hides the
  // range option by default rather than defaulting to a combined-numbering
  // range that wouldn't mean anything.
  $('#delete-platform-instagram').checked = leadsState.platformFilter !== 'linkedin';
  $('#delete-platform-linkedin').checked = leadsState.platformFilter !== 'instagram';
  $('#delete-range-from').value = '';
  $('#delete-range-to').value = '';
  $('#delete-mode-all').checked = true;
  $('#delete-range-inputs').classList.add('hidden');
  updateDeleteModalState();
  $('#leads-delete-modal').classList.remove('hidden');
});

$('#delete-platform-instagram').addEventListener('change', updateDeleteModalState);
$('#delete-platform-linkedin').addEventListener('change', updateDeleteModalState);

$all('input[name="delete-mode"]').forEach(r => r.addEventListener('change', () => {
  $('#delete-range-inputs').classList.toggle('hidden', !$('#delete-mode-range').checked);
}));

$('#delete-cancel-btn').addEventListener('click', () => $('#leads-delete-modal').classList.add('hidden'));

$('#delete-confirm-btn').addEventListener('click', () => {
  const errorEl = $('#delete-error');
  errorEl.style.display = 'none';

  const platforms = checkedDeletePlatforms();
  if (platforms.length === 0) {
    errorEl.textContent = 'Select at least one platform.';
    errorEl.style.display = 'block';
    return;
  }
  const matching = deleteModalMatchingLeads();

  let ids;
  if ($('#delete-mode-all').checked) {
    ids = matching.map(l => l.id);
  } else {
    const from = Number($('#delete-range-from').value);
    const to = Number($('#delete-range-to').value);
    if (!from || !to || from < 1 || to < from || to > matching.length) {
      errorEl.textContent = `Enter a valid row range between 1 and ${matching.length} (within the selected platform).`;
      errorEl.style.display = 'block';
      return;
    }
    ids = matching.slice(from - 1, to).map(l => l.id);
  }

  $('#leads-delete-modal').classList.add('hidden');
  if (ids.length > 0) deleteLeads(ids);
});

// ---------- Add lead modal ----------

function updateAddModalFieldsForPlatform() {
  const isLinkedin = $('#add-platform-linkedin').checked;
  $('#add-username-row').classList.toggle('hidden', isLinkedin);
  $('#add-followers-row').classList.toggle('hidden', isLinkedin);
  $('#add-headline-row').classList.toggle('hidden', !isLinkedin);
  $('#add-bio-label').textContent = isLinkedin ? 'Additional info' : 'Bio';
  $('#add-profileUrl').placeholder = isLinkedin ? 'https://www.linkedin.com/in/username/' : 'https://www.instagram.com/username/';
}

$('#add-platform-row').addEventListener('change', (e) => {
  if (e.target.name !== 'add-platform') return;
  updateAddModalFieldsForPlatform();
});

$('#leads-add-btn').addEventListener('click', () => {
  ['profileUrl', 'username', 'fullName', 'headline', 'bio', 'followers', 'notes'].forEach(f => {
    const el = $(`#add-${f}`);
    if (el) el.value = '';
  });
  $('#add-platform-instagram').checked = leadsState.platformFilter !== 'linkedin';
  $('#add-platform-linkedin').checked = leadsState.platformFilter === 'linkedin';
  updateAddModalFieldsForPlatform();
  $('#leads-add-modal').classList.remove('hidden');
});

$('#add-cancel-btn').addEventListener('click', () => $('#leads-add-modal').classList.add('hidden'));

$('#add-confirm-btn').addEventListener('click', async () => {
  const platform = $('#add-platform-linkedin').checked ? 'linkedin' : 'instagram';
  const profileUrl = $('#add-profileUrl').value.trim();
  let body;
  if (platform === 'linkedin') {
    const fullName = $('#add-fullName').value.trim();
    if (!profileUrl && !fullName) {
      alert('Enter at least a profile URL or full name.');
      return;
    }
    body = {
      platform,
      profileUrl,
      fullName,
      headline: $('#add-headline').value.trim(),
      bio: $('#add-bio').value,
      notes: $('#add-notes').value
    };
  } else {
    const username = $('#add-username').value.trim().replace('@', '');
    if (!profileUrl && !username) {
      alert('Enter at least a profile URL or username.');
      return;
    }
    const usernameMatch = profileUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    body = {
      platform,
      profileUrl: profileUrl || (username ? `https://www.instagram.com/${username}/` : ''),
      username: username || (usernameMatch ? usernameMatch[1] : ''),
      fullName: $('#add-fullName').value.trim(),
      bio: $('#add-bio').value,
      followers: $('#add-followers').value,
      notes: $('#add-notes').value
    };
  }
  const btn = $('#add-confirm-btn');
  btn.disabled = true;
  try {
    await fetchJson('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    $('#leads-add-modal').classList.add('hidden');
    await loadLeads();
  } catch (e) {
    alert(`Could not add lead: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------- CSV import ----------

function resetCsvState() {
  csvState.headers = [];
  csvState.rows = [];
  csvState.mapping = {};
  csvState.leadsToImport = null;
  csvState.importedCount = 0;
  csvState.duplicatesSkipped = 0;
}

function handleCsvFile(file) {
  resetCsvState();
  // Defaults to the page's active platform tab (falling back to Instagram
  // when viewing "All", since a single CSV import is always one platform).
  csvState.platform = leadsState.platformFilter === 'linkedin' ? 'linkedin' : 'instagram';
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    let rows;
    try {
      rows = parseDelimitedRows(text.trim(), ',').map(r => r.map(c => c.trim()));
    } catch (e) {
      alert(`Could not parse that CSV: ${e.message}`);
      return;
    }
    if (rows.length === 0) { alert('That CSV appears to be empty.'); return; }
    csvState.headers = rows[0];
    csvState.rows = rows.slice(1).filter(r => r.some(c => c !== ''));
    if (csvState.rows.length === 0) { alert('No data rows found in that CSV.'); return; }
    openMappingModal();
  };
  reader.onerror = () => alert('Could not read that file. Please try again.');
  reader.readAsText(file);
}

const leadsFileInput = $('#leads-file-input');
$('#leads-import-btn').addEventListener('click', () => leadsFileInput.click());
$('#leads-dropzone').addEventListener('click', () => leadsFileInput.click());
$('#leads-dropzone').addEventListener('dragover', e => { e.preventDefault(); $('#leads-dropzone').classList.add('drag-over'); });
$('#leads-dropzone').addEventListener('dragleave', () => $('#leads-dropzone').classList.remove('drag-over'));
$('#leads-dropzone').addEventListener('drop', e => {
  e.preventDefault();
  $('#leads-dropzone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleCsvFile(file);
});
leadsFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleCsvFile(file);
});

function autoMapColumns(headers, platform) {
  const used = new Set();
  const mapping = {};
  LEAD_FIELDS_BY_PLATFORM[platform].forEach(field => {
    let found = -1;
    for (const pattern of field.patterns) {
      const idx = headers.findIndex((h, i) => !used.has(i) && pattern.test(h));
      if (idx !== -1) { found = idx; break; }
    }
    if (found !== -1) used.add(found);
    mapping[field.key] = found;
  });
  return mapping;
}

function openMappingModal() {
  $('#mapping-platform-instagram').checked = csvState.platform === 'instagram';
  $('#mapping-platform-linkedin').checked = csvState.platform === 'linkedin';
  renderMappingGrid();
  $('#leads-mapping-modal').classList.remove('hidden');
}

function renderMappingGrid() {
  const grid = $('#mapping-grid');
  grid.innerHTML = '';
  csvState.mapping = autoMapColumns(csvState.headers, csvState.platform);

  LEAD_FIELDS_BY_PLATFORM[csvState.platform].forEach(field => {
    const wrap = document.createElement('label');
    wrap.textContent = field.label + (field.required ? ' *' : '');
    const sel = document.createElement('select');
    const skipOpt = document.createElement('option');
    skipOpt.value = '-1';
    skipOpt.textContent = '— Skip —';
    sel.appendChild(skipOpt);
    csvState.headers.forEach((h, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = h || `Column ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = String(csvState.mapping[field.key]);
    sel.addEventListener('change', () => {
      csvState.mapping[field.key] = Number(sel.value);
      renderMappingPreview();
    });
    wrap.appendChild(sel);
    grid.appendChild(wrap);
  });

  renderMappingPreview();
}

$('#mapping-platform-row').addEventListener('change', (e) => {
  if (e.target.name !== 'mapping-platform') return;
  csvState.platform = e.target.value;
  renderMappingGrid();
});

function renderMappingPreview() {
  const table = $('#mapping-preview');
  const fields = LEAD_FIELDS_BY_PLATFORM[csvState.platform];
  const previewRows = csvState.rows.slice(0, 4);
  let html = '<tr>' + fields.map(f => `<th>${escapeHtml(f.label)}</th>`).join('') + '</tr>';
  previewRows.forEach(row => {
    html += '<tr>' + fields.map(f => {
      const idx = csvState.mapping[f.key];
      const val = idx >= 0 ? (row[idx] || '') : '';
      return `<td>${escapeHtml(val)}</td>`;
    }).join('') + '</tr>';
  });
  table.innerHTML = html;
}

function closeMappingModal() {
  $('#leads-mapping-modal').classList.add('hidden');
  $('#mapping-progress').classList.add('hidden');
  $('#mapping-error').classList.add('hidden');
  $('#mapping-confirm-btn').disabled = false;
  $('#mapping-confirm-btn').textContent = 'Import leads';
  $('#mapping-cancel-btn').disabled = false;
  leadsFileInput.value = '';
  resetCsvState();
}

$('#mapping-cancel-btn').addEventListener('click', closeMappingModal);

function buildLeadsFromMapping() {
  const mapping = csvState.mapping;
  if (csvState.platform === 'linkedin') {
    const leads = csvState.rows.map(row => ({
      profileUrl: mapping.profileUrl >= 0 ? (row[mapping.profileUrl] || '').trim() : '',
      fullName: mapping.fullName >= 0 ? (row[mapping.fullName] || '').trim() : '',
      headline: mapping.headline >= 0 ? (row[mapping.headline] || '').trim() : '',
      // "Additional info" is LinkedIn's equivalent of Instagram's bio field
      // (same underlying column server-side — see LEAD_PATCH_FIELDS).
      bio: mapping.additionalInfo >= 0 ? (row[mapping.additionalInfo] || '') : ''
    })).filter(l => l.profileUrl || l.fullName);
    return leads;
  }

  const leads = csvState.rows.map(row => ({
    profileUrl: mapping.profileUrl >= 0 ? (row[mapping.profileUrl] || '').trim() : '',
    username: mapping.username >= 0 ? (row[mapping.username] || '').trim().replace('@', '') : '',
    fullName: mapping.fullName >= 0 ? (row[mapping.fullName] || '').trim() : '',
    bio: mapping.bio >= 0 ? (row[mapping.bio] || '') : '',
    followers: mapping.followers >= 0 ? normalizeFollowers(row[mapping.followers]) : ''
  })).filter(l => l.profileUrl || l.username);

  leads.forEach(l => {
    if (!l.username && l.profileUrl) {
      const m = l.profileUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
      if (m) l.username = m[1];
    }
    if (!l.profileUrl && l.username) {
      l.profileUrl = `https://www.instagram.com/${l.username}/`;
    }
  });

  return leads;
}

// Imports csvState.leadsToImport in chunks (so a 3000-20000 row CSV never
// hits a request-size/timeout limit in one shot), tracking how many rows
// have landed so far. On failure, the already-imported rows stay put and
// clicking the button again (still labelled "Retry…") resumes from
// csvState.importedCount instead of re-sending everything.
async function importLeadsInChunks() {
  const leads = csvState.leadsToImport;
  const total = leads.length;
  const progressWrap = $('#mapping-progress');
  const progressFill = $('#mapping-progress-fill');
  const progressText = $('#mapping-progress-text');
  const errorEl = $('#mapping-error');
  const confirmBtn = $('#mapping-confirm-btn');
  const cancelBtn = $('#mapping-cancel-btn');

  errorEl.classList.add('hidden');
  progressWrap.classList.remove('hidden');
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;

  while (csvState.importedCount < total) {
    const start = csvState.importedCount;
    const chunk = leads.slice(start, start + IMPORT_CHUNK_SIZE);

    progressText.textContent = `Importing ${start} of ${total} leads…`;
    progressFill.style.width = `${Math.round((start / total) * 100)}%`;

    try {
      const data = await fetchJson('/api/leads/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leads: chunk, platform: csvState.platform })
      }, 30000);
      csvState.importedCount += chunk.length;
      csvState.duplicatesSkipped += data.duplicates || 0;
    } catch (e) {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      confirmBtn.textContent = `Retry (${csvState.importedCount} of ${total} done)`;
      errorEl.textContent = `Import stopped after ${csvState.importedCount} of ${total} leads: ${e.message}. Nothing already imported was lost — click Retry to continue with the rest.`;
      errorEl.classList.remove('hidden');
      return false;
    }
  }

  progressFill.style.width = '100%';
  progressText.textContent = `Imported ${total} of ${total} leads.`;
  if (csvState.duplicatesSkipped > 0) {
    const added = total - csvState.duplicatesSkipped;
    alert(`Imported ${added} new lead${added === 1 ? '' : 's'}. Skipped ${csvState.duplicatesSkipped} duplicate${csvState.duplicatesSkipped === 1 ? '' : 's'} already in your list (or repeated in the file) — nothing was added twice.`);
  }
  return true;
}

$('#mapping-confirm-btn').addEventListener('click', async () => {
  if (!csvState.leadsToImport) {
    const mapping = csvState.mapping;
    const idField = csvState.platform === 'linkedin' ? 'fullName' : 'username';
    if (mapping.profileUrl < 0 && mapping[idField] < 0) {
      alert(`Map at least Profile URL or ${csvState.platform === 'linkedin' ? 'Full name' : 'Username'}.`);
      return;
    }
    const leads = buildLeadsFromMapping();
    if (leads.length === 0) { alert('No valid rows to import.'); return; }
    csvState.leadsToImport = leads;
    csvState.importedCount = 0;
    csvState.duplicatesSkipped = 0;
  }

  const ok = await importLeadsInChunks();
  if (ok) {
    closeMappingModal();
    await loadLeads();
  }
});
