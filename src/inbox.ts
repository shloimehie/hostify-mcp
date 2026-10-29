// Guest inbox history: Hostify /inbox -> D1.
//
// Two background steps, run from the same cron as the booking sync:
//   1. inbox_threads  – pages through GET /inbox and stores one row per
//                        conversation thread (h_threads), incl. its booking
//                        and listing ids. This is also how a booking's
//                        thread is found later (no more guessing).
//   2. inbox_messages – opens each thread that is new or has changed since
//                        it was last read (GET /inbox/{id}) and stores its
//                        messages (h_messages).
//
// The first pass is a full backfill of all past conversations; afterwards
// only changed threads are re-read. Message text is stored with guest
// emails/phone numbers and access details (door codes, PINs, WiFi
// passwords) cut out, like everything else in this cache. Automatic
// template messages are skipped: they repeat on every booking and the
// templates themselves live in Hostify.

import { extractItems, hostifyGet, num, Row, str } from "./hostify";
import { redactAccess, redactContacts } from "./writes";

export interface InboxEnv {
  HOSTIFY_API_KEY: string;
  DB: D1Database;
}

const MAX_TEXT = 4000;

function pick(row: Row, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function nested(row: Row, key: string): Row {
  const v = row[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

// When the thread last changed. Hostify's list sends it as "last_message".
function lastMessageAt(item: Row, lastMsg: Row): string | null {
  for (const key of ["last_message_at", "last_message", "last_message_date", "last_message_time", "updated_at", "updated", "modified"]) {
    const v = item[key];
    if (typeof v === "string" && DATE_LIKE.test(v)) return v;
  }
  const nestedDate = pick(lastMsg, "created", "created_at");
  return typeof nestedDate === "string" && DATE_LIKE.test(nestedDate) ? nestedDate : null;
}

// One thread row from GET /inbox.
export function mapThread(item: Row): Record<string, unknown> | null {
  const id = num(pick(item, "id", "thread_id", "inbox_id"));
  if (!id) return null;
  const res = nested(item, "reservation");
  const lastMsg = nested(item, "last_message");
  return {
    id,
    reservation_id: num(pick(item, "reservation_id") ?? pick(res, "id")),
    listing_id: num(pick(item, "listing_id") ?? pick(res, "listing_id")),
    channel: str(pick(item, "integration_type_name", "channel", "source", "integration_type")),
    guest_name: str(pick(item, "guest_name", "name") ?? pick(nested(item, "guest"), "name")),
    last_message_at: lastMessageAt(item, lastMsg),
  };
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const plain = value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();
  return (redactAccess(redactContacts(plain)) ?? "").slice(0, MAX_TEXT) || null;
}

// One message from GET /inbox/{id}.
// Who wrote a message. Hostify sets guest_id on every message of a thread,
// so it can't tell guest from team on its own; prefer an explicit field.
export function senderOf(m: Row): "guest" | "team" {
  for (const key of ["is_incoming", "incoming", "from_guest", "is_guest"]) {
    if (m[key] !== undefined && m[key] !== null && m[key] !== "") return Number(m[key]) === 1 || m[key] === true ? "guest" : "team";
  }
  for (const key of ["sender_type", "from", "direction", "type", "sender", "author_type"]) {
    const v = typeof m[key] === "string" ? (m[key] as string).toLowerCase() : "";
    if (/guest|incoming|^in$|inbound|received/.test(v)) return "guest";
    if (/host|team|user|outgoing|^out$|outbound|sent|staff|admin/.test(v)) return "team";
  }
  if (m.user_id || m.sender_user_id || m.host_id) return "team";
  return m.guest_id ? "guest" : "team";
}

// Status lines like "Request accepted|Reservation2|accepted".
const SYSTEM_LINE = /^[^|\n]{1,60}\|[^|\n]{1,60}\|[^|\n]{1,60}$/;

function mapMessage(m: Row, thread: { id: number; reservation_id: number | null; listing_id: number | null }): Record<string, unknown> | null {
  const id = num(m.id);
  if (!id) return null;
  if (Number(m.is_automatic) === 1) return null;
  const text = cleanText(m.message) ?? cleanText(m.notes);
  if (!text || SYSTEM_LINE.test(text.trim())) return null;
  return {
    id,
    thread_id: thread.id,
    reservation_id: thread.reservation_id,
    listing_id: thread.listing_id,
    created: str(pick(m, "created", "created_at", "date")),
    sender: senderOf(m),
    kind: cleanText(m.message) ? "message" : "internal_note",
    text,
  };
}

// GET /inbox/{id}: returns the thread header and its messages, or a reason it couldn't.
export async function fetchThread(env: InboxEnv, threadId: number): Promise<{ header: Row; messages: Row[] }> {
  const body = await hostifyGet(env.HOSTIFY_API_KEY, `/inbox/${threadId}`) as Row;
  const header = (body.thread && typeof body.thread === "object" ? body.thread : {}) as Row;
  return { header, messages: extractItems(body, ["messages"]) };
}

function upsertSql(table: string, row: Record<string, unknown>): { sql: string; values: unknown[] } {
  const columns = [...Object.keys(row), "synced_at"];
  const updates = columns.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`).join(",");
  const same = Object.keys(row).filter((c) => c !== "id").map((c) => `${table}.${c} IS excluded.${c}`).join(" AND ");
  return {
    sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${updates} WHERE NOT (${same})`,
    values: Object.values(row).map((v) => (v === undefined ? null : v)),
  };
}

// Field names (and short non-text values) Hostify sends, so the mapping can be
// checked from the database without reading any message content.
const SAFE_VALUE = /^(id|guest_id|user_id|host_id|is_\w+|incoming|type|sender_type|from|direction|sender|author_type|status|channel\w*|integration\w*|created\w*|updated\w*|last_\w*_at|\w*date\w*|\w*time\w*|answered|read|unread)$/i;
export function shapeOf(row: unknown): string {
  if (!row || typeof row !== "object") return JSON.stringify(typeof row);
  const out: Row = {};
  for (const [k, v] of Object.entries(row as Row)) {
    if (v === null || typeof v === "object") { out[k] = v === null ? null : Array.isArray(v) ? "[array]" : "{object}"; continue; }
    out[k] = SAFE_VALUE.test(k) && String(v).length <= 30 ? v : typeof v;
  }
  return JSON.stringify(out).slice(0, 4000);
}

async function recordShape(db: D1Database, what: string, row: unknown): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO h_inbox_shape (what, shape, seen_at) VALUES (?,?,?)")
    .bind(what, shapeOf(row), new Date().toISOString()).run().catch(() => undefined);
}

export function upsertThread(db: D1Database, row: Record<string, unknown>, now: string): D1PreparedStatement {
  const { sql, values } = upsertSql("h_threads", row);
  return db.prepare(sql).bind(...values, now);
}

// Only live listings' conversations are read: listed in Hostify, or (for
// channel copies and room units, which aren't in h_listings) a booking that
// ended in the last 90 days or is still to come. Names starting "X " are
// retired listings and are skipped.
export const LIVE_LISTINGS_SQL = `
  SELECT id FROM h_listings WHERE is_listed = 1 AND lower(COALESCE(nickname,'')) NOT LIKE 'x %'
  UNION
  SELECT listing_id FROM h_reservations
  WHERE is_booking = 1 AND check_out >= date('now','-90 days') AND lower(COALESCE(listing_nickname,'')) NOT LIKE 'x %'`;

// Read up to `limit` threads whose messages are missing or out of date.
// Newest conversations first, so recent history is usable early.
export async function syncThreadMessages(env: InboxEnv, limit: number, now: Date): Promise<{ threads: number; messages: number; writes: number; errors: number }> {
  const nowIso = now.toISOString();
  const pending = await env.DB.prepare(
    `SELECT id, reservation_id, listing_id, last_message_at FROM h_threads
     WHERE messages_synced_for IS NOT COALESCE(last_message_at, '-')
       AND listing_id IN (${LIVE_LISTINGS_SQL})
     ORDER BY last_message_at DESC, id DESC LIMIT ?`,
  ).bind(limit).all<{ id: number; reservation_id: number | null; listing_id: number | null; last_message_at: string | null }>();

  const out = { threads: 0, messages: 0, writes: 0, errors: 0 };
  let shapeRecorded = false;
  type Pending = { id: number; reservation_id: number | null; listing_id: number | null; last_message_at: string | null };

  // Read one thread from Hostify and return the statements that store it.
  const readOne = async (t: Pending): Promise<D1PreparedStatement[]> => {
    const stamp = t.last_message_at ?? "-";
    try {
      const { header, messages } = await fetchThread(env, t.id);
      if (!shapeRecorded) {
        const anyMsg = messages.find((m) => m.message && Number(m.is_automatic) !== 1);
        if (anyMsg) {
          shapeRecorded = true;
          await recordShape(env.DB, "thread_header", header);
          await recordShape(env.DB, "message", anyMsg);
          const other = messages.find((m) => m.message && Number(m.is_automatic) !== 1 && senderOf(m) !== senderOf(anyMsg));
          if (other) await recordShape(env.DB, "message_other_sender", other);
        }
      }
      const reservationId = t.reservation_id ?? num(header.reservation_id);
      const listingId = t.listing_id ?? num(header.listing_id);
      const rows = messages
        .map((m) => mapMessage(m, { id: t.id, reservation_id: reservationId, listing_id: listingId }))
        .filter((r): r is Record<string, unknown> => r !== null);
      const statements = rows.map((r) => {
        const { sql, values } = upsertSql("h_messages", r);
        return env.DB.prepare(sql).bind(...values, nowIso);
      });
      statements.push(env.DB.prepare(
        `UPDATE h_threads SET messages_synced_for=?, message_count=?, fetch_error=NULL,
           reservation_id=COALESCE(reservation_id, ?), listing_id=COALESCE(listing_id, ?) WHERE id=?`,
      ).bind(stamp, rows.length, reservationId, listingId, t.id));
      out.messages += rows.length;
      return statements;
    } catch (error) {
      // Don't retry a broken thread every minute: mark it read for this
      // version; it is retried when the thread changes again.
      out.errors += 1;
      return [env.DB.prepare(`UPDATE h_threads SET messages_synced_for=?, fetch_error=? WHERE id=?`)
        .bind(stamp, (error instanceof Error ? error.message : String(error)).slice(0, 200), t.id)];
    }
  };

  // A few threads at a time: much faster than one by one, gentle on Hostify.
  const PARALLEL = 5;
  for (let i = 0; i < pending.results.length; i += PARALLEL) {
    const group = pending.results.slice(i, i + PARALLEL);
    const statements = (await Promise.all(group.map(readOne))).flat();
    for (let j = 0; j < statements.length; j += 50) {
      const results = (await env.DB.batch(statements.slice(j, j + 50))) as { meta?: { rows_written?: number } }[];
      out.writes += (results ?? []).reduce((sum, r) => sum + Number(r?.meta?.rows_written ?? 0), 0);
    }
    out.threads += group.length;
  }
  return out;
}

export async function messagesStatus(db: D1Database): Promise<Row> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS threads,
            SUM(CASE WHEN messages_synced_for IS COALESCE(last_message_at,'-') THEN 1 ELSE 0 END) AS threads_read,
            SUM(CASE WHEN fetch_error IS NOT NULL THEN 1 ELSE 0 END) AS threads_with_errors,
            MIN(last_message_at) AS oldest_thread
     FROM h_threads WHERE listing_id IN (${LIVE_LISTINGS_SQL})`,
  ).first<Row>();
  const msgs = await db.prepare("SELECT COUNT(*) AS n FROM h_messages").first<{ n: number }>();
  const err = await db.prepare("SELECT fetch_error FROM h_threads WHERE fetch_error IS NOT NULL ORDER BY id DESC LIMIT 1").first<{ fetch_error: string }>();
  return {
    dataset: "Guest messages (live listings' past conversations)",
    job: "inbox_messages",
    live_listing_threads_found: row?.threads ?? 0,
    threads_read: row?.threads_read ?? 0,
    threads_with_errors: row?.threads_with_errors ?? 0,
    messages_stored: msgs?.n ?? 0,
    oldest_thread: row?.oldest_thread ?? null,
    last_error: err?.fetch_error ?? null,
  };
}

// The thread for one booking, from the cache. null if not synced yet.
export async function cachedThreadFor(db: D1Database, reservationId: number): Promise<number | null> {
  const row = await db.prepare("SELECT id FROM h_threads WHERE reservation_id=? ORDER BY last_message_at DESC LIMIT 1")
    .bind(reservationId).first<{ id: number }>();
  return row?.id ?? null;
}

// Messages for one property (all its channel listings), for building
// guest-ops FAQs. Guest questions and the team's answers, newest first.
export async function messagesForListings(
  db: D1Database, listingIds: number[], opts: { from?: string; to?: string; sender?: "guest" | "team"; search?: string; limit: number },
): Promise<Row[]> {
  const where = [`m.listing_id IN (${listingIds.map(() => "?").join(",")})`];
  const values: unknown[] = [...listingIds];
  if (opts.from) { where.push("m.created >= ?"); values.push(opts.from); }
  if (opts.to) { where.push("m.created < ?"); values.push(`${opts.to}~`); }
  if (opts.sender) { where.push("m.sender = ?"); values.push(opts.sender); }
  if (opts.search) { where.push("lower(m.text) LIKE ?"); values.push(`%${opts.search.toLowerCase()}%`); }
  const rows = await db.prepare(
    `SELECT m.thread_id, m.reservation_id, m.created, m.sender, m.kind, m.text, t.channel
     FROM h_messages m LEFT JOIN h_threads t ON t.id = m.thread_id
     WHERE ${where.join(" AND ")} ORDER BY m.created DESC LIMIT ?`,
  ).bind(...values, opts.limit).all<Row>();
  return rows.results;
}

// Field names only (never values, except ids), to check what Hostify sends.
export async function inboxDiagnostics(env: InboxEnv, reservationId?: number): Promise<Row> {
  const out: Row = {};
  const keysOf = (r: unknown) => (r && typeof r === "object" ? Object.keys(r as Row).sort() : typeof r);
  try {
    const body = await hostifyGet(env.HOSTIFY_API_KEY, "/inbox", { page: 1, per_page: 3 }) as Row;
    const threads = extractItems(body, ["threads"]);
    out.list = { top_level_keys: keysOf(body), total: num(body.total), first_thread_keys: keysOf(threads[0]), mapped_first_thread: threads[0] ? mapThread(threads[0]) : null };
    const first = threads[0] ? mapThread(threads[0]) : null;
    if (first) {
      try {
        const raw = await hostifyGet(env.HOSTIFY_API_KEY, `/inbox/${first.id}`) as Row;
        const msgs = extractItems(raw, ["messages"]);
        out.thread = { id: first.id, top_level_keys: keysOf(raw), thread_keys: keysOf(raw.thread), message_count: msgs.length, first_message_keys: keysOf(msgs[0]) };
      } catch (e) { out.thread = { id: first.id, error: e instanceof Error ? e.message : String(e) }; }
    }
  } catch (e) { out.list = { error: e instanceof Error ? e.message : String(e) }; }
  if (reservationId) {
    try {
      const body = await hostifyGet(env.HOSTIFY_API_KEY, `/reservations/${reservationId}`) as Row;
      const raw = (body.reservation && typeof body.reservation === "object" ? body.reservation : body) as Row;
      out.reservation = {
        id_fields: Object.fromEntries(Object.entries(raw).filter(([k]) => /inbox|thread|conversation|message/i.test(k)).map(([k, v]) => [k, typeof v === "number" || /^\d+$/.test(String(v)) ? v : typeof v])),
        cached_thread_id: await cachedThreadFor(env.DB, reservationId),
      };
    } catch (e) { out.reservation = { error: e instanceof Error ? e.message : String(e) }; }
  }
  return out;
}
