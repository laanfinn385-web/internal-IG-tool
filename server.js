const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function loadData() {
  const rows = await sql`SELECT * FROM outreaches`;
  return {
    outreaches: rows.map(r => ({
      id: r.id,
      date: r.date,
      createdAt: r.created_at,
      username: r.username,
      profileUrl: r.profile_url,
      fullName: r.full_name,
      bio: r.bio,
      followers: r.followers,
      lastPostWeeks: r.last_post_weeks,
      postsPerWeek: r.posts_per_week,
      avgViews: r.avg_views,
      template: r.template,
      message: r.message,
      status: r.status
    }))
  };
}

// Local-timezone date string (YYYY-MM-DD). Deliberately avoids toISOString(),
// which converts to UTC and rolls back to the previous day for any positive
// UTC-offset timezone once local time is past midnight but before the UTC
// offset catches up (e.g. Europe/Amsterdam).
function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoStr(n, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return todayStr(d);
}

// Streak = consecutive days with >=1 "sent" outreach, walking backward from today,
// never broken by Sundays (they just don't count either way).
function computeStreak(sentDateSet) {
  const today = todayStr();
  let cursor = new Date(today + 'T00:00:00');
  if (!sentDateSet.has(today)) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (true) {
    if (cursor.getDay() === 0) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    const ds = todayStr(cursor);
    if (sentDateSet.has(ds)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

app.get('/api/home', async (req, res) => {
  const data = await loadData();
  const sentDateSet = new Set(
    data.outreaches.filter(o => o.status === 'sent').map(o => o.date)
  );
  const streak = computeStreak(sentDateSet);
  const sevenDaysAgo = daysAgoStr(6);
  const last7Days = data.outreaches.filter(
    o => o.status === 'sent' && o.date >= sevenDaysAgo
  ).length;
  res.json({ streak, last7Days });
});

app.post('/api/outreach', async (req, res) => {
  const record = {
    id: crypto.randomUUID(),
    date: todayStr(),
    createdAt: new Date().toISOString(),
    username: req.body.username || '',
    profileUrl: req.body.profileUrl || '',
    fullName: req.body.fullName || '',
    bio: req.body.bio || '',
    followers: req.body.followers === '' || req.body.followers == null ? null : req.body.followers,
    lastPostWeeks: req.body.lastPostWeeks === '' || req.body.lastPostWeeks == null ? null : req.body.lastPostWeeks,
    postsPerWeek: req.body.postsPerWeek === '' || req.body.postsPerWeek == null ? null : req.body.postsPerWeek,
    avgViews: req.body.avgViews === '' || req.body.avgViews == null ? null : req.body.avgViews,
    template: req.body.template || '',
    message: req.body.message || '',
    status: req.body.status === 'not_qualified' ? 'not_qualified' : 'sent'
  };

  await sql`
    INSERT INTO outreaches (id, date, created_at, username, profile_url, full_name, bio, followers, last_post_weeks, posts_per_week, avg_views, template, message, status)
    VALUES (${record.id}, ${record.date}, ${record.createdAt}, ${record.username}, ${record.profileUrl}, ${record.fullName}, ${record.bio}, ${record.followers}, ${record.lastPostWeeks}, ${record.postsPerWeek}, ${record.avgViews}, ${record.template}, ${record.message}, ${record.status})
  `;

  res.json({ ok: true, record });
});

app.get('/api/analytics', async (req, res) => {
  const data = await loadData();
  const range = req.query.range || 'month';
  const sent = data.outreaches.filter(o => o.status === 'sent');
  const today = new Date();

  function countBetween(startStr, endStr) {
    return sent.filter(o => o.date >= startStr && o.date <= endStr).length;
  }

  function startOfWeek(d) {
    // Monday-start week
    const dd = new Date(d);
    const day = (dd.getDay() + 6) % 7; // 0 = Monday
    dd.setDate(dd.getDate() - day);
    return dd;
  }

  let currentStart, currentEnd, prevStart, prevEnd, series = [];

  if (range === 'today') {
    currentStart = currentEnd = todayStr();
    prevStart = prevEnd = daysAgoStr(1);
    for (let i = 13; i >= 0; i--) {
      const ds = daysAgoStr(i);
      series.push({ label: ds.slice(5), count: countBetween(ds, ds) });
    }
  } else if (range === 'week') {
    const ws = startOfWeek(today);
    currentStart = todayStr(ws);
    currentEnd = todayStr();
    const prevWs = new Date(ws); prevWs.setDate(prevWs.getDate() - 7);
    const prevWe = new Date(ws); prevWe.setDate(prevWe.getDate() - 1);
    prevStart = todayStr(prevWs);
    prevEnd = todayStr(prevWe);
    for (let i = 13; i >= 0; i--) {
      const ds = daysAgoStr(i);
      series.push({ label: ds.slice(5), count: countBetween(ds, ds) });
    }
  } else if (range === 'month') {
    currentStart = todayStr(new Date(today.getFullYear(), today.getMonth(), 1));
    currentEnd = todayStr();
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    prevStart = todayStr(prevMonthStart);
    prevEnd = todayStr(prevMonthEnd);
    const daysInMonth = today.getDate();
    for (let i = daysInMonth - 1; i >= 0; i--) {
      const ds = daysAgoStr(i);
      series.push({ label: ds.slice(8), count: countBetween(ds, ds) });
    }
  } else if (range === '3months') {
    const start = new Date(today); start.setMonth(start.getMonth() - 3);
    currentStart = todayStr(start);
    currentEnd = todayStr();
    const prevStartD = new Date(start); prevStartD.setMonth(prevStartD.getMonth() - 3);
    const prevEndD = new Date(start); prevEndD.setDate(prevEndD.getDate() - 1);
    prevStart = todayStr(prevStartD);
    prevEnd = todayStr(prevEndD);
    for (let i = 11; i >= 0; i--) {
      const ws = new Date(today); ws.setDate(ws.getDate() - i * 7);
      const weekStart = startOfWeek(ws);
      const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
      series.push({
        label: todayStr(weekStart).slice(5),
        count: countBetween(todayStr(weekStart), todayStr(weekEnd))
      });
    }
  } else if (range === 'year') {
    currentStart = todayStr(new Date(today.getFullYear(), 0, 1));
    currentEnd = todayStr();
    prevStart = todayStr(new Date(today.getFullYear() - 1, 0, 1));
    prevEnd = todayStr(new Date(today.getFullYear() - 1, 11, 31));
    for (let m = 0; m <= today.getMonth(); m++) {
      const ms = todayStr(new Date(today.getFullYear(), m, 1));
      const me = todayStr(new Date(today.getFullYear(), m + 1, 0));
      series.push({ label: ms.slice(0, 7), count: countBetween(ms, me) });
    }
  } else { // all
    if (sent.length === 0) {
      currentStart = currentEnd = todayStr();
    } else {
      currentStart = sent.reduce((min, o) => (o.date < min ? o.date : min), sent[0].date);
      currentEnd = todayStr();
    }
    prevStart = prevEnd = null;
    const startD = new Date(currentStart + 'T00:00:00');
    let m = new Date(startD.getFullYear(), startD.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 1);
    while (m <= end) {
      const ms = todayStr(m);
      const me = todayStr(new Date(m.getFullYear(), m.getMonth() + 1, 0));
      series.push({ label: ms.slice(0, 7), count: countBetween(ms, me) });
      m.setMonth(m.getMonth() + 1);
    }
  }

  const total = countBetween(currentStart, currentEnd);
  const prevTotal = prevStart ? countBetween(prevStart, prevEnd) : null;
  let pctChange = null;
  if (prevTotal !== null) {
    pctChange = prevTotal === 0
      ? (total > 0 ? 100 : 0)
      : Math.round(((total - prevTotal) / prevTotal) * 1000) / 10;
  }

  res.json({ range, total, prevTotal, pctChange, series });
});

// ---------- LEADS ----------

// Wraps an async route handler so a thrown/rejected error becomes a JSON
// error response instead of hanging the request or falling through to
// Express's default HTML error page (which the frontend can't parse).
function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`${req.method} ${req.path} failed:`, e);
      res.status(500).json({ error: e.message || 'Something went wrong on the server.' });
    }
  };
}

const MAX_BULK_BATCH = 2000;

async function loadLeads() {
  const rows = await sql`SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY seq ASC`;
  return rows.map(r => ({
    id: r.id,
    profileUrl: r.profile_url,
    username: r.username,
    fullName: r.full_name,
    bio: r.bio,
    followers: r.followers,
    stage: r.stage,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

app.get('/api/leads', asyncRoute(async (req, res) => {
  const leads = await loadLeads();
  res.json({ leads });
}));

app.post('/api/leads', asyncRoute(async (req, res) => {
  const b = req.body;
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO leads (id, profile_url, username, full_name, bio, followers)
    VALUES (${id}, ${b.profileUrl || ''}, ${b.username || ''}, ${b.fullName || ''}, ${b.bio || ''},
      ${b.followers === '' || b.followers == null ? null : Number(b.followers)})
  `;
  res.json({ ok: true, id });
}));

app.post('/api/leads/bulk', asyncRoute(async (req, res) => {
  const leads = Array.isArray(req.body.leads) ? req.body.leads : [];
  if (leads.length === 0) return res.json({ ok: true, inserted: 0 });
  if (leads.length > MAX_BULK_BATCH) {
    return res.status(400).json({ error: `Batch too large (${leads.length} rows) — send at most ${MAX_BULK_BATCH} at a time.` });
  }

  const ids = leads.map(() => crypto.randomUUID());
  const profileUrls = leads.map(l => l.profileUrl || '');
  const usernames = leads.map(l => l.username || '');
  const fullNames = leads.map(l => l.fullName || '');
  const bios = leads.map(l => l.bio || '');
  const followersArr = leads.map(l => (l.followers === '' || l.followers == null ? null : Number(l.followers)));

  await sql`
    INSERT INTO leads (id, profile_url, username, full_name, bio, followers)
    SELECT * FROM unnest(${ids}::uuid[], ${profileUrls}::text[], ${usernames}::text[], ${fullNames}::text[], ${bios}::text[], ${followersArr}::integer[])
  `;
  res.json({ ok: true, inserted: leads.length });
}));

app.patch('/api/leads/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  await sql`
    UPDATE leads SET
      profile_url = ${b.profileUrl ?? ''},
      username = ${b.username ?? ''},
      full_name = ${b.fullName ?? ''},
      bio = ${b.bio ?? ''},
      followers = ${b.followers === '' || b.followers == null ? null : Number(b.followers)},
      stage = ${b.stage || 'new'},
      updated_at = now()
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  res.json({ ok: true });
}));

app.post('/api/leads/delete', asyncRoute(async (req, res) => {
  const { ids, all } = req.body;
  let rows;
  if (all) {
    rows = await sql`UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL RETURNING id`;
  } else {
    const idList = Array.isArray(ids) ? ids : [];
    if (idList.length === 0) return res.json({ ok: true, deletedIds: [] });
    rows = await sql`UPDATE leads SET deleted_at = now() WHERE id = ANY(${idList}::uuid[]) AND deleted_at IS NULL RETURNING id`;
  }
  res.json({ ok: true, deletedIds: rows.map(r => r.id) });
}));

app.post('/api/leads/restore', asyncRoute(async (req, res) => {
  const idList = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (idList.length === 0) return res.json({ ok: true });
  await sql`UPDATE leads SET deleted_at = NULL WHERE id = ANY(${idList}::uuid[])`;
  res.json({ ok: true });
}));

// Catches body-parser errors (e.g. payload too large) and anything else
// that reaches next(err), so the client always gets JSON back instead of
// Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`Outreach tool running at http://localhost:${PORT}`);
});
