import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import {
  extractAmenities, extractDescription, extractItems, extractPhotos, hostifyGet, keyOutline,
  mapListing, mapListingDetail, mapReservation, mapSearchItem, Row,
} from "./hostify";
import {
  findListings, findReservations, scopeForQuery, movements, portfolioPerformance, propertyPerformance, reviews,
} from "./queries";
import { ensureSchema } from "./schema";
import { inboxDiagnostics, messagesForListings } from "./inbox";
import { freshness, runInboxMessages, runSync, syncStatus } from "./sync";
import {
  executePending, previewCancelReservation, previewCreateReservation, previewGuestMessage, previewUpdateReservation,
  readGuestThread, recentWrites, writesEnabled,
} from "./writes";

interface Env {
  HOSTIFY_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  DB: D1Database;
  SYNC_PAGES_PER_RUN?: string;
  WRITES_ENABLED?: string;
  INBOX_THREADS_PER_RUN?: string;
  INBOX_HISTORY_DAYS?: string;
}

type Props = { login: string; name: string; email: string; accessToken: string };

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const BOOKING_JOBS = ["reservations_hot", "reservations_full"];

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// For live payloads with no fixed shape (calendar): drop anything that could
// carry access details or guest contact data.
const SENSITIVE = /(custom_fields|email|phone|pin|lock|password|wifi|access|door|code|instructions|link|photo|notes|details)/i;
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row).filter(([k]) => !SENSITIVE.test(k)).map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

const INSTRUCTIONS = [
  "Home to Host property data from Hostify.",
  "Answer from the cached tools first — they are instant and pre-computed: find_property, property_performance, portfolio_performance,",
  "arrivals_departures, find_reservation, property_reviews, guest_message_history. The cache refreshes itself every few minutes; each answer carries a data_freshness stamp.",
  "Use one call per question: property_performance already includes totals, occupancy, ADR and the booking list.",
  "Use live tools only for what the cache cannot answer: get_calendar (open nights and today's prices), get_reservation (fee breakdown of one booking),",
  "or when data_freshness says the cache is stale. Properties can be named by nickname, street or postcode (e.g. 'Holmbury 7', 'Durlston 52', 'E5 8RR').",
  "Never reveal door codes, lock PINs, WiFi passwords, guest emails or phone numbers.",
].join(" ");

export class HostifyMCPV2 extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "Home to Host – Hostify", version: "3.4.0" }, { instructions: INSTRUCTIONS });

  async init() {
    const db = () => this.env.DB;

    // ---------------- cached (fast) ----------------

    this.server.tool(
      "find_property",
      "Instant. Find properties by nickname, title, street or postcode (any word order). Returns ids, nicknames, bedrooms and capacity.",
      { query: z.string().min(1), limit: z.number().int().min(1).max(30).default(10) },
      async ({ query, limit }) => {
        try {
          const rows = await findListings(db(), query, limit);
          return result({ matches: rows, data_freshness: await freshness(db(), ["listings"]) });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "property_performance",
      "Instant. Everything about one property (or every property matching a name) for a date range in one call: bookings, booked nights, " +
      "occupancy %, gross, payout and net revenue, ADR, transactions, and the booking list. Nights and money are clipped to the range; " +
      "enquiries and cancellations are excluded (counted separately under not_counted).",
      {
        property: z.string().min(1).describe("Nickname, street or postcode, e.g. 'Holmbury 7'"),
        from_date: date,
        to_date: date.describe("Inclusive last night, YYYY-MM-DD"),
        include_bookings: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(40),
      },
      async ({ property, from_date, to_date, include_bookings, limit }) => {
        try {
          const data = await propertyPerformance(db(), property, from_date, to_date, include_bookings, limit);
          return result({ ...data, data_freshness: await freshness(db(), [...BOOKING_JOBS, "listings"]) });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "portfolio_performance",
      "Instant. Ranks every live property for a date range by revenue, occupancy, nights or ADR, with portfolio totals. " +
      "Use for 'which properties are empty / best / worst this month'. Optional filter narrows by name, street or postcode.",
      {
        from_date: date,
        to_date: date,
        sort_by: z.enum(["revenue", "occupancy", "nights", "adr"]).default("revenue"),
        order: z.enum(["desc", "asc"]).default("desc"),
        limit: z.number().int().min(1).max(500).default(30),
        filter: z.string().optional().describe("e.g. 'Hackney' or 'E5'"),
      },
      async ({ from_date, to_date, sort_by, order, limit, filter }) => {
        try {
          const data = await portfolioPerformance(db(), from_date, to_date, sort_by, order, limit, filter);
          return result({ ...data, data_freshness: await freshness(db(), [...BOOKING_JOBS, "listings"]) });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "arrivals_departures",
      "Instant. Check-ins, check-outs and who is in-house, across all properties or one, for a day or several days.",
      {
        date,
        days: z.number().int().min(1).max(31).default(1),
        property: z.string().optional(),
      },
      async ({ date: day, days, property }) => {
        try {
          const data = await movements(db(), day, days, property);
          return result({ ...data, data_freshness: await freshness(db(), ["reservations_hot"]) });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "find_reservation",
      "Instant. Find bookings by confirmation code, reservation id or guest name (full name or first name works best; surname-only searches cover stays from the last 75 days on). " +
      "Covers the cached window, about 2 months back to 6 months ahead; for older bookings use list_reservations_live. Includes enquiries and cancellations (see status). " +
      "To check many bookings, prefer one property_performance or arrivals_departures call over many find_reservation calls.",
      { query: z.string().min(2), limit: z.number().int().min(1).max(50).default(15) },
      async ({ query, limit }) => {
        try {
          const data = await findReservations(db(), query, limit);
          return result({ ...data, data_freshness: await freshness(db(), BOOKING_JOBS) });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "property_reviews",
      "Instant. Review count, average rating and recent reviews for one property or the whole portfolio. " +
      "Use max_rating (e.g. 3) to list only poor reviews.",
      {
        property: z.string().optional(),
        from_date: date.optional(),
        to_date: date.optional(),
        max_rating: z.number().min(0).max(10).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      async ({ property, from_date, to_date, max_rating, limit }) => {
        try {
          const data = await reviews(db(), property, from_date, to_date, max_rating, limit);
          return result({ ...data, data_freshness: await freshness(db(), ["reviews"]) });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "guest_message_history",
      "Instant. Past guest conversations for one property (all its channel listings), newest first: what guests asked and what the team answered. " +
      "Use it to build per-property guest FAQs or to see how an issue was handled before. Filter by sender ('guest' = guest questions only) or a search word " +
      "(e.g. 'heating', 'parking', 'wifi'). Contact details and access codes are already removed.",
      {
        property: z.string().min(1).describe("Nickname, street or postcode"),
        from_date: date.optional(),
        to_date: date.optional(),
        sender: z.enum(["guest", "team"]).optional(),
        search: z.string().min(2).max(60).optional(),
        limit: z.number().int().min(1).max(300).default(100),
      },
      async ({ property, from_date, to_date, sender, search, limit }) => {
        try {
          const scope = await scopeForQuery(db(), property);
          if (!scope.listingIds.length) return result({ note: `No property matched "${property}".` });
          const messages = await messagesForListings(db(), scope.listingIds, { from: from_date, to: to_date, sender, search, limit });
          return result({ property: scope.units, count: messages.length, messages, data_freshness: await freshness(db(), ["inbox_threads", "inbox_recent"]) });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "inbox_diagnostics",
      "Technical check of the Hostify inbox connection: field names Hostify returns for threads and messages (no message content). Optional reservation_id shows its thread ids.",
      { reservation_id: z.number().int().positive().optional() },
      async ({ reservation_id }) => {
        try { return result(await inboxDiagnostics(this.env, reservation_id)); } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "cache_status",
      "How fresh each cached dataset is. The cache updates itself automatically; check this only if an answer looks out of date.",
      {},
      async () => {
        try { return result(await syncStatus(db())); } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "sync_now",
      "Pull a few more pages from Hostify into the cache immediately. Rarely needed — the cache refreshes itself every few minutes.",
      { pages: z.number().int().min(1).max(10).default(6) },
      async ({ pages }) => {
        try { return result(await runSync(this.env, pages)); } catch (e) { return failure(e); }
      },
    );

    // ---------------- live (slower, call Hostify directly) ----------------

    this.server.tool(
      "get_calendar",
      "Live from Hostify. Nightly availability, price and minimum stay for one listing id and date range. Use find_property first for the id.",
      { listing_id: z.number().int().positive(), start_date: date, end_date: date },
      async ({ listing_id, start_date, end_date }) => {
        try {
          return result(scrub(await hostifyGet(this.env.HOSTIFY_API_KEY, "/calendar", { listing_id, start_date, end_date })));
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "get_reservation",
      "Live from Hostify. Current details and fee breakdown of one reservation id.",
      { reservation_id: z.number().int().positive() },
      async ({ reservation_id }) => {
        try {
          const body = await hostifyGet(this.env.HOSTIFY_API_KEY, `/reservations/${reservation_id}`, { fees: 1 }) as Row;
          const item = (body.reservation && typeof body.reservation === "object" ? body.reservation : body) as Row;
          return result({ reservation: mapReservation(item), source: "live" });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "get_listing",
      "Live from Hostify. Settings of one listing id: pricing defaults, fees, min/max nights, check-in times.",
      { listing_id: z.number().int().positive() },
      async ({ listing_id }) => {
        try {
          const body = await hostifyGet(this.env.HOSTIFY_API_KEY, `/listings/${listing_id}`, { include_related_objects: 0 }) as Row;
          const item = (body.listing && typeof body.listing === "object" ? body.listing : body) as Row;
          return result({ listing: mapListingDetail(item), source: "live" });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "get_listing_content",
      "Live from Hostify. Public, guest-facing content of one listing id for the website: photo URLs with captions (in order), " +
      "the public description sections and amenity names. Never includes access, check-in or house-manual text.",
      { listing_id: z.number().int().positive(), max_photos: z.number().int().min(1).max(100).default(40) },
      async ({ listing_id, max_photos }) => {
        try {
          const apiKey = this.env.HOSTIFY_API_KEY;
          const body = await hostifyGet(apiKey, `/listings/${listing_id}`, { include_related_objects: 1 }) as Row;
          const listing = (body.listing && typeof body.listing === "object" ? body.listing : body) as Row;
          const sources: Row[] = [listing, body];
          const tried = [`/listings/${listing_id}?include_related_objects=1`];

          // Some accounts serve photos from their own endpoint; try those only if needed.
          if (!extractPhotos(sources).length) {
            for (const [path, params] of [
              [`/listings/${listing_id}/photos`, {}],
              ["/photos", { listing_id }],
            ] as [string, Row][]) {
              tried.push(path);
              try {
                const extra = await hostifyGet(apiKey, path, params);
                const items = extractItems(extra, ["photos", "images"]);
                if (items.length) { sources.push({ photos: items }); break; }
              } catch { /* endpoint not available on this account */ }
            }
          }

          const photos = extractPhotos(sources);
          const description = extractDescription(sources);
          const out: Row = {
            listing: mapListing(listing),
            photo_count: photos.length,
            photos: photos.slice(0, max_photos),
            description,
            amenities: extractAmenities(sources),
            source: "live",
          };
          if (!photos.length || !Object.keys(description).length) {
            out.diagnostics = { endpoints_tried: tried, response_keys: keyOutline(sources.slice(0, 2)) };
          }
          return result(out);
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "list_reservations_live",
      "Live from Hostify, slow. Only if the cache is stale and the answer must be up to the minute. Prefer property_performance or arrivals_departures.",
      {
        start_date: date,
        end_date: date,
        listing_id: z.number().int().positive().optional(),
        page: z.number().int().positive().default(1),
        per_page: z.number().int().min(1).max(50).default(50),
      },
      async ({ start_date, end_date, listing_id, page, per_page }) => {
        try {
          const body = await hostifyGet(this.env.HOSTIFY_API_KEY, "/reservations", {
            start_date, end_date, listing_id, page, per_page, sort: "checkIn", fees: 1,
          }) as Row;
          const items = extractItems(body, ["reservations"]).map(mapReservation).filter(Boolean);
          return result({ total: body.total ?? null, page, per_page, reservations: items, source: "live" });
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "search_hostify",
      "Live Hostify search across guests, reservations and listings. Prefer find_reservation / find_property, which are instant.",
      { query: z.string().min(2), type: z.enum(["guests", "reservations", "listings"]).optional() },
      async ({ query, type }) => {
        try {
          const body = await hostifyGet(this.env.HOSTIFY_API_KEY, "/search", { q: query, type }) as Row;
          const groups: Row = {};
          for (const [key, value] of Object.entries(body)) {
            if (Array.isArray(value)) groups[key] = (value as Row[]).slice(0, 25).map(mapSearchItem);
          }
          return result({ results: groups, source: "live" });
        } catch (e) { return failure(e); }
      },
    );

    // ---------------- writes (preview → confirm) ----------------

    const writesOff = () => failure("Write actions are switched off (WRITES_ENABLED is not 'true').");
    const who = () => this.props?.login ?? "unknown";

    this.server.tool(
      "create_reservation",
      "WRITE – step 1 of 2. Prepares a new reservation (direct / corporate booking) on a Hostify listing and returns a preview: " +
      "resolved property, nights, availability check, clashes with existing bookings, and the exact request. NOTHING is created yet. " +
      "Show the preview to the user; only if they say yes, call confirm_write with confirm_token.",
      {
        property: z.string().min(1).describe("Listing id, or nickname/street/postcode. If several match you get candidates back."),
        check_in: date,
        check_out: date.describe("Departure date, YYYY-MM-DD"),
        guest_name: z.string().min(2).max(120),
        guests: z.number().int().min(1).max(30).default(1),
        total_price: z.number().min(0).optional().describe("Total stay price the guest pays"),
        currency: z.string().length(3).optional().describe("e.g. GBP"),
        source: z.string().min(2).max(40).default("direct").describe("Booking source/channel, e.g. direct, ICAB, corporate"),
        status: z.enum(["accepted", "pending"]).default("accepted"),
        guest_email: z.string().email().describe("Required by Hostify"),
        guest_phone: z.string().min(5).max(30).describe("Required by Hostify, e.g. +447700900000"),
        note: z.string().max(1000).optional().describe("Internal note on the booking"),
        base_price: z.number().min(0).optional().describe("Optional base price (before fees)"),
        pets: z.number().int().min(0).max(5).optional(),
        allow_overlap: z.boolean().default(false)
          .describe("DANGER: lets Hostify accept dates that clash with another booking (double booking). Only when the user explicitly asks."),
        extra_fields: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe("Advanced: extra Hostify fields to include as-is"),
      },
      async (args) => {
        if (!writesEnabled(this.env)) return writesOff();
        try { return result(await previewCreateReservation(this.env, args, who())); } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "cancel_reservation",
      "WRITE – step 1 of 2. Prepares cancelling one reservation. DIRECT BOOKINGS ONLY: bookings from Airbnb, Booking.com or any other " +
      "channel are refused. Checks the live booking in Hostify and returns a preview; NOTHING is cancelled yet. Use find_reservation " +
      "first to get the reservation id. Show the preview; only if the user says yes, call confirm_write with confirm_token.",
      {
        reservation_id: z.number().int().positive(),
        reason: z.string().max(500).optional().describe("Why it is being cancelled (kept in the write log)"),
        cancelled_by: z.enum(["host", "guest"]).default("host")
          .describe("Who is cancelling: host → cancelled_by_host (default), guest → cancelled_by_guest"),
      },
      async ({ reservation_id, reason, cancelled_by }) => {
        if (!writesEnabled(this.env)) return writesOff();
        try { return result(await previewCancelReservation(this.env, reservation_id, reason, who(), cancelled_by)); } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "update_reservation",
      "WRITE – step 1 of 2. Prepares changes to one reservation: new dates (direct bookings only), internal notes (appended by default), " +
      "planned arrival/departure times, or check-in / check-out marks. Returns a before/after preview; NOTHING is changed yet. " +
      "Show the preview; only if the user says yes, call confirm_write with confirm_token.",
      {
        reservation_id: z.number().int().positive(),
        check_in: date.optional().describe("New arrival date (direct bookings only)"),
        check_out: date.optional().describe("New departure date (direct bookings only)"),
        notes: z.string().max(2000).optional().describe("Internal reservation notes"),
        notes_mode: z.enum(["append", "replace"]).default("append").describe("append keeps existing notes; replace overwrites them"),
        planned_arrival: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().describe("HH:MM"),
        planned_departure: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().describe("HH:MM"),
        checked_in: z.boolean().optional().describe("true = mark checked-in, false = undo"),
        checked_out: z.boolean().optional().describe("true = mark checked-out, false = undo"),
        allow_overlap: z.boolean().default(false).describe("Only if the user explicitly accepts a double booking"),
      },
      async (args) => {
        if (!writesEnabled(this.env)) return writesOff();
        try { return result(await previewUpdateReservation(this.env, args, who())); } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "read_guest_messages",
      "Live from Hostify. The message thread for one reservation (or thread id), newest first. Emails and phone numbers are hidden.",
      {
        reservation_id: z.number().int().positive().optional(),
        thread_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(50).default(15),
      },
      async ({ reservation_id, thread_id, limit }) => {
        try { return result(await readGuestThread(this.env, reservation_id, thread_id, limit)); } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "send_guest_message",
      "WRITE – step 1 of 2. Prepares a message to the guest of one reservation (via the booking channel by default), or an internal team " +
      "note on the thread (kind=internal_note, never sent to the guest). Returns a preview with who it goes to and the exact text; NOTHING is sent yet. " +
      "Show the full message to the user; only if they say yes, call confirm_write. Never invent or add content the user did not approve.",
      {
        reservation_id: z.number().int().positive().optional(),
        thread_id: z.number().int().positive().optional(),
        message: z.string().min(1).max(4000),
        kind: z.enum(["reply", "internal_note"]).default("reply"),
        send_by: z.enum(["channel", "email", "sms", "whatsapp"]).default("channel"),
      },
      async (args) => {
        if (!writesEnabled(this.env)) return writesOff();
        try { return result(await previewGuestMessage(this.env, args, who())); } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "confirm_write",
      "WRITE – step 2 of 2. Sends a previewed change to Hostify. Only call after the user has seen the preview and explicitly said yes. " +
      "Each token works once and expires after 15 minutes.",
      { confirm_token: z.string().min(6).max(40) },
      async ({ confirm_token }) => {
        if (!writesEnabled(this.env)) return writesOff();
        try {
          const out = await executePending(this.env, confirm_token, who());
          // Pull the new booking into the cache soon after.
          this.ctx.waitUntil(runSync(this.env, 2).catch(() => undefined));
          return result(out);
        } catch (e) { return failure(e); }
      },
    );

    this.server.tool(
      "write_log",
      "Recent changes sent to Hostify through this connector (who, when, what, result).",
      { limit: z.number().int().min(1).max(50).default(10) },
      async ({ limit }) => {
        try { return result({ writes: await recentWrites(this.env.DB, limit) }); } catch (e) { return failure(e); }
      },
    );
  }
}

// Private entry point for the hometohost.com website worker (service binding "HOSTIFY",
// entrypoint "SiteData"). Returns a listing's public photos, description and amenities, so the
// website needs no Hostify key of its own. Not reachable from the internet.
export class SiteData extends WorkerEntrypoint<Env> {
  async listingContent(listingId: number): Promise<Row> {
    if (!Number.isInteger(listingId) || listingId <= 0) throw new Error("bad listing id");
    const apiKey = this.env.HOSTIFY_API_KEY;
    const body = await hostifyGet(apiKey, `/listings/${listingId}`, { include_related_objects: 1 }) as Row;
    const listing = (body.listing && typeof body.listing === "object" ? body.listing : body) as Row;
    const sources: Row[] = [listing, body];
    if (!extractPhotos(sources).length) {
      for (const [path, params] of [[`/listings/${listingId}/photos`, {}], ["/photos", { listing_id: listingId }]] as [string, Row][]) {
        try {
          const items = extractItems(await hostifyGet(apiKey, path, params), ["photos", "images"]);
          if (items.length) { sources.push({ photos: items }); break; }
        } catch { /* endpoint not available on this account */ }
      }
    }
    const photos = extractPhotos(sources);
    return {
      listing: mapListing(listing), photo_count: photos.length, photos: photos.slice(0, 20),
      description: extractDescription(sources), amenities: extractAmenities(sources), source: "live",
    };
  }
}

// Kept so the existing Durable Object migration still resolves.
export class HostifyMCP extends HostifyMCPV2 {}

const oauth = new OAuthProvider({
  apiHandler: HostifyMCPV2.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: "/token",
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => oauth.fetch(request, env, ctx),
  // Cron trigger (see wrangler.jsonc): keeps the cache current with no manual refresh.
  // "* * * * *" = bookings, listings, reviews, inbox thread list.
  // "*/2 * * * *" = guest messages, on their own so they don't wait behind the rest.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await ensureSchema(env.DB);
      if (controller.cron === "*/2 * * * *") await runInboxMessages(env);
      else await runSync(env);
    })());
  },
};
