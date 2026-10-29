// Background sync: Hostify -> D1.
// Runs from the Worker's cron trigger. Each run does a small, fixed number of
// Hostify pages (to stay well inside Cloudflare's per-invocation subrequest
// and CPU limits) and saves a cursor, so the next run carries on where this
// one stopped. No one ever has to "refresh" by hand.

import {
  hostifyPage, mapListing, mapReservation, mapReview, mapTransaction, Row,
} from "./hostify";
import { ensureSchema } from "./schema";
import { mapThread, messagesStatus, shapeOf, syncThreadMessages } from "./inbox";

export interface SyncEnv {
  HOSTIFY_API_KEY: string;
  DB: D1Database;
  SYNC_PAGES_PER_RUN?: string;
  SYNC_DAILY_WRITE_SOFT_CAP?: string;
  SYNC_DAILY_WRITE_HARD_CAP?: string;
  SYNC_HISTORY_DAYS?: string;
  INBOX_THREADS_PER_RUN?: string;
  INBOX_HISTORY_DAYS?: string;
}

type Mapper = (item: Row) => Record<string, unknown> | null;

interface JobDef {
  name: string;
  label: string;
  path: string;
  keys: string[];
  perPage: number;
  table: string;
  map: Mapper;
  restMinutes: number; // pause between completed passes
  maxPages?: number; // stop a pass early (for "newest first" feeds)
  window?: (today: Date) => { from: string; to: string };
  params: (from: string | null, to: string | null) => Row;
}

const PER_PAGE = 50;

// How far back bookings and reviews are kept, in days (wrangler var
// SYNC_HISTORY_DAYS, set per isolate from the env on each run).
let HISTORY_DAYS = 60;

function shift(today: Date, days: number): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Order matters: earlier jobs get the first page of every run.
export const JOBS: JobDef[] = [
  {
    name: "listings",
    label: "Properties",
    path: "/listings",
    keys: ["listings"],
    perPage: PER_PAGE,
    table: "h_listings",
    map: mapListing as Mapper,
    restMinutes: 360,
    params: () => ({ include_related_objects: 0 }),
  },
  {
    // Recent and upcoming stays: kept fresh continuously.
    name: "reservations_hot",
    label: "Bookings (last week to 2 months ahead)",
    path: "/reservations",
    keys: ["reservations"],
    perPage: PER_PAGE,
    table: "h_reservations",
    map: mapReservation as Mapper,
    restMinutes: 2,
    window: (t) => ({ from: shift(t, -7), to: shift(t, 60) }),
    params: (from, to) => ({ start_date: from, end_date: to, sort: "checkIn", fees: 1 }),
  },
  {
    name: "reviews",
    label: "Reviews (history window)",
    path: "/reviews",
    keys: ["reviews"],
    perPage: PER_PAGE,
    table: "h_reviews",
    map: mapReview as Mapper,
    restMinutes: 180,
    window: (t) => ({ from: shift(t, -HISTORY_DAYS), to: shift(t, 1) }),
    params: (from, to) => ({ created_from: from, created_to: to }),
  },
  {
    // Full history and far future: a slower, daily sweep.
    name: "reservations_full",
    label: "Bookings (history window to 6 months ahead)",
    path: "/reservations",
    keys: ["reservations"],
    perPage: PER_PAGE,
    table: "h_reservations",
    map: mapReservation as Mapper,
    restMinutes: 720,
    window: (t) => ({ from: shift(t, -HISTORY_DAYS), to: shift(t, 180) }),
    params: (from, to) => ({ start_date: from, end_date: to, sort: "checkIn", fees: 1 }),
  },
  {
    // Guest inbox: every conversation thread ever (daily full sweep). The
    // messages inside each thread are read by syncThreadMessages.
    name: "inbox_threads",
    label: "Guest conversations (all, for message history)",
    path: "/inbox",
    keys: ["threads"],
    perPage: 100,
    table: "h_threads",
    map: mapThread as Mapper,
    restMinutes: 1440,
    params: () => ({}),
  },
  {
    // Newest conversations, so new guest messages arrive within minutes.
    name: "inbox_recent",
    label: "Guest conversations (latest activity)",
    path: "/inbox",
    keys: ["threads"],
    perPage: 100,
    table: "h_threads",
    map: mapThread as Mapper,
    restMinutes: 5,
    maxPages: 2,
    params: () => ({}),
  },
  // Transactions are paused: Hostify's /transactions endpoint has no date
  // filter, so loading them means all ~90,000 rows.
];

interface JobState {
  job: string;
  next_page: number;
  window_from: string | null;
  window_to: string | null;
  pass_started_at: string | null;
  last_page_at: string | null;
  last_pass_completed_at: string | null;
  rows_this_pass: number;
  total_expected: number | null;
  restart_after: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

function upsert(db: D1Database, table: string, row: Record<string, unknown>, now: string): D1PreparedStatement {
  const columns = [...Object.keys(row), "synced_at"];
  const values = [...Object.values(row), now];
  const updates = columns.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`).join(",");
  // Only rewrite a row when something in it changed; unchanged rows cost no writes.
  const same = Object.keys(row).filter((c) => c !== "id").map((c) => `${table}.${c} IS excluded.${c}`).join(" AND ");
  return db
    .prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${updates} WHERE NOT (${same})`)
    .bind(...values.map((v) => (v === undefined ? null : v)));
}

function saveState(db: D1Database, s: JobState): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO h_sync_jobs (job,next_page,window_from,window_to,pass_started_at,last_page_at,last_pass_completed_at,rows_this_pass,total_expected,restart_after,last_error,last_error_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(job) DO UPDATE SET next_page=excluded.next_page,window_from=excluded.window_from,window_to=excluded.window_to,
       pass_started_at=excluded.pass_started_at,last_page_at=excluded.last_page_at,last_pass_completed_at=excluded.last_pass_completed_at,
       rows_this_pass=excluded.rows_this_pass,total_expected=excluded.total_expected,restart_after=excluded.restart_after,
       last_error=excluded.last_error,last_error_at=excluded.last_error_at`,
  ).bind(
    s.job, s.next_page, s.window_from, s.window_to, s.pass_started_at, s.last_page_at, s.last_pass_completed_at,
    s.rows_this_pass, s.total_expected, s.restart_after, s.last_error, s.last_error_at,
  );
}

function isDue(state: JobState | undefined, now: Date): boolean {
  if (!state) return true;
  if (!state.restart_after) return true;
  return Date.parse(state.restart_after) <= now.getTime();
}

function addMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60000).toISOString();
}

async function runOnePage(env: SyncEnv, def: JobDef, prior: JobState | undefined, now: Date, writes: { count: number }): Promise<JobState> {
  const nowIso = now.toISOString();
  const state: JobState = prior ? { ...prior } : {
    job: def.name, next_page: 1, window_from: null, window_to: null, pass_started_at: null, last_page_at: null,
    last_pass_completed_at: null, rows_this_pass: 0, total_expected: null, restart_after: null, last_error: null, last_error_at: null,
  };

  // Starting a new pass: fix the date window for the whole pass so pages stay stable.
  // A pass in progress keeps its window so pages stay stable, unless the job's
  // window setting has changed (e.g. a new history length): then start over.
  if (state.next_page > 1 && def.window && state.window_from && state.window_to) {
    const w = def.window(now);
    const drift = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
    if (drift(w.from, state.window_from) > 7 || drift(w.to, state.window_to) > 7) state.next_page = 1;
  }
  if (state.next_page <= 1) {
    const w = def.window ? def.window(now) : null;
    state.next_page = 1;
    state.window_from = w?.from ?? null;
    state.window_to = w?.to ?? null;
    state.pass_started_at = nowIso;
    state.rows_this_pass = 0;
    state.total_expected = null;
  }

  try {
    const page = await hostifyPage(
      env.HOSTIFY_API_KEY, def.path, def.params(state.window_from, state.window_to), def.keys, state.next_page, def.perPage,
    );
    const rows = page.items.map(def.map).filter((r): r is Record<string, unknown> => r !== null);
    if (def.table === "h_threads" && page.items[0]) {
      await env.DB.prepare("INSERT OR REPLACE INTO h_inbox_shape (what, shape, seen_at) VALUES ('thread_list_item',?,?)")
        .bind(shapeOf(page.items[0]), nowIso).run().catch(() => undefined);
    }
    const statements = rows.map((r) => upsert(env.DB, def.table, r, nowIso));
    state.rows_this_pass += rows.length;
    state.total_expected = page.total;
    state.last_page_at = nowIso;
    state.last_error = null;
    if (page.hasMore && page.items.length > 0 && !(def.maxPages && state.next_page >= def.maxPages)) {
      state.next_page += 1;
      state.restart_after = null;
    } else {
      state.next_page = 1;
      state.last_pass_completed_at = nowIso;
      state.restart_after = addMinutes(now, def.restMinutes);
    }
    const results = (await env.DB.batch([...statements, saveState(env.DB, state)])) as { meta?: { rows_written?: number } }[];
    writes.count += (results ?? []).reduce((sum, r) => sum + Number(r?.meta?.rows_written ?? 0), 0);
  } catch (error) {
    // Keep the cursor so the pass resumes; back off for a few minutes.
    state.last_error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    state.last_error_at = nowIso;
    state.restart_after = addMinutes(now, 10);
    await saveState(env.DB, state).run();
  }
  return state;
}

export interface SyncReport {
  pages: number;
  writes_used_today?: number;
  writes_this_run?: number;
  skipped?: string;
  jobs: Record<string, { pages: number; rows_this_pass: number; total_expected: number | null; complete: boolean; error: string | null }>;
}

// Each run spends a fixed page budget. Priority jobs (properties and
// upcoming stays) get the first 60% so they stay fresh; the large history,
// reviews and transactions backfills share whatever is left.
const PRIORITY_JOBS = new Set(["listings", "reservations_hot", "inbox_recent"]);

export async function runSync(env: SyncEnv, pageBudget?: number): Promise<SyncReport> {
  await ensureSchema(env.DB);
  HISTORY_DAYS = Math.max(14, Math.min(730, Number(env.SYNC_HISTORY_DAYS) || 60));
  const now = new Date();
  // Runs start every minute; a slow run must not overlap the next one.
  const lock = (await env.DB.prepare(
    `INSERT INTO h_sync_jobs (job, restart_after) VALUES ('_lock', ?) ON CONFLICT(job) DO UPDATE SET restart_after = excluded.restart_after
     WHERE h_sync_jobs.restart_after IS NULL OR h_sync_jobs.restart_after < ?`,
  ).bind(addMinutes(now, 2), now.toISOString()).run()) as { meta?: { changes?: number } };
  if (lock?.meta && lock.meta.changes === 0) return { pages: 0, jobs: {}, skipped: "previous run still in progress" };
  try {
    return await syncLocked(env, pageBudget, now);
  } finally {
    await env.DB.prepare("UPDATE h_sync_jobs SET restart_after = NULL WHERE job = '_lock'").run();
  }
}

async function syncLocked(env: SyncEnv, pageBudget: number | undefined, now: Date): Promise<SyncReport> {
  const budget = Math.max(1, Math.min(40, pageBudget ?? (Number(env.SYNC_PAGES_PER_RUN) || 8)));
  const existing = await env.DB.prepare("SELECT * FROM h_sync_jobs WHERE job <> '_lock'").all<JobState>();
  const states = new Map<string, JobState>(existing.results.map((s) => [s.job, s]));
  const report: SyncReport = { pages: 0, jobs: {} };

  const step = async (def: JobDef) => {
    const state = await runOnePage(env, def, states.get(def.name), now, writes);
    states.set(def.name, state);
    report.pages += 1;
    const entry = report.jobs[def.name] ?? { pages: 0, rows_this_pass: 0, total_expected: null, complete: false, error: null };
    entry.pages += 1;
    entry.rows_this_pass = state.rows_this_pass;
    entry.total_expected = state.total_expected;
    entry.complete = state.next_page === 1 && state.last_pass_completed_at === state.last_page_at;
    entry.error = state.last_error;
    report.jobs[def.name] = entry;
  };

  const spend = async (jobs: JobDef[], limit: number) => {
    while (report.pages < limit) {
      const due = jobs.filter((def) => isDue(states.get(def.name), now));
      if (!due.length) return;
      for (const def of due) {
        if (report.pages >= limit) return;
        await step(def);
      }
    }
  };

  // Daily write budget: the free D1 plan errors for the whole account above
  // 100,000 rows written per UTC day. Backfill stops at the soft cap; keeping
  // upcoming bookings fresh (cheap once loaded) stops at the hard cap.
  const day = now.toISOString().slice(0, 10);
  const used = Number((await env.DB.prepare("SELECT rows_written FROM h_daily_writes WHERE day=?").bind(day).first<{ rows_written: number }>())?.rows_written ?? 0);
  const soft = Number(env.SYNC_DAILY_WRITE_SOFT_CAP) || 50000;
  const hard = Number(env.SYNC_DAILY_WRITE_HARD_CAP) || 80000;
  const writes = { count: 0 };
  report.writes_used_today = used;
  if (used >= hard) { report.skipped = "daily write cap reached"; return report; }

  await spend(JOBS.filter((d) => PRIORITY_JOBS.has(d.name)), Math.ceil(budget * 0.6));
  if (used + writes.count < soft) {
    await spend([...JOBS.filter((d) => !PRIORITY_JOBS.has(d.name)), ...JOBS.filter((d) => PRIORITY_JOBS.has(d.name))], budget);
  }
  if (used + writes.count < soft) writes.count += await maintain(env.DB, now);
  if (writes.count > 0) {
    await env.DB.prepare(
      "INSERT INTO h_daily_writes (day, rows_written) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET rows_written = rows_written + excluded.rows_written",
    ).bind(day, writes.count + 1).run();
  }
  report.writes_this_run = writes.count;
  return report;
}

// Retention: drop cached bookings and reviews older than the history window
// (Hostify keeps the originals), a chunk per run so deletes stay inside the
// daily write budget. Once the old rows are gone, add the lookup indexes —
// building them on a small table costs few writes.
async function maintain(db: D1Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - (HISTORY_DAYS + 30) * 86400000).toISOString().slice(0, 10);
  const results = (await db.batch([
    db.prepare(
      `DELETE FROM h_reservations WHERE id IN (SELECT id FROM h_reservations WHERE check_in < ? AND check_out < ? LIMIT 800)`,
    ).bind(cutoff, cutoff),
    db.prepare(`DELETE FROM h_reviews WHERE id IN (SELECT id FROM h_reviews WHERE review_date < ? LIMIT 400)`).bind(cutoff),
  ])) as { meta?: { rows_written?: number; changes?: number } }[];
  let written = (results ?? []).reduce((sum, r) => sum + Number(r?.meta?.rows_written ?? 0), 0);
  const deleted = (results ?? []).reduce((sum, r) => sum + Number(r?.meta?.changes ?? 0), 0);
  if (deleted === 0) {
    const built = (await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS h_res_code_nc ON h_reservations(confirmation_code COLLATE NOCASE)"),
      db.prepare("CREATE INDEX IF NOT EXISTS h_res_guest_nc ON h_reservations(guest_name COLLATE NOCASE)"),
    ])) as { meta?: { rows_written?: number } }[];
    written += (built ?? []).reduce((sum, r) => sum + Number(r?.meta?.rows_written ?? 0), 0);
  }
  return written;
}

function ageMinutes(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((now - t) / 60000) : null;
}

// Plain-English status of every job, for the cache_status tool.
export async function syncStatus(db: D1Database): Promise<Row[]> {
  await ensureSchema(db);
  const rows = await db.prepare("SELECT * FROM h_sync_jobs").all<JobState>();
  const states = new Map(rows.results.map((s) => [s.job, s]));
  const now = Date.now();
  const inbox = await messagesStatus(db).catch((e) => ({ job: "inbox_messages", last_error: String(e) }));
  return [...JOBS.map((def) => {
    const s = states.get(def.name);
    const inProgress = !!s && s.next_page > 1;
    return {
      dataset: def.label,
      job: def.name,
      state: !s ? "not started" : s.last_error ? "retrying after error" : inProgress ? "updating" : "up to date",
      last_full_update_minutes_ago: ageMinutes(s?.last_pass_completed_at ?? null, now),
      current_pass_progress: inProgress && s ? `${s.rows_this_pass}${s.total_expected ? ` of ~${s.total_expected}` : ""} records` : null,
      window: s?.window_from ? `${s.window_from} to ${s.window_to}` : null,
      last_error: s?.last_error ?? null,
    };
  }), inbox];
}

// Compact freshness stamp attached to every cached answer.
export async function freshness(db: D1Database, jobs: string[]): Promise<Record<string, string>> {
  const rows = await db.prepare(
    `SELECT job,last_pass_completed_at,next_page,last_error FROM h_sync_jobs WHERE job IN (${jobs.map(() => "?").join(",")})`,
  ).bind(...jobs).all<Pick<JobState, "job" | "last_pass_completed_at" | "next_page" | "last_error">>();
  const now = Date.now();
  const out: Record<string, string> = {};
  for (const job of jobs) {
    const s = rows.results.find((r) => r.job === job);
    const age = ageMinutes(s?.last_pass_completed_at ?? null, now);
    out[job] = !s ? "never synced — data may be missing"
      : age === null ? "first sync in progress — data may be incomplete"
      : `updated ${age < 60 ? `${age} min` : `${Math.round(age / 60)} h`} ago${s.next_page > 1 ? " (refresh in progress)" : ""}${s.last_error ? " (last attempt errored)" : ""}`;
  }
  return out;
}

// Guest messages: own cron and own lock, so reading conversations never waits
// behind the booking sync. Stops early if Hostify pushes back.
export async function runInboxMessages(env: SyncEnv): Promise<Row> {
  await ensureSchema(env.DB);
  const now = new Date();
  const lock = (await env.DB.prepare(
    `INSERT INTO h_sync_jobs (job, restart_after) VALUES ('_lock_inbox', ?) ON CONFLICT(job) DO UPDATE SET restart_after = excluded.restart_after
     WHERE h_sync_jobs.restart_after IS NULL OR h_sync_jobs.restart_after < ?`,
  ).bind(addMinutes(now, 3), now.toISOString()).run()) as { meta?: { changes?: number } };
  if (lock?.meta && lock.meta.changes === 0) return { skipped: "previous inbox run still in progress" };
  try {
    const day = now.toISOString().slice(0, 10);
    const used = Number((await env.DB.prepare("SELECT rows_written FROM h_daily_writes WHERE day=?").bind(day).first<{ rows_written: number }>())?.rows_written ?? 0);
    const soft = Number(env.SYNC_DAILY_WRITE_SOFT_CAP) || 50000;
    if (used >= soft) return { skipped: "daily write cap reached" };
    const perRun = Math.max(5, Math.min(150, Number(env.INBOX_THREADS_PER_RUN) || 100));
    const days = Math.max(30, Math.min(3650, Number(env.INBOX_HISTORY_DAYS) || 365));
    const m = await syncThreadMessages(env, perRun, now, days);
    if (m.writes > 0) {
      await env.DB.prepare(
        "INSERT INTO h_daily_writes (day, rows_written) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET rows_written = rows_written + excluded.rows_written",
      ).bind(day, m.writes).run();
    }
    return m as unknown as Row;
  } finally {
    await env.DB.prepare("UPDATE h_sync_jobs SET restart_after = NULL WHERE job = '_lock_inbox'").run();
  }
}
