// Write actions (v1: create reservation).
//
// Every write is two steps:
//   1. preview  – validate, resolve the property, check availability, and store
//                 the exact Hostify request in h_pending_writes. Nothing is sent.
//   2. confirm  – called with the preview token. Sends exactly the stored
//                 request (never re-built from new arguments), once.
// Tokens expire after 15 minutes and can only be used once. Every confirmed
// write stays in h_pending_writes as an audit log (who, when, what, result).
//
// Later actions (guest messages, edits/cancellations, prices) add a builder
// here and reuse preparePending / executePending unchanged.

import { extractItems, hostifyGet, HOSTIFY_BASE_URL, mapReservation, Row } from "./hostify";
import { findListings } from "./queries";
import { ensureSchema } from "./schema";
import { cachedThreadFor } from "./inbox";

const TOKEN_TTL_MINUTES = 15;

export interface WriteEnv {
  HOSTIFY_API_KEY: string;
  DB: D1Database;
  WRITES_ENABLED?: string;
}

export function writesEnabled(env: WriteEnv): boolean {
  return String(env.WRITES_ENABLED ?? "").toLowerCase() === "true";
}

// ---------- Hostify write client ----------

export async function hostifySend(
  apiKey: string, method: "POST" | "PUT" | "DELETE", path: string, body: Row,
): Promise<{ status: number; body: unknown }> {
  if (!apiKey) throw new Error("HOSTIFY_API_KEY is not configured");
  const response = await fetch(new URL(path, HOSTIFY_BASE_URL), {
    method,
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = parsed && typeof parsed === "object"
      ? JSON.stringify((parsed as Row).error ?? (parsed as Row).message ?? (parsed as Row).errors ?? parsed).slice(0, 400)
      : "";
    const err = new Error(`Hostify API error ${response.status}${detail ? `: ${detail}` : ""}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  return { status: response.status, body: parsed };
}

// ---------- pending writes / audit log ----------

type Method = "POST" | "PUT" | "DELETE";
interface Attempt { method: Method; path: string; body: Row }
interface SendPlan { attempts: Attempt[]; verify?: { path: string; expect_status: string; expect?: Record<string, string> } }

interface PendingRow {
  token: string;
  action: string;
  method: string;
  path: string;
  payload: string;
  summary: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  result: string | null;
}

async function preparePending(
  db: D1Database, action: string, method: string, path: string, payload: Row, summary: Row, user: string,
): Promise<{ token: string; expires_at: string }> {
  await ensureSchema(db);
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const now = new Date();
  const expires = new Date(now.getTime() + TOKEN_TTL_MINUTES * 60000).toISOString();
  await db.prepare(
    `INSERT INTO h_pending_writes (token, action, method, path, payload, summary, created_by, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(token, action, method, path, JSON.stringify(payload), JSON.stringify(summary), user, now.toISOString(), expires).run();
  return { token, expires_at: expires };
}

export async function executePending(env: WriteEnv, token: string, user: string): Promise<Row> {
  const db = env.DB;
  await ensureSchema(db);
  const row = await db.prepare(`SELECT * FROM h_pending_writes WHERE token=?`).bind(token).first<PendingRow>();
  if (!row) throw new Error("Unknown confirmation token. Run the preview again.");
  if (row.confirmed_at) throw new Error(`This change was already sent at ${row.confirmed_at}. It will not be sent twice.`);
  if (Date.parse(row.expires_at) < Date.now()) throw new Error("This preview has expired (15 minutes). Run the preview again.");

  // Claim the token first so a double call can never send twice.
  const claimed = await db.prepare(
    `UPDATE h_pending_writes SET confirmed_at=?, confirmed_by=? WHERE token=? AND confirmed_at IS NULL`,
  ).bind(new Date().toISOString(), user, token).run();
  if (!claimed.meta.changes) throw new Error("This change is already being sent.");

  try {
    const stored = JSON.parse(row.payload) as Row;
    const plan = Array.isArray(stored.attempts)
      ? (stored as unknown as SendPlan)
      : { attempts: [{ method: row.method as Method, path: row.path, body: stored }] } as SendPlan;

    // Try each endpoint in order. Move on ONLY when Hostify says the endpoint
    // itself does not exist (404/405) — any other error stops immediately.
    let sent: { status: number; body: unknown } | null = null;
    let used: Attempt | null = null;
    const skipped: string[] = [];
    for (const attempt of plan.attempts) {
      try {
        sent = await hostifySend(env.HOSTIFY_API_KEY, attempt.method, attempt.path, attempt.body);
        used = attempt;
        break;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if ((status === 404 || status === 405) && attempt !== plan.attempts[plan.attempts.length - 1]) {
          skipped.push(`${attempt.method} ${attempt.path} → ${status}`);
          continue;
        }
        throw e;
      }
    }
    if (!sent || !used) throw new Error("No Hostify endpoint accepted the request.");

    const outcome: Row = { ok: true, http_status: sent.status, endpoint: `${used.method} ${used.path}`, ...pickCreated(sent.body) };
    if (skipped.length) outcome.endpoints_skipped = skipped;

    // Read the record back so the answer reflects what Hostify actually holds.
    if (plan.verify) {
      try {
        const body = await hostifyGet(env.HOSTIFY_API_KEY, plan.verify.path, { fees: 1 }) as Row;
        const item = (body.reservation && typeof body.reservation === "object" ? body.reservation : body) as Row;
        const now = mapReservation(item);
        const status = now?.status ?? null;
        outcome.verified_status = status;
        outcome.verified = !!status && new RegExp(plan.verify.expect_status, "i").test(status);
        for (const [k, v] of Object.entries(plan.verify.expect ?? {})) {
          const got = now ? (now as unknown as Row)[k] : null;
          if (got !== v) { outcome.verified = false; outcome[`verified_${k}`] = got; }
        }
        if (now) { outcome.now = { status: now.status, check_in: now.check_in, check_out: now.check_out, nights: now.nights, total_price: now.total_price }; }
        if (!outcome.verified) {
          outcome.ok = false;
          outcome.warning = `Hostify accepted the request but the reservation does not show the expected result (status "${status}"). Check it in Hostify.`;
        }
      } catch (e) {
        outcome.verified = null;
        outcome.warning = `Sent, but could not read the reservation back: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    await db.prepare(`UPDATE h_pending_writes SET result=? WHERE token=?`).bind(JSON.stringify(outcome), token).run();
    return { action: row.action, summary: JSON.parse(row.summary), ...outcome };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.prepare(`UPDATE h_pending_writes SET result=? WHERE token=?`)
      .bind(JSON.stringify({ ok: false, error: message }), token).run();
    throw new Error(`${message} — nothing further was retried. Fix the input and run a new preview.`);
  }
}

// Only identifiers and status come back to the model, never the full payload.
function pickCreated(body: unknown): Row {
  const root = body && typeof body === "object" ? (body as Row) : {};
  const inner = (root.reservation && typeof root.reservation === "object" ? root.reservation : root) as Row;
  const out: Row = {};
  for (const key of ["id", "reservation_id", "confirmation_code", "status", "success"]) {
    const v = inner[key] ?? root[key];
    if (v !== undefined && v !== null && typeof v !== "object") out[key] = v;
  }
  return out;
}

export async function recentWrites(db: D1Database, limit: number): Promise<Row[]> {
  await ensureSchema(db);
  const rows = await db.prepare(
    `SELECT token, action, summary, created_by, created_at, confirmed_at, result FROM h_pending_writes
     WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT ?`,
  ).bind(limit).all<PendingRow>();
  return rows.results.map((r) => ({
    token: r.token, action: r.action, summary: JSON.parse(r.summary),
    confirmed_at: r.confirmed_at, result: r.result ? JSON.parse(r.result) : null,
  }));
}

// ---------- create reservation ----------

export interface NewReservation {
  property: string;
  check_in: string;
  check_out: string;
  guest_name: string;
  guests: number;
  total_price?: number;
  currency?: string;
  source: string;
  status: string;
  guest_email?: string;
  guest_phone?: string;
  note?: string;
  extra_fields?: Row;
  allow_overlap?: boolean;
  base_price?: number;
  pets?: number;
}

// The one place that decides Hostify's field names for POST /reservations.
// Adjust here if the Hostify API reference names a field differently.
export function buildReservationBody(listingId: number, r: NewReservation): Row {
  const body: Row = {
    listing_id: listingId,
    start_date: r.check_in,
    end_date: r.check_out,
    name: r.guest_name,
    guests: r.guests,
    source: r.source,
    status: r.status,
  };
  if (r.total_price !== undefined) body.total_price = r.total_price;
  if (r.currency) body.currency = r.currency;
  if (r.guest_email) body.email = r.guest_email;
  if (r.guest_phone) body.phone = r.guest_phone;
  if (r.note) body.note = r.note;
  if (r.base_price !== undefined) body.base_price = r.base_price;
  if (r.pets !== undefined) body.pets = r.pets;
  // skip_restrictions also bypasses availability (tested 26 Oct 2026), so it is
  // only ever sent through the explicit allow_overlap switch.
  const extra = { ...(r.extra_fields ?? {}) };
  delete extra.skip_restrictions;
  if (r.allow_overlap) body.skip_restrictions = true;
  return { ...body, ...extra };
}

// Hide contact details in anything shown back in chat.
function redact(body: Row): Row {
  const out: Row = { ...body };
  for (const key of Object.keys(out)) {
    if (/email|phone/i.test(key) && out[key]) out[key] = "(provided, hidden)";
  }
  return out;
}

function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

async function liveAvailability(apiKey: string, listingId: number, checkIn: string, checkOut: string): Promise<Row> {
  // Calendar is per night: check_in .. the night before check_out.
  const lastNight = new Date(Date.parse(checkOut) - 86400000).toISOString().slice(0, 10);
  const url = new URL("/calendar", HOSTIFY_BASE_URL);
  url.searchParams.set("listing_id", String(listingId));
  url.searchParams.set("start_date", checkIn);
  url.searchParams.set("end_date", lastNight);
  try {
    const response = await fetch(url, { headers: { "content-type": "application/json", "x-api-key": apiKey } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) return { checked: false, reason: `calendar returned ${response.status}` };
    const days = extractItems(body, ["calendar", "days"]);
    const blocked: string[] = [];
    let known = 0;
    for (const d of days) {
      const date = String(d.date ?? d.day ?? "").slice(0, 10);
      const status = String(d.status ?? "").toLowerCase();
      const flag = d.is_available ?? d.available ?? d.availability;
      let available: boolean | null = null;
      if (status) available = status === "available" || status === "open";
      else if (flag !== undefined && flag !== null) available = flag === true || flag === 1 || flag === "1" || flag === "available";
      if (available === null) continue;
      known++;
      if (!available && date) blocked.push(date);
    }
    if (!known) return { checked: false, reason: "calendar format not recognised", days_returned: days.length };
    return { checked: true, nights_checked: known, all_open: blocked.length === 0, unavailable_nights: blocked };
  } catch (e) {
    return { checked: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function previewCreateReservation(env: WriteEnv, r: NewReservation, user: string): Promise<Row> {
  const db = env.DB;
  const nights = nightsBetween(r.check_in, r.check_out);
  if (!(nights > 0)) throw new Error("check_out must be after check_in.");
  if (nights > 365) throw new Error("Stays longer than 365 nights are not allowed here.");
  const today = new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];
  if (r.check_in < today) warnings.push("Check-in is in the past.");

  // Resolve the property. Must be exactly one match.
  const matches = await findListings(db, r.property, 5);
  if (!matches.length) throw new Error(`No property matches "${r.property}". Use find_property first.`);
  const exact = matches.filter((m) => /^\d+$/.test(r.property.trim()) || (m.nickname ?? "").toLowerCase() === r.property.trim().toLowerCase());
  const chosen = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (!chosen) {
    return {
      status: "needs_clarification",
      message: "More than one property matches. Ask which one, then call again with its listing id as property.",
      candidates: matches.map((m) => ({ id: m.id, nickname: m.nickname, street: m.street, zipcode: m.zipcode })),
    };
  }

  // Overlap with bookings already in the cache.
  const overlaps = await db.prepare(
    `SELECT id, guest_name, status, check_in, check_out, source FROM h_reservations
     WHERE listing_id=? AND is_booking=1 AND check_in < ? AND check_out > ? ORDER BY check_in LIMIT 10`,
  ).bind(chosen.id, r.check_out, r.check_in).all<Row>();
  if (overlaps.results.length) warnings.push(`Overlaps ${overlaps.results.length} existing booking(s) in the cache.`);

  const availability = await liveAvailability(env.HOSTIFY_API_KEY, chosen.id, r.check_in, r.check_out);
  if (availability.checked && !availability.all_open) warnings.push("Hostify calendar shows some nights unavailable.");
  if (!availability.checked) warnings.push(`Could not confirm availability on the live calendar (${availability.reason}).`);

  if (chosen.capacity && r.guests > Number(chosen.capacity)) warnings.push(`Guests (${r.guests}) exceeds capacity (${chosen.capacity}).`);
  if (r.total_price === undefined) warnings.push("No total price given; Hostify will apply its own pricing (if any).");

  // Hostify adds the listing's cleaning fee on top of the price given.
  let cleaningFee: number | null = null;
  try {
    const lb = await hostifyGet(env.HOSTIFY_API_KEY, `/listings/${chosen.id}`, { include_related_objects: 0 }) as Row;
    const li = (lb.listing && typeof lb.listing === "object" ? lb.listing : lb) as Row;
    const fee = Number(li.cleaning_fee);
    cleaningFee = Number.isFinite(fee) ? fee : null;
  } catch { /* preview still works without it */ }
  if (cleaningFee) warnings.push(`Hostify will add this listing's cleaning fee of ${cleaningFee} on top of the price.`);

  const clash = overlaps.results.length > 0 || (availability.checked && !availability.all_open);
  if (clash && !r.allow_overlap) {
    warnings.push("Hostify will reject these dates as unavailable unless allow_overlap is set — which creates a DOUBLE BOOKING.");
  }
  if (r.allow_overlap) {
    warnings.unshift(clash
      ? "⚠ DOUBLE BOOKING: allow_overlap is on and these dates clash. Confirming creates an overlapping booking that may sync to the channels."
      : "allow_overlap is on (also skips minimum stay and capacity rules). No clash found.");
  }

  const body = buildReservationBody(chosen.id, r);
  const summary = {
    property: { id: chosen.id, nickname: chosen.nickname, street: chosen.street, zipcode: chosen.zipcode },
    check_in: r.check_in, check_out: r.check_out, nights,
    guest_name: r.guest_name, guests: r.guests,
    total_price: r.total_price ?? null, currency: r.currency ?? null,
    listing_cleaning_fee: cleaningFee,
    source: r.source, status: r.status,
    allow_overlap: !!r.allow_overlap,
  };
  const pending = await preparePending(db, "create_reservation", "POST", "/reservations", body, summary, user);

  return {
    status: "preview",
    message: "Nothing has been sent to Hostify yet. Show this preview to the user. Only after they clearly say yes, call confirm_write with this token.",
    confirm_token: pending.token,
    expires_at: pending.expires_at,
    summary,
    warnings,
    conflicting_bookings: overlaps.results,
    availability,
    request: { method: "POST", path: "/reservations", body: redact(body) },
  };
}

// ---------- cancel reservation (direct bookings only) ----------

const DIRECT_SOURCE = /^direct\b/i;
const ALREADY_CANCELLED = /cancel/i;

// Hostify's accepted statuses: accepted, cancelled_by_host, cancelled_by_guest, denied, no_show.
export type CancelledBy = "host" | "guest";

export async function previewCancelReservation(
  env: WriteEnv, reservationId: number, reason: string | undefined, user: string, cancelledBy: CancelledBy = "host",
): Promise<Row> {
  const newStatus = cancelledBy === "guest" ? "cancelled_by_guest" : "cancelled_by_host";
  // Always check against live Hostify data, never the cache.
  const body = await hostifyGet(env.HOSTIFY_API_KEY, `/reservations/${reservationId}`, { fees: 1 }) as Row;
  const item = (body.reservation && typeof body.reservation === "object" ? body.reservation : body) as Row;
  const res = mapReservation(item);
  if (!res) throw new Error(`Reservation ${reservationId} was not found in Hostify.`);

  const source = res.source ?? "";
  if (!DIRECT_SOURCE.test(source)) {
    return {
      status: "refused",
      message: `Only direct bookings can be cancelled through this connector. This booking's source is "${source || "unknown"}" — cancel it in Hostify or on the channel instead.`,
      reservation: { id: res.id, source: res.source, status: res.status, check_in: res.check_in, check_out: res.check_out },
    };
  }
  if (res.status && ALREADY_CANCELLED.test(res.status)) {
    return { status: "refused", message: `Reservation ${res.id} is already ${res.status}.` };
  }

  const warnings: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  if (res.check_in && res.check_in <= today) warnings.push("The stay has already started or finished.");
  if (res.paid_part && res.paid_part !== "none") warnings.push(`Payment recorded on this booking (paid: ${res.paid_part}). Refunds are not handled here.`);

  let nickname = res.listing_nickname;
  if (!nickname && res.listing_id) {
    const m = await findListings(env.DB, String(res.listing_id), 1).catch(() => []);
    nickname = m[0]?.nickname ?? null;
  }

  const plan: SendPlan = {
    attempts: [
      { method: "PUT", path: `/reservations/${res.id}`, body: { status: newStatus } }, // no note: it would overwrite the booking's existing note
      { method: "POST", path: `/reservations/${res.id}/cancel`, body: { status: newStatus, ...(reason ? { reason } : {}) } },
    ],
    verify: { path: `/reservations/${res.id}`, expect_status: "cancel" },
  };
  const summary = {
    reservation_id: res.id, confirmation_code: res.confirmation_code,
    property: { id: res.listing_id, nickname },
    check_in: res.check_in, check_out: res.check_out, nights: res.nights,
    source: res.source, current_status: res.status, total_price: res.total_price, currency: res.currency,
    new_status: newStatus, reason: reason ?? null,
  };
  const pending = await preparePending(
    env.DB, "cancel_reservation", plan.attempts[0].method, plan.attempts[0].path, plan as unknown as Row, summary, user,
  );
  return {
    status: "preview",
    message: "Nothing has been cancelled yet. Show this preview to the user. Only after they clearly say yes, call confirm_write with this token.",
    confirm_token: pending.token,
    expires_at: pending.expires_at,
    summary,
    warnings,
    request: { method: plan.attempts[0].method, path: plan.attempts[0].path, body: plan.attempts[0].body },
  };
}

// ---------- shared helpers for edits & messaging ----------

async function liveReservation(env: WriteEnv, reservationId: number): Promise<{ raw: Row; res: NonNullable<ReturnType<typeof mapReservation>> }> {
  const body = await hostifyGet(env.HOSTIFY_API_KEY, `/reservations/${reservationId}`, { fees: 1 }) as Row;
  const raw = (body.reservation && typeof body.reservation === "object" ? body.reservation : body) as Row;
  const res = mapReservation(raw);
  if (!res) throw new Error(`Reservation ${reservationId} was not found in Hostify.`);
  return { raw, res };
}

async function nicknameFor(env: WriteEnv, listingId: number | null): Promise<string | null> {
  if (!listingId) return null;
  const m = await findListings(env.DB, String(listingId), 1).catch(() => []);
  return m[0]?.nickname ?? null;
}

// Guest emails and phone numbers never go back to the model.
export function redactContacts(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email hidden]")
    // Phone-like runs with 9+ digits (dates and times have fewer, so they stay).
    .replace(/(?:\+|00)?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number hidden]" : m));
}

// Access details (door codes, PINs, WiFi passwords) are cut from anything read back.
export function redactAccess(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text.replace(
    /\b(door\s*code|access\s*code|entry\s*code|code|pin|passcode|password|wi-?fi|network|ssid|lock\s*box|key\s*safe|keysafe|key\s*box)\b[^\n]{0,60}/gi,
    (_m, k) => `${k} [hidden]`,
  );
}

// ---------- update reservation (dates, notes, arrival times, check-in/out marks) ----------

export interface ReservationEdit {
  reservation_id: number;
  check_in?: string;
  check_out?: string;
  notes?: string;
  notes_mode?: "append" | "replace";
  planned_arrival?: string;
  planned_departure?: string;
  checked_in?: boolean;
  checked_out?: boolean;
  allow_overlap?: boolean;
}

export async function previewUpdateReservation(env: WriteEnv, e: ReservationEdit, user: string): Promise<Row> {
  const { raw, res } = await liveReservation(env, e.reservation_id);
  if (res.status && /cancel|denied|declin/i.test(res.status)) {
    return { status: "refused", message: `Reservation ${res.id} is ${res.status}; it cannot be edited here.` };
  }
  const isDirect = /^direct\b/i.test(res.source ?? "");
  const changesDates = (e.check_in && e.check_in !== res.check_in) || (e.check_out && e.check_out !== res.check_out);
  if (changesDates && !isDirect) {
    return {
      status: "refused",
      message: `Dates can only be changed on direct bookings. This booking is from "${res.source}" — change it on the channel so both sides stay in sync.`,
    };
  }

  const newIn = e.check_in ?? res.check_in;
  const newOut = e.check_out ?? res.check_out;
  if (!newIn || !newOut) throw new Error("This reservation has no dates in Hostify.");
  const nights = Math.round((Date.parse(newOut) - Date.parse(newIn)) / 86400000);
  if (!(nights > 0)) throw new Error("check_out must be after check_in.");

  const warnings: string[] = [];
  let conflicts: Row[] = [];
  if (changesDates && res.listing_id) {
    const rows = await env.DB.prepare(
      `SELECT id, guest_name, status, check_in, check_out, source FROM h_reservations
       WHERE listing_id=? AND is_booking=1 AND id<>? AND check_in < ? AND check_out > ? ORDER BY check_in LIMIT 10`,
    ).bind(res.listing_id, res.id, newOut, newIn).all<Row>();
    conflicts = rows.results;
    if (conflicts.length) {
      warnings.push(e.allow_overlap
        ? "⚠ DOUBLE BOOKING: the new dates clash with another booking and allow_overlap is on."
        : "The new dates clash with another booking; Hostify will probably reject the change.");
    }
  }

  const body: Row = { listing_id: res.listing_id, check_in: newIn, check_out: newOut };
  const changes: Row = {};
  if (changesDates) {
    changes.dates = { from: `${res.check_in} → ${res.check_out} (${res.nights} nights)`, to: `${newIn} → ${newOut} (${nights} nights)` };
    warnings.push("Hostify recalculates the price for new dates — check the total afterwards.");
  }
  if (e.notes !== undefined) {
    const existing = typeof raw.notes === "string" ? raw.notes : "";
    const mode = e.notes_mode ?? "append";
    body.notes = mode === "append" && existing ? `${existing}\n${e.notes}` : e.notes;
    changes.notes = { mode, adding: e.notes, existing_notes_length: existing.length };
    if (mode === "replace" && existing) warnings.push(`Replace mode deletes the existing notes (${existing.length} characters).`);
  }
  if (e.planned_arrival) { body.planned_arrival = e.planned_arrival; changes.planned_arrival = e.planned_arrival; }
  if (e.planned_departure) { body.planned_departure = e.planned_departure; changes.planned_departure = e.planned_departure; }
  if (e.checked_in !== undefined) { body.checked_in_mark = e.checked_in ? 1 : 0; changes.checked_in_mark = e.checked_in ? "mark checked-in" : "undo checked-in"; }
  if (e.checked_out !== undefined) { body.checked_out_mark = e.checked_out ? 1 : 0; changes.checked_out_mark = e.checked_out ? "mark checked-out" : "undo checked-out"; }
  if (!Object.keys(changes).length) throw new Error("Nothing to change — give new dates, notes, arrival/departure times or a check-in/out mark.");

  const summary = {
    reservation_id: res.id, confirmation_code: res.confirmation_code,
    property: { id: res.listing_id, nickname: res.listing_nickname ?? await nicknameFor(env, res.listing_id) },
    source: res.source, status: res.status, changes,
  };
  const plan: SendPlan = {
    attempts: [{ method: "PUT", path: `/reservations/${res.id}`, body }],
    verify: changesDates
      ? { path: `/reservations/${res.id}`, expect_status: ".", expect: { check_in: newIn, check_out: newOut } }
      : { path: `/reservations/${res.id}`, expect_status: "." },
  };
  const pending = await preparePending(env.DB, "update_reservation", "PUT", `/reservations/${res.id}`, plan as unknown as Row, summary, user);
  const shownBody = { ...body };
  if (typeof shownBody.notes === "string") shownBody.notes = `(${(shownBody.notes as string).length} characters)`;
  return {
    status: "preview",
    message: "Nothing has been changed yet. Show this preview to the user. Only after they clearly say yes, call confirm_write with this token.",
    confirm_token: pending.token, expires_at: pending.expires_at,
    summary, warnings, conflicting_bookings: conflicts,
    request: { method: "PUT", path: `/reservations/${res.id}`, body: shownBody },
  };
}

// ---------- guest messaging ----------

// A booking's thread: from the inbox cache first (h_threads, filled by the
// background sync), then the booking's own inbox id, then a scan of the
// newest threads. Each candidate is tried in turn by the caller, because
// Hostify's booking "inbox_id" is not always a thread id.
async function threadCandidates(env: WriteEnv, reservationId?: number, threadId?: number): Promise<{ ids: number[]; res: ReturnType<typeof mapReservation> | null }> {
  if (threadId) return { ids: [threadId], res: null };
  if (!reservationId) throw new Error("Give a reservation_id (or a thread_id).");
  const ids: number[] = [];
  const cached = await cachedThreadFor(env.DB, reservationId).catch(() => null);
  if (cached) ids.push(cached);
  const { raw, res } = await liveReservation(env, reservationId);
  for (const key of ["thread_id", "inbox_thread_id", "inbox_id"]) {
    const v = Number(raw[key]);
    if (Number.isFinite(v) && v > 0 && !ids.includes(v)) ids.push(v);
  }
  return { ids, res };
}

async function scanForThread(env: WriteEnv, reservationId: number): Promise<number | null> {
  for (let page = 1; page <= 5; page++) {
    const body = await hostifyGet(env.HOSTIFY_API_KEY, "/inbox", { page, per_page: 100 }) as Row;
    const threads = extractItems(body, ["threads"]);
    const hit = threads.find((t) => Number(t.reservation_id ?? (t.reservation as Row | undefined)?.id) === reservationId);
    if (hit) return Number(hit.id);
    if (threads.length < 100) break;
  }
  return null;
}

async function resolveThread(env: WriteEnv, reservationId?: number, threadId?: number): Promise<{ threadId: number; res: ReturnType<typeof mapReservation> | null; body: Row }> {
  const { ids, res } = await threadCandidates(env, reservationId, threadId);
  let lastError: unknown = null;
  for (const id of ids) {
    try { return { threadId: id, res, body: await hostifyGet(env.HOSTIFY_API_KEY, `/inbox/${id}`) as Row }; }
    catch (e) { lastError = e; }
  }
  if (reservationId && !threadId) {
    const scanned = await scanForThread(env, reservationId);
    if (scanned && !ids.includes(scanned)) {
      return { threadId: scanned, res, body: await hostifyGet(env.HOSTIFY_API_KEY, `/inbox/${scanned}`) as Row };
    }
  }
  if (lastError) throw lastError;
  throw new Error(`No inbox thread found for reservation ${reservationId}. If it is older, the inbox history sync may not have reached it yet (see cache_status).`);
}

export async function readGuestThread(env: WriteEnv, reservationId: number | undefined, threadId: number | undefined, limit: number): Promise<Row> {
  const resolved = await resolveThread(env, reservationId, threadId);
  const body = resolved.body;
  const thread = (body.thread && typeof body.thread === "object" ? body.thread : {}) as Row;
  const messages = extractItems(body, ["messages"])
    .map((m) => ({
      id: m.id,
      created: m.created,
      from: m.guest_id ? "guest" : "host/system",
      guest_first_name: typeof m.guest_name === "string" ? m.guest_name.split(" ")[0] : null,
      automatic: Number(m.is_automatic) === 1,
      text: redactAccess(redactContacts(typeof m.message === "string" && m.message ? m.message : null)),
      system_note: typeof m.notes === "string" && m.notes ? redactAccess(redactContacts(m.notes)) : undefined,
    }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, limit);
  return {
    thread: {
      id: resolved.threadId, reservation_id: thread.reservation_id ?? reservationId ?? null, listing_id: thread.listing_id ?? null,
      channel: thread.integration_type_name ?? null, answered: thread.answered ?? null, last_message: thread.last_message ?? null,
    },
    messages_newest_first: messages,
    source: "live",
  };
}

export async function previewGuestMessage(
  env: WriteEnv,
  a: { reservation_id?: number; thread_id?: number; message: string; kind: "reply" | "internal_note"; send_by?: string },
  user: string,
): Promise<Row> {
  const resolved = await resolveThread(env, a.reservation_id, a.thread_id);
  const body = resolved.body;
  const thread = (body.thread && typeof body.thread === "object" ? body.thread : {}) as Row;
  const msgs = extractItems(body, ["messages"]);
  const lastGuest = msgs.filter((m) => m.guest_id && m.message).sort((x, y) => String(y.created).localeCompare(String(x.created)))[0];
  const res = resolved.res ?? (thread.reservation_id ? (await liveReservation(env, Number(thread.reservation_id)).catch(() => null))?.res ?? null : null);

  const warnings: string[] = [];
  if (a.kind === "reply") {
    if (res?.status && /cancel|denied|declin|expired/i.test(res.status)) warnings.push(`The reservation is ${res.status}.`);
    if (/\b(code|pin|password|wifi|key\s?safe|lockbox)\b/i.test(a.message)) warnings.push("The message looks like it may contain access details — double-check before sending.");
  }

  const summary = {
    kind: a.kind,
    goes_to: a.kind === "reply" ? `guest via ${a.send_by ?? "channel"} (${thread.integration_type_name ?? "unknown channel"})` : "internal note — team only, never sent to the guest",
    thread_id: resolved.threadId,
    reservation: res ? {
      id: res.id, confirmation_code: res.confirmation_code, guest_first_name: res.guest_name?.split(" ")[0] ?? null,
      check_in: res.check_in, check_out: res.check_out, status: res.status, source: res.source,
      property: res.listing_nickname ?? await nicknameFor(env, res.listing_id),
    } : null,
    last_guest_message: lastGuest ? { created: lastGuest.created, text: (redactAccess(redactContacts(String(lastGuest.message))) ?? "").slice(0, 300) } : null,
    message: a.message,
  };
  const req: Attempt = a.kind === "reply"
    ? { method: "POST", path: "/inbox/reply", body: { thread_id: resolved.threadId, message: a.message, ...(a.send_by && a.send_by !== "channel" ? { send_by: a.send_by } : {}) } }
    : { method: "POST", path: "/inbox/note", body: { thread_id: resolved.threadId, note: a.message } };
  const action = a.kind === "reply" ? "send_guest_message" : "add_thread_note";
  const pending = await preparePending(env.DB, action, req.method, req.path, { attempts: [req] } as unknown as Row, summary, user);
  return {
    status: "preview",
    message: a.kind === "reply"
      ? "Nothing has been sent yet. Show the user exactly who this goes to and the full message. Only after they clearly say yes, call confirm_write."
      : "Nothing has been saved yet. Only after the user says yes, call confirm_write.",
    confirm_token: pending.token, expires_at: pending.expires_at,
    summary, warnings,
  };
}
