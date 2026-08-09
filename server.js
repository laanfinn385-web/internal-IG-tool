const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Safety net: if any route handler ever forgets asyncRoute (see below) and
// throws inside an async function, Node treats that as an unhandled
// rejection and — since Node 15 — kills the whole process by default. This
// is exactly what happened before this fix: a single malformed `followers`
// value sent to /api/outreach crashed the entire server for every user,
// not just that one request.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (recovered, not crashing):', err);
});

// Converts a raw value to a number Postgres can safely store in an
// INTEGER column — '', null, undefined, non-numeric strings, NaN, and
// values outside Postgres's 32-bit integer range all become NULL instead
// of throwing a raw DB error (or, worse, crashing the process).
function toNullableInt(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < -2147483648 || n > 2147483647) return null;
  return n;
}

// Same idea for NUMERIC columns (posts_per_week, last_post_weeks), which
// don't have the 32-bit range limit but still choke on non-numeric input.
function toNullableNumeric(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Only http(s) URLs (or empty) are allowed — a javascript: URL saved here
// would render as a normal-looking clickable link in the leads table and
// execute in the page when clicked.
function sanitizeUrl(v) {
  const url = String(v || '').trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : '';
}

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

// Date string (YYYY-MM-DD) anchored to Europe/Amsterdam, not the server
// process's own timezone. This runs on Vercel, whose serverless functions
// default to UTC — using d.getFullYear()/getMonth()/getDate() (server-local)
// would stamp a Tue 00:30 Amsterdam send as "Mon" for roughly the first two
// hours of every local calendar day. Intl reads the wall-clock date for the
// target zone regardless of what timezone the process itself runs in.
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
function todayStr(d = new Date()) {
  return DATE_FMT.format(d); // en-CA locale formats as YYYY-MM-DD
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

app.get('/api/home', asyncRoute(async (req, res) => {
  const data = await loadData();
  const sentDateSet = new Set(
    data.outreaches.filter(o => o.status === 'sent').map(o => o.date)
  );
  const streak = computeStreak(sentDateSet);
  const sevenDaysAgo = daysAgoStr(6);
  const last7Days = data.outreaches.filter(
    o => o.status === 'sent' && o.date >= sevenDaysAgo
  ).length;
  const [{ count }] = await sql`SELECT count(*) FROM leads WHERE deleted_at IS NULL AND stage = 'new'`;
  res.json({ streak, last7Days, availableLeads: Number(count) });
}));

app.post('/api/outreach', asyncRoute(async (req, res) => {
  const record = {
    id: crypto.randomUUID(),
    date: todayStr(),
    createdAt: new Date().toISOString(),
    username: req.body.username || '',
    profileUrl: req.body.profileUrl || '',
    fullName: req.body.fullName || '',
    bio: req.body.bio || '',
    followers: toNullableInt(req.body.followers),
    lastPostWeeks: toNullableNumeric(req.body.lastPostWeeks),
    postsPerWeek: toNullableNumeric(req.body.postsPerWeek),
    avgViews: toNullableInt(req.body.avgViews),
    template: req.body.template || '',
    message: req.body.message || '',
    status: req.body.status === 'not_qualified' ? 'not_qualified' : 'sent'
  };

  await sql`
    INSERT INTO outreaches (id, date, created_at, username, profile_url, full_name, bio, followers, last_post_weeks, posts_per_week, avg_views, template, message, status)
    VALUES (${record.id}, ${record.date}, ${record.createdAt}, ${record.username}, ${record.profileUrl}, ${record.fullName}, ${record.bio}, ${record.followers}, ${record.lastPostWeeks}, ${record.postsPerWeek}, ${record.avgViews}, ${record.template}, ${record.message}, ${record.status})
  `;

  res.json({ ok: true, record });
}));

app.get('/api/analytics', asyncRoute(async (req, res) => {
  const data = await loadData();
  const range = req.query.range || 'month';
  const sent = data.outreaches.filter(o => o.status === 'sent');
  // Built from todayStr() (Amsterdam-anchored) rather than `new Date()`
  // directly — the getFullYear/getMonth/getDate/getDay getters below read
  // whatever timezone the Date object's midnight was constructed in, and on
  // Vercel (UTC) that would otherwise drift a day out of step with the date
  // strings the rest of this function compares against.
  const today = new Date(todayStr() + 'T00:00:00');

  function countBetween(startStr, endStr) {
    return sent.filter(o => o.date >= startStr && o.date <= endStr).length;
  }

  // Plain d.setMonth(d.getMonth() - n) silently overflows into the next
  // month whenever the current day-of-month doesn't exist n months earlier
  // (e.g. May 31 minus 3 months would land on "Feb 31" -> normalizes to
  // Mar 3). Clamp to the target month's actual last day instead.
  function subtractMonths(d, n) {
    const day = d.getDate();
    const result = new Date(d.getFullYear(), d.getMonth() - n, 1);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, lastDay));
    return result;
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
    // Just today — one bar, matching how every other range's chart is
    // confined to its own current period (was previously hardcoded to a
    // 14-day lookback shared with "week", making the two tabs look identical).
    series.push({ label: currentStart.slice(5), count: countBetween(currentStart, currentEnd) });
  } else if (range === 'week') {
    const ws = startOfWeek(today);
    currentStart = todayStr(ws);
    currentEnd = todayStr();
    const prevWs = new Date(ws); prevWs.setDate(prevWs.getDate() - 7);
    const prevWe = new Date(ws); prevWe.setDate(prevWe.getDate() - 1);
    prevStart = todayStr(prevWs);
    prevEnd = todayStr(prevWe);
    // Just this week's days so far (Monday through today), not a 14-day
    // lookback that spilled into last week too.
    for (let d = new Date(ws); todayStr(d) <= currentEnd; d.setDate(d.getDate() + 1)) {
      const ds = todayStr(d);
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
    const start = subtractMonths(today, 3);
    currentStart = todayStr(start);
    currentEnd = todayStr();
    const prevStartD = subtractMonths(start, 3);
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

  const [[{ count: followupsCount }], [{ count: positiveReplyCount }], [{ count: deadCount }], [{ count: appointmentsCount }]] = await Promise.all([
    sql`SELECT count(*) FROM followup_sends WHERE date >= ${currentStart} AND date <= ${currentEnd}`,
    sql`SELECT count(*) FROM lead_events WHERE event = 'positive_reply' AND date >= ${currentStart} AND date <= ${currentEnd}`,
    sql`SELECT count(*) FROM lead_events WHERE event = 'dead' AND date >= ${currentStart} AND date <= ${currentEnd}`,
    sql`SELECT count(*) FROM lead_events WHERE event = 'call_booked' AND date >= ${currentStart} AND date <= ${currentEnd}`
  ]);

  const positiveReplies = Number(positiveReplyCount);
  const appointmentsSet = Number(appointmentsCount);
  // Replies = Positive Replies + Dead (a "no" is still a reply; going
  // completely unanswered is not) — see the analytics tracking discussion.
  const replies = positiveReplies + Number(deadCount);
  const rate = (num, denom) => (denom > 0 ? Math.round((num / denom) * 1000) / 10 : null);

  const funnel = {
    totalSends: total,
    followups: Number(followupsCount),
    replies,
    replyRate: rate(replies, total),
    positiveReplies,
    prr: rate(positiveReplies, total),
    appointmentsSet,
    asr: rate(appointmentsSet, total)
  };

  res.json({ range, total, prevTotal, pctChange, series, funnel });
}));

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
const MAX_NEXT_COUNT = 500;

function mapLeadRow(r) {
  return {
    id: r.id,
    profileUrl: r.profile_url,
    username: r.username,
    fullName: r.full_name,
    bio: r.bio,
    followers: r.followers,
    stage: r.stage,
    notes: r.notes,
    phaseStep: r.phase_step,
    phaseStartedAt: r.phase_started_at,
    everPositiveReply: r.ever_positive_reply,
    everCallBooked: r.ever_call_booked,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

async function loadLeads() {
  const rows = await sql`SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY seq ASC`;
  return rows.map(mapLeadRow);
}

app.get('/api/leads', asyncRoute(async (req, res) => {
  const leads = await loadLeads();
  res.json({ leads });
}));

// The outreach queue: the next N leads that haven't been contacted yet, in
// import order. If fewer than `count` come back, that shortfall *is* the
// full remaining supply — no separate count query needed.
// POST (not GET) so a home-session top-up request can pass `excludeIds` —
// the leads already sitting in the current session's queue but not yet
// decided (still `stage = 'new'` in the DB) — without risking a URL-length
// limit on a large session. `count` still works the same as before.
app.post('/api/leads/next', asyncRoute(async (req, res) => {
  const body = req.body || {};
  // `|| 15` would treat an explicit count=0 as "unset" and silently hand
  // back 15 leads instead of the Math.max(1, ...) floor doing that job.
  const parsedCount = parseInt(body.count, 10);
  const count = Math.max(1, Math.min(MAX_NEXT_COUNT, Number.isFinite(parsedCount) ? parsedCount : 15));
  const excludeIds = Array.isArray(body.excludeIds) ? body.excludeIds.filter(id => typeof id === 'string') : [];
  const rows = excludeIds.length > 0
    ? await sql`
        SELECT * FROM leads
        WHERE deleted_at IS NULL AND stage = 'new' AND NOT (id = ANY(${excludeIds}))
        ORDER BY seq ASC
        LIMIT ${count}
      `
    : await sql`
        SELECT * FROM leads
        WHERE deleted_at IS NULL AND stage = 'new'
        ORDER BY seq ASC
        LIMIT ${count}
      `;
  res.json({ leads: rows.map(mapLeadRow) });
}));

// Username uniqueness (case-insensitive, among active leads) is enforced by
// the leads_username_unique_active partial index, so ON CONFLICT DO NOTHING
// here covers both "already in the list" and "duplicated within this same
// request" — Postgres resolves conflicts between rows in the same INSERT
// too, not just against rows already on disk.
app.post('/api/leads', asyncRoute(async (req, res) => {
  const b = req.body;
  if (!b.username && !b.profileUrl) {
    return res.status(400).json({ error: 'A lead needs at least a username or profile URL.' });
  }
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO leads (id, profile_url, username, full_name, bio, followers, notes)
    VALUES (${id}, ${sanitizeUrl(b.profileUrl)}, ${b.username || ''}, ${b.fullName || ''}, ${b.bio || ''},
      ${toNullableInt(b.followers)}, ${b.notes || ''})
    ON CONFLICT (lower(username)) WHERE deleted_at IS NULL AND username <> '' DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0 && b.username) {
    return res.status(409).json({ error: `A lead with username @${b.username} is already in your list.` });
  }
  res.json({ ok: true, id });
}));

app.post('/api/leads/bulk', asyncRoute(async (req, res) => {
  // Rows with neither a username nor a profile URL (e.g. a trailing blank
  // line in a CSV) are dropped rather than sent to the DB — an empty lead
  // is never useful and previously could be inserted with no validation.
  const leads = (Array.isArray(req.body.leads) ? req.body.leads : [])
    .filter(l => l.username || l.profileUrl);
  if (leads.length === 0) return res.json({ ok: true, inserted: 0, duplicates: 0 });
  if (leads.length > MAX_BULK_BATCH) {
    return res.status(400).json({ error: `Batch too large (${leads.length} rows) — send at most ${MAX_BULK_BATCH} at a time.` });
  }

  const ids = leads.map(() => crypto.randomUUID());
  const profileUrls = leads.map(l => sanitizeUrl(l.profileUrl));
  const usernames = leads.map(l => l.username || '');
  const fullNames = leads.map(l => l.fullName || '');
  const bios = leads.map(l => l.bio || '');
  const followersArr = leads.map(l => toNullableInt(l.followers));

  const rows = await sql`
    INSERT INTO leads (id, profile_url, username, full_name, bio, followers)
    SELECT * FROM unnest(${ids}::uuid[], ${profileUrls}::text[], ${usernames}::text[], ${fullNames}::text[], ${bios}::text[], ${followersArr}::integer[])
    ON CONFLICT (lower(username)) WHERE deleted_at IS NULL AND username <> '' DO NOTHING
    RETURNING id
  `;
  res.json({ ok: true, inserted: rows.length, duplicates: leads.length - rows.length });
}));

// Partial update — only columns actually present in the request body are
// touched, so a caller that only wants to flip `stage` (or just `notes`)
// can't accidentally blank out the rest of the lead.
const LEAD_PATCH_FIELDS = {
  profileUrl: 'profile_url',
  username: 'username',
  fullName: 'full_name',
  bio: 'bio',
  followers: 'followers',
  stage: 'stage',
  notes: 'notes'
};

const FOLLOWUP_STAGES = ['phase1', 'phase2', 'phase3'];
// Stages that imply "this lead has given a positive reply" — phase3 and
// call_booked are downstream of phase2, so staying anywhere in this set
// keeps the Positive Replies credit; call_booked is its own narrower set
// for Appointments Set.
const POSITIVE_REPLY_STAGES = ['phase2', 'phase3', 'call_booked'];

app.patch('/api/leads/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const sets = [];
  const params = [];
  let i = 1;

  // A stage change into a follow-up phase resets that phase's clock (fresh
  // day-0) and logs a dated event so period-based analytics (Positive
  // Replies, Appointments Set) can be computed later. These only count a
  // lead while it's *currently* sitting in a stage that implies the
  // milestone — moving it back out (e.g. undoing an accidental stage click)
  // deletes the event and un-flags it, so it stops counting immediately,
  // even retroactively for past date ranges. Re-entering later logs a fresh
  // dated event rather than silently no-op'ing.
  if (Object.prototype.hasOwnProperty.call(b, 'stage')) {
    const [current] = await sql`SELECT stage, ever_positive_reply, ever_call_booked FROM leads WHERE id = ${id} AND deleted_at IS NULL`;
    if (current && current.stage !== b.stage) {
      if (FOLLOWUP_STAGES.includes(b.stage)) {
        sets.push(`phase_step = $${i++}`); params.push(0);
        sets.push('phase_started_at = now()');
      }
      const today = todayStr();
      const enteringPositive = POSITIVE_REPLY_STAGES.includes(b.stage);
      const leavingPositive = POSITIVE_REPLY_STAGES.includes(current.stage) && !enteringPositive;

      if (enteringPositive && !current.ever_positive_reply) {
        sets.push('ever_positive_reply = true');
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'positive_reply', ${today})`;
      }
      if (leavingPositive) {
        sets.push('ever_positive_reply = false');
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'positive_reply'`;
      }

      if (b.stage === 'call_booked' && !current.ever_call_booked) {
        sets.push('ever_call_booked = true');
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'call_booked', ${today})`;
      }
      if (current.stage === 'call_booked' && b.stage !== 'call_booked') {
        sets.push('ever_call_booked = false');
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'call_booked'`;
      }

      // 'Replies' = Positive Replies + Dead (a "no" is still a reply) — so
      // 'dead' needs the same enter/leave symmetry as the positive-reply
      // stages above, or un-deading a lead (e.g. undoing a misclick) leaves
      // it permanently stuck counting as a reply forever.
      if (b.stage === 'dead') {
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'dead', ${today})`;
      }
      if (current.stage === 'dead' && b.stage !== 'dead') {
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'dead'`;
      }
    }
  }

  for (const [key, column] of Object.entries(LEAD_PATCH_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
    let value = b[key];
    if (key === 'followers') value = toNullableInt(value);
    if (key === 'profileUrl') value = sanitizeUrl(value);
    sets.push(`${column} = $${i++}`);
    params.push(value);
  }

  if (sets.length === 0) return res.json({ ok: true });
  sets.push('updated_at = now()');
  params.push(id);

  try {
    await sql.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${i} AND deleted_at IS NULL`, params);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: `A lead with username @${b.username} is already in your list.` });
    }
    throw e;
  }
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

// ---------- FOLLOW-UP SEQUENCING ----------

const PHASE_MAX_STEP = { 1: 2, 2: 9, 3: 9 };

function firstName(fullName, username) {
  const base = (fullName || username || '').trim();
  return base.split(' ')[0] || username;
}

function renderFollowupMessage(message, lead, calendarLink) {
  if (!message) return null;
  return message
    .replace(/\{naam\}/g, firstName(lead.full_name, lead.username))
    .replace(/\{link\}/g, calendarLink || '');
}

async function getCalendarLink() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = 'calendar_link'`;
  return rows.length ? rows[0].value : '';
}

// Which leads have a follow-up due right now, grouped by phase. A lead is
// "due" once phase_started_at + the next step's day_offset has passed —
// works for both on-time and overdue (haven't opened the app in days).
app.get('/api/notifications', asyncRoute(async (req, res) => {
  const rows = await sql`
    SELECT
      CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END AS phase,
      l.phase_started_at + make_interval(days => ft.day_offset) AS due_at
    FROM leads l
    JOIN followup_templates ft
      ON ft.phase = CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END
     AND ft.step = l.phase_step + 1
    WHERE l.deleted_at IS NULL
      AND l.stage IN ('phase1', 'phase2', 'phase3')
      AND l.phase_started_at + make_interval(days => ft.day_offset) <= now()
  `;
  const byPhase = {};
  rows.forEach(r => {
    const p = r.phase;
    if (!byPhase[p]) byPhase[p] = { phase: p, count: 0, earliestDue: r.due_at };
    byPhase[p].count++;
    if (new Date(r.due_at) < new Date(byPhase[p].earliestDue)) byPhase[p].earliestDue = r.due_at;
  });
  res.json({ notifications: Object.values(byPhase).sort((a, b) => a.phase - b.phase) });
}));

// The due leads for one phase, each with its exact next message pre-rendered.
app.get('/api/followups/due', asyncRoute(async (req, res) => {
  const phase = Number(req.query.phase);
  if (![1, 2, 3].includes(phase)) return res.status(400).json({ error: 'phase must be 1, 2, or 3' });
  const stageVal = 'phase' + phase;
  const calendarLink = await getCalendarLink();

  const rows = await sql`
    SELECT l.id, l.username, l.profile_url, l.full_name,
           ft.step, ft.type, ft.message, ft.media_note,
           l.phase_started_at + make_interval(days => ft.day_offset) AS due_at
    FROM leads l
    JOIN followup_templates ft ON ft.phase = ${phase} AND ft.step = l.phase_step + 1
    WHERE l.deleted_at IS NULL
      AND l.stage = ${stageVal}
      AND l.phase_started_at + make_interval(days => ft.day_offset) <= now()
    ORDER BY due_at ASC
  `;

  const leads = rows.map(r => ({
    id: r.id,
    username: r.username,
    profileUrl: r.profile_url,
    fullName: r.full_name,
    phase,
    step: r.step,
    type: r.type,
    mediaNote: r.media_note,
    message: renderFollowupMessage(r.message, r, calendarLink)
  }));
  res.json({ leads });
}));

// Logs the send (for analytics) and advances the lead to that step.
app.post('/api/leads/:id/followup-sent', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const phase = Number(req.body.phase);
  const step = Number(req.body.step);
  if (![1, 2, 3].includes(phase) || !step) {
    return res.status(400).json({ error: 'phase and step are required' });
  }
  const [lead] = await sql`SELECT username, profile_url FROM leads WHERE id = ${id} AND deleted_at IS NULL`;
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  await sql`
    INSERT INTO followup_sends (id, lead_id, username, profile_url, phase, step, message, date)
    VALUES (${crypto.randomUUID()}, ${id}, ${lead.username}, ${lead.profile_url}, ${phase}, ${step}, ${req.body.message || ''}, ${todayStr()})
  `;
  await sql`UPDATE leads SET phase_step = ${step}, updated_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
  res.json({ ok: true });
}));

// ---------- SETTINGS ----------

app.get('/api/settings/templates', asyncRoute(async (req, res) => {
  const rows = await sql`SELECT id, label, text FROM message_templates ORDER BY sort_order`;
  res.json({ templates: rows });
}));

app.put('/api/settings/templates/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { label, text } = req.body;
  const sets = []; const params = []; let i = 1;
  if (label !== undefined) { sets.push(`label = $${i++}`); params.push(label); }
  if (text !== undefined) { sets.push(`text = $${i++}`); params.push(text); }
  if (sets.length === 0) return res.json({ ok: true });
  sets.push('updated_at = now()');
  params.push(id);
  await sql.query(`UPDATE message_templates SET ${sets.join(', ')} WHERE id = $${i}`, params);
  res.json({ ok: true });
}));

app.get('/api/settings/followups', asyncRoute(async (req, res) => {
  const rows = await sql`SELECT phase, step, day_offset, type, message, media_note FROM followup_templates ORDER BY phase, step`;
  res.json({
    followups: rows.map(r => ({
      phase: r.phase, step: r.step, dayOffset: r.day_offset,
      type: r.type, message: r.message, mediaNote: r.media_note
    }))
  });
}));

app.put('/api/settings/followups/:phase/:step', asyncRoute(async (req, res) => {
  const phase = Number(req.params.phase);
  const step = Number(req.params.step);
  const { dayOffset, type, message, mediaNote } = req.body;
  const sets = []; const params = []; let i = 1;
  if (dayOffset !== undefined) {
    // Matches the input's own min="0" — without this, a negative or
    // non-numeric value (NaN) could reach the day_offset column and produce
    // a due-date that's always in the past (or a raw SQL error for NaN).
    const clamped = Math.max(0, Math.round(Number(dayOffset)) || 0);
    sets.push(`day_offset = $${i++}`); params.push(clamped);
  }
  if (type !== undefined) { sets.push(`type = $${i++}`); params.push(type); }
  if (message !== undefined) { sets.push(`message = $${i++}`); params.push(message); }
  if (mediaNote !== undefined) { sets.push(`media_note = $${i++}`); params.push(mediaNote); }
  if (sets.length === 0) return res.json({ ok: true });
  sets.push('updated_at = now()');
  params.push(phase, step);
  await sql.query(`UPDATE followup_templates SET ${sets.join(', ')} WHERE phase = $${i++} AND step = $${i}`, params);
  res.json({ ok: true });
}));

app.get('/api/settings/app', asyncRoute(async (req, res) => {
  const rows = await sql`SELECT key, value FROM app_settings`;
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ settings });
}));

app.put('/api/settings/app', asyncRoute(async (req, res) => {
  const { calendarLink, viewsThreshold } = req.body;
  if (calendarLink !== undefined) {
    await sql`
      INSERT INTO app_settings (key, value) VALUES ('calendar_link', ${calendarLink})
      ON CONFLICT (key) DO UPDATE SET value = ${calendarLink}
    `;
  }
  if (viewsThreshold !== undefined) {
    await sql`
      INSERT INTO app_settings (key, value) VALUES ('views_threshold', ${String(viewsThreshold)})
      ON CONFLICT (key) DO UPDATE SET value = ${String(viewsThreshold)}
    `;
  }
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
