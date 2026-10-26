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
interface SendPlan { attempts: Attempt[]; verify?: { path: string; expect_status: string } }

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
        if (!outcome.verified) {
          outcome.ok = false;
          outcome.warning = `Hostify accepted the request but the reservation status is now "${status}". Check it in Hostify.`;
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
  return { ...body, ...(r.extra_fields ?? {}) };
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

  const body = buildReservationBody(chosen.id, r);
  const summary = {
    property: { id: chosen.id, nickname: chosen.nickname, street: chosen.street, zipcode: chosen.zipcode },
    check_in: r.check_in, check_out: r.check_out, nights,
    guest_name: r.guest_name, guests: r.guests,
    total_price: r.total_price ?? null, currency: r.currency ?? null,
    listing_cleaning_fee: cleaningFee,
    source: r.source, status: r.status,
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

export async function previewCancelReservation(
  env: WriteEnv, reservationId: number, reason: string | undefined, user: string,
): Promise<Row> {
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
      { method: "PUT", path: `/reservations/${res.id}`, body: { status: "cancelled" } }, // no note: it would overwrite the booking's existing note
      { method: "POST", path: `/reservations/${res.id}/cancel`, body: reason ? { reason } : {} },
    ],
    verify: { path: `/reservations/${res.id}`, expect_status: "cancel" },
  };
  const summary = {
    reservation_id: res.id, confirmation_code: res.confirmation_code,
    property: { id: res.listing_id, nickname },
    check_in: res.check_in, check_out: res.check_out, nights: res.nights,
    source: res.source, current_status: res.status, total_price: res.total_price, currency: res.currency,
    new_status: "cancelled", reason: reason ?? null,
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
  };
}
