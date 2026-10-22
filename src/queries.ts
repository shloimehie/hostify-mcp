// Read-side queries over the D1 cache. Everything here is a single round-trip
// to D1 and returns compact, pre-computed numbers so one tool call answers
// one question.

import { ensureSchema } from "./schema";

type Db = D1Database;
type Row = Record<string, unknown>;

const MAX_IDS = 90; // D1 allows 100 bound parameters per statement

// ---------- dates ----------

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysInclusive(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
}

function round(n: unknown, dp = 2): number | null {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

// ---------- property matching ----------

export interface MatchedListing {
  id: number;
  nickname: string | null;
  name: string | null;
  street: string | null;
  zipcode: string | null;
  city: string | null;
  bedrooms: number | null;
  capacity: number | null;
  is_listed: number | null;
  parent_listing_id: number | null;
}

function tokens(query: string): string[] {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean).slice(0, 6);
}

// Matches every word of the query against nickname, title, street and
// postcode, so "52 Durlston", "Durlston 52" and "E5 8RR" all work.
export async function findListings(db: Db, query: string, limit = 10): Promise<MatchedListing[]> {
  await ensureSchema(db);
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    const byId = await db.prepare(`SELECT * FROM h_listings WHERE id=?`).bind(Number(q)).all<MatchedListing>();
    if (byId.results.length) return byId.results;
  }
  const words = tokens(q);
  if (!words.length) return [];
  const hay = "lower(COALESCE(nickname,'')||' '||COALESCE(name,'')||' '||COALESCE(street,'')||' '||COALESCE(zipcode,''))";
  const where = words.map(() => `${hay} LIKE ?`).join(" AND ");
  const lowered = q.toLowerCase();
  const rows = await db.prepare(
    `SELECT id,nickname,name,street,zipcode,city,bedrooms,capacity,is_listed,parent_listing_id FROM h_listings
     WHERE ${where}
     ORDER BY CASE WHEN lower(nickname)=? THEN 0 WHEN lower(nickname) LIKE ? THEN 1 ELSE 2 END,
              (parent_listing_id IS NULL) DESC, is_listed DESC, nickname
     LIMIT ?`,
  ).bind(...words.map((w) => `%${w}%`), lowered, `${lowered}%`, limit).all<MatchedListing>();
  if (rows.results.length) return rows.results;

  // Fallback: names seen on bookings (covers listings not yet synced).
  const resWhere = words.map(() => "lower(COALESCE(listing_nickname,'')) LIKE ?").join(" AND ");
  const fromBookings = await db.prepare(
    `SELECT listing_id AS id, MAX(listing_nickname) AS nickname FROM h_reservations
     WHERE check_in >= date('now','-75 days') AND listing_id IS NOT NULL AND ${resWhere} GROUP BY listing_id LIMIT ?`,
  ).bind(...words.map((w) => `%${w}%`), limit).all<{ id: number; nickname: string }>();
  return fromBookings.results.map((r) => ({
    id: r.id, nickname: r.nickname, name: null, street: null, zipcode: null, city: null,
    bedrooms: null, capacity: null, is_listed: null, parent_listing_id: null,
  }));
}

// A "unit" is a physical property: channel copies of a listing (e.g.
// "New Road 35 - Bcom") roll up into their parent listing.
interface Scope {
  listingIds: number[];
  units: { unit_id: number; nickname: string | null }[];
}

async function scopeFor(db: Db, matched: MatchedListing[]): Promise<Scope> {
  const unitIds = [...new Set(matched.map((m) => m.parent_listing_id ?? m.id))].slice(0, 40);
  if (!unitIds.length) return { listingIds: [], units: [] };
  const members = await db.prepare(
    `SELECT id FROM h_listings WHERE COALESCE(parent_listing_id,id) IN (${placeholders(unitIds.length)})`,
  ).bind(...unitIds).all<{ id: number }>();
  const listingIds = [...new Set([...matched.map((m) => m.id), ...members.results.map((r) => r.id)])].slice(0, MAX_IDS);
  const names = await db.prepare(
    `SELECT id,nickname FROM h_listings WHERE id IN (${placeholders(unitIds.length)})`,
  ).bind(...unitIds).all<{ id: number; nickname: string | null }>();
  const nameOf = new Map(names.results.map((r) => [r.id, r.nickname]));
  const fallback = new Map(matched.map((m) => [m.parent_listing_id ?? m.id, m.nickname]));
  return {
    listingIds,
    units: unitIds.map((u) => ({ unit_id: u, nickname: nameOf.get(u) ?? fallback.get(u) ?? null })),
  };
}

// ---------- booking statistics ----------

interface UnitStats {
  unit_id: number;
  bookings: number;
  nights: number;
  gross: number;
  payout: number;
  net: number;
  accommodation: number;
  currency: string | null;
}

// Nights are clipped to the date range and money is pro-rated by nights,
// so a stay that straddles the range only counts the part inside it.
// Only real bookings count (no enquiries, cancellations, declines...).
async function statsByUnit(db: Db, from: string, to: string, listingIds: number[] | null): Promise<UnitStats[]> {
  const toExcl = addDays(to, 1);
  const filter = listingIds ? ` AND r.listing_id IN (${placeholders(listingIds.length)})` : "";
  const rows = await db.prepare(
    `WITH b AS (
       SELECT r.*, COALESCE(l.parent_listing_id, r.listing_id) AS unit_id,
              MAX(0, julianday(MIN(r.check_out, ?1)) - julianday(MAX(r.check_in, ?2))) AS nir
       FROM h_reservations r LEFT JOIN h_listings l ON l.id = r.listing_id
       WHERE r.is_booking = 1 AND r.check_in < ?1 AND r.check_out > ?2${filter}
     )
     SELECT unit_id,
            COUNT(*) AS bookings,
            SUM(nir) AS nights,
            SUM(CASE WHEN nights > 0 THEN COALESCE(subtotal, total_price, 0) * nir / nights ELSE 0 END) AS gross,
            SUM(CASE WHEN nights > 0 THEN COALESCE(payout_price, revenue, 0) * nir / nights ELSE 0 END) AS payout,
            SUM(CASE WHEN nights > 0 THEN COALESCE(net_revenue, owner_revenue, 0) * nir / nights ELSE 0 END) AS net,
            SUM(CASE WHEN nights > 0 THEN COALESCE(base_price, 0) * nir / nights ELSE 0 END) AS accommodation,
            MIN(currency) AS currency
     FROM b GROUP BY unit_id`,
  ).bind(toExcl, from, ...(listingIds ?? [])).all<UnitStats>();
  return rows.results;
}

function describeStats(s: Partial<UnitStats> | undefined, days: number) {
  const nights = Number(s?.nights ?? 0);
  return {
    bookings: Number(s?.bookings ?? 0),
    booked_nights: nights,
    available_nights: days,
    occupancy_pct: days ? round((nights / days) * 100, 1) : null,
    gross_booking_value: round(s?.gross ?? 0),
    payout_after_channel_fees: round(s?.payout ?? 0),
    net_revenue_excl_cleaning: round(s?.net ?? 0),
    adr_accommodation: nights ? round(Number(s?.accommodation ?? 0) / nights) : null,
    currency: s?.currency ?? null,
  };
}

const MONEY_NOTE =
  "Money is pro-rated to nights inside the range. gross_booking_value = accommodation + cleaning before channel fees; " +
  "payout_after_channel_fees = what the channel pays out; net_revenue_excl_cleaning = payout minus cleaning. " +
  "Only confirmed bookings are counted (no enquiries or cancellations).";

// ---------- tool implementations ----------

export async function propertyPerformance(
  db: Db, property: string, from: string, to: string, includeBookings: boolean, limit: number,
): Promise<Row> {
  const matched = await findListings(db, property, 20);
  if (!matched.length) return { property, matched_properties: [], note: "No property matched. Try find_property with part of the name, street or postcode." };
  const scope = await scopeFor(db, matched);
  const days = daysInclusive(from, to);
  const stats = await statsByUnit(db, from, to, scope.listingIds);
  const byUnit = new Map(stats.map((s) => [s.unit_id, s]));
  const units = scope.units.map((u) => ({ property: u.nickname, unit_id: u.unit_id, ...describeStats(byUnit.get(u.unit_id), days) }));

  const total = stats.reduce(
    (acc, s) => ({
      bookings: acc.bookings + Number(s.bookings), nights: acc.nights + Number(s.nights), gross: acc.gross + Number(s.gross),
      payout: acc.payout + Number(s.payout), net: acc.net + Number(s.net), accommodation: acc.accommodation + Number(s.accommodation),
      currency: acc.currency ?? s.currency, unit_id: 0,
    }),
    { bookings: 0, nights: 0, gross: 0, payout: 0, net: 0, accommodation: 0, currency: null as string | null, unit_id: 0 },
  );

  const toExcl = addDays(to, 1);
  const idList = placeholders(scope.listingIds.length);
  const [other, txns, rows] = await Promise.all([
    db.prepare(
      `SELECT status, COUNT(*) AS n FROM h_reservations
       WHERE is_booking = 0 AND check_in < ? AND check_out > ? AND listing_id IN (${idList}) GROUP BY status`,
    ).bind(toExcl, from, ...scope.listingIds).all<{ status: string; n: number }>(),
    db.prepare(
      `SELECT COALESCE(txn_type,'other') AS type, COUNT(*) AS count, ROUND(SUM(amount),2) AS amount, MIN(currency) AS currency
       FROM h_transactions WHERE txn_date >= ? AND txn_date <= ? AND listing_id IN (${idList}) GROUP BY COALESCE(txn_type,'other')`,
    ).bind(from, to, ...scope.listingIds).all(),
    includeBookings
      ? db.prepare(
        `SELECT r.id, r.listing_nickname AS listing, r.guest_name, r.status, r.source, r.check_in, r.check_out, r.nights,
                CAST(MAX(0, julianday(MIN(r.check_out, ?)) - julianday(MAX(r.check_in, ?))) AS INTEGER) AS nights_in_range,
                r.guests, r.payout_price AS payout, r.net_revenue, r.currency
         FROM h_reservations r
         WHERE r.is_booking = 1 AND r.check_in < ? AND r.check_out > ? AND r.listing_id IN (${idList})
         ORDER BY r.check_in LIMIT ?`,
      ).bind(toExcl, from, toExcl, from, ...scope.listingIds, limit).all()
      : Promise.resolve(null),
  ]);

  return {
    range: { from, to, days },
    matched_properties: units.length > 1 ? units : undefined,
    property: units.length === 1 ? units[0].property : `${units.length} properties matched "${property}"`,
    totals: describeStats(total, days * Math.max(1, units.length)),
    not_counted: other.results.length ? Object.fromEntries(other.results.map((o) => [o.status, o.n])) : undefined,
    transactions: txns.results.length ? txns.results : undefined,
    bookings: rows ? rows.results : undefined,
    bookings_truncated: rows && rows.results.length === limit ? true : undefined,
    note: MONEY_NOTE,
  };
}

export async function portfolioPerformance(
  db: Db, from: string, to: string, sortBy: "revenue" | "occupancy" | "nights" | "adr", order: "asc" | "desc",
  limit: number, filter: string | undefined,
): Promise<Row> {
  await ensureSchema(db);
  const days = daysInclusive(from, to);
  let listingIds: number[] | null = null;
  let unitFilter: Set<number> | null = null;
  if (filter) {
    const matched = await findListings(db, filter, 80);
    const scope = await scopeFor(db, matched);
    listingIds = scope.listingIds;
    unitFilter = new Set(scope.units.map((u) => u.unit_id));
  }
  const stats = await statsByUnit(db, from, to, listingIds);
  const byUnit = new Map(stats.map((s) => [s.unit_id, s]));
  // Every live unit appears, including ones with no bookings in the range.
  const live = await db.prepare(
    `SELECT id, nickname, city, bedrooms FROM h_listings WHERE parent_listing_id IS NULL AND is_listed = 1`,
  ).all<{ id: number; nickname: string | null; city: string | null; bedrooms: number | null }>();
  const meta = new Map(live.results.map((l) => [l.id, l]));
  const unitIds = new Set<number>([...live.results.map((l) => l.id), ...stats.map((s) => s.unit_id)]);
  const missingNames = [...unitIds].filter((u) => !meta.has(u));
  if (missingNames.length) {
    for (let i = 0; i < missingNames.length; i += MAX_IDS) {
      const chunk = missingNames.slice(i, i + MAX_IDS);
      const extra = await db.prepare(`SELECT id, nickname, city, bedrooms FROM h_listings WHERE id IN (${placeholders(chunk.length)})`)
        .bind(...chunk).all<{ id: number; nickname: string | null; city: string | null; bedrooms: number | null }>();
      for (const l of extra.results) meta.set(l.id, l);
    }
  }

  let rows = [...unitIds]
    .filter((u) => !unitFilter || unitFilter.has(u))
    .map((u) => {
      const m = meta.get(u);
      return { property: m?.nickname ?? `listing ${u}`, unit_id: u, bedrooms: m?.bedrooms ?? null, ...describeStats(byUnit.get(u), days) };
    });

  const key = {
    revenue: (r: (typeof rows)[number]) => r.payout_after_channel_fees ?? 0,
    occupancy: (r: (typeof rows)[number]) => r.occupancy_pct ?? 0,
    nights: (r: (typeof rows)[number]) => r.booked_nights,
    adr: (r: (typeof rows)[number]) => r.adr_accommodation ?? 0,
  }[sortBy];
  rows.sort((a, b) => (order === "asc" ? key(a) - key(b) : key(b) - key(a)));

  const totals = describeStats(
    stats.filter((s) => !unitFilter || unitFilter.has(s.unit_id)).reduce(
      (acc, s) => ({
        ...acc, bookings: acc.bookings + Number(s.bookings), nights: acc.nights + Number(s.nights), gross: acc.gross + Number(s.gross),
        payout: acc.payout + Number(s.payout), net: acc.net + Number(s.net), accommodation: acc.accommodation + Number(s.accommodation),
        currency: acc.currency ?? s.currency,
      }),
      { unit_id: 0, bookings: 0, nights: 0, gross: 0, payout: 0, net: 0, accommodation: 0, currency: null as string | null },
    ),
    days * rows.length,
  );
  const count = rows.length;
  rows = rows.slice(0, limit);
  return {
    range: { from, to, days },
    properties_included: count,
    portfolio_totals: totals,
    sorted_by: `${sortBy} ${order}`,
    properties: rows,
    truncated: count > rows.length ? `showing ${rows.length} of ${count}` : undefined,
    note: MONEY_NOTE,
  };
}

export async function movements(db: Db, date: string, days: number, property: string | undefined): Promise<Row> {
  await ensureSchema(db);
  const end = addDays(date, days);
  let filter = "";
  let ids: number[] = [];
  if (property) {
    const matched = await findListings(db, property, 40);
    ids = (await scopeFor(db, matched)).listingIds;
    if (!ids.length) return { note: `No property matched "${property}".` };
    filter = ` AND listing_id IN (${placeholders(ids.length)})`;
  }
  const cols = "id, listing_nickname AS listing, guest_name, source, check_in, check_out, nights, guests";
  // Stays longer than 400 nights are not expected; bounding check_in keeps every query on the index.
  const earliest = addDays(date, -400);
  const [arrivals, departures, inHouse] = await Promise.all([
    db.prepare(`SELECT ${cols} FROM h_reservations WHERE is_booking=1 AND check_in >= ? AND check_in < ?${filter} ORDER BY check_in, listing LIMIT 200`)
      .bind(date, end, ...ids).all(),
    db.prepare(`SELECT ${cols} FROM h_reservations WHERE is_booking=1 AND check_in >= ? AND check_in < ? AND check_out >= ? AND check_out < ?${filter} ORDER BY check_out, listing LIMIT 200`)
      .bind(earliest, end, date, end, ...ids).all(),
    db.prepare(`SELECT ${cols} FROM h_reservations WHERE is_booking=1 AND check_in >= ? AND check_in <= ? AND check_out > ?${filter} ORDER BY listing LIMIT 500`)
      .bind(earliest, date, date, ...ids).all(),
  ]);
  // Across the whole portfolio the in-house list runs to hundreds of guests;
  // return it only for a property filter (or when short), otherwise just the count.
  const showInHouse = Boolean(property) || inHouse.results.length <= 40;
  return {
    from: date,
    to: addDays(end, -1),
    arrivals: { count: arrivals.results.length, list: arrivals.results },
    departures: { count: departures.results.length, list: departures.results },
    in_house_night_of: showInHouse
      ? { date, count: inHouse.results.length, list: inHouse.results }
      : { date, count: inHouse.results.length, note: "List omitted for the whole portfolio; pass a property to see who is staying." },
  };
}

export async function findReservations(db: Db, query: string, limit: number): Promise<Row> {
  await ensureSchema(db);
  const q = query.trim();
  const cols = `id, listing_nickname AS listing, guest_name, status, is_booking, source, confirmation_code, check_in, check_out,
                nights, guests, subtotal AS gross, payout_price AS payout, net_revenue, currency, created_at, cancelled_at`;
  if (/^\d+$/.test(q)) {
    const byId = await db.prepare(`SELECT ${cols} FROM h_reservations WHERE id = ? OR confirmation_code = ? LIMIT ?`)
      .bind(Number(q), q, limit).all();
    if (byId.results.length) return { matches: byId.results };
  }
  // Every search here must use an index: a full scan of h_reservations costs
  // one D1 "row read" per stored booking, and the free plan allows 5M a day.
  const byCode = await db.prepare(`SELECT ${cols} FROM h_reservations WHERE confirmation_code = ? COLLATE NOCASE LIMIT ?`).bind(q, limit).all();
  if (byCode.results.length) return { matches: byCode.results };
  const words = tokens(q);
  if (!words.length) return { matches: [] };
  // Fast path: name starts with the query ("joanne", "joanne thomas") via the NOCASE index.
  const prefix = await db.prepare(`SELECT ${cols} FROM h_reservations WHERE guest_name LIKE ? ORDER BY check_in DESC LIMIT ?`)
    .bind(`${q.replace(/[%_]/g, "")}%`, limit).all();
  if (prefix.results.length) return { matches: prefix.results, note: "Includes enquiries and cancellations; check is_booking/status." };
  // Slow path (e.g. surname only): scan only stays from the last 75 days onwards, via the check_in index.
  const rows = await db.prepare(
    `SELECT ${cols} FROM h_reservations WHERE check_in >= date('now','-75 days') AND ${words.map(() => "lower(COALESCE(guest_name,'')) LIKE ?").join(" AND ")}
     ORDER BY check_in DESC LIMIT ?`,
  ).bind(...words.map((w) => `%${w}%`), limit).all();
  return { matches: rows.results, note: "Includes enquiries and cancellations; check is_booking/status." };
}

export async function reviews(
  db: Db, property: string | undefined, from: string | undefined, to: string | undefined, maxRating: number | undefined, limit: number,
): Promise<Row> {
  await ensureSchema(db);
  const where: string[] = [];
  const values: unknown[] = [];
  let label = "all properties";
  if (property) {
    const matched = await findListings(db, property, 40);
    const scope = await scopeFor(db, matched);
    if (!scope.listingIds.length) return { note: `No property matched "${property}".` };
    where.push(`listing_id IN (${placeholders(scope.listingIds.length)})`);
    values.push(...scope.listingIds);
    label = scope.units.map((u) => u.nickname).join(", ");
  }
  if (from) { where.push("review_date >= ?"); values.push(from); }
  if (to) { where.push("review_date <= ?"); values.push(to); }
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rowWhere = maxRating !== undefined ? `${base ? `${base} AND` : "WHERE"} rating <= ?` : base;
  const rowValues = maxRating !== undefined ? [...values, maxRating] : values;
  const [summary, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS review_count, ROUND(AVG(rating),2) AS average_rating,
                SUM(CASE WHEN rating <= 3 THEN 1 ELSE 0 END) AS three_or_below FROM h_reviews ${base}`).bind(...values).first(),
    db.prepare(`SELECT listing_nickname AS listing, guest_name, rating, review_date, source,
                substr(review_text,1,500) AS review, substr(response_text,1,300) AS response
                FROM h_reviews ${rowWhere} ORDER BY review_date DESC LIMIT ?`).bind(...rowValues, limit).all(),
  ]);
  return { scope: label, summary, reviews: rows.results };
}
