const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { put: putBlob } = require('@vercel/blob');

// The video-render-service is a separate Vercel deployment (see
// video-render-service/README.md) — these point this app at it.
const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL;
const RENDER_SERVICE_SECRET = process.env.RENDER_SERVICE_SECRET;
// Sibling endpoint on the same render-service deployment — reuses its
// existing BLOB_READ_WRITE_TOKEN rather than this app needing its own.
const RENDER_SERVICE_DELETE_URL = RENDER_SERVICE_URL ? RENDER_SERVICE_URL.replace(/\/api\/render$/, '/api/delete-video') : null;

// Rendered videos are only useful up to the moment a lead is decided (sent
// or disqualified) — after that they just sit in Vercel Blob's 5GB free
// Hobby tier forever unless cleaned up. Best-effort: a failed delete here
// leaves an orphaned blob (harmless beyond quota) rather than blocking the
// lead update that called it.
async function deleteVideoBlobs(urls) {
  const validUrls = (urls || []).filter(Boolean);
  if (validUrls.length === 0 || !RENDER_SERVICE_DELETE_URL || !RENDER_SERVICE_SECRET) return;
  try {
    const res = await fetch(RENDER_SERVICE_DELETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-render-secret': RENDER_SERVICE_SECRET },
      body: JSON.stringify({ urls: validUrls })
    });
    // fetch() only rejects on network failure, not on HTTP error status —
    // an unchecked response here means a 401/500/etc. from the render
    // service fails completely silently (this orphans the blob, which is
    // harmless beyond quota, but should still be visible in logs).
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Video blob delete failed (${res.status}): ${body}`);
    }
  } catch (e) {
    console.error('Could not delete video blob(s):', e);
  }
}

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

// platform: 'instagram' | 'linkedin' | 'all' (default) — every platform-
// scoped query in this file uses this same three-value convention.
function platformClause(platform) {
  return platform === 'all' ? sql`` : sql`AND platform = ${platform}`;
}

async function loadData(platform = 'all') {
  const rows = await sql`SELECT * FROM outreaches WHERE true ${platformClause(platform)}`;
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
      status: r.status,
      platform: r.platform
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

// A day "counts" toward the streak once BOTH platform daily-goal thresholds
// are met (0 = that platform isn't part of the goal, so it's always
// satisfied). If neither platform has a goal configured, there's nothing to
// have hit, so no day ever counts — see computeGoalStreak below.
function goalMetOnDate(date, igByDate, liByDate, igGoal, liGoal) {
  const igOk = igGoal <= 0 || (igByDate[date] || 0) >= igGoal;
  const liOk = liGoal <= 0 || (liByDate[date] || 0) >= liGoal;
  return igOk && liOk;
}

// Streak = consecutive days the daily goal was hit, walking backward from
// today, never broken by Sundays (they just don't count either way). Today
// not having hit the goal *yet* doesn't break the streak — there's still
// time left in the day — it just isn't counted until it's actually hit.
function computeGoalStreak(igByDate, liByDate, igGoal, liGoal) {
  if (igGoal <= 0 && liGoal <= 0) return { streak: 0, todayMet: false };
  const today = todayStr();
  const todayMet = goalMetOnDate(today, igByDate, liByDate, igGoal, liGoal);
  let cursor = new Date(today + 'T00:00:00');
  if (!todayMet) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (true) {
    if (cursor.getDay() === 0) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    const ds = todayStr(cursor);
    if (goalMetOnDate(ds, igByDate, liByDate, igGoal, liGoal)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return { streak, todayMet };
}

app.get('/api/home', asyncRoute(async (req, res) => {
  const platform = ['instagram', 'linkedin'].includes(req.query.platform) ? req.query.platform : 'all';
  const data = await loadData(platform);
  const sent = data.outreaches.filter(o => o.status === 'sent');
  const sevenDaysAgo = daysAgoStr(6);
  const last7Days = sent.filter(o => o.date >= sevenDaysAgo).length;

  // Week-over-week comparison for the sends sparkline — the 7 days before
  // the current 7-day window, same pctChange formula /api/analytics uses.
  const fourteenDaysAgo = daysAgoStr(13);
  const prevWeek = sent.filter(o => o.date >= fourteenDaysAgo && o.date < sevenDaysAgo).length;
  const last7DaysPctChange = prevWeek === 0
    ? (last7Days > 0 ? 100 : 0)
    : Math.round(((last7Days - prevWeek) / prevWeek) * 1000) / 10;

  // Mini trend for the home overview sparkline — one point per of the last
  // 7 days, oldest first.
  const sendsTrend = [];
  for (let i = 6; i >= 0; i--) {
    const ds = daysAgoStr(i);
    sendsTrend.push({ date: ds, count: sent.filter(o => o.date === ds).length });
  }

  const [{ count }] = await sql`SELECT count(*) FROM leads WHERE deleted_at IS NULL AND stage = 'new' ${platformClause(platform)}`;
  const stageRows = await sql`SELECT stage, count(*) FROM leads WHERE deleted_at IS NULL ${platformClause(platform)} GROUP BY stage`;
  const stageCounts = { new: 0, engaged: 0, connection_sent: 0, phase1: 0, phase2: 0, phase3: 0, call_booked: 0, dead: 0, cant_message: 0, in_conversation: 0 };
  stageRows.forEach(r => { if (r.stage in stageCounts) stageCounts[r.stage] = Number(r.count); });

  // All-time funnel rates — same definitions/formulas /api/analytics uses
  // (replies = positive_reply + dead events; PRR/ASR against total sends),
  // just unscoped by date range here for always-current headline numbers.
  // lead_events has no platform column of its own (see the dedup-fix
  // migration) — scoped via a join to leads instead.
  const eventRows = await sql`
    SELECT e.event, count(*) FROM lead_events e
    JOIN leads l ON l.id = e.lead_id
    WHERE e.event IN ('positive_reply', 'dead', 'call_booked', 'connection_sent', 'connection_accepted')
    ${platform === 'all' ? sql`` : sql`AND l.platform = ${platform}`}
    GROUP BY e.event
  `;
  const eventCounts = { positive_reply: 0, dead: 0, call_booked: 0, connection_sent: 0, connection_accepted: 0 };
  eventRows.forEach(r => { eventCounts[r.event] = Number(r.count); });
  const rate = (num, denom) => (denom > 0 ? Math.round((num / denom) * 1000) / 10 : null);
  const replyRate = rate(eventCounts.positive_reply + eventCounts.dead, sent.length);
  const prr = rate(eventCounts.positive_reply, sent.length);
  const asr = rate(eventCounts.call_booked, sent.length);
  const car = rate(eventCounts.connection_accepted, eventCounts.connection_sent);

  // Daily goal (+ the streak, now driven by the same per-day history) —
  // deliberately independent of this endpoint's own `platform` filter (which
  // only scopes the stats above it): the goal bar and streak always reflect
  // real progress across both platforms, since that's what "Start/Continue
  // daily goal session" is working toward regardless of which tab is active.
  const today = todayStr();
  const [
    goalSettingRows,
    igSentByDateRows,
    liEngagedByDateRows,
    [dailyGoalSession]
  ] = await Promise.all([
    sql`SELECT key, value FROM app_settings WHERE key IN ('daily_goal_instagram', 'daily_goal_linkedin')`,
    sql`SELECT date, count(*) FROM outreaches WHERE platform = 'instagram' AND status = 'sent' GROUP BY date`,
    sql`SELECT e.date, count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.event = 'engaged' AND l.platform = 'linkedin' GROUP BY e.date`,
    sql`SELECT * FROM saved_sessions WHERE is_daily_goal = true ORDER BY created_at DESC LIMIT 1`
  ]);
  const goalSettings = {};
  goalSettingRows.forEach(r => { goalSettings[r.key] = r.value; });
  const dailyGoalInstagram = Number(goalSettings.daily_goal_instagram) || 0;
  const dailyGoalLinkedin = Number(goalSettings.daily_goal_linkedin) || 0;

  const igSentByDate = {};
  igSentByDateRows.forEach(r => { igSentByDate[r.date] = Number(r.count); });
  const liEngagedByDate = {};
  liEngagedByDateRows.forEach(r => { liEngagedByDate[r.date] = Number(r.count); });

  const { streak, todayMet: streakTodayMet } = computeGoalStreak(igSentByDate, liEngagedByDate, dailyGoalInstagram, dailyGoalLinkedin);

  res.json({
    streak, streakTodayMet, last7Days, last7DaysPctChange, availableLeads: Number(count), stageCounts,
    sendsTrend, replyRate, prr, asr,
    connectionsSent: eventCounts.connection_sent, connectionsAccepted: eventCounts.connection_accepted, car,
    dailyGoal: {
      instagram: dailyGoalInstagram,
      linkedin: dailyGoalLinkedin,
      todaySentInstagram: igSentByDate[today] || 0,
      todayEngagedLinkedin: liEngagedByDate[today] || 0,
      savedSession: dailyGoalSession ? mapSavedSessionRow(dailyGoalSession) : null
    }
  });
}));

app.post('/api/outreach', asyncRoute(async (req, res) => {
  const record = {
    id: crypto.randomUUID(),
    date: todayStr(),
    createdAt: new Date().toISOString(),
    platform: req.body.platform === 'linkedin' ? 'linkedin' : 'instagram',
    accountId: req.body.accountId || null,
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
    INSERT INTO outreaches (id, date, created_at, platform, account_id, username, profile_url, full_name, bio, followers, last_post_weeks, posts_per_week, avg_views, template, message, status)
    VALUES (${record.id}, ${record.date}, ${record.createdAt}, ${record.platform}, ${record.accountId}, ${record.username}, ${record.profileUrl}, ${record.fullName}, ${record.bio}, ${record.followers}, ${record.lastPostWeeks}, ${record.postsPerWeek}, ${record.avgViews}, ${record.template}, ${record.message}, ${record.status})
  `;

  // Lets the client know immediately whether this send just hit the active
  // account's daily cap, without a second round-trip — only meaningful for a
  // real Instagram account send that actually counted (a 'sent' status).
  let accountTodaySentCount = null;
  if (record.accountId && record.status === 'sent') {
    const [{ count }] = await sql`
      SELECT count(*) FROM outreaches
      WHERE account_id = ${record.accountId} AND status = 'sent' AND date = ${record.date}
    `;
    accountTodaySentCount = Number(count);
  }

  res.json({ ok: true, record, accountTodaySentCount });
}));

app.get('/api/analytics', asyncRoute(async (req, res) => {
  const platform = ['instagram', 'linkedin'].includes(req.query.platform) ? req.query.platform : 'all';
  const data = await loadData(platform);
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

  // followup_sends/lead_events have no platform column of their own (see the
  // dedup-fix migration and the followup content migration) — both are
  // scoped via a join to leads instead of a flat WHERE.
  const [
    [{ count: followupsCount }], [{ count: positiveReplyCount }], [{ count: deadCount }],
    [{ count: appointmentsCount }], [{ count: connectionsSentCount }], [{ count: connectionsAcceptedCount }]
  ] = await Promise.all([
    sql`SELECT count(*) FROM followup_sends fs JOIN leads l ON l.id = fs.lead_id WHERE fs.date >= ${currentStart} AND fs.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.event = 'positive_reply' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.event = 'dead' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.event = 'call_booked' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.event = 'connection_sent' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.event = 'connection_accepted' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`
  ]);

  const positiveReplies = Number(positiveReplyCount);
  const appointmentsSet = Number(appointmentsCount);
  const connectionsSent = Number(connectionsSentCount);
  const connectionsAccepted = Number(connectionsAcceptedCount);
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
    asr: rate(appointmentsSet, total),
    connectionsSent,
    connectionsAccepted,
    car: rate(connectionsAccepted, connectionsSent)
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
    platform: r.platform,
    profileUrl: r.profile_url,
    username: r.username,
    fullName: r.full_name,
    bio: r.bio,
    headline: r.headline,
    followers: r.followers,
    stage: r.stage,
    notes: r.notes,
    phaseStep: r.phase_step,
    phaseStartedAt: r.phase_started_at,
    stageChangedAt: r.stage_changed_at,
    everPositiveReply: r.ever_positive_reply,
    everCallBooked: r.ever_call_booked,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    personalizedVideoUrl: r.personalized_video_url,
    personalizedVideoStatus: r.personalized_video_status,
    personalizedVideoError: r.personalized_video_error,
    personalizedVideoName: r.personalized_video_name
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
  const platform = body.platform === 'linkedin' ? 'linkedin' : 'instagram';
  const excludeIds = Array.isArray(body.excludeIds) ? body.excludeIds.filter(id => typeof id === 'string') : [];
  const rows = excludeIds.length > 0
    ? await sql`
        SELECT * FROM leads
        WHERE deleted_at IS NULL AND stage = 'new' AND platform = ${platform} AND NOT (id = ANY(${excludeIds}))
        ORDER BY seq ASC
        LIMIT ${count}
      `
    : await sql`
        SELECT * FROM leads
        WHERE deleted_at IS NULL AND stage = 'new' AND platform = ${platform}
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
  const platform = b.platform === 'linkedin' ? 'linkedin' : 'instagram';
  // LinkedIn leads have no username concept — a profile URL or full name is
  // the minimum needed instead.
  if (platform === 'linkedin') {
    if (!b.fullName && !b.profileUrl) {
      return res.status(400).json({ error: 'A lead needs at least a full name or profile URL.' });
    }
  } else if (!b.username && !b.profileUrl) {
    return res.status(400).json({ error: 'A lead needs at least a username or profile URL.' });
  }
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO leads (id, platform, profile_url, username, full_name, bio, headline, followers, notes)
    VALUES (${id}, ${platform}, ${sanitizeUrl(b.profileUrl)}, ${b.username || ''}, ${b.fullName || ''}, ${b.bio || ''},
      ${b.headline || ''}, ${toNullableInt(b.followers)}, ${b.notes || ''})
    ON CONFLICT (lower(username)) WHERE deleted_at IS NULL AND username <> '' DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0 && b.username) {
    return res.status(409).json({ error: `A lead with username @${b.username} is already in your list.` });
  }
  res.json({ ok: true, id });
}));

app.post('/api/leads/bulk', asyncRoute(async (req, res) => {
  // One platform per import batch — the CSV mapping modal picks it up front.
  const platform = req.body.platform === 'linkedin' ? 'linkedin' : 'instagram';
  // Rows with nothing usable to identify them (e.g. a trailing blank line in
  // a CSV) are dropped rather than sent to the DB — an empty lead is never
  // useful and previously could be inserted with no validation. LinkedIn
  // leads have no username, so full name stands in for that check.
  const leads = (Array.isArray(req.body.leads) ? req.body.leads : [])
    .filter(l => (platform === 'linkedin' ? (l.fullName || l.profileUrl) : (l.username || l.profileUrl)));
  if (leads.length === 0) return res.json({ ok: true, inserted: 0, duplicates: 0 });
  if (leads.length > MAX_BULK_BATCH) {
    return res.status(400).json({ error: `Batch too large (${leads.length} rows) — send at most ${MAX_BULK_BATCH} at a time.` });
  }

  const ids = leads.map(() => crypto.randomUUID());
  const platforms = leads.map(() => platform);
  const profileUrls = leads.map(l => sanitizeUrl(l.profileUrl));
  const usernames = leads.map(l => l.username || '');
  const fullNames = leads.map(l => l.fullName || '');
  const bios = leads.map(l => l.bio || '');
  const headlines = leads.map(l => l.headline || '');
  const followersArr = leads.map(l => toNullableInt(l.followers));

  const rows = await sql`
    INSERT INTO leads (id, platform, profile_url, username, full_name, bio, headline, followers)
    SELECT * FROM unnest(${ids}::uuid[], ${platforms}::text[], ${profileUrls}::text[], ${usernames}::text[], ${fullNames}::text[], ${bios}::text[], ${headlines}::text[], ${followersArr}::integer[])
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
  headline: 'headline',
  followers: 'followers',
  stage: 'stage',
  notes: 'notes'
};

const FOLLOWUP_STAGES = ['phase1', 'phase2', 'phase3'];
// Stages that imply "this lead has given a positive reply" — phase3 and
// call_booked are downstream of phase2, so staying anywhere in this set
// keeps the Positive Replies credit; call_booked is its own narrower set
// for Appointments Set. in_conversation is a reply too (that's the whole
// point of the stage — an active conversation, not silence), it's just
// deliberately outside FOLLOWUP_STAGES so it stops the automated follow-up
// clock instead of nagging someone you're already talking to.
const POSITIVE_REPLY_STAGES = ['phase2', 'phase3', 'call_booked', 'in_conversation'];

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
    const [current] = await sql`SELECT stage, ever_positive_reply, ever_call_booked, personalized_video_url FROM leads WHERE id = ${id} AND deleted_at IS NULL`;
    if (current && current.stage !== b.stage) {
      // General "when did this lead's stage last change" — unlike
      // phase_started_at (only reset for phase1/2/3/engaged, for follow-up
      // due-date scheduling) this fires for every stage transition, so the
      // Leads page can show it for any stage, not just the ones with a
      // day-offset sequence behind them.
      sets.push('stage_changed_at = now()');
      if (FOLLOWUP_STAGES.includes(b.stage)) {
        sets.push(`phase_step = $${i++}`); params.push(0);
        sets.push('phase_started_at = now()');
      }
      // LinkedIn-only: 'engaged' needs its own fresh clock too (read by the
      // connection-request due query below) — it isn't a follow-up phase, so
      // it doesn't get phase_step reset along with it.
      if (b.stage === 'engaged') {
        sets.push('phase_started_at = now()');
      }
      // The video is done being useful once the lead leaves active-outreach
      // limbo — either it's already been sent (entering a follow-up phase),
      // it never can be (can't receive messages), or they've already
      // replied and moved past needing it (in conversation). Clean it up
      // rather than let it sit in Blob's 5GB free tier forever.
      // Awaited: fire-and-forget here risked the function freezing/recycling
      // right after the response was sent, before the delete fetch actually
      // completed — confirmed happening in testing on /api/leads/delete.
      if ((FOLLOWUP_STAGES.includes(b.stage) || b.stage === 'cant_message' || b.stage === 'in_conversation') && current.personalized_video_url) {
        await deleteVideoBlobs([current.personalized_video_url]);
        sets.push('personalized_video_url = NULL', 'personalized_video_status = NULL', 'personalized_video_name = NULL');
      }
      const today = todayStr();
      const enteringPositive = POSITIVE_REPLY_STAGES.includes(b.stage);
      const leavingPositive = POSITIVE_REPLY_STAGES.includes(current.stage) && !enteringPositive;

      // ON CONFLICT DO NOTHING against the (lead_id, event) unique index
      // below is the real guarantee that a lead can never rack up more than
      // one positive_reply/call_booked/dead row — the `!current.ever_*`
      // checks are just there to skip a redundant no-op UPDATE, not to be
      // the only thing standing between here and a double-counted lead
      // (e.g. two in-flight PATCHes racing each other would both pass a
      // flag check based on stale data; they can't both pass the DB).
      if (enteringPositive && !current.ever_positive_reply) {
        sets.push('ever_positive_reply = true');
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'positive_reply', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
      }
      if (leavingPositive) {
        sets.push('ever_positive_reply = false');
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'positive_reply'`;
      }

      if (b.stage === 'call_booked' && !current.ever_call_booked) {
        sets.push('ever_call_booked = true');
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'call_booked', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
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
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'dead', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
      }
      if (current.stage === 'dead' && b.stage !== 'dead') {
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'dead'`;
      }

      // LinkedIn funnel milestones. Unlike positive_reply/dead/call_booked
      // above (which describe a lead's *current* status and should stop
      // counting the moment a lead leaves every stage that implies them),
      // engaged/connection_sent/connection_accepted are one-time passages
      // through the funnel — a lead that gets engaged, has a connection
      // request sent, and then moves on to phase1 is still, historically,
      // "a lead whose connection request was sent". Deleting on every
      // departure (matching the pattern above) would erase that the instant
      // the lead progresses, making connectionsSent/connectionsAccepted
      // collapse into just "currently sitting in that stage" and the
      // acceptance rate impossible to compute. So the delete side here is
      // deliberately narrow: only the exact reverse transition (an explicit
      // undo of the last stage move) un-counts it, not any forward move.
      if (b.stage === 'engaged') {
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'engaged', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
      }
      if (current.stage === 'engaged' && b.stage === 'new') {
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'engaged'`;
      }
      if (b.stage === 'connection_sent') {
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'connection_sent', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
      }
      if (current.stage === 'connection_sent' && b.stage === 'engaged') {
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'connection_sent'`;
      }
      // "Accepted" can't be detected automatically (see /api/linkedin —
      // there's no notification for this step) — starting a phase1 message
      // session on a connection_sent lead and getting a "sent" decision out
      // of it *is* the acceptance signal, so this fires on exactly that
      // transition rather than a separate button.
      if (current.stage === 'connection_sent' && b.stage === 'phase1') {
        await sql`INSERT INTO lead_events (id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${id}, 'connection_accepted', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
      }
      if (current.stage === 'phase1' && b.stage === 'connection_sent') {
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'connection_accepted'`;
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

// Renders a personalized "Hey {name}" video for one lead by calling the
// separate video-render-service (kept out of this app's own deployment so
// ffmpeg's binary size doesn't bloat every route's cold start — see
// video-render-service/README.md). One lead per call, called directly by the
// browser once per lead in a batch, so a slow/failed render never blocks the
// rest of a batch and each call stays within its own timeout budget.
app.post('/api/leads/:id/render-video', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const [lead] = await sql`SELECT id FROM leads WHERE id = ${id} AND deleted_at IS NULL`;
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  if (!RENDER_SERVICE_URL || !RENDER_SERVICE_SECRET) {
    return res.status(500).json({ error: 'Video rendering is not configured (RENDER_SERVICE_URL / RENDER_SERVICE_SECRET missing).' });
  }

  await sql`
    UPDATE leads SET personalized_video_status = 'rendering', personalized_video_error = NULL, updated_at = now()
    WHERE id = ${id}
  `;

  // Generous timeout — this is a real ffmpeg render on the other end, not a
  // quick API call, and it has its own 300s ceiling on the render service.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 280000);
  try {
    const renderRes = await fetch(RENDER_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-render-secret': RENDER_SERVICE_SECRET },
      body: JSON.stringify({ name, leadId: id }),
      signal: controller.signal
    });
    const data = await renderRes.json().catch(() => ({}));
    if (!renderRes.ok) {
      const errMsg = data.error || `Render service error (${renderRes.status})`;
      await sql`UPDATE leads SET personalized_video_status = 'error', personalized_video_error = ${errMsg}, updated_at = now() WHERE id = ${id}`;
      return res.status(502).json({ error: errMsg });
    }
    await sql`
      UPDATE leads SET
        personalized_video_status = 'done',
        personalized_video_url = ${data.url},
        personalized_video_name = ${name},
        personalized_video_error = NULL,
        updated_at = now()
      WHERE id = ${id}
    `;
    res.json({ url: data.url, name });
  } catch (err) {
    const errMsg = err.name === 'AbortError' ? 'Render service timed out.' : (err.message || 'Video render failed.');
    await sql`UPDATE leads SET personalized_video_status = 'error', personalized_video_error = ${errMsg}, updated_at = now() WHERE id = ${id}`;
    res.status(502).json({ error: errMsg });
  } finally {
    clearTimeout(timer);
  }
}));

app.post('/api/leads/delete', asyncRoute(async (req, res) => {
  const { ids, all } = req.body;
  // RETURNING reflects the row *after* the update, so the video URLs have
  // to be read before it — otherwise nulling them out in the same statement
  // would mean we always "return" NULL and never know what to delete.
  const toDelete = all
    ? await sql`SELECT id, personalized_video_url FROM leads WHERE deleted_at IS NULL`
    : (Array.isArray(ids) && ids.length > 0
        ? await sql`SELECT id, personalized_video_url FROM leads WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL`
        : []);
  if (!all && toDelete.length === 0) return res.json({ ok: true, deletedIds: [] });

  let rows;
  if (all) {
    rows = await sql`
      UPDATE leads SET deleted_at = now(), personalized_video_url = NULL, personalized_video_status = NULL, personalized_video_name = NULL
      WHERE deleted_at IS NULL RETURNING id
    `;
  } else {
    const idList = toDelete.map(r => r.id);
    rows = await sql`
      UPDATE leads SET deleted_at = now(), personalized_video_url = NULL, personalized_video_status = NULL, personalized_video_name = NULL
      WHERE id = ANY(${idList}::uuid[]) AND deleted_at IS NULL RETURNING id
    `;
  }
  // Disqualified leads never got their video sent — no reason to keep it
  // around in Blob storage either. Awaited — see the comment on the same
  // call in PATCH /api/leads/:id for why fire-and-forget silently drops this.
  await deleteVideoBlobs(toDelete.map(r => r.personalized_video_url).filter(Boolean));
  res.json({ ok: true, deletedIds: rows.map(r => r.id) });
}));

app.post('/api/leads/restore', asyncRoute(async (req, res) => {
  const idList = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (idList.length === 0) return res.json({ ok: true });
  await sql`UPDATE leads SET deleted_at = NULL WHERE id = ANY(${idList}::uuid[])`;
  res.json({ ok: true });
}));

// ---------- IG ACCOUNTS ----------
// Multiple-account rotation to avoid Instagram flagging one account for
// high-volume DMing — each account gets its own daily send cap, stricter for
// younger accounts, and a real "how many did this account send today" fact
// (outreaches.account_id) rather than the app being blind to which account
// sent what.

// Age tiers — day-based, matching the same ~30-day month approximation used
// elsewhere in this app (e.g. the reminder feature's "months" unit).
function tierCapForAge(ageDays) {
  if (ageDays < 30) return 40;
  if (ageDays < 180) return 60;
  return 80;
}

const TIER_CAPS = [40, 60, 80];
// A brand-new account can't send at all for its first week in the tool (not
// the Instagram account's own age — this is about the *tool* easing into
// using it), then ramps up 10/day from there to whatever its tier allows,
// rather than jumping straight to the tier cap. The 7-day default (the
// ig_accounts.warmup_days column default) is just what a fresh account gets
// at creation — it's per-account and editable afterward (see
// PATCH /api/accounts/:id and "Change warmup duration" in Settings), not a
// fixed global.
const RAMP_STEP = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Only bumps an account that's currently sitting *at* the tier it's outgrown
// — a deliberately-lower custom value (e.g. 25) doesn't match any tier
// boundary and is left alone, per the user's explicit call on this.
function maybeAutoUpgrade(dailyLimit, ageDays) {
  const currentTierCap = tierCapForAge(ageDays);
  if (TIER_CAPS.includes(dailyLimit) && dailyLimit < currentTierCap) return currentTierCap;
  return null;
}

// createdOn/createdAt arrive as plain strings from a fresh POST body, but as
// JS Date objects when read back from the DB (the neon driver parses
// DATE/TIMESTAMPTZ columns into Date instances) — string-concatenating a
// Date produces garbage ("[object Date]T00:00:00Z"), so both shapes need
// handling everywhere a stored timestamp gets compared against now().
function toDate(value, assumeUtcMidnight) {
  if (value instanceof Date) return value;
  return assumeUtcMidnight ? new Date(value + 'T00:00:00Z') : new Date(value);
}

function ageDaysFrom(createdOn) {
  const ms = Date.now() - toDate(createdOn, true).getTime();
  return Math.floor(ms / MS_PER_DAY);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// When ramping actually starts: immediately if warmup was skipped, otherwise
// exactly this account's own warmup_days after it was added to the tool.
function effectiveRampStart(r) {
  return r.warmup_skipped_at ? toDate(r.warmup_skipped_at) : addDays(toDate(r.created_at), r.warmup_days);
}

function mapAccountRow(r, todaySentCount) {
  const ageDays = ageDaysFrom(r.created_on);
  const tierCap = tierCapForAge(ageDays);
  let phase = 'ready';
  let warmupEndsAt = null;
  let warmupDay = null;
  let rampDay = null;
  if (!r.rampup_skipped_at) {
    const rampStart = effectiveRampStart(r);
    if (!r.warmup_skipped_at && new Date() < rampStart) {
      phase = 'warming_up';
      warmupEndsAt = rampStart;
      // 0-indexed ("day 0 of N" the day it's added, counting up to "day N-1
      // of N" the day before ramp-up starts) — matches warmup_days directly
      // rather than needing a separate +1/-1 convention to keep straight.
      warmupDay = r.warmup_days - Math.ceil((rampStart.getTime() - Date.now()) / MS_PER_DAY);
    } else if (r.daily_limit < tierCap) {
      phase = 'ramping_up';
      rampDay = Math.floor((Date.now() - rampStart.getTime()) / MS_PER_DAY) + 1;
    }
  }
  return {
    id: r.id,
    username: r.username,
    createdOn: r.created_on,
    profileImageUrl: r.profile_image_url,
    dailyLimit: r.daily_limit,
    ageDays,
    tierCap,
    overTierCap: r.daily_limit > tierCap,
    todaySentCount: todaySentCount || 0,
    phase,
    warmupDay,
    warmupDays: r.warmup_days,
    warmupEndsAt,
    rampDay
  };
}

app.get('/api/accounts', asyncRoute(async (req, res) => {
  const today = todayStr();
  const accounts = await sql`SELECT * FROM ig_accounts WHERE archived_at IS NULL ORDER BY created_at ASC`;
  const sentRows = await sql`
    SELECT account_id, count(*) FROM outreaches
    WHERE status = 'sent' AND date = ${today} AND account_id IS NOT NULL
    GROUP BY account_id
  `;
  const sentByAccount = {};
  sentRows.forEach(r => { sentByAccount[r.account_id] = Number(r.count); });

  // Lazy warmup/ramp-up/tier-upgrade — this app has no background jobs, so
  // all of this (like the follow-up due-query) runs at request time instead.
  // Each transition a plain reminder announces (reusing the existing
  // reminders/notification-bell pipeline rather than a parallel mechanism).
  const upgraded = [];
  for (const r of accounts) {
    const ageDays = ageDaysFrom(r.created_on);
    const tierCap = tierCapForAge(ageDays);

    if (!r.rampup_skipped_at) {
      const rampStart = effectiveRampStart(r);
      if (new Date() >= rampStart) {
        const daysInRamp = Math.floor((Date.now() - rampStart.getTime()) / MS_PER_DAY) + 1;
        const rampLimit = Math.min(tierCap, daysInRamp * RAMP_STEP);
        if (rampLimit !== r.daily_limit) {
          // The stored value still reading 0 is what tells us this is the
          // exact moment warmup ends — the natural (non-skipped) path, since
          // skip-warmup already bumps this itself and announces separately.
          if (r.daily_limit === 0) {
            await sql`
              INSERT INTO reminders (id, text, due_at, lead_id)
              VALUES (${crypto.randomUUID()}, ${`🔥 @${r.username} finished its ${r.warmup_days}-day warmup and is ready to start ramping up`}, now(), NULL)
            `;
          }
          await sql`UPDATE ig_accounts SET daily_limit = ${rampLimit} WHERE id = ${r.id}`;
          r.daily_limit = rampLimit;
        }
      }
      // Still warming up or actively ramping — not eligible for the tier
      // auto-upgrade below until it's actually reached its tier cap.
      if (r.daily_limit < tierCap) continue;
    }

    const newCap = maybeAutoUpgrade(r.daily_limit, ageDays);
    if (newCap !== null) {
      await sql`UPDATE ig_accounts SET daily_limit = ${newCap} WHERE id = ${r.id}`;
      r.daily_limit = newCap;
      await sql`
        INSERT INTO reminders (id, text, due_at, lead_id)
        VALUES (${crypto.randomUUID()}, ${`🎉 @${r.username}'s daily limit was raised to ${newCap} — account turned ${ageDays >= 180 ? '6+ months' : '1+ month'} old`}, now(), NULL)
      `;
      upgraded.push(r.id);
    }
  }

  res.json({ accounts: accounts.map(r => mapAccountRow(r, sentByAccount[r.id])), upgraded });
}));

app.post('/api/accounts/:id/skip-warmup', asyncRoute(async (req, res) => {
  const [account] = await sql`SELECT username FROM ig_accounts WHERE id = ${req.params.id} AND archived_at IS NULL`;
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  await sql`UPDATE ig_accounts SET warmup_skipped_at = now(), daily_limit = ${RAMP_STEP} WHERE id = ${req.params.id}`;
  await sql`
    INSERT INTO reminders (id, text, due_at, lead_id)
    VALUES (${crypto.randomUUID()}, ${`🔥 @${account.username}'s warmup was skipped and is ready to start ramping up`}, now(), NULL)
  `;
  res.json({ ok: true });
}));

app.post('/api/accounts/:id/skip-rampup', asyncRoute(async (req, res) => {
  const [account] = await sql`SELECT created_on FROM ig_accounts WHERE id = ${req.params.id} AND archived_at IS NULL`;
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const tierCap = tierCapForAge(ageDaysFrom(account.created_on));
  await sql`UPDATE ig_accounts SET rampup_skipped_at = now(), daily_limit = ${tierCap} WHERE id = ${req.params.id}`;
  res.json({ ok: true });
}));

// Base64 JSON body (not multipart/raw) — reuses the existing express.json()
// middleware as-is rather than adding route-specific body parsing, and a
// profile photo is small enough that the ~33% base64 overhead doesn't matter
// against the app's existing 15mb JSON limit.
app.post('/api/accounts/upload-image', asyncRoute(async (req, res) => {
  const { imageBase64, contentType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required.' });
  const buffer = Buffer.from(imageBase64, 'base64');
  const ext = (contentType && contentType.split('/')[1]) || 'jpg';
  const blob = await putBlob(`ig-account-photos/${crypto.randomUUID()}.${ext}`, buffer, {
    access: 'public',
    contentType: contentType || 'image/jpeg'
  });
  res.json({ url: blob.url });
}));

app.post('/api/accounts', asyncRoute(async (req, res) => {
  const username = String(req.body.username || '').trim().replace('@', '');
  const createdOn = req.body.createdOn;
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (!createdOn || Number.isNaN(new Date(createdOn).getTime())) {
    return res.status(400).json({ error: 'A valid creation date is required.' });
  }
  // Every newly-added account starts at 0 and warming up, regardless of how
  // old the real Instagram account already is — the warmup/ramp-up here is
  // about easing this *tool's* usage pattern in, not the account's own age
  // (which still separately determines its eventual tier cap once ramped).
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO ig_accounts (id, username, created_on, profile_image_url, daily_limit)
    VALUES (${id}, ${username}, ${createdOn}, ${req.body.profileImageUrl || null}, 0)
  `;
  res.json({ ok: true, id });
}));

app.patch('/api/accounts/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const sets = []; const params = []; let i = 1;
  if (req.body.dailyLimit !== undefined) {
    const clamped = Math.max(1, Math.round(Number(req.body.dailyLimit)) || 1);
    sets.push(`daily_limit = $${i++}`); params.push(clamped);
  }
  if (req.body.username !== undefined) { sets.push(`username = $${i++}`); params.push(String(req.body.username).trim().replace('@', '')); }
  if (req.body.profileImageUrl !== undefined) { sets.push(`profile_image_url = $${i++}`); params.push(req.body.profileImageUrl); }
  if (req.body.warmupDays !== undefined) {
    // 0 is a valid, deliberate "no warmup" choice (functionally the same as
    // skipping immediately) — only negative/non-numeric input gets clamped.
    const clamped = Math.max(0, Math.round(Number(req.body.warmupDays)) || 0);
    sets.push(`warmup_days = $${i++}`); params.push(clamped);
  }
  if (sets.length === 0) return res.json({ ok: true });
  params.push(id);
  await sql.query(`UPDATE ig_accounts SET ${sets.join(', ')} WHERE id = $${i}`, params);
  res.json({ ok: true });
}));

app.delete('/api/accounts/:id', asyncRoute(async (req, res) => {
  await sql`UPDATE ig_accounts SET archived_at = now() WHERE id = ${req.params.id}`;
  res.json({ ok: true });
}));

// ---------- SAVED SESSIONS ----------
// "Quit & Save" on an in-progress outreach session: the profiles not yet
// decided are stashed here (full profile state, so resuming looks exactly
// like the session was never interrupted), alongside a summary of what was
// already decided this session (for the saved-sessions list/detail views —
// those decisions are already reflected in outreaches/leads regardless, this
// is just for display). Nothing is created if a session has no decisions
// yet — see the client-side check before this is ever called.

function mapSavedSessionRow(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    sessionKind: r.session_kind,
    sessionMode: r.session_mode,
    sessionTarget: r.session_target,
    sentCount: r.sent_count,
    results: r.results || [],
    remainingProfiles: r.remaining_profiles || [],
    isDailyGoal: r.is_daily_goal,
    igCooldownUntil: r.ig_cooldown_until,
    igCooldownAccountId: r.ig_cooldown_account_id
  };
}

app.post('/api/saved-sessions', asyncRoute(async (req, res) => {
  const { sessionKind, sessionMode, sessionTarget, sentCount, results, remainingProfiles, isDailyGoal, igCooldownUntil, igCooldownAccountId } = req.body;
  const remaining = Array.isArray(remainingProfiles) ? remainingProfiles : [];
  if (remaining.length === 0) return res.status(400).json({ error: 'Nothing to save — no remaining profiles.' });
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO saved_sessions (id, session_kind, session_mode, session_target, sent_count, results, remaining_profiles, is_daily_goal, ig_cooldown_until, ig_cooldown_account_id)
    VALUES (${id}, ${sessionKind || 'ig_message'}, ${sessionMode || 'fixed'}, ${sessionTarget ?? null}, ${sentCount || 0}, ${JSON.stringify(Array.isArray(results) ? results : [])}, ${JSON.stringify(remaining)}, ${!!isDailyGoal}, ${igCooldownUntil || null}, ${igCooldownAccountId || null})
  `;
  res.json({ ok: true, id });
}));

app.get('/api/saved-sessions', asyncRoute(async (req, res) => {
  const rows = await sql`SELECT * FROM saved_sessions ORDER BY created_at DESC`;
  res.json({ sessions: rows.map(mapSavedSessionRow) });
}));

app.delete('/api/saved-sessions/:id', asyncRoute(async (req, res) => {
  await sql`DELETE FROM saved_sessions WHERE id = ${req.params.id}`;
  res.json({ ok: true });
}));

// ---------- FOLLOW-UP SEQUENCING ----------

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

// Each follow-up step's message is split into 1-3 ordered components (see the
// migration that seeded followup_template_parts), each with several
// independently-worded versions. `partsByStep[step]` is an array of component
// groups in composition order; picking one random version per group and
// joining them means leads due for the same step at the same time don't all
// get the literal same nudge. Falls back to the flat template message when a
// step has no parts (the media-only GIF/meme steps with no caption).
function composeFollowupMessage(componentGroups, fallbackMessage, lead, calendarLink) {
  if (!componentGroups || componentGroups.length === 0) {
    return renderFollowupMessage(fallbackMessage, lead, calendarLink);
  }
  const text = componentGroups
    .map(versions => versions[Math.floor(Math.random() * versions.length)])
    .join(' ');
  return renderFollowupMessage(text, lead, calendarLink);
}

async function getFollowupPartsByPhase(phase, platform) {
  const rows = await sql`
    SELECT step, part_order, text FROM followup_template_parts
    WHERE phase = ${phase} AND platform = ${platform} ORDER BY step, part_order, sort_order
  `;
  const byStep = {};
  rows.forEach(r => {
    if (!byStep[r.step]) byStep[r.step] = [];
    if (!byStep[r.step][r.part_order]) byStep[r.step][r.part_order] = [];
    byStep[r.step][r.part_order].push(r.text);
  });
  return byStep;
}

async function getCalendarLink() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = 'calendar_link'`;
  return rows.length ? rows[0].value : '';
}

async function getLinkedinConnectionDelayDays() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = 'linkedin_connection_delay_days'`;
  const n = rows.length ? Number(rows[0].value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

// Which leads have a follow-up due right now, grouped by (platform, phase). A
// lead is "due" once phase_started_at + the next step's day_offset has
// passed — works for both on-time and overdue (haven't opened the app in
// days). Instagram and LinkedIn each have their own phase1/2/3 content (see
// the platform column on followup_templates), so the join has to match
// platform too or a LinkedIn lead could pick up Instagram's day-offsets.
// Dismissing a follow-up/connections notification group (see POST below)
// doesn't touch any lead — there's no real record behind "48 leads to
// follow up with" to delete, it's a live count. Instead it hides that group
// until leads *newly* cross their due threshold after the dismissal, by
// filtering each group's rows to due_at > dismissed_at rather than just
// suppressing the group outright — so it reappears on its own once there's
// actually new work, not just on some arbitrary timer.
async function getNotificationDismissals() {
  const rows = await sql`SELECT group_key, dismissed_at FROM notification_dismissals`;
  const map = {};
  rows.forEach(r => { map[r.group_key] = r.dismissed_at; });
  return map;
}

app.get('/api/notifications', asyncRoute(async (req, res) => {
  const [followupRows, connectionDelayDays, dismissals, reminderRows] = await Promise.all([
    sql`
      SELECT
        l.platform,
        CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END AS phase,
        l.phase_started_at + make_interval(days => ft.day_offset) AS due_at
      FROM leads l
      JOIN followup_templates ft
        ON ft.platform = l.platform
       AND ft.phase = CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END
       AND ft.step = l.phase_step + 1
      WHERE l.deleted_at IS NULL
        AND l.stage IN ('phase1', 'phase2', 'phase3')
        AND l.phase_started_at + make_interval(days => ft.day_offset) <= now()
    `,
    getLinkedinConnectionDelayDays(),
    getNotificationDismissals(),
    sql`
      SELECT r.id, r.text, r.due_at, r.lead_id, l.platform, l.username, l.full_name
      FROM reminders r
      LEFT JOIN leads l ON l.id = r.lead_id AND l.deleted_at IS NULL
      WHERE r.due_at <= now()
      ORDER BY r.due_at ASC
    `
  ]);

  const byKey = {};
  followupRows.forEach(r => {
    const key = `followup:${r.platform}:${r.phase}`;
    const dismissedAt = dismissals[key];
    if (dismissedAt && new Date(r.due_at) <= new Date(dismissedAt)) return;
    if (!byKey[key]) byKey[key] = { type: 'followup', groupKey: key, platform: r.platform, phase: r.phase, count: 0, earliestDue: r.due_at };
    byKey[key].count++;
    if (new Date(r.due_at) < new Date(byKey[key].earliestDue)) byKey[key].earliestDue = r.due_at;
  });

  const connectionRows = await sql`
    SELECT phase_started_at + make_interval(days => ${connectionDelayDays}) AS due_at
    FROM leads
    WHERE deleted_at IS NULL AND platform = 'linkedin' AND stage = 'engaged'
      AND phase_started_at + make_interval(days => ${connectionDelayDays}) <= now()
  `;
  const connKey = 'connections:linkedin';
  const connDismissedAt = dismissals[connKey];
  const liveConnectionRows = connDismissedAt
    ? connectionRows.filter(r => new Date(r.due_at) > new Date(connDismissedAt))
    : connectionRows;
  if (liveConnectionRows.length > 0) {
    const earliestDue = liveConnectionRows.reduce((min, r) => (new Date(r.due_at) < new Date(min) ? r.due_at : min), liveConnectionRows[0].due_at);
    byKey[connKey] = { type: 'connections', groupKey: connKey, platform: 'linkedin', count: liveConnectionRows.length, earliestDue };
  }

  const grouped = Object.values(byKey).sort((a, b) => (a.platform === b.platform ? (a.phase || 0) - (b.phase || 0) : a.platform.localeCompare(b.platform)));
  // Reminders are individual, not grouped — each has its own text, unlike
  // "N leads due" — so they're listed one per row rather than counted.
  const reminders = reminderRows.map(r => ({
    type: 'reminder', id: r.id, text: r.text, earliestDue: r.due_at,
    leadId: r.lead_id, leadPlatform: r.platform, leadUsername: r.username, leadFullName: r.full_name
  }));

  // The Instagram account-switch cooldown — computed live from saved_sessions
  // rather than a separate stored notification, same "compute from real
  // state" approach as everything else here. Kept non-null even once expired
  // (with `expired: true`) so the global banner can render a "ready" state on
  // a fresh page load, not just while the same tab counted it down live.
  const [pendingCooldown] = await sql`
    SELECT s.id AS saved_session_id, s.ig_cooldown_until, s.ig_cooldown_account_id, a.username AS account_username
    FROM saved_sessions s
    LEFT JOIN ig_accounts a ON a.id = s.ig_cooldown_account_id
    WHERE s.ig_cooldown_until IS NOT NULL
    ORDER BY s.ig_cooldown_until DESC
    LIMIT 1
  `;
  let igCooldown = null;
  const cooldownReadyNotifications = [];
  if (pendingCooldown) {
    const expired = new Date(pendingCooldown.ig_cooldown_until) <= new Date();
    igCooldown = {
      until: pendingCooldown.ig_cooldown_until,
      accountId: pendingCooldown.ig_cooldown_account_id,
      accountUsername: pendingCooldown.account_username,
      savedSessionId: pendingCooldown.saved_session_id,
      expired
    };
    if (expired) {
      cooldownReadyNotifications.push({
        type: 'ig_cooldown_ready',
        savedSessionId: pendingCooldown.saved_session_id,
        accountUsername: pendingCooldown.account_username,
        earliestDue: pendingCooldown.ig_cooldown_until
      });
    }
  }

  res.json({ notifications: [...grouped, ...reminders, ...cooldownReadyNotifications], igCooldown });
}));

app.post('/api/notifications/dismiss', asyncRoute(async (req, res) => {
  const { groupKey } = req.body;
  if (!groupKey) return res.status(400).json({ error: 'groupKey is required' });
  await sql`
    INSERT INTO notification_dismissals (group_key, dismissed_at) VALUES (${groupKey}, now())
    ON CONFLICT (group_key) DO UPDATE SET dismissed_at = now()
  `;
  res.json({ ok: true });
}));

// ---------- REMINDERS ----------

function mapReminderRow(r) {
  return {
    id: r.id,
    text: r.text,
    dueAt: r.due_at,
    leadId: r.lead_id,
    leadPlatform: r.platform,
    leadUsername: r.username,
    leadFullName: r.full_name,
    createdAt: r.created_at
  };
}

app.get('/api/reminders', asyncRoute(async (req, res) => {
  const rows = await sql`
    SELECT r.id, r.text, r.due_at, r.lead_id, r.created_at, l.platform, l.username, l.full_name
    FROM reminders r
    LEFT JOIN leads l ON l.id = r.lead_id AND l.deleted_at IS NULL
    ORDER BY r.due_at ASC
  `;
  res.json({ reminders: rows.map(mapReminderRow) });
}));

app.post('/api/reminders', asyncRoute(async (req, res) => {
  const text = String(req.body.text || '').trim();
  const dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
  if (!text) return res.status(400).json({ error: 'A reminder needs some text.' });
  if (!dueAt || Number.isNaN(dueAt.getTime())) return res.status(400).json({ error: 'A valid due date/time is required.' });
  const leadId = req.body.leadId || null;
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO reminders (id, text, due_at, lead_id) VALUES (${id}, ${text}, ${dueAt.toISOString()}, ${leadId})
  `;
  res.json({ ok: true, id });
}));

app.delete('/api/reminders/:id', asyncRoute(async (req, res) => {
  await sql`DELETE FROM reminders WHERE id = ${req.params.id}`;
  res.json({ ok: true });
}));

// The due leads for one platform+phase, each with its exact next message pre-rendered.
app.get('/api/followups/due', asyncRoute(async (req, res) => {
  const phase = Number(req.query.phase);
  const platform = req.query.platform === 'linkedin' ? 'linkedin' : 'instagram';
  if (![1, 2, 3].includes(phase)) return res.status(400).json({ error: 'phase must be 1, 2, or 3' });
  const stageVal = 'phase' + phase;
  const [calendarLink, partsByStep] = await Promise.all([getCalendarLink(), getFollowupPartsByPhase(phase, platform)]);

  const rows = await sql`
    SELECT l.id, l.username, l.profile_url, l.full_name,
           ft.step, ft.type, ft.message, ft.media_note,
           l.phase_started_at + make_interval(days => ft.day_offset) AS due_at
    FROM leads l
    JOIN followup_templates ft ON ft.platform = ${platform} AND ft.phase = ${phase} AND ft.step = l.phase_step + 1
    WHERE l.deleted_at IS NULL
      AND l.platform = ${platform}
      AND l.stage = ${stageVal}
      AND l.phase_started_at + make_interval(days => ft.day_offset) <= now()
    ORDER BY due_at ASC
  `;

  const leads = rows.map(r => ({
    id: r.id,
    platform,
    username: r.username,
    profileUrl: r.profile_url,
    fullName: r.full_name,
    phase,
    step: r.step,
    type: r.type,
    mediaNote: r.media_note,
    message: composeFollowupMessage(partsByStep[r.step], r.message, r, calendarLink)
  }));
  res.json({ leads });
}));

// The LinkedIn leads whose connection-request delay has elapsed since being
// marked "Engaged" — no message to compose, this just drives the simple
// swipeable "Connected / Delete" session (see public/app.js).
app.get('/api/linkedin/connections/due', asyncRoute(async (req, res) => {
  const connectionDelayDays = await getLinkedinConnectionDelayDays();
  const rows = await sql`
    SELECT id, full_name, profile_url, headline
    FROM leads
    WHERE deleted_at IS NULL AND platform = 'linkedin' AND stage = 'engaged'
      AND phase_started_at + make_interval(days => ${connectionDelayDays}) <= now()
    ORDER BY phase_started_at ASC
  `;
  res.json({ leads: rows.map(r => ({ id: r.id, fullName: r.full_name, profileUrl: r.profile_url, headline: r.headline })) });
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

// Each category (e.g. "haven't posted in months") is built from 4 sentence
// slots — opener/hook/value/cta — each with several independently-worded
// versions. public/app.js draws one version per slot at random per profile,
// so recombination alone gives far more distinct renderings than any one
// slot's version count, without ever mixing a slot from one category into
// another (see pickPart() there).
app.get('/api/settings/templates', asyncRoute(async (req, res) => {
  const platform = req.query.platform === 'linkedin' ? 'linkedin' : 'instagram';
  const templates = await sql`SELECT id, label FROM message_templates WHERE platform = ${platform} ORDER BY sort_order`;
  const parts = await sql`SELECT id, template_id, slot, text FROM message_template_parts ORDER BY template_id, slot, sort_order`;
  res.json({
    templates: templates.map(t => {
      const forTemplate = parts.filter(p => p.template_id === t.id);
      const bySlot = {};
      for (const slot of ['opener', 'hook', 'value', 'cta']) {
        bySlot[slot] = forTemplate.filter(p => p.slot === slot).map(p => ({ id: p.id, text: p.text }));
      }
      return { id: t.id, label: t.label, parts: bySlot };
    })
  });
}));

app.put('/api/settings/templates/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { label } = req.body;
  if (label === undefined) return res.json({ ok: true });
  await sql`UPDATE message_templates SET label = ${label}, updated_at = now() WHERE id = ${id}`;
  res.json({ ok: true });
}));

app.get('/api/settings/followups', asyncRoute(async (req, res) => {
  const platform = req.query.platform === 'linkedin' ? 'linkedin' : 'instagram';
  const rows = await sql`SELECT phase, step, day_offset, type, message, media_note FROM followup_templates WHERE platform = ${platform} ORDER BY phase, step`;
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
  const platform = req.body.platform === 'linkedin' ? 'linkedin' : 'instagram';
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
  params.push(platform, phase, step);
  await sql.query(`UPDATE followup_templates SET ${sets.join(', ')} WHERE platform = $${i++} AND phase = $${i++} AND step = $${i}`, params);
  res.json({ ok: true });
}));

app.get('/api/settings/app', asyncRoute(async (req, res) => {
  const rows = await sql`SELECT key, value FROM app_settings`;
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ settings });
}));

app.put('/api/settings/app', asyncRoute(async (req, res) => {
  const { calendarLink, viewsThreshold, linkedinConnectionDelayDays, dailyGoalInstagram, dailyGoalLinkedin } = req.body;
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
  if (linkedinConnectionDelayDays !== undefined) {
    const clamped = Math.max(0, Math.round(Number(linkedinConnectionDelayDays)) || 0);
    await sql`
      INSERT INTO app_settings (key, value) VALUES ('linkedin_connection_delay_days', ${String(clamped)})
      ON CONFLICT (key) DO UPDATE SET value = ${String(clamped)}
    `;
  }
  if (dailyGoalInstagram !== undefined) {
    const clamped = Math.max(0, Math.round(Number(dailyGoalInstagram)) || 0);
    await sql`
      INSERT INTO app_settings (key, value) VALUES ('daily_goal_instagram', ${String(clamped)})
      ON CONFLICT (key) DO UPDATE SET value = ${String(clamped)}
    `;
  }
  if (dailyGoalLinkedin !== undefined) {
    const clamped = Math.max(0, Math.round(Number(dailyGoalLinkedin)) || 0);
    await sql`
      INSERT INTO app_settings (key, value) VALUES ('daily_goal_linkedin', ${String(clamped)})
      ON CONFLICT (key) DO UPDATE SET value = ${String(clamped)}
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
