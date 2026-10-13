// Hostify API client and allowlist mappers.
// Every row that leaves this module is built field-by-field from an allowlist,
// so custom_fields (lockbox codes, WiFi passwords, phone numbers), guest
// contact details and long free-text blobs never reach the cache or the model.

export const HOSTIFY_BASE_URL = "https://api-rms.hostify.com";

export type Row = Record<string, unknown>;

export interface HostifyPage {
  items: Row[];
  page: number;
  total: number | null;
  hasMore: boolean;
}

export async function hostifyGet(apiKey: string, path: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!apiKey) throw new Error("HOSTIFY_API_KEY is not configured");
  const url = new URL(path, HOSTIFY_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  }
  const response = await fetch(url, {
    headers: { "content-type": "application/json", "x-api-key": apiKey },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    const detail = body && typeof body === "object" ? String((body as Row).error ?? (body as Row).message ?? "") : "";
    throw new Error(`Hostify API error ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return body;
}

export function extractItems(body: unknown, keys: string[]): Row[] {
  if (Array.isArray(body)) return body.filter((x) => x && typeof x === "object") as Row[];
  if (!body || typeof body !== "object") return [];
  const row = body as Row;
  for (const key of [...keys, "data", "items", "results"]) {
    if (Array.isArray(row[key])) return row[key] as Row[];
  }
  return [];
}

export async function hostifyPage(
  apiKey: string, path: string, params: Row, keys: string[], page: number, perPage: number,
): Promise<HostifyPage> {
  const body = await hostifyGet(apiKey, path, { ...params, page, per_page: perPage });
  const items = extractItems(body, keys);
  const total = body && typeof body === "object" ? num((body as Row).total) : null;
  const hasMore = total !== null ? page * perPage < total : items.length === perPage;
  return { items, page, total, hasMore };
}

// ---------- value helpers ----------

export function str(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") return null;
  return String(value);
}

export function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function pick(row: Row, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function nested(row: Row, ...keys: string[]): Row {
  for (const key of keys) {
    const value = row[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  }
  return {};
}

function day(value: unknown): string | null {
  const s = str(value);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

// Codes such as Airbnb's are sometimes returned as huge numbers in
// scientific notation; keep them as text and drop the ones that are mangled.
function code(value: unknown): string | null {
  const s = str(value);
  if (!s || /e\+/i.test(s)) return null;
  return s;
}

// ---------- reservations ----------

// Statuses that are not real stays. Anything else (accepted, confirmed,
// checked_in, ...) counts as a booking.
const NON_BOOKING = /(inquiry|enquiry|cancel|denied|declin|expired|timeout|timedout|withdrawn|pending|request|offer|preapprov|not_possible|moved|blocked|deleted)/i;

export function isBookingStatus(status: string | null): boolean {
  if (!status) return false;
  return !NON_BOOKING.test(status);
}

export interface Reservation {
  id: number;
  listing_id: number | null;
  listing_nickname: string | null;
  guest_name: string | null;
  status: string | null;
  is_booking: number;
  source: string | null;
  confirmation_code: string | null;
  check_in: string | null;
  check_out: string | null;
  nights: number | null;
  guests: number | null;
  currency: string | null;
  base_price: number | null;
  cleaning_fee: number | null;
  channel_commission: number | null;
  subtotal: number | null;
  total_price: number | null;
  revenue: number | null;
  payout_price: number | null;
  owner_revenue: number | null;
  net_revenue: number | null;
  paid_part: string | null;
  created_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  hostify_updated_at: string | null;
}

export function mapReservation(item: Row): Reservation | null {
  const id = int(pick(item, "id", "reservation_id"));
  if (id === null) return null;
  const listing = nested(item, "listing");
  const checkIn = day(pick(item, "checkIn", "check_in", "arrival_date"));
  const checkOut = day(pick(item, "checkOut", "check_out", "departure_date"));
  let nights = int(pick(item, "nights"));
  if (nights === null && checkIn && checkOut) nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000);
  const status = str(pick(item, "status"));
  return {
    id,
    listing_id: int(pick(item, "listing_id")) ?? int(listing.id),
    listing_nickname: str(pick(item, "listing_nickname")) ?? str(pick(listing, "nickname", "name")),
    guest_name: str(pick(item, "guest_name")),
    status,
    is_booking: isBookingStatus(status) ? 1 : 0,
    source: str(pick(item, "source", "channel")),
    confirmation_code: code(pick(item, "confirmation_code")),
    check_in: checkIn,
    check_out: checkOut,
    nights,
    guests: int(pick(item, "guests")),
    currency: str(pick(item, "currency")),
    base_price: num(item.base_price),
    cleaning_fee: num(item.cleaning_fee),
    channel_commission: num(item.channel_commission),
    subtotal: num(item.subtotal),
    total_price: num(item.total_price),
    revenue: num(item.revenue),
    payout_price: num(item.payout_price),
    owner_revenue: num(item.owner_revenue),
    net_revenue: num(item.net_revenue),
    paid_part: str(item.paid_part),
    created_at: str(item.created_at),
    confirmed_at: str(item.confirmed_at),
    cancelled_at: str(item.cancelled_at),
    hostify_updated_at: str(item.updated_at),
  };
}

// ---------- listings ----------

export interface Listing {
  id: number;
  nickname: string | null;
  name: string | null;
  street: string | null;
  city: string | null;
  zipcode: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  capacity: number | null;
  property_type: string | null;
  is_listed: number | null;
  parent_listing_id: number | null;
  tags: string | null;
  currency: string | null;
  default_price: number | null;
  min_nights: number | null;
}

export function mapListing(item: Row): Listing | null {
  const id = int(pick(item, "id", "listing_id"));
  if (id === null) return null;
  const tags = Array.isArray(item.tags) ? (item.tags as unknown[]).map(String).join(", ") : str(item.tags);
  return {
    id,
    nickname: str(item.nickname),
    name: str(pick(item, "name", "title")),
    street: str(item.street),
    city: str(item.city),
    zipcode: str(item.zipcode),
    bedrooms: num(item.bedrooms),
    bathrooms: num(item.bathrooms),
    capacity: int(pick(item, "person_capacity", "accommodates", "max_guests")),
    property_type: str(item.property_type),
    is_listed: int(item.is_listed),
    parent_listing_id: int(item.parent_listing_id),
    tags,
    currency: str(item.currency),
    default_price: num(pick(item, "default_daily_price", "price")),
    min_nights: int(item.min_nights),
  };
}

// Extra non-sensitive detail for a single live listing lookup.
export function mapListingDetail(item: Row): Row | null {
  const base = mapListing(item);
  if (!base) return null;
  return {
    ...base,
    country: str(item.country),
    room_type: str(item.room_type),
    beds: num(item.beds),
    guests_included: int(item.guests_included),
    cleaning_fee: num(item.cleaning_fee),
    security_deposit: num(item.security_deposit),
    extra_person_fee: num(item.extra_person),
    weekend_price: num(item.weekend_price),
    weekly_price_factor: num(item.weekly_price_factor),
    monthly_price_factor: num(item.monthly_price_factor),
    max_nights: int(item.max_nights),
    checkin_start: str(item.checkin_start),
    checkout: str(item.checkout),
    instant_booking: str(item.instant_booking),
    cancel_policy: str(item.cancel_policy),
    available_from: str(item.available_from),
    hostify_updated_at: str(item.updated_at),
  };
}

// ---------- reviews ----------

export interface Review {
  id: number;
  listing_id: number | null;
  listing_nickname: string | null;
  reservation_id: number | null;
  guest_name: string | null;
  rating: number | null;
  review_text: string | null;
  response_text: string | null;
  review_date: string | null;
  source: string | null;
}

export function mapReview(item: Row): Review | null {
  const id = int(pick(item, "id", "review_id"));
  if (id === null) return null;
  const listing = nested(item, "listing");
  return {
    id,
    listing_id: int(pick(item, "listing_id")) ?? int(listing.id),
    listing_nickname: str(pick(item, "listing_nickname")) ?? str(pick(listing, "nickname", "name")),
    reservation_id: int(pick(item, "reservation_id")),
    guest_name: str(pick(item, "guest_name", "reviewer_name")),
    rating: num(pick(item, "rating", "overall_rating", "score")),
    review_text: str(pick(item, "comments", "review", "review_text", "comment", "public_review", "text")),
    response_text: str(pick(item, "reply", "response", "response_text", "host_response")),
    review_date: day(pick(item, "created", "created_at", "submitted_at", "review_date", "date")),
    source: str(pick(item, "source", "channel", "integration_type_name")),
  };
}

// ---------- transactions ----------

export interface Transaction {
  id: number;
  listing_id: number | null;
  reservation_id: number | null;
  txn_date: string | null;
  txn_type: string | null;
  description: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
}

export function mapTransaction(item: Row): Transaction | null {
  const id = int(pick(item, "id", "transaction_id"));
  if (id === null) return null;
  return {
    id,
    listing_id: int(pick(item, "listing_id")),
    reservation_id: int(pick(item, "reservation_id")),
    txn_date: day(pick(item, "date", "transaction_date", "paid_at", "created_at")),
    txn_type: str(pick(item, "type", "transaction_type", "category")),
    description: str(pick(item, "description", "details", "memo")),
    amount: num(pick(item, "amount", "value", "total")),
    currency: str(pick(item, "currency")),
    status: str(pick(item, "status")),
  };
}

// ---------- live search ----------

// /search returns mixed object types; keep only identifying, non-sensitive fields.
const SEARCH_FIELDS = [
  "id", "type", "nickname", "name", "listing_id", "listing_nickname", "guest_name",
  "status", "checkIn", "checkOut", "check_in", "check_out", "source", "confirmation_code", "city",
];

export function mapSearchItem(item: Row): Row {
  const out: Row = {};
  for (const key of SEARCH_FIELDS) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== "" && typeof value !== "object") out[key] = value;
  }
  return out;
}
