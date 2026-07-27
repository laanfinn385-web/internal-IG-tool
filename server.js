const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'data.json');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { outreaches: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

app.get('/api/home', (req, res) => {
  const data = loadData();
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

app.post('/api/outreach', (req, res) => {
  const data = loadData();
  const record = {
    id: crypto.randomUUID(),
    date: todayStr(),
    createdAt: new Date().toISOString(),
    username: req.body.username || '',
    profileUrl: req.body.profileUrl || '',
    fullName: req.body.fullName || '',
    bio: req.body.bio || '',
    followers: req.body.followers ?? null,
    lastPostWeeks: req.body.lastPostWeeks ?? null,
    postsPerWeek: req.body.postsPerWeek ?? null,
    avgViews: req.body.avgViews ?? null,
    template: req.body.template || '',
    message: req.body.message || '',
    status: req.body.status === 'not_qualified' ? 'not_qualified' : 'sent'
  };
  data.outreaches.push(record);
  saveData(data);
  res.json({ ok: true, record });
});

app.get('/api/analytics', (req, res) => {
  const data = loadData();
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

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`Outreach tool running at http://localhost:${PORT}`);
});
