const leadsState = {
  leads: [],
  expanded: new Set()
};

const csvState = { headers: [], rows: [], mapping: {} };

let pendingUndo = null; // { ids, timer }

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

function stageLabel(stage) {
  if (!stage) return 'New';
  return stage.charAt(0).toUpperCase() + stage.slice(1);
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
    const res = await fetch('/api/leads');
    const data = await res.json();
    leadsState.leads = data.leads || [];
  } catch (e) {
    console.error('Could not load leads', e);
  }
  renderLeadsTable();
}

function leadRowHtml(lead, index) {
  const expanded = leadsState.expanded.has(lead.id);
  const row = `
    <div class="leads-row leads-row-body" data-id="${lead.id}">
      <div class="lc lc-num">${index + 1}</div>
      <div class="lc lc-url"><input type="text" value="${escapeHtml(lead.profileUrl)}" data-field="profileUrl" placeholder="Profile URL"></div>
      <div class="lc lc-username"><input type="text" value="${escapeHtml(lead.username)}" data-field="username" placeholder="username"></div>
      <div class="lc lc-expand"><button type="button" class="expand-btn${expanded ? ' expanded' : ''}" title="Show details">&rsaquo;</button></div>
      <div class="lc lc-stage"><span class="stage-badge">${escapeHtml(stageLabel(lead.stage))}</span></div>
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
      <label class="lead-detail-bio">Bio
        <textarea rows="2" data-field="bio">${escapeHtml(lead.bio)}</textarea>
      </label>
    </div>`;
  return row + detail;
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
  $('#leads-rows').innerHTML = leadsState.leads.map(leadRowHtml).join('');
}

// ---------- Inline editing ----------

async function updateLeadField(id, field, value) {
  const lead = leadsState.leads.find(l => l.id === id);
  if (!lead) return;
  lead[field] = value;
  try {
    await fetch(`/api/leads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileUrl: lead.profileUrl,
        username: lead.username,
        fullName: lead.fullName,
        bio: lead.bio,
        followers: lead.followers,
        stage: lead.stage
      })
    });
  } catch (e) {
    console.error('Could not save lead', e);
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
  }
}

$('#leads-rows').addEventListener('change', (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const container = e.target.closest('[data-id], [data-detail-id]');
  const id = container.dataset.id || container.dataset.detailId;
  updateLeadField(id, field, e.target.value);
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
    ids.forEach(id => leadsState.expanded.delete(id));
    renderLeadsTable();

    try {
      const res = await fetch('/api/leads/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      const data = await res.json();
      showUndoToast(data.deletedIds && data.deletedIds.length ? data.deletedIds : ids);
    } catch (e) {
      console.error('Could not delete leads', e);
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
    await fetch('/api/leads/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
  } catch (e) {
    console.error('Could not restore leads', e);
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
  ['profileUrl', 'username', 'fullName', 'bio', 'followers'].forEach(f => {
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
    followers: $('#add-followers').value
  };
  const btn = $('#add-confirm-btn');
  btn.disabled = true;
  try {
    await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    $('#leads-add-modal').classList.add('hidden');
    await loadLeads();
  } catch (e) {
    alert('Could not add lead.');
  } finally {
    btn.disabled = false;
  }
});

// ---------- CSV import ----------

function handleCsvFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    const rows = parseDelimitedRows(text.trim(), ',').map(r => r.map(c => c.trim()));
    if (rows.length === 0) { alert('That CSV appears to be empty.'); return; }
    csvState.headers = rows[0];
    csvState.rows = rows.slice(1).filter(r => r.some(c => c !== ''));
    if (csvState.rows.length === 0) { alert('No data rows found in that CSV.'); return; }
    openMappingModal();
  };
  reader.onerror = () => alert('Could not read that file.');
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
  leadsFileInput.value = '';
}

$('#mapping-cancel-btn').addEventListener('click', closeMappingModal);

$('#mapping-confirm-btn').addEventListener('click', async () => {
  const mapping = csvState.mapping;
  if (mapping.profileUrl < 0 && mapping.username < 0) {
    alert('Map at least Profile URL or Username.');
    return;
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

  if (leads.length === 0) { alert('No valid rows to import.'); return; }

  const btn = $('#mapping-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    await fetch('/api/leads/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leads })
    });
    closeMappingModal();
    await loadLeads();
  } catch (e) {
    alert('Import failed. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import leads';
  }
});
