const PAGE_SIZE = 200;
const IMPORT_CHUNK_SIZE = 500;

const leadsState = {
  leads: [],
  expanded: new Set(),
  selected: new Set(),
  page: 0
};

const csvState = { headers: [], rows: [], mapping: {}, leadsToImport: null, importedCount: 0 };

let pendingUndo = null; // { ids, timer }
// fetchJson is defined in app.js (loaded first) and shared globally.

const LEAD_FIELDS = [
  { key: 'profileUrl', label: 'Profile URL', required: true, patterns: [/profile.?url/i, /^url$/i, /link/i] },
  { key: 'username', label: 'Username', required: true, patterns: [/username/i, /handle/i, /^user$/i] },
  { key: 'fullName', label: 'Full name', required: false, patterns: [/full.?name/i, /^name$/i] },
  { key: 'bio', label: 'Bio', required: false, patterns: [/bio/i, /about/i] },
  { key: 'followers', label: 'Followers', required: false, patterns: [/follower/i] }
];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PHASE_MAX_STEP = { 1: 2, 2: 9, 3: 9 };

const STAGE_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'phase1', label: 'Phase 1' },
  { value: 'phase2', label: 'Phase 2' },
  { value: 'phase3', label: 'Phase 3' },
  { value: 'call_booked', label: 'Call booked' },
  { value: 'dead', label: 'Dead' }
];

function stageLabel(lead) {
  const stage = lead.stage;
  if (stage === 'phase1' || stage === 'phase2' || stage === 'phase3') {
    const phase = Number(stage.slice(-1));
    const max = PHASE_MAX_STEP[phase];
    const step = Math.min(lead.phaseStep || 0, max);
    return `Phase ${phase} · ${step}/${max}`;
  }
  if (stage === 'call_booked') return 'Call booked';
  if (stage === 'dead') return 'Dead';
  return 'New';
}

// Maps a stage to the CSS class that colors its badge / row.
function stageClass(stage) {
  if (stage === 'phase1' || stage === 'phase2' || stage === 'phase3') return stage;
  if (stage === 'call_booked') return 'call-booked';
  if (stage === 'dead') return 'dead';
  return '';
}

function normalizeFollowers(raw) {
  if (!raw) return '';
  const kMatch = String(raw).trim().match(/^([\d.,]+)\s*[kK]$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1].replace(',', '.')) * 1000);
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits ? Number(digits) : '';
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
  renderLeadsTable();
}

function leadRowHtml(lead, index) {
  const expanded = leadsState.expanded.has(lead.id);
  const selected = leadsState.selected.has(lead.id);
  const stageCls = stageClass(lead.stage);
  const hasNote = !!(lead.notes && lead.notes.trim());
  const rowClasses = ['leads-row', 'leads-row-body', stageCls, selected ? 'selected' : ''].filter(Boolean).join(' ');
  const row = `
    <div class="${rowClasses}" data-id="${lead.id}">
      <div class="lc lc-check"><input type="checkbox" class="row-select" ${selected ? 'checked' : ''}></div>
      <div class="lc lc-num">${index + 1}</div>
      <div class="lc lc-url"><input type="text" value="${escapeHtml(lead.profileUrl)}" data-field="profileUrl" placeholder="Profile URL"></div>
      <div class="lc lc-username">
        <input type="text" value="${escapeHtml(lead.username)}" data-field="username" placeholder="username">
        ${hasNote ? '<span class="note-dot" title="Has a note"></span>' : ''}
      </div>
      <div class="lc lc-expand"><button type="button" class="expand-btn${expanded ? ' expanded' : ''}" title="Show details">&rsaquo;</button></div>
      <div class="lc lc-stage">
        <select class="stage-badge${stageCls ? ' ' + stageCls : ''}" data-field="stage">
          ${STAGE_OPTIONS.map(o => {
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
  const detail = `
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
  if (leadsState.leads.length === 0) {
    wrap.classList.add('hidden');
    dropzone.classList.remove('hidden');
    return;
  }
  dropzone.classList.add('hidden');
  wrap.classList.remove('hidden');

  // Only the current page is rendered into the DOM — with lead lists up to
  // ~20k rows, rendering everything at once makes the page sluggish.
  const totalPages = Math.max(1, Math.ceil(leadsState.leads.length / PAGE_SIZE));
  leadsState.page = Math.min(Math.max(leadsState.page, 0), totalPages - 1);

  const start = leadsState.page * PAGE_SIZE;
  const pageLeads = leadsState.leads.slice(start, start + PAGE_SIZE);
  $('#leads-rows').innerHTML = pageLeads.map((lead, i) => leadRowHtml(lead, start + i)).join('');

  // Expanded detail rows render visible (not display:none), so their bio
  // textarea can be measured and grown to fit right away.
  $all('.lead-detail:not(.hidden) textarea.auto-resize').forEach(autoResizeTextarea);
  updateSelectAllCheckbox();
  updateSelectionBar();

  const pagination = $('#leads-pagination');
  if (leadsState.leads.length <= PAGE_SIZE) {
    pagination.classList.add('hidden');
  } else {
    pagination.classList.remove('hidden');
    const end = Math.min(start + PAGE_SIZE, leadsState.leads.length);
    $('#leads-pagination-info').textContent = `Showing ${start + 1}–${end} of ${leadsState.leads.length}`;
    $('#leads-prev-page').disabled = leadsState.page === 0;
    $('#leads-next-page').disabled = leadsState.page >= totalPages - 1;
  }
}

$('#leads-prev-page').addEventListener('click', () => { leadsState.page--; renderLeadsTable(); });
$('#leads-next-page').addEventListener('click', () => { leadsState.page++; renderLeadsTable(); });

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
  select.innerHTML = STAGE_OPTIONS.map(o => {
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
  }
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
  const pageIds = leadsState.leads.slice(start, start + PAGE_SIZE).map(l => l.id);
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
  const pageLeads = leadsState.leads.slice(start, start + PAGE_SIZE);
  pageLeads.forEach(l => {
    if (e.target.checked) leadsState.selected.add(l.id);
    else leadsState.selected.delete(l.id);
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

$('#leads-selection-start').addEventListener('click', () => {
  const selectedLeads = leadsState.leads.filter(l => leadsState.selected.has(l.id));
  if (selectedLeads.length === 0) return;
  leadsState.selected.clear();
  updateSelectionBar();
  beginSessionWithLeads(selectedLeads);
});

// ---------- Delete + undo ----------

function deleteLeads(ids) {
  if (!ids || ids.length === 0) return;
  ids.forEach(id => {
    const row = document.querySelector(`.leads-row-body[data-id="${id}"]`);
    const detail = document.querySelector(`.lead-detail[data-detail-id="${id}"]`);
    if (row) row.classList.add('removing');
    if (detail) detail.classList.add('hidden');
  });

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
  }, 300);
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

$('#leads-delete-btn').addEventListener('click', () => {
  $('#delete-all-count').textContent = `(${leadsState.leads.length})`;
  $('#delete-range-from').value = '';
  $('#delete-range-to').value = '';
  $('#delete-mode-all').checked = true;
  $('#delete-range-inputs').classList.add('hidden');
  $('#delete-error').style.display = 'none';
  $('#leads-delete-modal').classList.remove('hidden');
});

$all('input[name="delete-mode"]').forEach(r => r.addEventListener('change', () => {
  $('#delete-range-inputs').classList.toggle('hidden', !$('#delete-mode-range').checked);
}));

$('#delete-cancel-btn').addEventListener('click', () => $('#leads-delete-modal').classList.add('hidden'));

$('#delete-confirm-btn').addEventListener('click', () => {
  const errorEl = $('#delete-error');
  errorEl.style.display = 'none';
  let ids;
  const total = leadsState.leads.length;

  if ($('#delete-mode-all').checked) {
    ids = leadsState.leads.map(l => l.id);
  } else {
    const from = Number($('#delete-range-from').value);
    const to = Number($('#delete-range-to').value);
    if (!from || !to || from < 1 || to < from || to > total) {
      errorEl.textContent = `Enter a valid range between 1 and ${total}.`;
      errorEl.style.display = 'block';
      return;
    }
    ids = leadsState.leads.slice(from - 1, to).map(l => l.id);
  }

  $('#leads-delete-modal').classList.add('hidden');
  if (ids.length > 0) deleteLeads(ids);
});

// ---------- Add lead modal ----------

$('#leads-add-btn').addEventListener('click', () => {
  ['profileUrl', 'username', 'fullName', 'bio', 'followers', 'notes'].forEach(f => {
    const el = $(`#add-${f}`);
    if (el) el.value = '';
  });
  $('#leads-add-modal').classList.remove('hidden');
});

$('#add-cancel-btn').addEventListener('click', () => $('#leads-add-modal').classList.add('hidden'));

$('#add-confirm-btn').addEventListener('click', async () => {
  const profileUrl = $('#add-profileUrl').value.trim();
  const username = $('#add-username').value.trim().replace('@', '');
  if (!profileUrl && !username) {
    alert('Enter at least a profile URL or username.');
    return;
  }
  const usernameMatch = profileUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
  const body = {
    profileUrl: profileUrl || (username ? `https://www.instagram.com/${username}/` : ''),
    username: username || (usernameMatch ? usernameMatch[1] : ''),
    fullName: $('#add-fullName').value.trim(),
    bio: $('#add-bio').value,
    followers: $('#add-followers').value,
    notes: $('#add-notes').value
  };
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
}

function handleCsvFile(file) {
  resetCsvState();
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

function autoMapColumns(headers) {
  const used = new Set();
  const mapping = {};
  LEAD_FIELDS.forEach(field => {
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
  const grid = $('#mapping-grid');
  grid.innerHTML = '';
  csvState.mapping = autoMapColumns(csvState.headers);

  LEAD_FIELDS.forEach(field => {
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
  $('#leads-mapping-modal').classList.remove('hidden');
}

function renderMappingPreview() {
  const table = $('#mapping-preview');
  const previewRows = csvState.rows.slice(0, 4);
  let html = '<tr>' + LEAD_FIELDS.map(f => `<th>${escapeHtml(f.label)}</th>`).join('') + '</tr>';
  previewRows.forEach(row => {
    html += '<tr>' + LEAD_FIELDS.map(f => {
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
      await fetchJson('/api/leads/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leads: chunk })
      }, 30000);
      csvState.importedCount += chunk.length;
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
  return true;
}

$('#mapping-confirm-btn').addEventListener('click', async () => {
  if (!csvState.leadsToImport) {
    const mapping = csvState.mapping;
    if (mapping.profileUrl < 0 && mapping.username < 0) {
      alert('Map at least Profile URL or Username.');
      return;
    }
    const leads = buildLeadsFromMapping();
    if (leads.length === 0) { alert('No valid rows to import.'); return; }
    csvState.leadsToImport = leads;
    csvState.importedCount = 0;
  }

  const ok = await importLeadsInChunks();
  if (ok) {
    closeMappingModal();
    await loadLeads();
  }
});
