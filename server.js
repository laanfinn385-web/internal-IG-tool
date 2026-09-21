const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { put: putBlob } = require('@vercel/blob');

// ---------- WORKSPACES (profiles) ----------
// No login/auth exists in this app (single-user personal tool) — a
// "workspace" is just a data-scoping boundary, identified per-request via
// the X-Workspace-Id header the client sends on every call (set in
// fetchJson, public/app.js). Falls back to the seeded default workspace
// ('A&P Media', backfilled with every pre-existing row when workspaces were
// introduced) so a stray unscoped request never 500s or silently touches
// every workspace's data at once.
let defaultWorkspaceIdCache = null;
async function getDefaultWorkspaceId() {
  if (defaultWorkspaceIdCache) return defaultWorkspaceIdCache;
  const [row] = await sql`SELECT id FROM workspaces WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1`;
  defaultWorkspaceIdCache = row ? row.id : null;
  return defaultWorkspaceIdCache;
}
async function getWorkspaceId(req) {
  const header = req.headers['x-workspace-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return getDefaultWorkspaceId();
}

function mapWorkspaceRow(r) {
  return {
    id: r.id,
    name: r.name,
    pictureUrl: r.picture_url,
    instagramEnabled: r.instagram_enabled,
    linkedinEnabled: r.linkedin_enabled,
    createdAt: r.created_at
  };
}

// A brand-new profile starts with zero Timing/Messaging sequences — without
// seeding it with the same generic defaults every workspace originally had,
// POST /api/accounts (below) can never resolve a "Default — <tier>" timing
// sequence for a freshly-added account, leaving it with timing_sequence_id
// NULL: no ramp days to look up means curveLimitForDay always returns 0, so
// the account reads as perpetually stuck at day 0 of warmup — and Skip
// warmup "does nothing" for the same reason (it looks up the very same
// nonexistent ramp days to decide what limit to skip to). These curves are
// generic, vetted Instagram-warmup shapes (not tied to any one workspace's
// own messaging), safe to reuse as every new profile's starting point,
// exactly like "+ New sequence" already creates a blank starting point for
// a manually-created one.
const DEFAULT_TIMING_SEQUENCE_SEEDS = [
  {
    name: 'Default — New',
    rampDays: [
      { dayNumber: 1, dailyLimit: 0 }, { dayNumber: 14, dailyLimit: 5 }, { dayNumber: 16, dailyLimit: 10 },
      { dayNumber: 18, dailyLimit: 20 }, { dayNumber: 20, dailyLimit: 30 }
    ],
    pacingBlocks: [
      { blockType: 'send', minValue: 6, maxValue: 10, label: null, message: null },
      { blockType: 'pause', minValue: 8, maxValue: 12, label: 'Scroll session', message: "Go scroll your feed, check a few stories, like a couple posts — anything that isn't sending another DM." }
    ]
  },
  {
    name: 'Default — 1-6 months',
    rampDays: [
      { dayNumber: 1, dailyLimit: 0 }, { dayNumber: 8, dailyLimit: 10 }, { dayNumber: 9, dailyLimit: 20 },
      { dayNumber: 10, dailyLimit: 30 }, { dayNumber: 11, dailyLimit: 40 }, { dayNumber: 12, dailyLimit: 50 }, { dayNumber: 13, dailyLimit: 60 }
    ],
    pacingBlocks: [
      { blockType: 'send', minValue: 8, maxValue: 15, label: null, message: null },
      { blockType: 'pause', minValue: 8, maxValue: 12, label: 'Scroll session', message: "Go scroll your feed, check a few stories, like a couple posts — anything that isn't sending another DM." }
    ]
  },
  {
    name: 'Default — 6+ months',
    rampDays: [
      { dayNumber: 1, dailyLimit: 0 }, { dayNumber: 8, dailyLimit: 10 }, { dayNumber: 9, dailyLimit: 20 },
      { dayNumber: 10, dailyLimit: 30 }, { dayNumber: 11, dailyLimit: 40 }, { dayNumber: 12, dailyLimit: 50 },
      { dayNumber: 13, dailyLimit: 60 }, { dayNumber: 14, dailyLimit: 70 }, { dayNumber: 15, dailyLimit: 80 }
    ],
    pacingBlocks: [
      { blockType: 'send', minValue: 8, maxValue: 15, label: null, message: null },
      { blockType: 'pause', minValue: 8, maxValue: 12, label: 'Scroll session', message: "Go scroll your feed, check a few stories, like a couple posts — anything that isn't sending another DM." }
    ]
  }
];

async function seedDefaultSequencesForWorkspace(workspaceId) {
  for (const seed of DEFAULT_TIMING_SEQUENCE_SEEDS) {
    const seqId = crypto.randomUUID();
    await sql`INSERT INTO timing_sequences (id, workspace_id, name) VALUES (${seqId}, ${workspaceId}, ${seed.name})`;
    for (const d of seed.rampDays) {
      await sql`INSERT INTO timing_sequence_ramp_days (id, workspace_id, sequence_id, day_number, daily_limit) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${seqId}, ${d.dayNumber}, ${d.dailyLimit})`;
    }
    for (let i = 0; i < seed.pacingBlocks.length; i++) {
      const b = seed.pacingBlocks[i];
      await sql`
        INSERT INTO timing_sequence_pacing_blocks (id, workspace_id, sequence_id, position, block_type, min_value, max_value, label, message)
        VALUES (${crypto.randomUUID()}, ${workspaceId}, ${seqId}, ${i}, ${b.blockType}, ${b.minValue}, ${b.maxValue}, ${b.label}, ${b.message})
      `;
    }
  }
  // A blank starting point — same shape POST /api/message-sequences already
  // creates for a manually-added sequence — deliberately not copying any
  // workspace's real opener/follow-up wording into a new profile, since
  // that's business-specific copywriting, not generic boilerplate.
  const msgSeqId = crypto.randomUUID();
  await sql`INSERT INTO message_sequences (id, workspace_id, name) VALUES (${msgSeqId}, ${workspaceId}, 'Default')`;
  await sql`INSERT INTO message_sequence_openers (id, workspace_id, sequence_id, position, text) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${msgSeqId}, 0, '')`;
}

// Routes registered here (rather than grouped with the rest of the API
// further down) since they're the one thing that has to work before any
// other endpoint's workspace scoping means anything — switching profiles
// happens before the client sends its next X-Workspace-Id-tagged request.
app.get('/api/workspaces', asyncRoute(async (req, res) => {
  const rows = await sql`SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY created_at ASC`;
  res.json({ workspaces: rows.map(mapWorkspaceRow) });
}));

app.post('/api/workspaces', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const id = crypto.randomUUID();
  const instagramEnabled = req.body.instagramEnabled !== false;
  const linkedinEnabled = req.body.linkedinEnabled !== false;
  if (!instagramEnabled && !linkedinEnabled) {
    return res.status(400).json({ error: 'At least one platform must be enabled.' });
  }
  await sql`
    INSERT INTO workspaces (id, name, picture_url, instagram_enabled, linkedin_enabled)
    VALUES (${id}, ${name}, ${req.body.pictureUrl || null}, ${instagramEnabled}, ${linkedinEnabled})
  `;
  await seedDefaultSequencesForWorkspace(id);
  res.json({ ok: true, id });
}));

app.patch('/api/workspaces/:id', asyncRoute(async (req, res) => {
  const sets = []; const params = []; let i = 1;
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    sets.push(`name = $${i++}`); params.push(name);
  }
  if (req.body.pictureUrl !== undefined) { sets.push(`picture_url = $${i++}`); params.push(req.body.pictureUrl); }
  if (req.body.instagramEnabled !== undefined) { sets.push(`instagram_enabled = $${i++}`); params.push(!!req.body.instagramEnabled); }
  if (req.body.linkedinEnabled !== undefined) { sets.push(`linkedin_enabled = $${i++}`); params.push(!!req.body.linkedinEnabled); }
  if (sets.length === 0) return res.json({ ok: true });
  // Read-modify-check rather than a DB constraint — simplest way to block
  // "both platforms off" across a partial PATCH (e.g. only instagramEnabled
  // sent) without a cross-column CHECK constraint that'd need updating every
  // time these two columns' semantics changed.
  const [current] = await sql`SELECT instagram_enabled, linkedin_enabled FROM workspaces WHERE id = ${req.params.id} AND archived_at IS NULL`;
  if (!current) return res.status(404).json({ error: 'Profile not found.' });
  const nextIg = req.body.instagramEnabled !== undefined ? !!req.body.instagramEnabled : current.instagram_enabled;
  const nextLi = req.body.linkedinEnabled !== undefined ? !!req.body.linkedinEnabled : current.linkedin_enabled;
  if (!nextIg && !nextLi) return res.status(400).json({ error: 'At least one platform must be enabled.' });
  params.push(req.params.id);
  await sql.query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $${i}`, params);
  defaultWorkspaceIdCache = null; // name/archival elsewhere could change which workspace this resolves to
  res.json({ ok: true });
}));

app.delete('/api/workspaces/:id', asyncRoute(async (req, res) => {
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM workspaces WHERE archived_at IS NULL`;
  if (count <= 1) {
    return res.status(400).json({ error: "Can't archive the only remaining profile." });
  }
  await sql`UPDATE workspaces SET archived_at = now() WHERE id = ${req.params.id}`;
  defaultWorkspaceIdCache = null;
  res.json({ ok: true });
}));

// Same base64-JSON-to-Blob pattern as /api/accounts/upload-image — a profile
// picture is small enough that base64's ~33% overhead against the existing
// 15mb JSON limit doesn't matter.
app.post('/api/workspaces/upload-image', asyncRoute(async (req, res) => {
  const { imageBase64, contentType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required.' });
  const buffer = Buffer.from(imageBase64, 'base64');
  const ext = (contentType && contentType.split('/')[1]) || 'jpg';
  const blob = await putBlob(`workspace-photos/${crypto.randomUUID()}.${ext}`, buffer, {
    access: 'public',
    contentType: contentType || 'image/jpeg'
  });
  res.json({ url: blob.url });
}));

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

async function loadData(workspaceId, platform = 'all') {
  const rows = await sql`SELECT * FROM outreaches WHERE workspace_id = ${workspaceId} ${platformClause(platform)}`;
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

// Same "T00:00:00" local-as-Amsterdam-midnight construction computeGoalStreak
// uses for its own Sunday check below — outreach never happens on Sundays,
// so nothing new should be surfaced to act on that day either (follow-ups,
// connection requests) — it just all shows up Monday instead, nothing lost.
// Reminders and warmup tasks are deliberately exempt (see their call sites).
function isSundayAmsterdam(dateStr = todayStr()) {
  return new Date(dateStr + 'T00:00:00').getDay() === 0;
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
  const workspaceId = await getWorkspaceId(req);
  const platform = ['instagram', 'linkedin'].includes(req.query.platform) ? req.query.platform : 'all';
  const data = await loadData(workspaceId, platform);
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

  const [{ count }] = await sql`SELECT count(*) FROM leads WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND stage = 'new' ${platformClause(platform)}`;
  const stageRows = await sql`SELECT stage, count(*) FROM leads WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ${platformClause(platform)} GROUP BY stage`;
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
    WHERE e.workspace_id = ${workspaceId} AND e.event IN ('positive_reply', 'dead', 'call_booked', 'connection_sent', 'connection_accepted')
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
    sql`SELECT key, value FROM app_settings WHERE workspace_id = ${workspaceId} AND key IN ('daily_goal_instagram', 'daily_goal_linkedin', 'daily_goal_instagram_sync')`,
    sql`SELECT date, count(*) FROM outreaches WHERE workspace_id = ${workspaceId} AND platform = 'instagram' AND status = 'sent' GROUP BY date`,
    sql`SELECT e.date, count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.workspace_id = ${workspaceId} AND e.event = 'engaged' AND l.platform = 'linkedin' GROUP BY e.date`,
    sql`SELECT * FROM saved_sessions WHERE workspace_id = ${workspaceId} AND is_daily_goal = true ORDER BY created_at DESC LIMIT 1`
  ]);
  const goalSettings = {};
  goalSettingRows.forEach(r => { goalSettings[r.key] = r.value; });
  const dailyGoalInstagramSynced = goalSettings.daily_goal_instagram_sync === 'true';
  let dailyGoalInstagram = Number(goalSettings.daily_goal_instagram) || 0;
  const dailyGoalLinkedin = Number(goalSettings.daily_goal_linkedin) || 0;

  // "Sync to Instagram combined accounts max sends" — instead of a manually
  // typed number, the Instagram goal becomes the combined ceiling across
  // every connected account: each account's current daily_limit (reflecting
  // today's ramp-up step, if any) minus today's still-pending phase-1
  // follow-ups for that account, since those draw from the same daily cap
  // and would otherwise silently blow past it (same accounting as
  // effectiveRemainingForNewSends in GET /api/accounts, just summed).
  //
  // Locked once per day (at the same due-hour boundary — 4am by default —
  // follow-ups themselves use, via amsterdam_day_index), not recomputed on
  // every request. Recomputing live subtracted *currently still-pending*
  // follow-ups: as follow-ups actually got sent during the day, "still
  // pending" shrank, so the computed goal silently grew mid-day — a
  // daily-goal session that had already hit its target would suddenly show
  // as short again with no new cold sends having happened. Every follow-up
  // due today already counts as pending as soon as it's past today's
  // due-hour (due_at_normalized always normalizes to that exact hour, never
  // spreads later in the day), so whatever gets computed first after that
  // boundary is already the correct, stable total for the rest of the day.
  if (dailyGoalInstagramSynced) {
    const [dueHour, defaultSeqId] = await Promise.all([getFollowupDueHour(workspaceId), getDefaultMessageSequenceId(workspaceId)]);
    // ::text — amsterdam_day_index() returns a Postgres `date`, which the
    // driver hands back as a JS Date object; String()-ing that produces a
    // verbose, environment-dependent locale string (and Vercel's UTC
    // serverless runtime would stringify it differently than this app's
    // other date/day-index math expects), not a stable comparison key.
    const [{ day_index }] = await sql`SELECT amsterdam_day_index(now(), ${dueHour})::text AS day_index`;
    const snapshotKey = day_index;
    const snapshotRows = await sql`SELECT key, value FROM app_settings WHERE workspace_id = ${workspaceId} AND key IN ('daily_goal_instagram_snapshot_day', 'daily_goal_instagram_snapshot_value')`;
    const snapshot = {};
    snapshotRows.forEach(r => { snapshot[r.key] = r.value; });
    if (snapshot.daily_goal_instagram_snapshot_day === snapshotKey && snapshot.daily_goal_instagram_snapshot_value !== undefined) {
      dailyGoalInstagram = Number(snapshot.daily_goal_instagram_snapshot_value) || 0;
    } else {
      const [{ total_limit, total_pending }] = await sql`
        SELECT
          COALESCE(SUM(a.daily_limit), 0) AS total_limit,
          COALESCE(SUM(pending.cnt), 0) AS total_pending
        FROM ig_accounts a
        LEFT JOIN (
          SELECT l.account_id, count(*) AS cnt
          FROM leads l
          JOIN ig_accounts la ON la.id = l.account_id
          JOIN message_sequence_followups msf
            ON msf.sequence_id = COALESCE(la.message_sequence_id, ${defaultSeqId})
           AND msf.phase = 1 AND msf.step = l.phase_step + 1
          WHERE l.workspace_id = ${workspaceId} AND l.deleted_at IS NULL AND l.platform = 'instagram' AND l.stage = 'phase1' AND l.account_id IS NOT NULL
            AND due_at_normalized(l.phase_started_at, msf.day_offset, ${dueHour}) <= now()
          GROUP BY l.account_id
        ) pending ON pending.account_id = a.id
        WHERE a.workspace_id = ${workspaceId} AND a.archived_at IS NULL
      `;
      dailyGoalInstagram = Math.max(0, Number(total_limit) - Number(total_pending));
      await sql`
        INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'daily_goal_instagram_snapshot_day', ${snapshotKey})
        ON CONFLICT (workspace_id, key) DO UPDATE SET value = ${snapshotKey}
      `;
      await sql`
        INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'daily_goal_instagram_snapshot_value', ${String(dailyGoalInstagram)})
        ON CONFLICT (workspace_id, key) DO UPDATE SET value = ${String(dailyGoalInstagram)}
      `;
    }
  }

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
      instagramSynced: dailyGoalInstagramSynced,
      linkedin: dailyGoalLinkedin,
      todaySentInstagram: igSentByDate[today] || 0,
      todayEngagedLinkedin: liEngagedByDate[today] || 0,
      savedSession: dailyGoalSession ? mapSavedSessionRow(dailyGoalSession) : null
    }
  });
}));

app.post('/api/outreach', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
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
    INSERT INTO outreaches (id, workspace_id, date, created_at, platform, account_id, username, profile_url, full_name, bio, followers, last_post_weeks, posts_per_week, avg_views, template, message, status)
    VALUES (${record.id}, ${workspaceId}, ${record.date}, ${record.createdAt}, ${record.platform}, ${record.accountId}, ${record.username}, ${record.profileUrl}, ${record.fullName}, ${record.bio}, ${record.followers}, ${record.lastPostWeeks}, ${record.postsPerWeek}, ${record.avgViews}, ${record.template}, ${record.message}, ${record.status})
  `;

  // Lets the client know immediately whether this send just hit the active
  // account's daily cap, without a second round-trip — only meaningful for a
  // real Instagram account send that actually counted (a 'sent' status).
  let accountTodaySentCount = null;
  if (record.accountId && record.status === 'sent') {
    const [{ count }] = await sql`
      SELECT count(*) FROM outreaches
      WHERE workspace_id = ${workspaceId} AND account_id = ${record.accountId} AND status = 'sent' AND date = ${record.date}
    `;
    accountTodaySentCount = Number(count);
  }

  res.json({ ok: true, record, accountTodaySentCount });
}));

app.get('/api/analytics', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const platform = ['instagram', 'linkedin'].includes(req.query.platform) ? req.query.platform : 'all';
  const data = await loadData(workspaceId, platform);
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
    sql`SELECT count(*) FROM followup_sends fs JOIN leads l ON l.id = fs.lead_id WHERE fs.workspace_id = ${workspaceId} AND fs.date >= ${currentStart} AND fs.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.workspace_id = ${workspaceId} AND e.event = 'positive_reply' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.workspace_id = ${workspaceId} AND e.event = 'dead' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.workspace_id = ${workspaceId} AND e.event = 'call_booked' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.workspace_id = ${workspaceId} AND e.event = 'connection_sent' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`,
    sql`SELECT count(*) FROM lead_events e JOIN leads l ON l.id = e.lead_id WHERE e.workspace_id = ${workspaceId} AND e.event = 'connection_accepted' AND e.date >= ${currentStart} AND e.date <= ${currentEnd} ${platformClause(platform)}`
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

// Opening-line A/B test performance — deliberately separate from the
// date-ranged /api/analytics above: an opener's performance is a cumulative
// comparison across however long it's been running, not a period-over-period
// one, so this ignores the range/platform tabs entirely. Joins straight to
// message_sequences (not filtered by archived_at) so a variant from an
// archived/deleted sequence still shows its historical performance rather
// than silently disappearing.
app.get('/api/analytics/openers', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const rows = await sql`
    SELECT o.id, o.position, o.text, ms.name AS sequence_name,
      count(l.id) AS sends,
      count(l.id) FILTER (WHERE l.ever_positive_reply) AS positive_replies,
      count(l.id) FILTER (WHERE l.ever_call_booked) AS appointments_set,
      count(l.id) FILTER (WHERE EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.event = 'dead')) AS dead_count
    FROM message_sequence_openers o
    JOIN message_sequences ms ON ms.id = o.sequence_id
    LEFT JOIN leads l ON l.opener_id = o.id AND l.deleted_at IS NULL
    WHERE o.workspace_id = ${workspaceId}
    GROUP BY o.id, o.position, o.text, ms.name
    ORDER BY ms.name, o.position
  `;
  const rate = (num, denom) => (denom > 0 ? Math.round((num / denom) * 1000) / 10 : null);
  const openers = rows.map(r => {
    const sends = Number(r.sends);
    const positiveReplies = Number(r.positive_replies);
    const appointmentsSet = Number(r.appointments_set);
    // Replies = Positive Replies + Dead (a "no" is still a reply) — same
    // definition GET /api/analytics uses.
    const replies = positiveReplies + Number(r.dead_count);
    return {
      id: r.id,
      position: r.position,
      text: r.text,
      sequenceName: r.sequence_name,
      sends,
      replies,
      replyRate: rate(replies, sends),
      positiveReplies,
      prr: rate(positiveReplies, sends),
      appointmentsSet,
      asr: rate(appointmentsSet, sends)
    };
  });
  res.json({ openers });
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

async function loadLeads(workspaceId) {
  const rows = await sql`SELECT * FROM leads WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY seq ASC`;
  return rows.map(mapLeadRow);
}

app.get('/api/leads', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const leads = await loadLeads(workspaceId);
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
  const workspaceId = await getWorkspaceId(req);
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
        WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND stage = 'new' AND platform = ${platform} AND NOT (id = ANY(${excludeIds}))
        ORDER BY seq ASC
        LIMIT ${count}
      `
    : await sql`
        SELECT * FROM leads
        WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND stage = 'new' AND platform = ${platform}
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
  const workspaceId = await getWorkspaceId(req);
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
    INSERT INTO leads (id, workspace_id, platform, profile_url, username, full_name, bio, headline, followers, notes)
    VALUES (${id}, ${workspaceId}, ${platform}, ${sanitizeUrl(b.profileUrl)}, ${b.username || ''}, ${b.fullName || ''}, ${b.bio || ''},
      ${b.headline || ''}, ${toNullableInt(b.followers)}, ${b.notes || ''})
    ON CONFLICT (workspace_id, lower(username)) WHERE deleted_at IS NULL AND username <> '' DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0 && b.username) {
    return res.status(409).json({ error: `A lead with username @${b.username} is already in your list.` });
  }
  res.json({ ok: true, id });
}));

app.post('/api/leads/bulk', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
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
  const workspaceIds = leads.map(() => workspaceId);
  const platforms = leads.map(() => platform);
  const profileUrls = leads.map(l => sanitizeUrl(l.profileUrl));
  const usernames = leads.map(l => l.username || '');
  const fullNames = leads.map(l => l.fullName || '');
  const bios = leads.map(l => l.bio || '');
  const headlines = leads.map(l => l.headline || '');
  const followersArr = leads.map(l => toNullableInt(l.followers));

  const rows = await sql`
    INSERT INTO leads (id, workspace_id, platform, profile_url, username, full_name, bio, headline, followers)
    SELECT * FROM unnest(${ids}::uuid[], ${workspaceIds}::uuid[], ${platforms}::text[], ${profileUrls}::text[], ${usernames}::text[], ${fullNames}::text[], ${bios}::text[], ${headlines}::text[], ${followersArr}::integer[])
    ON CONFLICT (workspace_id, lower(username)) WHERE deleted_at IS NULL AND username <> '' DO NOTHING
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
  notes: 'notes',
  accountId: 'account_id',
  openerId: 'opener_id'
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
  const workspaceId = await getWorkspaceId(req);
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
    const [current] = await sql`SELECT stage, ever_positive_reply, ever_call_booked, personalized_video_url FROM leads WHERE id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
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
        await sql`INSERT INTO lead_events (id, workspace_id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id},'positive_reply', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
      }
      if (leavingPositive) {
        sets.push('ever_positive_reply = false');
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'positive_reply'`;
      }

      if (b.stage === 'call_booked' && !current.ever_call_booked) {
        sets.push('ever_call_booked = true');
        await sql`INSERT INTO lead_events (id, workspace_id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id},'call_booked', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
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
        await sql`INSERT INTO lead_events (id, workspace_id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id},'dead', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
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
        await sql`INSERT INTO lead_events (id, workspace_id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id},'engaged', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
      }
      if (current.stage === 'engaged' && b.stage === 'new') {
        await sql`DELETE FROM lead_events WHERE lead_id = ${id} AND event = 'engaged'`;
      }
      if (b.stage === 'connection_sent') {
        await sql`INSERT INTO lead_events (id, workspace_id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id},'connection_sent', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
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
        await sql`INSERT INTO lead_events (id, workspace_id, lead_id, event, date) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id},'connection_accepted', ${today}) ON CONFLICT (lead_id, event) DO NOTHING`;
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
  params.push(workspaceId);

  try {
    await sql.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${i} AND workspace_id = $${i + 1} AND deleted_at IS NULL`, params);
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
  const workspaceId = await getWorkspaceId(req);
  const { id } = req.params;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const [lead] = await sql`SELECT id FROM leads WHERE id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  if (!RENDER_SERVICE_URL || !RENDER_SERVICE_SECRET) {
    return res.status(500).json({ error: 'Video rendering is not configured (RENDER_SERVICE_URL / RENDER_SERVICE_SECRET missing).' });
  }

  await sql`
    UPDATE leads SET personalized_video_status = 'rendering', personalized_video_error = NULL, updated_at = now()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
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
      await sql`UPDATE leads SET personalized_video_status = 'error', personalized_video_error = ${errMsg}, updated_at = now() WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return res.status(502).json({ error: errMsg });
    }
    await sql`
      UPDATE leads SET
        personalized_video_status = 'done',
        personalized_video_url = ${data.url},
        personalized_video_name = ${name},
        personalized_video_error = NULL,
        updated_at = now()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    res.json({ url: data.url, name });
  } catch (err) {
    const errMsg = err.name === 'AbortError' ? 'Render service timed out.' : (err.message || 'Video render failed.');
    await sql`UPDATE leads SET personalized_video_status = 'error', personalized_video_error = ${errMsg}, updated_at = now() WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    res.status(502).json({ error: errMsg });
  } finally {
    clearTimeout(timer);
  }
}));

app.post('/api/leads/delete', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const { ids, all } = req.body;
  // RETURNING reflects the row *after* the update, so the video URLs have
  // to be read before it — otherwise nulling them out in the same statement
  // would mean we always "return" NULL and never know what to delete.
  const toDelete = all
    ? await sql`SELECT id, personalized_video_url FROM leads WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL`
    : (Array.isArray(ids) && ids.length > 0
        ? await sql`SELECT id, personalized_video_url FROM leads WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL`
        : []);
  if (!all && toDelete.length === 0) return res.json({ ok: true, deletedIds: [] });

  let rows;
  if (all) {
    rows = await sql`
      UPDATE leads SET deleted_at = now(), personalized_video_url = NULL, personalized_video_status = NULL, personalized_video_name = NULL
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL RETURNING id
    `;
  } else {
    const idList = toDelete.map(r => r.id);
    rows = await sql`
      UPDATE leads SET deleted_at = now(), personalized_video_url = NULL, personalized_video_status = NULL, personalized_video_name = NULL
      WHERE id = ANY(${idList}::uuid[]) AND workspace_id = ${workspaceId} AND deleted_at IS NULL RETURNING id
    `;
  }
  // Disqualified leads never got their video sent — no reason to keep it
  // around in Blob storage either. Awaited — see the comment on the same
  // call in PATCH /api/leads/:id for why fire-and-forget silently drops this.
  await deleteVideoBlobs(toDelete.map(r => r.personalized_video_url).filter(Boolean));
  res.json({ ok: true, deletedIds: rows.map(r => r.id) });
}));

app.post('/api/leads/restore', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const idList = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (idList.length === 0) return res.json({ ok: true });
  await sql`UPDATE leads SET deleted_at = NULL WHERE id = ANY(${idList}::uuid[]) AND workspace_id = ${workspaceId}`;
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

// Daily limits now come from whichever Timing sequence is assigned to the
// account (see Settings → Timing sequences) instead of a fixed 40/60/80
// age-tier formula — tierCapForAge lives on only as the "recommended max"
// comparison behind the over-cap ⚠️ warning, it no longer drives the actual
// limit or auto-upgrades anything.
function tierCapForAge(ageDays) {
  if (ageDays < 30) return 40;
  if (ageDays < 180) return 60;
  return 80;
}

// rampDays: that sequence's timing_sequence_ramp_days, sorted ascending by
// dayNumber. The limit for any given day is whichever defined day is the
// closest at-or-before it — rows only need to exist at the days where the
// value actually changes, it holds steady in between and past the last row
// (that's the whole "ramp then plateau" shape, no separate formula needed).
function curveLimitForDay(rampDays, dayNumber) {
  let limit = 0;
  for (const rd of rampDays) {
    if (rd.dayNumber <= dayNumber) limit = rd.dailyLimit;
    else break;
  }
  return limit;
}

// firstNonzeroDay: where "warming up" (limit 0) gives way to real sending —
// this is now what defines "how many days is the warmup", derived from the
// curve rather than a stored warmup_days column. lastDay: the last day the
// curve explicitly ramps through, beyond which it's just holding steady
// ("ready").
function curveBoundaries(rampDays) {
  const nonzero = rampDays.find(rd => rd.dailyLimit > 0);
  return {
    firstNonzeroDay: nonzero ? nonzero.dayNumber : null,
    lastDay: rampDays.length ? rampDays[rampDays.length - 1].dayNumber : null
  };
}

// warmup_age_days/ramp_start-equivalents come pre-computed from the accounts
// query (see GET /api/accounts) via the same Amsterdam-morning-boundary SQL
// functions follow-up due-times use — "day 1" is the calendar day the
// account's clock reference lands on, ticking over at the next 4am Amsterdam
// (or whatever the follow-up due hour setting is), not at the exact
// clock-time of that reference.
function mapAccountRow(r, todaySentCount, pendingPhase1FollowupCount, rampDays) {
  const ageDays = ageDaysFrom(r.created_on);
  const tierCap = tierCapForAge(ageDays);
  const { firstNonzeroDay, lastDay } = curveBoundaries(rampDays);
  const zeroDayCount = firstNonzeroDay != null ? firstNonzeroDay - 1 : null;

  let phase = 'ready';
  let warmupDay = null;
  let rampDay = null;
  if (!r.rampup_skipped_at) {
    // Skipping warmup is a deliberate, instant user action — its day-count
    // stays exact-elapsed-time-based rather than morning-aligned, since
    // there's no "day it was added" boundary to align to (same reasoning as
    // before this became curve-driven).
    const dayNumber = r.warmup_skipped_at
      ? Math.floor((Date.now() - toDate(r.warmup_skipped_at).getTime()) / MS_PER_DAY) + (firstNonzeroDay || 1)
      : r.days_since_clock_start + 1;
    const limit = curveLimitForDay(rampDays, dayNumber);
    if (limit === 0) {
      phase = 'warming_up';
      // 0-indexed ("day 0 of N" the day it's added, counting up to "day N-1
      // of N" the day before ramp-up starts) — matches zeroDayCount directly
      // rather than needing a separate +1/-1 convention to keep straight.
      warmupDay = zeroDayCount != null ? Math.min(zeroDayCount - 1, Math.max(0, dayNumber - 1)) : Math.max(0, dayNumber - 1);
    } else if (lastDay != null && dayNumber <= lastDay) {
      phase = 'ramping_up';
      rampDay = Math.max(1, dayNumber - (zeroDayCount || 0));
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
    pendingPhase1FollowupCount: pendingPhase1FollowupCount || 0,
    effectiveRemainingForNewSends: Math.max(0, r.daily_limit - (todaySentCount || 0) - (pendingPhase1FollowupCount || 0)),
    phase,
    warmupDay,
    warmupDays: zeroDayCount,
    plateauLimit: lastDay != null ? curveLimitForDay(rampDays, lastDay) : null,
    rampDay,
    timingSequenceId: r.timing_sequence_id,
    messageSequenceId: r.message_sequence_id
  };
}

// All ramp-day rows for every non-archived sequence in use, grouped by
// sequence_id — cheap to fetch entirely (a handful of rows per sequence)
// rather than a per-account correlated query, and sorted ascending so
// curveLimitForDay/curveBoundaries can just walk each list in order.
async function getRampDaysBySequence(workspaceId) {
  const rows = await sql`SELECT sequence_id, day_number, daily_limit FROM timing_sequence_ramp_days WHERE workspace_id = ${workspaceId} ORDER BY sequence_id, day_number ASC`;
  const bySequence = {};
  rows.forEach(r => {
    if (!bySequence[r.sequence_id]) bySequence[r.sequence_id] = [];
    bySequence[r.sequence_id].push({ dayNumber: r.day_number, dailyLimit: r.daily_limit });
  });
  return bySequence;
}

app.get('/api/accounts', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const today = todayStr();
  const [dueHour, defaultMessageSeqId] = await Promise.all([getFollowupDueHour(workspaceId), getDefaultMessageSequenceId(workspaceId)]);
  // days_since_clock_start is computed here (not in JS) so "a day" ticks
  // over at the same Amsterdam morning boundary follow-ups use
  // (amsterdam_day_index()), not at the exact clock-time of the reference —
  // see mapAccountRow below. The clock starts from warmup_restarted_at when
  // set (see POST .../restart-warmup) — an account can be sent back into
  // warmup from any phase without touching created_at, which still means
  // "when this row was added to the tool" for list ordering and everywhere
  // else.
  const [accounts, rampDaysBySequence] = await Promise.all([
    sql`
      SELECT *,
        (amsterdam_day_index(now(), ${dueHour}) - amsterdam_day_index(COALESCE(warmup_restarted_at, created_at), ${dueHour})) AS days_since_clock_start
      FROM ig_accounts WHERE workspace_id = ${workspaceId} AND archived_at IS NULL ORDER BY created_at ASC
    `,
    getRampDaysBySequence(workspaceId)
  ]);
  const sentRows = await sql`
    SELECT account_id, count(*) FROM outreaches
    WHERE workspace_id = ${workspaceId} AND status = 'sent' AND date = ${today} AND account_id IS NOT NULL
    GROUP BY account_id
  `;
  // Phase-1 follow-ups are sent from the same account and count just as much
  // toward its daily cap — deliberately not stored in `outreaches` itself
  // (that would inflate Home's daily-goal/streak and Analytics' funnel
  // numbers), so today's count is this account's real sends *plus* its
  // phase-1 follow-up sends, merged here rather than in a shared table.
  const followupSentRows = await sql`
    SELECT account_id, count(*) FROM followup_sends
    WHERE workspace_id = ${workspaceId} AND phase = 1 AND date = ${today} AND account_id IS NOT NULL
    GROUP BY account_id
  `;
  const sentByAccount = {};
  sentRows.forEach(r => { sentByAccount[r.account_id] = (sentByAccount[r.account_id] || 0) + Number(r.count); });
  followupSentRows.forEach(r => { sentByAccount[r.account_id] = (sentByAccount[r.account_id] || 0) + Number(r.count); });

  // How many phase-1 follow-ups are due right now but not yet sent, per
  // account — deducted from the account's remaining daily capacity for
  // *new* cold-outreach sends (see effectiveRemainingForNewSends in
  // mapAccountRow), so starting a fresh session doesn't blow past the cap
  // once today's follow-up backlog is also sent.
  const pendingRows = await sql`
    SELECT l.account_id, count(*) FROM leads l
    JOIN ig_accounts la ON la.id = l.account_id
    JOIN message_sequence_followups msf
      ON msf.sequence_id = COALESCE(la.message_sequence_id, ${defaultMessageSeqId})
     AND msf.phase = 1 AND msf.step = l.phase_step + 1
    WHERE l.workspace_id = ${workspaceId} AND l.deleted_at IS NULL AND l.platform = 'instagram' AND l.stage = 'phase1' AND l.account_id IS NOT NULL
      AND due_at_normalized(l.phase_started_at, msf.day_offset, ${dueHour}) <= now()
    GROUP BY l.account_id
  `;
  const pendingByAccount = {};
  pendingRows.forEach(r => { pendingByAccount[r.account_id] = Number(r.count); });

  // Lazy write-through — daily_limit stays a stored, kept-up-to-date column
  // (not purely derived) because two other endpoints read it directly: the
  // "sync to accounts max sends" daily-goal sum, and the follow-up-sent
  // overage check. Recomputed here (like the follow-up due-query, this app
  // has no background jobs) from the account's assigned Timing sequence
  // instead of the old age-tier formula — a curve reaching its plateau no
  // longer auto-upgrades with the account's age, the curve is authoritative.
  const warmupJustEnded = [];
  for (const r of accounts) {
    if (r.rampup_skipped_at) continue; // parked at its curve's plateau already, nothing to recompute
    const rampDays = rampDaysBySequence[r.timing_sequence_id] || [];
    const { firstNonzeroDay } = curveBoundaries(rampDays);
    const dayNumber = r.warmup_skipped_at
      ? Math.floor((Date.now() - toDate(r.warmup_skipped_at).getTime()) / MS_PER_DAY) + (firstNonzeroDay || 1)
      : r.days_since_clock_start + 1;
    const computedLimit = curveLimitForDay(rampDays, dayNumber);
    if (computedLimit !== r.daily_limit) {
      // The stored value still reading 0 is what tells us this is the exact
      // moment warmup ends — the natural (non-skipped) path, since
      // skip-warmup already bumps this itself and announces separately.
      if (r.daily_limit === 0 && computedLimit > 0) {
        const zeroDayCount = firstNonzeroDay != null ? firstNonzeroDay - 1 : 0;
        await sql`
          INSERT INTO reminders (id, workspace_id, text, due_at, lead_id)
          VALUES (${crypto.randomUUID()}, ${workspaceId}, ${`🔥 @${r.username} finished its ${zeroDayCount}-day warmup and is ready to start ramping up`}, now(), NULL)
        `;
        warmupJustEnded.push(r.id);
      }
      await sql`UPDATE ig_accounts SET daily_limit = ${computedLimit} WHERE id = ${r.id} AND workspace_id = ${workspaceId}`;
      r.daily_limit = computedLimit;
    }
  }

  res.json({
    accounts: accounts.map(r => mapAccountRow(r, sentByAccount[r.id], pendingByAccount[r.id], rampDaysBySequence[r.timing_sequence_id] || [])),
    upgraded: warmupJustEnded
  });
}));

app.post('/api/accounts/:id/skip-warmup', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [account] = await sql`SELECT username, timing_sequence_id FROM ig_accounts WHERE id = ${req.params.id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const rampDays = await sql`SELECT day_number, daily_limit FROM timing_sequence_ramp_days WHERE sequence_id = ${account.timing_sequence_id} AND workspace_id = ${workspaceId} ORDER BY day_number ASC`;
  const { firstNonzeroDay } = curveBoundaries(rampDays.map(r => ({ dayNumber: r.day_number, dailyLimit: r.daily_limit })));
  const startLimit = firstNonzeroDay != null ? rampDays.find(r => r.day_number === firstNonzeroDay).daily_limit : 0;
  await sql`UPDATE ig_accounts SET warmup_skipped_at = now(), daily_limit = ${startLimit} WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  await sql`
    INSERT INTO reminders (id, workspace_id, text, due_at, lead_id)
    VALUES (${crypto.randomUUID()}, ${workspaceId}, ${`🔥 @${account.username}'s warmup was skipped and is ready to start ramping up`}, now(), NULL)
  `;
  res.json({ ok: true });
}));

app.post('/api/accounts/:id/skip-rampup', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [account] = await sql`SELECT timing_sequence_id FROM ig_accounts WHERE id = ${req.params.id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const [plateau] = await sql`SELECT daily_limit FROM timing_sequence_ramp_days WHERE sequence_id = ${account.timing_sequence_id} AND workspace_id = ${workspaceId} ORDER BY day_number DESC LIMIT 1`;
  await sql`UPDATE ig_accounts SET rampup_skipped_at = now(), daily_limit = ${plateau ? plateau.daily_limit : 0} WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  res.json({ ok: true });
}));

// Sends an account back into warmup from any phase (ready, ramping_up, or
// even mid-warmup) — for when something's gone wrong on Instagram's end and
// the account needs to genuinely start over, not just have its limit
// lowered. warmup_restarted_at (not created_at) becomes the new clock
// reference everywhere warmup/ramp timing is computed, so this doesn't
// disturb created_at's "when this row was added to the tool" meaning (list
// ordering) or created_on's real-world IG account age (tier eligibility).
// Clears both skip flags and zeroes the limit — a full do-over, matching a
// brand-new account's starting state.
app.post('/api/accounts/:id/restart-warmup', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [account] = await sql`SELECT username, timing_sequence_id FROM ig_accounts WHERE id = ${req.params.id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const [day1] = await sql`SELECT daily_limit FROM timing_sequence_ramp_days WHERE sequence_id = ${account.timing_sequence_id} AND workspace_id = ${workspaceId} AND day_number = 1`;
  await sql`
    UPDATE ig_accounts
    SET warmup_restarted_at = now(), warmup_skipped_at = NULL, rampup_skipped_at = NULL, daily_limit = ${day1 ? day1.daily_limit : 0}
    WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}
  `;
  res.json({ ok: true });
}));

// ---------- Daily warmup activity tasks (post + scroll/engage) ----------

// Accounts still genuinely in their warmup window right now — computes
// ramp_start the same way GET /api/accounts does (due_at_normalized, morning-
// aligned) so this never drifts out of sync with what Settings shows as
// "warming up".
async function getWarmingUpAccounts(workspaceId) {
  const dueHour = await getFollowupDueHour(workspaceId);
  const [accounts, rampDaysBySequence] = await Promise.all([
    sql`
      SELECT id, username, warmup_skipped_at, rampup_skipped_at, timing_sequence_id,
        (amsterdam_day_index(now(), ${dueHour}) - amsterdam_day_index(COALESCE(warmup_restarted_at, created_at), ${dueHour})) AS days_since_clock_start
      FROM ig_accounts WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
    `,
    getRampDaysBySequence(workspaceId)
  ]);
  return accounts.filter(r => {
    if (r.warmup_skipped_at || r.rampup_skipped_at) return false;
    const rampDays = rampDaysBySequence[r.timing_sequence_id] || [];
    const dayNumber = r.days_since_clock_start + 1;
    return curveLimitForDay(rampDays, dayNumber) === 0;
  });
}

function mapWarmupTaskRow(r) {
  const elapsedSeconds = r.type === 'engage'
    ? r.accumulated_seconds + (r.run_started_at ? Math.floor((Date.now() - new Date(r.run_started_at).getTime()) / 1000) : 0)
    : 0;
  return {
    id: r.id,
    accountId: r.account_id,
    accountUsername: r.account_username,
    type: r.type,
    targetSeconds: r.target_seconds,
    elapsedSeconds,
    running: !!r.run_started_at,
    completed: !!r.completed_at,
    createdAt: r.created_at
  };
}

app.get('/api/warmup-tasks/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [row] = await sql`
    SELECT t.*, a.username AS account_username FROM account_warmup_tasks t
    JOIN ig_accounts a ON a.id = t.account_id
    WHERE t.id = ${req.params.id} AND t.workspace_id = ${workspaceId}
  `;
  if (!row) return res.status(404).json({ error: 'Task not found.' });
  // Lazy completion check — covers a session left running unattended past
  // its target with nobody around to hit Pause.
  if (row.type === 'engage' && !row.completed_at) {
    const elapsed = row.accumulated_seconds + (row.run_started_at ? Math.floor((Date.now() - new Date(row.run_started_at).getTime()) / 1000) : 0);
    if (elapsed >= row.target_seconds) {
      await sql`UPDATE account_warmup_tasks SET accumulated_seconds = ${elapsed}, run_started_at = NULL, completed_at = now() WHERE id = ${row.id}`;
      row.accumulated_seconds = elapsed; row.run_started_at = null; row.completed_at = new Date();
    }
  }
  res.json(mapWarmupTaskRow(row));
}));

app.post('/api/warmup-tasks/:id/complete', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [row] = await sql`SELECT type FROM account_warmup_tasks WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  if (!row) return res.status(404).json({ error: 'Task not found.' });
  if (row.type !== 'post') return res.status(400).json({ error: "Only 'post' tasks can be completed directly." });
  await sql`UPDATE account_warmup_tasks SET completed_at = now() WHERE id = ${req.params.id}`;
  res.json({ ok: true });
}));

app.post('/api/warmup-tasks/:id/start', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [row] = await sql`
    SELECT t.*, a.username AS account_username FROM account_warmup_tasks t
    JOIN ig_accounts a ON a.id = t.account_id
    WHERE t.id = ${req.params.id} AND t.workspace_id = ${workspaceId}
  `;
  if (!row) return res.status(404).json({ error: 'Task not found.' });
  if (row.type !== 'engage') return res.status(400).json({ error: "Only 'engage' tasks can be started." });
  if (!row.completed_at && !row.run_started_at) {
    await sql`UPDATE account_warmup_tasks SET run_started_at = now() WHERE id = ${req.params.id}`;
    row.run_started_at = new Date();
  }
  res.json(mapWarmupTaskRow(row));
}));

app.post('/api/warmup-tasks/:id/pause', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [row] = await sql`
    SELECT t.*, a.username AS account_username FROM account_warmup_tasks t
    JOIN ig_accounts a ON a.id = t.account_id
    WHERE t.id = ${req.params.id} AND t.workspace_id = ${workspaceId}
  `;
  if (!row) return res.status(404).json({ error: 'Task not found.' });
  if (row.type !== 'engage') return res.status(400).json({ error: "Only 'engage' tasks can be paused." });
  const elapsed = row.accumulated_seconds + (row.run_started_at ? Math.floor((Date.now() - new Date(row.run_started_at).getTime()) / 1000) : 0);
  const completed = elapsed >= row.target_seconds;
  if (completed) {
    await sql`UPDATE account_warmup_tasks SET accumulated_seconds = ${elapsed}, run_started_at = NULL, completed_at = now() WHERE id = ${req.params.id}`;
    row.completed_at = new Date();
  } else {
    await sql`UPDATE account_warmup_tasks SET accumulated_seconds = ${elapsed}, run_started_at = NULL WHERE id = ${req.params.id}`;
  }
  row.accumulated_seconds = elapsed; row.run_started_at = null;
  res.json(mapWarmupTaskRow(row));
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

// Seeded by the timing-sequences migration — a brand-new account gets
// auto-assigned whichever of these matches its real-world IG age, so it
// behaves the same as before this system existed until you deliberately
// reassign or edit a sequence.
const DEFAULT_TIMING_SEQUENCE_NAMES = { 40: 'Default — New', 60: 'Default — 1-6 months', 80: 'Default — 6+ months' };

app.post('/api/accounts', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const username = String(req.body.username || '').trim().replace('@', '');
  const createdOn = req.body.createdOn;
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (!createdOn || Number.isNaN(new Date(createdOn).getTime())) {
    return res.status(400).json({ error: 'A valid creation date is required.' });
  }
  // Every newly-added account starts at 0 and warming up, regardless of how
  // old the real Instagram account already is — the warmup/ramp-up here is
  // about easing this *tool's* usage pattern in, not the account's own age
  // (which still separately determines which default Timing sequence it
  // starts on, editable/reassignable afterward from Settings → Timing
  // sequences).
  const tierCap = tierCapForAge(ageDaysFrom(createdOn));
  const [[defaultSeq], defaultMessageSeqId] = await Promise.all([
    sql`SELECT id FROM timing_sequences WHERE workspace_id = ${workspaceId} AND name = ${DEFAULT_TIMING_SEQUENCE_NAMES[tierCap]} AND archived_at IS NULL`,
    getDefaultMessageSequenceId(workspaceId)
  ]);
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO ig_accounts (id, workspace_id, username, created_on, profile_image_url, daily_limit, timing_sequence_id, message_sequence_id)
    VALUES (${id}, ${workspaceId}, ${username}, ${createdOn}, ${req.body.profileImageUrl || null}, 0, ${defaultSeq ? defaultSeq.id : null}, ${defaultMessageSeqId})
  `;
  res.json({ ok: true, id });
}));

app.patch('/api/accounts/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const { id } = req.params;
  const sets = []; const params = []; let i = 1;
  if (req.body.username !== undefined) { sets.push(`username = $${i++}`); params.push(String(req.body.username).trim().replace('@', '')); }
  if (req.body.profileImageUrl !== undefined) { sets.push(`profile_image_url = $${i++}`); params.push(req.body.profileImageUrl); }
  if (req.body.timingSequenceId !== undefined) { sets.push(`timing_sequence_id = $${i++}`); params.push(req.body.timingSequenceId); }
  if (req.body.messageSequenceId !== undefined) { sets.push(`message_sequence_id = $${i++}`); params.push(req.body.messageSequenceId); }
  if (sets.length === 0) return res.json({ ok: true });
  params.push(id);
  params.push(workspaceId);
  await sql.query(`UPDATE ig_accounts SET ${sets.join(', ')} WHERE id = $${i} AND workspace_id = $${i + 1}`, params);
  res.json({ ok: true });
}));

app.delete('/api/accounts/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  await sql`UPDATE ig_accounts SET archived_at = now() WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  res.json({ ok: true });
}));

// ---------- TIMING SEQUENCES ----------
// Named, reusable presets bundling a day-by-day daily-limit ramp curve
// (timing_sequence_ramp_days) and a repeating in-session send/pause pattern
// (timing_sequence_pacing_blocks), assignable per Instagram account
// (ig_accounts.timing_sequence_id) — see Settings → Timing sequences.
// Instagram-only, matching the rest of the account system.

app.get('/api/timing-sequences', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [sequences, rampDayRows, pacingBlockRows, accountRows] = await Promise.all([
    sql`SELECT * FROM timing_sequences WHERE workspace_id = ${workspaceId} AND archived_at IS NULL ORDER BY created_at ASC`,
    sql`SELECT * FROM timing_sequence_ramp_days WHERE workspace_id = ${workspaceId} ORDER BY sequence_id, day_number ASC`,
    sql`SELECT * FROM timing_sequence_pacing_blocks WHERE workspace_id = ${workspaceId} ORDER BY sequence_id, position ASC`,
    sql`SELECT id, username, timing_sequence_id FROM ig_accounts WHERE workspace_id = ${workspaceId} AND archived_at IS NULL AND timing_sequence_id IS NOT NULL`
  ]);
  res.json({
    sequences: sequences.map(s => ({
      id: s.id,
      name: s.name,
      rampDays: rampDayRows.filter(r => r.sequence_id === s.id).map(r => ({ dayNumber: r.day_number, dailyLimit: r.daily_limit })),
      pacingBlocks: pacingBlockRows.filter(b => b.sequence_id === s.id).map(b => ({
        id: b.id, position: b.position, blockType: b.block_type, minValue: b.min_value, maxValue: b.max_value, label: b.label, message: b.message
      })),
      // "Always include at least one scroll break" — for a session whose
      // volume is too low to naturally trip the pacing pattern's send-block
      // threshold, one gets forced in right before the session would
      // otherwise end (see app.js shouldForceEndOfSessionBreak), so a
      // session with real sends never finishes without at least one.
      guaranteeMinOnePause: s.guarantee_min_one_pause,
      accountsUsing: accountRows.filter(a => a.timing_sequence_id === s.id).map(a => ({ id: a.id, username: a.username }))
    }))
  });
}));

app.post('/api/timing-sequences', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const id = crypto.randomUUID();
  if (req.body.duplicateFrom) {
    const [source] = await sql`SELECT guarantee_min_one_pause FROM timing_sequences WHERE id = ${req.body.duplicateFrom} AND workspace_id = ${workspaceId}`;
    await sql`INSERT INTO timing_sequences (id, workspace_id, name, guarantee_min_one_pause) VALUES (${id}, ${workspaceId}, ${name}, ${source ? source.guarantee_min_one_pause : false})`;
    const [rampDays, pacingBlocks] = await Promise.all([
      sql`SELECT day_number, daily_limit FROM timing_sequence_ramp_days WHERE sequence_id = ${req.body.duplicateFrom} AND workspace_id = ${workspaceId} ORDER BY day_number ASC`,
      sql`SELECT position, block_type, min_value, max_value, label, message FROM timing_sequence_pacing_blocks WHERE sequence_id = ${req.body.duplicateFrom} AND workspace_id = ${workspaceId} ORDER BY position ASC`
    ]);
    for (const r of rampDays) {
      await sql`INSERT INTO timing_sequence_ramp_days (id, workspace_id, sequence_id, day_number, daily_limit) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id}, ${r.day_number}, ${r.daily_limit})`;
    }
    for (const b of pacingBlocks) {
      await sql`
        INSERT INTO timing_sequence_pacing_blocks (id, workspace_id, sequence_id, position, block_type, min_value, max_value, label, message)
        VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id}, ${b.position}, ${b.block_type}, ${b.min_value}, ${b.max_value}, ${b.label}, ${b.message})
      `;
    }
  } else {
    await sql`INSERT INTO timing_sequences (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${name})`;
  }
  res.json({ ok: true, id });
}));

app.patch('/api/timing-sequences/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const sets = []; const params = []; let i = 1;
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    sets.push(`name = $${i++}`); params.push(name);
  }
  if (req.body.guaranteeMinOnePause !== undefined) { sets.push(`guarantee_min_one_pause = $${i++}`); params.push(!!req.body.guaranteeMinOnePause); }
  if (sets.length === 0) return res.json({ ok: true });
  params.push(req.params.id);
  params.push(workspaceId);
  await sql.query(`UPDATE timing_sequences SET ${sets.join(', ')} WHERE id = $${i} AND workspace_id = $${i + 1}`, params);
  res.json({ ok: true });
}));

app.delete('/api/timing-sequences/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [inUse] = await sql`SELECT count(*)::int AS count FROM ig_accounts WHERE timing_sequence_id = ${req.params.id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
  if (inUse.count > 0) {
    return res.status(400).json({ error: `${inUse.count} account${inUse.count === 1 ? ' is' : 's are'} still using this sequence — reassign them first.` });
  }
  await sql`UPDATE timing_sequences SET archived_at = now() WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  res.json({ ok: true });
}));

// Bulk replace — the client edits each day as "+N days after the previous
// one" (see the Timing sequences page), so changing one offset cascades to
// every day after it; simplest to just send the whole recomputed list back
// rather than track that cascade as individual per-row updates.
app.put('/api/timing-sequences/:id/ramp-days', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const days = Array.isArray(req.body.days) ? req.body.days : [];
  await sql`DELETE FROM timing_sequence_ramp_days WHERE sequence_id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  for (const d of days) {
    const dayNumber = Math.max(1, Math.round(Number(d.dayNumber)) || 1);
    const dailyLimit = Math.max(0, Math.round(Number(d.dailyLimit)) || 0);
    await sql`INSERT INTO timing_sequence_ramp_days (id, workspace_id, sequence_id, day_number, daily_limit) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${req.params.id}, ${dayNumber}, ${dailyLimit})`;
  }
  res.json({ ok: true });
}));

// Bulk replace, not per-row CRUD like ramp days — a drag-and-drop reorder
// touches every block's position at once, so the client just sends the
// full ordered list back on every change.
app.put('/api/timing-sequences/:id/pacing-blocks', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const blocks = Array.isArray(req.body.blocks) ? req.body.blocks : [];
  await sql`DELETE FROM timing_sequence_pacing_blocks WHERE sequence_id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const blockType = b.blockType === 'pause' ? 'pause' : 'send';
    const minValue = Math.max(0, Math.round(Number(b.minValue)) || 0);
    const maxValue = Math.max(minValue, Math.round(Number(b.maxValue)) || minValue);
    await sql`
      INSERT INTO timing_sequence_pacing_blocks (id, workspace_id, sequence_id, position, block_type, min_value, max_value, label, message)
      VALUES (${crypto.randomUUID()}, ${workspaceId}, ${req.params.id}, ${i}, ${blockType}, ${minValue}, ${maxValue}, ${b.label || null}, ${b.message || null})
    `;
  }
  res.json({ ok: true });
}));

// ---------- MESSAGE SEQUENCES ----------
// Named, reusable presets bundling a single first-message block (text + a
// with/without-video flag) and a drag-and-drop-reorderable phase1/2/3
// follow-up step list, assignable per Instagram account
// (ig_accounts.message_sequence_id) — see Settings → Messaging sequences.
// Instagram-only, same as Timing sequences — LinkedIn keeps its own
// completely separate single-template + global follow-up system untouched.

app.get('/api/message-sequences', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [sequences, openerRows, followupRows, accountRows] = await Promise.all([
    sql`SELECT * FROM message_sequences WHERE workspace_id = ${workspaceId} AND archived_at IS NULL ORDER BY created_at ASC`,
    sql`SELECT * FROM message_sequence_openers WHERE workspace_id = ${workspaceId} ORDER BY sequence_id, position ASC`,
    sql`SELECT * FROM message_sequence_followups WHERE workspace_id = ${workspaceId} ORDER BY sequence_id, phase, step ASC`,
    sql`SELECT id, username, message_sequence_id FROM ig_accounts WHERE workspace_id = ${workspaceId} AND archived_at IS NULL AND message_sequence_id IS NOT NULL`
  ]);
  res.json({
    sequences: sequences.map(s => ({
      id: s.id,
      name: s.name,
      firstMessageHasVideo: s.first_message_has_video,
      // Up to 4 opening-line variants, randomly assigned per lead (see
      // app.js updateMessage()) for A/B testing — replaces the single fixed
      // first-message text this used to be. removed_at-filtered: a variant a
      // lead already received stays in the table forever (leads.opener_id is
      // a permanent record — see GET /api/analytics/openers) but shouldn't
      // keep showing up in the editor or get picked for new leads once
      // removed.
      openers: openerRows.filter(r => r.sequence_id === s.id && r.removed_at === null).map(r => ({ id: r.id, position: r.position, text: r.text })),
      followups: followupRows.filter(r => r.sequence_id === s.id).map(r => ({
        phase: r.phase, step: r.step, dayOffset: r.day_offset, type: r.type, message: r.message, mediaNote: r.media_note
      })),
      accountsUsing: accountRows.filter(a => a.message_sequence_id === s.id).map(a => ({ id: a.id, username: a.username }))
    }))
  });
}));

app.post('/api/message-sequences', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const id = crypto.randomUUID();
  if (req.body.duplicateFrom) {
    const [source] = await sql`SELECT first_message_has_video FROM message_sequences WHERE id = ${req.body.duplicateFrom} AND workspace_id = ${workspaceId}`;
    await sql`
      INSERT INTO message_sequences (id, workspace_id, name, first_message_has_video)
      VALUES (${id}, ${workspaceId}, ${name}, ${source ? source.first_message_has_video : false})
    `;
    const openers = await sql`SELECT position, text FROM message_sequence_openers WHERE sequence_id = ${req.body.duplicateFrom} AND workspace_id = ${workspaceId} AND removed_at IS NULL ORDER BY position`;
    for (const o of openers) {
      await sql`INSERT INTO message_sequence_openers (id, workspace_id, sequence_id, position, text) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id}, ${o.position}, ${o.text})`;
    }
    const followups = await sql`SELECT phase, step, day_offset, type, message, media_note FROM message_sequence_followups WHERE sequence_id = ${req.body.duplicateFrom} AND workspace_id = ${workspaceId} ORDER BY phase, step`;
    for (const f of followups) {
      await sql`
        INSERT INTO message_sequence_followups (id, workspace_id, sequence_id, phase, step, day_offset, type, message, media_note)
        VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id}, ${f.phase}, ${f.step}, ${f.day_offset}, ${f.type}, ${f.message}, ${f.media_note})
      `;
    }
  } else {
    await sql`INSERT INTO message_sequences (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${name})`;
    await sql`INSERT INTO message_sequence_openers (id, workspace_id, sequence_id, position, text) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id}, 0, '')`;
  }
  res.json({ ok: true, id });
}));

app.patch('/api/message-sequences/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const sets = []; const params = []; let i = 1;
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    sets.push(`name = $${i++}`); params.push(name);
  }
  if (req.body.firstMessageHasVideo !== undefined) { sets.push(`first_message_has_video = $${i++}`); params.push(!!req.body.firstMessageHasVideo); }
  if (sets.length === 0) return res.json({ ok: true });
  params.push(req.params.id);
  params.push(workspaceId);
  await sql.query(`UPDATE message_sequences SET ${sets.join(', ')} WHERE id = $${i} AND workspace_id = $${i + 1}`, params);
  res.json({ ok: true });
}));

// Bulk replace — up to 4 opening-line variants, edited/saved as one unit
// (add/remove/edit all go through this single endpoint, same reasoning as
// ramp-days/followup-steps/pacing-blocks elsewhere in this app). Matched by
// id (not array position) so an edit never misattributes one variant's
// wording onto another variant's id when a variant in the middle is removed.
// A kept variant is UPDATEd in place (same id — any lead already assigned it
// stays correctly attributed); a variant dropped from the list is hard-
// deleted if no lead was ever assigned it, or soft-removed (removed_at) if
// one was — a straight DELETE there would violate leads_opener_id_fkey.
app.put('/api/message-sequences/:id/openers', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const incoming = Array.isArray(req.body.openers) ? req.body.openers.slice(0, 4) : [];
  if (incoming.length === 0) return res.status(400).json({ error: 'At least one opener variant is required.' });
  const existing = await sql`SELECT id FROM message_sequence_openers WHERE sequence_id = ${req.params.id} AND workspace_id = ${workspaceId} AND removed_at IS NULL`;
  const existingIds = new Set(existing.map(r => r.id));
  const keptIds = new Set(incoming.map(o => o.id).filter(id => id && existingIds.has(id)));
  // Removed first, before any position is reassigned below — a kept row
  // moving into a removed row's old slot would otherwise collide with the
  // (sequence_id, position) unique constraint while the removed row still
  // physically holds it.
  for (const id of existingIds) {
    if (keptIds.has(id)) continue;
    const [inUse] = await sql`SELECT count(*)::int AS count FROM leads WHERE opener_id = ${id} AND workspace_id = ${workspaceId}`;
    if (inUse.count > 0) {
      await sql`UPDATE message_sequence_openers SET removed_at = now() WHERE id = ${id}`;
    } else {
      await sql`DELETE FROM message_sequence_openers WHERE id = ${id}`;
    }
  }
  for (let i = 0; i < incoming.length; i++) {
    const text = String(incoming[i].text || '');
    if (incoming[i].id && keptIds.has(incoming[i].id)) {
      await sql`UPDATE message_sequence_openers SET position = ${i}, text = ${text} WHERE id = ${incoming[i].id}`;
    } else {
      await sql`INSERT INTO message_sequence_openers (id, workspace_id, sequence_id, position, text) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${req.params.id}, ${i}, ${text})`;
    }
  }
  // Returned so the client can resync seq.openers with the real ids newly-
  // inserted variants got — without this, a variant added in one save has no
  // id to match on next save and would get inserted again as a duplicate.
  const result = await sql`SELECT id, position, text FROM message_sequence_openers WHERE sequence_id = ${req.params.id} AND workspace_id = ${workspaceId} AND removed_at IS NULL ORDER BY position ASC`;
  res.json({ ok: true, openers: result.map(r => ({ id: r.id, position: r.position, text: r.text })) });
}));

app.delete('/api/message-sequences/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [inUse] = await sql`SELECT count(*)::int AS count FROM ig_accounts WHERE message_sequence_id = ${req.params.id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
  if (inUse.count > 0) {
    return res.status(400).json({ error: `${inUse.count} account${inUse.count === 1 ? ' is' : 's are'} still using this sequence — reassign them first.` });
  }
  await sql`UPDATE message_sequences SET archived_at = now() WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  res.json({ ok: true });
}));

// Bulk replace, one phase at a time — the client edits each step as "+N days
// after the previous step in this phase" (same reasoning as Timing
// sequences' ramp days: one offset change cascades through the rest of that
// phase's steps), and phases are independent step lists so a save to one
// never touches the other two.
app.put('/api/message-sequences/:id/followups/:phase', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const phase = Number(req.params.phase);
  if (![1, 2, 3].includes(phase)) return res.status(400).json({ error: 'phase must be 1, 2, or 3' });
  const steps = Array.isArray(req.body.steps) ? req.body.steps : [];
  await sql`DELETE FROM message_sequence_followups WHERE sequence_id = ${req.params.id} AND workspace_id = ${workspaceId} AND phase = ${phase}`;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const dayOffset = Math.max(0, Math.round(Number(s.dayOffset)) || 0);
    const type = s.type || 'text';
    await sql`
      INSERT INTO message_sequence_followups (id, workspace_id, sequence_id, phase, step, day_offset, type, message, media_note)
      VALUES (${crypto.randomUUID()}, ${workspaceId}, ${req.params.id}, ${phase}, ${i + 1}, ${dayOffset}, ${type}, ${s.message || null}, ${s.mediaNote || null})
    `;
  }
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
  const workspaceId = await getWorkspaceId(req);
  const { sessionKind, sessionMode, sessionTarget, sentCount, results, remainingProfiles, isDailyGoal, igCooldownUntil, igCooldownAccountId } = req.body;
  const remaining = Array.isArray(remainingProfiles) ? remainingProfiles : [];
  if (remaining.length === 0) return res.status(400).json({ error: 'Nothing to save — no remaining profiles.' });
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO saved_sessions (id, workspace_id, session_kind, session_mode, session_target, sent_count, results, remaining_profiles, is_daily_goal, ig_cooldown_until, ig_cooldown_account_id)
    VALUES (${id}, ${workspaceId}, ${sessionKind || 'ig_message'}, ${sessionMode || 'fixed'}, ${sessionTarget ?? null}, ${sentCount || 0}, ${JSON.stringify(Array.isArray(results) ? results : [])}, ${JSON.stringify(remaining)}, ${!!isDailyGoal}, ${igCooldownUntil || null}, ${igCooldownAccountId || null})
  `;
  res.json({ ok: true, id });
}));

app.get('/api/saved-sessions', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const rows = await sql`SELECT * FROM saved_sessions WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC`;
  res.json({ sessions: rows.map(mapSavedSessionRow) });
}));

app.delete('/api/saved-sessions/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  await sql`DELETE FROM saved_sessions WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  res.json({ ok: true });
}));

// ---------- FOLLOW-UP SEQUENCING ----------

function firstName(fullName, username) {
  const base = (fullName || username || '').trim();
  return base.split(' ')[0] || username;
}

// Server-side twin of public/templates.js's resolveSpintax — same regex,
// same reasoning (a group needs a '|' so {naam}/{link} placeholders, which
// have none, are never mistaken for a one-option group; repeating the
// replace resolves nesting from the inside out; capped so a malformed input
// can't hang the request). Follow-up messages are composed here on the
// server (not client-side like the opener), so this can't just reuse the
// browser-loaded function — it needs its own copy.
function resolveSpintax(str) {
  let result = String(str || '');
  const groupPattern = /\{([^{}]*\|[^{}]*)\}/;
  let match;
  let guard = 0;
  while ((match = groupPattern.exec(result)) && guard < 100) {
    const options = match[1].split('|');
    const choice = options[Math.floor(Math.random() * options.length)];
    result = result.slice(0, match.index) + choice + result.slice(match.index + match[0].length);
    guard++;
  }
  return result;
}

function renderFollowupMessage(message, lead, calendarLink) {
  if (!message) return null;
  // Spintax resolves fresh on every call (same as the parts-recombination
  // wording variation below already does) — no per-lead locking needed here
  // the way the opener variant is, since follow-ups aren't A/B-tracked.
  return resolveSpintax(message)
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

async function getFollowupPartsByPhase(workspaceId, phase, platform) {
  const rows = await sql`
    SELECT step, part_order, text FROM followup_template_parts
    WHERE workspace_id = ${workspaceId} AND phase = ${phase} AND platform = ${platform} ORDER BY step, part_order, sort_order
  `;
  const byStep = {};
  rows.forEach(r => {
    if (!byStep[r.step]) byStep[r.step] = [];
    if (!byStep[r.step][r.part_order]) byStep[r.step][r.part_order] = [];
    byStep[r.step][r.part_order].push(r.text);
  });
  return byStep;
}

async function getCalendarLink(workspaceId) {
  const rows = await sql`SELECT value FROM app_settings WHERE workspace_id = ${workspaceId} AND key = 'calendar_link'`;
  return rows.length ? rows[0].value : '';
}

async function getLinkedinConnectionDelayDays(workspaceId) {
  const rows = await sql`SELECT value FROM app_settings WHERE workspace_id = ${workspaceId} AND key = 'linkedin_connection_delay_days'`;
  const n = rows.length ? Number(rows[0].value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

// The Amsterdam-local hour all follow-up/connection due-times normalize to
// (see due_at_normalized() in the DB) — so a full day's follow-ups are all
// visible together first thing, instead of trickling in at the exact hour
// of the original send throughout the day.
async function getFollowupDueHour(workspaceId) {
  const rows = await sql`SELECT value FROM app_settings WHERE workspace_id = ${workspaceId} AND key = 'followup_due_hour'`;
  const n = rows.length ? Number(rows[0].value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 4;
}

// Fallback for an Instagram lead/account with no Messaging sequence assigned
// (shouldn't normally happen — every account gets one at creation — but a
// lead predating the account system, or an account whose sequence was
// deleted out from under it, still needs somewhere to resolve to instead of
// silently vanishing from due-queries).
async function getDefaultMessageSequenceId(workspaceId) {
  const [row] = await sql`SELECT id FROM message_sequences WHERE workspace_id = ${workspaceId} AND name = 'Default' AND archived_at IS NULL`;
  return row ? row.id : null;
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
async function getNotificationDismissals(workspaceId) {
  const rows = await sql`SELECT group_key, dismissed_at FROM notification_dismissals WHERE workspace_id = ${workspaceId}`;
  const map = {};
  rows.forEach(r => { map[r.group_key] = r.dismissed_at; });
  return map;
}

app.get('/api/notifications', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [connectionDelayDays, dueHour, defaultMessageSeqId, dismissals, reminderRows] = await Promise.all([
    getLinkedinConnectionDelayDays(workspaceId),
    getFollowupDueHour(workspaceId),
    getDefaultMessageSequenceId(workspaceId),
    getNotificationDismissals(workspaceId),
    sql`
      SELECT r.id, r.text, r.due_at, r.lead_id, l.platform, l.username, l.full_name
      FROM reminders r
      LEFT JOIN leads l ON l.id = r.lead_id AND l.deleted_at IS NULL
      WHERE r.workspace_id = ${workspaceId} AND r.due_at <= now()
      ORDER BY r.due_at ASC
    `
  ]);

  // Instagram resolves its follow-up content through the lead's account's
  // assigned Messaging sequence; LinkedIn is untouched, still the one global
  // followup_templates set — two separate queries (a single join can't
  // switch which table it hits per row) concatenated below.
  const [followupRowsIg, followupRowsLi] = await Promise.all([
    sql`
      SELECT
        'instagram' AS platform,
        CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END AS phase,
        l.account_id,
        a.username AS account_username,
        due_at_normalized(l.phase_started_at, msf.day_offset, ${dueHour}) AS due_at
      FROM leads l
      LEFT JOIN ig_accounts a ON a.id = l.account_id
      JOIN message_sequence_followups msf
        ON msf.sequence_id = COALESCE(a.message_sequence_id, ${defaultMessageSeqId})
       AND msf.phase = CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END
       AND msf.step = l.phase_step + 1
      WHERE l.workspace_id = ${workspaceId} AND l.deleted_at IS NULL AND l.platform = 'instagram'
        AND l.stage IN ('phase1', 'phase2', 'phase3')
        AND due_at_normalized(l.phase_started_at, msf.day_offset, ${dueHour}) <= now()
    `,
    sql`
      SELECT
        'linkedin' AS platform,
        CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END AS phase,
        NULL::uuid AS account_id,
        NULL AS account_username,
        due_at_normalized(l.phase_started_at, ft.day_offset, ${dueHour}) AS due_at
      FROM leads l
      JOIN followup_templates ft
        ON ft.workspace_id = ${workspaceId}
       AND ft.platform = 'linkedin'
       AND ft.phase = CASE l.stage WHEN 'phase1' THEN 1 WHEN 'phase2' THEN 2 WHEN 'phase3' THEN 3 END
       AND ft.step = l.phase_step + 1
      WHERE l.workspace_id = ${workspaceId} AND l.deleted_at IS NULL AND l.platform = 'linkedin'
        AND l.stage IN ('phase1', 'phase2', 'phase3')
        AND due_at_normalized(l.phase_started_at, ft.day_offset, ${dueHour}) <= now()
    `
  ]);
  const followupRows = [...followupRowsIg, ...followupRowsLi];

  // Instagram follow-ups are grouped per-account too (so each account with
  // due follow-ups gets its own notification, showing which account and
  // letting the resulting session auto-select it) — LinkedIn has no account
  // system, so it stays grouped by (platform, phase) only.
  const byKey = {};
  followupRows.forEach(r => {
    const accountPart = r.platform === 'instagram' ? `:${r.account_id || 'none'}` : '';
    const key = `followup:${r.platform}:${r.phase}${accountPart}`;
    const dismissedAt = dismissals[key];
    if (dismissedAt && new Date(r.due_at) <= new Date(dismissedAt)) return;
    if (!byKey[key]) {
      byKey[key] = {
        type: 'followup', groupKey: key, platform: r.platform, phase: r.phase, count: 0, earliestDue: r.due_at,
        accountId: r.platform === 'instagram' ? r.account_id : undefined,
        accountUsername: r.platform === 'instagram' ? r.account_username : undefined
      };
    }
    byKey[key].count++;
    if (new Date(r.due_at) < new Date(byKey[key].earliestDue)) byKey[key].earliestDue = r.due_at;
  });

  const connectionRows = await sql`
    SELECT due_at_normalized(phase_started_at, ${connectionDelayDays}, ${dueHour}) AS due_at
    FROM leads
    WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND platform = 'linkedin' AND stage = 'engaged'
      AND due_at_normalized(phase_started_at, ${connectionDelayDays}, ${dueHour}) <= now()
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
    WHERE s.workspace_id = ${workspaceId} AND s.ig_cooldown_until IS NOT NULL
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

  // Daily warmup activity nudges (post + scroll/engage), one pair per
  // account still genuinely in its warmup window — created lazily here (the
  // first /api/notifications call of the day for that account) rather than
  // via a cron, same as everything else time-sensitive in this app.
  const warmingUpAccounts = await getWarmingUpAccounts(workspaceId);
  const today = todayStr();
  let warmupTaskNotifications = [];
  if (warmingUpAccounts.length > 0) {
    for (const a of warmingUpAccounts) {
      const engageTarget = Math.floor(Math.random() * 301) + 600; // 600-900s = 10-15 min
      await sql`
        INSERT INTO account_warmup_tasks (id, workspace_id, account_id, date, type) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${a.id}, ${today}, 'post')
        ON CONFLICT (account_id, date, type) DO NOTHING
      `;
      await sql`
        INSERT INTO account_warmup_tasks (id, workspace_id, account_id, date, type, target_seconds) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${a.id}, ${today}, 'engage', ${engageTarget})
        ON CONFLICT (account_id, date, type) DO NOTHING
      `;
    }
    const warmingUpIds = warmingUpAccounts.map(a => a.id);
    const taskRows = await sql`
      SELECT t.*, a.username AS account_username FROM account_warmup_tasks t
      JOIN ig_accounts a ON a.id = t.account_id
      WHERE t.workspace_id = ${workspaceId} AND t.date = ${today} AND t.completed_at IS NULL AND t.account_id = ANY(${warmingUpIds})
      ORDER BY t.created_at ASC
    `;
    warmupTaskNotifications = taskRows.map(r => {
      const mapped = mapWarmupTaskRow(r);
      return {
        type: r.type === 'post' ? 'warmup_post' : 'warmup_engage',
        groupKey: `warmup_${r.type}:${r.account_id}:${today}`,
        taskId: r.id,
        accountId: r.account_id,
        accountUsername: r.account_username,
        earliestDue: r.created_at,
        targetSeconds: mapped.targetSeconds,
        elapsedSeconds: mapped.elapsedSeconds,
        running: mapped.running
      };
    });
  }

  // No follow-up/connection/cooldown-ready nudges on Sundays — outreach
  // doesn't happen that day (see the streak's own Sunday-skip above), so
  // there's nothing to act on until Monday, when anything that became due
  // over the weekend shows up as normal. Reminders and warmup tasks are
  // exempt — reminders because you may have deliberately scheduled one for a
  // Sunday, warmup tasks because building the account is the one thing that
  // *should* still happen every day.
  const sundaySafeGrouped = isSundayAmsterdam() ? [] : grouped;
  const sundaySafeCooldownReady = isSundayAmsterdam() ? [] : cooldownReadyNotifications;
  res.json({ notifications: [...sundaySafeGrouped, ...reminders, ...sundaySafeCooldownReady, ...warmupTaskNotifications], igCooldown });
}));

app.post('/api/notifications/dismiss', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const { groupKey } = req.body;
  if (!groupKey) return res.status(400).json({ error: 'groupKey is required' });
  await sql`
    INSERT INTO notification_dismissals (workspace_id, group_key, dismissed_at) VALUES (${workspaceId}, ${groupKey}, now())
    ON CONFLICT (workspace_id, group_key) DO UPDATE SET dismissed_at = now()
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
  const workspaceId = await getWorkspaceId(req);
  const rows = await sql`
    SELECT r.id, r.text, r.due_at, r.lead_id, r.created_at, l.platform, l.username, l.full_name
    FROM reminders r
    LEFT JOIN leads l ON l.id = r.lead_id AND l.deleted_at IS NULL
    WHERE r.workspace_id = ${workspaceId}
    ORDER BY r.due_at ASC
  `;
  res.json({ reminders: rows.map(mapReminderRow) });
}));

app.post('/api/reminders', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const text = String(req.body.text || '').trim();
  const dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
  if (!text) return res.status(400).json({ error: 'A reminder needs some text.' });
  if (!dueAt || Number.isNaN(dueAt.getTime())) return res.status(400).json({ error: 'A valid due date/time is required.' });
  const leadId = req.body.leadId || null;
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO reminders (id, workspace_id, text, due_at, lead_id) VALUES (${id}, ${workspaceId}, ${text}, ${dueAt.toISOString()}, ${leadId})
  `;
  res.json({ ok: true, id });
}));

app.delete('/api/reminders/:id', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  await sql`DELETE FROM reminders WHERE id = ${req.params.id} AND workspace_id = ${workspaceId}`;
  res.json({ ok: true });
}));

// The due leads for one platform+phase, each with its exact next message pre-rendered.
app.get('/api/followups/due', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const phase = Number(req.query.phase);
  const platform = req.query.platform === 'linkedin' ? 'linkedin' : 'instagram';
  const accountId = platform === 'instagram' && req.query.accountId ? req.query.accountId : null;
  if (![1, 2, 3].includes(phase)) return res.status(400).json({ error: 'phase must be 1, 2, or 3' });
  const stageVal = 'phase' + phase;
  const calendarLink = await getCalendarLink(workspaceId);

  let rows;
  if (platform === 'instagram') {
    const [dueHour, defaultSeqId] = await Promise.all([getFollowupDueHour(workspaceId), getDefaultMessageSequenceId(workspaceId)]);
    rows = await sql`
      SELECT l.id, l.username, l.profile_url, l.full_name, l.account_id, a.username AS account_username,
             msf.step, msf.type, msf.message, msf.media_note,
             due_at_normalized(l.phase_started_at, msf.day_offset, ${dueHour}) AS due_at
      FROM leads l
      LEFT JOIN ig_accounts a ON a.id = l.account_id
      JOIN message_sequence_followups msf
        ON msf.sequence_id = COALESCE(a.message_sequence_id, ${defaultSeqId})
       AND msf.phase = ${phase} AND msf.step = l.phase_step + 1
      WHERE l.workspace_id = ${workspaceId} AND l.deleted_at IS NULL
        AND l.platform = 'instagram'
        AND l.stage = ${stageVal}
        AND due_at_normalized(l.phase_started_at, msf.day_offset, ${dueHour}) <= now()
        AND (${accountId}::uuid IS NULL OR l.account_id = ${accountId}::uuid)
      ORDER BY due_at ASC
    `;
  } else {
    // LinkedIn — untouched, still the one global followup_templates set with
    // its own wording-variation parts system (composeFollowupMessage/
    // getFollowupPartsByPhase), no account/sequence concept to resolve.
    const [partsByStep, dueHour] = await Promise.all([getFollowupPartsByPhase(workspaceId, phase, platform), getFollowupDueHour(workspaceId)]);
    const liRows = await sql`
      SELECT l.id, l.username, l.profile_url, l.full_name,
             ft.step, ft.type, ft.message, ft.media_note,
             due_at_normalized(l.phase_started_at, ft.day_offset, ${dueHour}) AS due_at
      FROM leads l
      JOIN followup_templates ft ON ft.workspace_id = ${workspaceId} AND ft.platform = 'linkedin' AND ft.phase = ${phase} AND ft.step = l.phase_step + 1
      WHERE l.workspace_id = ${workspaceId} AND l.deleted_at IS NULL
        AND l.platform = 'linkedin'
        AND l.stage = ${stageVal}
        AND due_at_normalized(l.phase_started_at, ft.day_offset, ${dueHour}) <= now()
      ORDER BY due_at ASC
    `;
    const leads = liRows.map(r => ({
      id: r.id, platform, username: r.username, profileUrl: r.profile_url, fullName: r.full_name,
      accountId: null, accountUsername: null, phase, step: r.step, type: r.type, mediaNote: r.media_note,
      message: composeFollowupMessage(partsByStep[r.step], r.message, r, calendarLink)
    }));
    return res.json({ leads });
  }

  const leads = rows.map(r => ({
    id: r.id,
    platform,
    username: r.username,
    profileUrl: r.profile_url,
    fullName: r.full_name,
    accountId: r.account_id,
    accountUsername: r.account_username,
    phase,
    step: r.step,
    type: r.type,
    mediaNote: r.media_note,
    // No wording-variation system for the new sequence model — one message
    // per step, composeFollowupMessage's no-componentGroups fallback path.
    message: composeFollowupMessage(null, r.message, r, calendarLink)
  }));
  res.json({ leads });
}));

// The LinkedIn leads whose connection-request delay has elapsed since being
// marked "Engaged" — no message to compose, this just drives the simple
// swipeable "Connected / Delete" session (see public/app.js).
app.get('/api/linkedin/connections/due', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const [connectionDelayDays, dueHour] = await Promise.all([getLinkedinConnectionDelayDays(workspaceId), getFollowupDueHour(workspaceId)]);
  const rows = await sql`
    SELECT id, full_name, profile_url, headline
    FROM leads
    WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND platform = 'linkedin' AND stage = 'engaged'
      AND due_at_normalized(phase_started_at, ${connectionDelayDays}, ${dueHour}) <= now()
    ORDER BY phase_started_at ASC
  `;
  res.json({ leads: rows.map(r => ({ id: r.id, fullName: r.full_name, profileUrl: r.profile_url, headline: r.headline })) });
}));

// Logs the send (for analytics) and advances the lead to that step.
app.post('/api/leads/:id/followup-sent', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const { id } = req.params;
  const phase = Number(req.body.phase);
  const step = Number(req.body.step);
  if (![1, 2, 3].includes(phase) || !step) {
    return res.status(400).json({ error: 'phase and step are required' });
  }
  const [lead] = await sql`SELECT username, profile_url, account_id FROM leads WHERE id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  await sql`
    INSERT INTO followup_sends (id, workspace_id, lead_id, username, profile_url, phase, step, message, date, account_id)
    VALUES (${crypto.randomUUID()}, ${workspaceId}, ${id}, ${lead.username}, ${lead.profile_url}, ${phase}, ${step}, ${req.body.message || ''}, ${todayStr()}, ${lead.account_id})
  `;
  await sql`UPDATE leads SET phase_step = ${step}, updated_at = now() WHERE id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;

  // Phase-1 follow-ups are sent from the same account as the original cold
  // message and count just as much toward its daily cap — surfaced here as a
  // plain warning (not blocked) since the real prevention already happened
  // up front via effectiveRemainingForNewSends when the session was started.
  let accountTodaySentCount = null, accountDailyLimit = null;
  if (phase === 1 && lead.account_id) {
    const today = todayStr();
    const [account] = await sql`SELECT daily_limit FROM ig_accounts WHERE id = ${lead.account_id} AND workspace_id = ${workspaceId}`;
    if (account) {
      const [{ count: outreachCount }] = await sql`SELECT count(*)::int AS count FROM outreaches WHERE account_id = ${lead.account_id} AND workspace_id = ${workspaceId} AND status = 'sent' AND date = ${today}`;
      const [{ count: followupCount }] = await sql`SELECT count(*)::int AS count FROM followup_sends WHERE account_id = ${lead.account_id} AND workspace_id = ${workspaceId} AND phase = 1 AND date = ${today}`;
      accountTodaySentCount = outreachCount + followupCount;
      accountDailyLimit = account.daily_limit;
    }
  }
  res.json({ ok: true, accountId: lead.account_id, accountTodaySentCount, accountDailyLimit });
}));

// ---------- SETTINGS ----------

// Instagram's initial-message category system (message_templates/
// message_template_parts, 6 stats-suggested categories x 4 recombinable
// slots) is retired — replaced by the one-message-per-Messaging-sequence
// first-message block, so the Settings card that edited category labels and
// its PUT endpoint are gone. The GET below stays: LinkedIn stores its own
// single fixed template in this same table (no suggestion, always been just
// one row) and still needs it, loaded via loadTemplatesFromServer('linkedin')
// — nothing about LinkedIn's template system is changing here.
app.get('/api/settings/templates', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const platform = req.query.platform === 'linkedin' ? 'linkedin' : 'instagram';
  const templates = await sql`SELECT id, label FROM message_templates WHERE workspace_id = ${workspaceId} AND platform = ${platform} ORDER BY sort_order`;
  const parts = await sql`SELECT id, template_id, slot, text FROM message_template_parts WHERE workspace_id = ${workspaceId} ORDER BY template_id, slot, sort_order`;
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

// Instagram's follow-up sequence now lives per Messaging sequence (see
// /api/message-sequences) — these two endpoints are LinkedIn-only going
// forward, its own global followup_templates set unchanged.
app.get('/api/settings/followups', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const platform = 'linkedin';
  const rows = await sql`SELECT phase, step, day_offset, type, message, media_note FROM followup_templates WHERE workspace_id = ${workspaceId} AND platform = ${platform} ORDER BY phase, step`;
  res.json({
    followups: rows.map(r => ({
      phase: r.phase, step: r.step, dayOffset: r.day_offset,
      type: r.type, message: r.message, mediaNote: r.media_note
    }))
  });
}));

app.put('/api/settings/followups/:phase/:step', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const phase = Number(req.params.phase);
  const step = Number(req.params.step);
  const platform = 'linkedin';
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
  params.push(workspaceId, platform, phase, step);
  await sql.query(`UPDATE followup_templates SET ${sets.join(', ')} WHERE workspace_id = $${i++} AND platform = $${i++} AND phase = $${i++} AND step = $${i}`, params);
  res.json({ ok: true });
}));

app.get('/api/settings/app', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const rows = await sql`SELECT key, value FROM app_settings WHERE workspace_id = ${workspaceId}`;
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ settings });
}));

app.put('/api/settings/app', asyncRoute(async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  const { calendarLink, viewsThreshold, linkedinConnectionDelayDays, followupDueHour, dailyGoalInstagram, dailyGoalInstagramSync, dailyGoalLinkedin } = req.body;
  if (calendarLink !== undefined) {
    await sql`
      INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'calendar_link', ${calendarLink})
      ON CONFLICT (workspace_id, key) DO UPDATE SET value =${calendarLink}
    `;
  }
  if (viewsThreshold !== undefined) {
    await sql`
      INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'views_threshold', ${String(viewsThreshold)})
      ON CONFLICT (workspace_id, key) DO UPDATE SET value =${String(viewsThreshold)}
    `;
  }
  if (linkedinConnectionDelayDays !== undefined) {
    const clamped = Math.max(0, Math.round(Number(linkedinConnectionDelayDays)) || 0);
    await sql`
      INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'linkedin_connection_delay_days', ${String(clamped)})
      ON CONFLICT (workspace_id, key) DO UPDATE SET value =${String(clamped)}
    `;
  }
  if (followupDueHour !== undefined) {
    const clamped = Math.min(23, Math.max(0, Math.round(Number(followupDueHour)) || 0));
    await sql`
      INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'followup_due_hour', ${String(clamped)})
      ON CONFLICT (workspace_id, key) DO UPDATE SET value =${String(clamped)}
    `;
  }
  if (dailyGoalInstagram !== undefined) {
    const clamped = Math.max(0, Math.round(Number(dailyGoalInstagram)) || 0);
    await sql`
      INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'daily_goal_instagram', ${String(clamped)})
      ON CONFLICT (workspace_id, key) DO UPDATE SET value =${String(clamped)}
    `;
  }
  if (dailyGoalInstagramSync !== undefined) {
    const value = dailyGoalInstagramSync ? 'true' : 'false';
    await sql`
      INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'daily_goal_instagram_sync', ${value})
      ON CONFLICT (workspace_id, key) DO UPDATE SET value =${value}
    `;
  }
  if (dailyGoalLinkedin !== undefined) {
    const clamped = Math.max(0, Math.round(Number(dailyGoalLinkedin)) || 0);
    await sql`
      INSERT INTO app_settings (workspace_id, key, value) VALUES (${workspaceId}, 'daily_goal_linkedin', ${String(clamped)})
      ON CONFLICT (workspace_id, key) DO UPDATE SET value =${String(clamped)}
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
