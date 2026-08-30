import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

interface Env {
  HOSTIFY_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  DB: D1Database;
}

type Props = { login: string; name: string; email: string; accessToken: string };
type Row = Record<string, unknown>;

const HOSTIFY_BASE_URL = "https://api-rms.hostify.com";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date in YYYY-MM-DD format");
const paging = {
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(50).default(20),
};

const blockedKeys = new Set([
  "lock_pin", "lock_link", "lockbox_code", "access_code", "access_codes",
  "door_code", "pin", "hostify_checkin_form_link", "email", "phone",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row)
        .filter(([key]) => !blockedKeys.has(key.toLowerCase()))
        .map(([key, item]) => [key, redact(item)]),
    );
  }
  return value;
}

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(redact(data)) }] };
}

function textValue(row: Row, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return null;
}

function numberValue(row: Row, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function objectValue(row: Row, ...keys: string[]): Row {
  for (const key of keys) {
    const value = row[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  }
  return {};
}

function extractItems(body: unknown, preferredKeys: string[]): Row[] {
  if (Array.isArray(body)) return body.filter((item) => item && typeof item === "object") as Row[];
  if (!body || typeof body !== "object") return [];
  const row = body as Row;
  for (const key of preferredKeys) {
    if (Array.isArray(row[key])) return row[key] as Row[];
  }
  for (const key of ["data", "result", "results", "response"]) {
    const nested = row[key];
    if (Array.isArray(nested)) return nested as Row[];
    if (nested && typeof nested === "object") {
      const found = extractItems(nested, preferredKeys);
      if (found.length) return found;
    }
  }
  return [];
}

function isoDate(offsetDays = 0): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function nightsBetween(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null;
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000);
  return Number.isFinite(nights) ? nights : null;
}

export class HostifyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer(
    { name: "Home to Host – Hostify Fast", version: "2.0.0" },
    {
      instructions:
        "Use the fast cached tools for listings, bookings, reviews and financial summaries. Use live Hostify tools for current calendar availability. Never expose secrets, door codes, lock PINs, guest email addresses or phone numbers.",
    },
  );

  private async hostify(path: string, params: Record<string, unknown> = {}) {
    if (!this.env.HOSTIFY_API_KEY) throw new Error("HOSTIFY_API_KEY is not configured");
    const url = new URL(path, HOSTIFY_BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    const response = await fetch(url, {
      headers: { "content-type": "application/json", "x-api-key": this.env.HOSTIFY_API_KEY },
    });
    const body = await response.json().catch(() => ({ success: false, error: "Invalid Hostify response" }));
    if (!response.ok) throw new Error(`Hostify API error ${response.status}: ${JSON.stringify(redact(body))}`);
    return body;
  }

  private async paged(path: string, params: Row, keys: string[], maxPages: number): Promise<Row[]> {
    const all: Row[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const body = await this.hostify(path, { ...params, page, per_page: 50 });
      const items = extractItems(body, keys);
      all.push(...items);
      if (items.length < 50) break;
    }
    return all;
  }

  private async batch(statements: D1PreparedStatement[]) {
    for (let start = 0; start < statements.length; start += 75) {
      await this.env.DB.batch(statements.slice(start, start + 75));
    }
  }

  private async syncStatus(type: string, status: string, count = 0, error: string | null = null) {
    const completed = status === "complete" || status === "error" ? new Date().toISOString() : null;
    await this.env.DB.prepare(
      `INSERT INTO sync_status (data_type,last_started_at,last_completed_at,records_synced,status,error_message)
       VALUES (?,CURRENT_TIMESTAMP,?,?,?,?)
       ON CONFLICT(data_type) DO UPDATE SET
         last_started_at=CASE WHEN excluded.status='running' THEN CURRENT_TIMESTAMP ELSE last_started_at END,
         last_completed_at=COALESCE(excluded.last_completed_at,last_completed_at),
         records_synced=excluded.records_synced,status=excluded.status,error_message=excluded.error_message`,
    ).bind(type, completed, count, status, error).run();
  }

  private async syncListings(): Promise<number> {
    const items = await this.paged("/listings", { include_related_objects: 0 }, ["listings", "items"], 20);
    const statements = items.map((item) => {
      const address = objectValue(item, "address", "location");
      return this.env.DB.prepare(
        `INSERT INTO listings (id,name,status,address,city,bedrooms,bathrooms,accommodates,currency,raw_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,address=excluded.address,
         city=excluded.city,bedrooms=excluded.bedrooms,bathrooms=excluded.bathrooms,
         accommodates=excluded.accommodates,currency=excluded.currency,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP`,
      ).bind(
        textValue(item, "id", "listing_id", "listingId"),
        textValue(item, "name", "title", "nickname") || "Unnamed listing",
        textValue(item, "status", "listing_status"),
        textValue(item, "address", "full_address") || textValue(address, "formatted", "address", "line1"),
        textValue(item, "city") || textValue(address, "city"),
        numberValue(item, "bedrooms", "bedroom_count"),
        numberValue(item, "bathrooms", "bathroom_count"),
        numberValue(item, "accommodates", "guests", "max_guests"),
        textValue(item, "currency", "currency_code"),
        JSON.stringify(redact(item)),
      );
    }).filter((_, index) => Boolean(textValue(items[index], "id", "listing_id", "listingId")));
    await this.batch(statements);
    return statements.length;
  }

  private async syncReservations(from: string, to: string): Promise<number> {
    const items = await this.paged(
      "/reservations",
      { start_date: from, end_date: to, sort: "checkIn", fees: 1 },
      ["reservations", "items"],
      100,
    );
    const statements = items.map((item) => {
      const listing = objectValue(item, "listing", "property");
      const guest = objectValue(item, "guest", "customer");
      const pricing = objectValue(item, "pricing", "financials", "money");
      const checkIn = textValue(item, "checkIn", "check_in", "arrival_date", "arrival");
      const checkOut = textValue(item, "checkOut", "check_out", "departure_date", "departure");
      const id = textValue(item, "id", "reservation_id", "reservationId");
      return { id, statement: this.env.DB.prepare(
        `INSERT INTO reservations (id,listing_id,listing_name,guest_name,status,check_in,check_out,nights,guests,currency,total_price,host_payout,channel,raw_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET listing_id=excluded.listing_id,listing_name=excluded.listing_name,
         guest_name=excluded.guest_name,status=excluded.status,check_in=excluded.check_in,check_out=excluded.check_out,
         nights=excluded.nights,guests=excluded.guests,currency=excluded.currency,total_price=excluded.total_price,
         host_payout=excluded.host_payout,channel=excluded.channel,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP`,
      ).bind(
        id,
        textValue(item, "listing_id", "listingId") || textValue(listing, "id"),
        textValue(item, "listing_name", "property_name") || textValue(listing, "name", "title"),
        textValue(item, "guest_name", "guestName") || textValue(guest, "name", "full_name"),
        textValue(item, "status"), checkIn, checkOut,
        numberValue(item, "nights") ?? nightsBetween(checkIn, checkOut),
        numberValue(item, "guests", "guest_count", "number_of_guests"),
        textValue(item, "currency") || textValue(pricing, "currency"),
        numberValue(item, "total_price", "totalPrice", "total") ?? numberValue(pricing, "total", "total_price"),
        numberValue(item, "host_payout", "hostPayout", "net_income", "netIncome") ?? numberValue(pricing, "host_payout", "net", "payout"),
        textValue(item, "channel", "source", "platform"),
        JSON.stringify(redact(item)),
      ) };
    }).filter((entry) => Boolean(entry.id));
    await this.batch(statements.map((entry) => entry.statement));
    return statements.length;
  }

  private async syncReviews(from: string, to: string): Promise<number> {
    const items = await this.paged("/reviews", { created_from: from, created_to: to }, ["reviews", "items"], 100);
    const statements = items.map((item) => {
      const listing = objectValue(item, "listing", "property");
      const guest = objectValue(item, "guest", "reviewer");
      const id = textValue(item, "id", "review_id", "reviewId");
      return { id, statement: this.env.DB.prepare(
        `INSERT INTO reviews (id,listing_id,listing_name,reservation_id,guest_name,rating,review_text,response_text,review_date,channel,raw_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET listing_id=excluded.listing_id,listing_name=excluded.listing_name,
         reservation_id=excluded.reservation_id,guest_name=excluded.guest_name,rating=excluded.rating,
         review_text=excluded.review_text,response_text=excluded.response_text,review_date=excluded.review_date,
         channel=excluded.channel,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP`,
      ).bind(
        id,
        textValue(item, "listing_id", "listingId") || textValue(listing, "id"),
        textValue(item, "listing_name", "property_name") || textValue(listing, "name", "title"),
        textValue(item, "reservation_id", "reservationId"),
        textValue(item, "guest_name", "reviewer_name") || textValue(guest, "name", "full_name"),
        numberValue(item, "rating", "score", "overall_rating"),
        textValue(item, "review", "review_text", "comment", "text"),
        textValue(item, "response", "response_text", "reply"),
        textValue(item, "created_at", "review_date", "date"),
        textValue(item, "channel", "source", "platform"),
        JSON.stringify(redact(item)),
      ) };
    }).filter((entry) => Boolean(entry.id));
    await this.batch(statements.map((entry) => entry.statement));
    return statements.length;
  }

  private async syncTransactions(): Promise<number> {
    const items = await this.paged("/transactions", {}, ["transactions", "items"], 100);
    const statements = items.map((item) => {
      const listing = objectValue(item, "listing", "property");
      const id = textValue(item, "id", "transaction_id", "transactionId");
      return { id, statement: this.env.DB.prepare(
        `INSERT INTO transactions (id,listing_id,listing_name,reservation_id,transaction_date,transaction_type,description,amount,currency,status,raw_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET listing_id=excluded.listing_id,listing_name=excluded.listing_name,
         reservation_id=excluded.reservation_id,transaction_date=excluded.transaction_date,
         transaction_type=excluded.transaction_type,description=excluded.description,amount=excluded.amount,
         currency=excluded.currency,status=excluded.status,raw_json=excluded.raw_json,updated_at=CURRENT_TIMESTAMP`,
      ).bind(
        id,
        textValue(item, "listing_id", "listingId") || textValue(listing, "id"),
        textValue(item, "listing_name", "property_name") || textValue(listing, "name", "title"),
        textValue(item, "reservation_id", "reservationId"),
        textValue(item, "date", "transaction_date", "created_at", "paid_at"),
        textValue(item, "type", "transaction_type", "category"),
        textValue(item, "description", "memo", "name"),
        numberValue(item, "amount", "value", "total"),
        textValue(item, "currency", "currency_code"),
        textValue(item, "status"),
        JSON.stringify(redact(item)),
      ) };
    }).filter((entry) => Boolean(entry.id));
    await this.batch(statements.map((entry) => entry.statement));
    return statements.length;
  }

  async init() {
    this.server.tool(
      "refresh_hostify_cache",
      "Refresh the fast Hostify cache. Use after setup or when fresh bookings, reviews or financial data are needed.",
      {
        data_types: z.array(z.enum(["listings", "reservations", "reviews", "transactions"])).default(["listings", "reservations", "reviews"]),
        from_date: date.default(isoDate(-730)),
        to_date: date.default(isoDate(730)),
      },
      async ({ data_types, from_date, to_date }) => {
        const summary: Row = {};
        for (const type of data_types) {
          await this.syncStatus(type, "running");
          try {
            const count = type === "listings" ? await this.syncListings()
              : type === "reservations" ? await this.syncReservations(from_date, to_date)
              : type === "reviews" ? await this.syncReviews(from_date, to_date)
              : await this.syncTransactions();
            await this.syncStatus(type, "complete", count);
            summary[type] = { status: "complete", records: count };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.syncStatus(type, "error", 0, message);
            summary[type] = { status: "error", error: message };
          }
        }
        return result({ refreshed: summary, from_date, to_date });
      },
    );

    this.server.tool(
      "hostify_cache_status",
      "Show when each Hostify dataset was last refreshed and how many records were cached.",
      {},
      async () => result((await this.env.DB.prepare("SELECT * FROM sync_status ORDER BY data_type").all()).results),
    );

    this.server.tool(
      "find_property",
      "Fast fuzzy property-name search. Use plain English names such as Durlston 52 or Ridgeway 47.",
      { property_name: z.string().min(1), limit: z.number().int().min(1).max(20).default(10) },
      async ({ property_name, limit }) => result((await this.env.DB.prepare(
        `SELECT id,name,status,address,city,bedrooms,bathrooms,accommodates,currency,updated_at
         FROM listings WHERE name LIKE ? COLLATE NOCASE ORDER BY CASE WHEN lower(name)=lower(?) THEN 0 ELSE 1 END,name LIMIT ?`,
      ).bind(`%${property_name}%`, property_name, limit).all()).results),
    );

    this.server.tool(
      "get_property_bookings_fast",
      "Fast compact booking search by property name and dates. Returns totals plus matching bookings without large raw Hostify payloads.",
      {
        property_name: z.string().min(1),
        from_date: date,
        to_date: date,
        status: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(200),
      },
      async ({ property_name, from_date, to_date, status, limit }) => {
        const filter = status ? " AND lower(status)=lower(?)" : "";
        const values: unknown[] = [`%${property_name}%`, to_date, from_date];
        if (status) values.push(status);
        const summary = await this.env.DB.prepare(
          `SELECT COUNT(*) booking_count,COALESCE(SUM(nights),0) nights,COALESCE(SUM(total_price),0) total_price,
           COALESCE(SUM(host_payout),0) host_payout,MIN(currency) currency
           FROM reservations WHERE listing_name LIKE ? COLLATE NOCASE AND check_in<=? AND check_out>=?${filter}`,
        ).bind(...values).first();
        const rows = await this.env.DB.prepare(
          `SELECT id,listing_name,guest_name,status,check_in,check_out,nights,guests,currency,total_price,host_payout,channel
           FROM reservations WHERE listing_name LIKE ? COLLATE NOCASE AND check_in<=? AND check_out>=?${filter}
           ORDER BY check_in LIMIT ?`,
        ).bind(...values, limit).all();
        return result({ summary, bookings: rows.results, returned: rows.results.length });
      },
    );

    this.server.tool(
      "get_property_reviews_fast",
      "Fast review lookup for one property using its plain-English name.",
      {
        property_name: z.string().min(1),
        from_date: date.optional(),
        to_date: date.optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      async ({ property_name, from_date, to_date, limit }) => {
        const values: unknown[] = [`%${property_name}%`];
        let dates = "";
        if (from_date) { dates += " AND review_date>=?"; values.push(from_date); }
        if (to_date) { dates += " AND review_date<=?"; values.push(to_date); }
        const summary = await this.env.DB.prepare(
          `SELECT COUNT(*) review_count,ROUND(AVG(rating),2) average_rating FROM reviews
           WHERE listing_name LIKE ? COLLATE NOCASE${dates}`,
        ).bind(...values).first();
        const rows = await this.env.DB.prepare(
          `SELECT id,listing_name,guest_name,rating,review_text,response_text,review_date,channel
           FROM reviews WHERE listing_name LIKE ? COLLATE NOCASE${dates} ORDER BY review_date DESC LIMIT ?`,
        ).bind(...values, limit).all();
        return result({ summary, reviews: rows.results, returned: rows.results.length });
      },
    );

    this.server.tool(
      "get_property_financial_summary_fast",
      "Fast financial summary for one property and date range using cached reservations and transactions.",
      { property_name: z.string().min(1), from_date: date, to_date: date },
      async ({ property_name, from_date, to_date }) => {
        const bookings = await this.env.DB.prepare(
          `SELECT COUNT(*) booking_count,COALESCE(SUM(nights),0) booked_nights,
           COALESCE(SUM(total_price),0) booking_total,COALESCE(SUM(host_payout),0) host_payout,MIN(currency) currency
           FROM reservations WHERE listing_name LIKE ? COLLATE NOCASE AND check_in<=? AND check_out>=?`,
        ).bind(`%${property_name}%`, to_date, from_date).first();
        const transactions = await this.env.DB.prepare(
          `SELECT COUNT(*) transaction_count,COALESCE(SUM(amount),0) transaction_total,MIN(currency) currency
           FROM transactions WHERE listing_name LIKE ? COLLATE NOCASE AND transaction_date>=? AND transaction_date<=?`,
        ).bind(`%${property_name}%`, from_date, to_date).first();
        return result({ property_name, from_date, to_date, bookings, transactions });
      },
    );

    this.server.tool(
      "list_listings",
      "List Hostify properties directly from Hostify. Prefer find_property for faster name searches.",
      { ...paging, include_related_objects: z.boolean().default(false) },
      async ({ page, per_page, include_related_objects }) => result(await this.hostify("/listings", { page, per_page, include_related_objects: include_related_objects ? 1 : 0 })),
    );

    this.server.tool(
      "get_listing",
      "Get detailed live information for one Hostify listing. Sensitive fields are removed.",
      { listing_id: z.number().int().positive(), include_related_objects: z.boolean().default(true) },
      async ({ listing_id, include_related_objects }) => result(await this.hostify(`/listings/${listing_id}`, { include_related_objects: include_related_objects ? 1 : 0 })),
    );

    this.server.tool(
      "list_reservations",
      "List reservations directly from Hostify. Prefer get_property_bookings_fast for normal analysis.",
      {
        ...paging, listing_id: z.number().int().positive().optional(), start_date: date, end_date: date,
        status: z.string().optional(), sort: z.enum(["checkIn", "checkOut", "confirmed_at"]).default("checkIn"),
        include_fees: z.boolean().default(false),
      },
      async ({ page, per_page, listing_id, start_date, end_date, status, sort, include_fees }) => {
        const filters = status ? [{ field: "status", operator: "=", value: status }] : undefined;
        return result(await this.hostify("/reservations", { page, per_page, listing_id, start_date, end_date, sort, fees: include_fees ? 1 : 0, filters }));
      },
    );

    this.server.tool(
      "get_reservation",
      "Get one live reservation with pricing and fees. Sensitive fields are removed.",
      { reservation_id: z.number().int().positive(), include_fees: z.boolean().default(true) },
      async ({ reservation_id, include_fees }) => result(await this.hostify(`/reservations/${reservation_id}`, { fees: include_fees ? 1 : 0 })),
    );

    this.server.tool(
      "get_calendar",
      "Get live nightly availability, price and minimum stay for one listing and date range.",
      { listing_id: z.number().int().positive(), start_date: date, end_date: date },
      async ({ listing_id, start_date, end_date }) => result(await this.hostify("/calendar", { listing_id, start_date, end_date })),
    );

    this.server.tool(
      "list_reviews",
      "List reviews directly from Hostify. Prefer get_property_reviews_fast for property-specific analysis.",
      { ...paging, created_from: date, created_to: date, city: z.string().optional() },
      async ({ page, per_page, created_from, created_to, city }) => result(await this.hostify("/reviews", { page, per_page, created_from, created_to, city })),
    );

    this.server.tool(
      "list_transactions",
      "List transactions directly from Hostify.",
      { ...paging, reservation_id: z.number().int().positive().optional(), listing_id: z.number().int().positive().optional() },
      async ({ page, per_page, reservation_id, listing_id }) => result(await this.hostify("/transactions", { page, per_page, reservation_id, listing_id })),
    );

    this.server.tool(
      "search_hostify",
      "Search Hostify directly across listings, reservations, guests or integrations. Sensitive fields are removed.",
      { query: z.string().min(2), type: z.enum(["guests", "reservations", "listings", "integrations"]).optional() },
      async ({ query, type }) => result(await this.hostify("/search", { q: query, type })),
    );
  }
}

export default new OAuthProvider({
  apiHandler: HostifyMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: "/token",
});
