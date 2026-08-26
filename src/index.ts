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
}

type Props = { login: string; name: string; email: string; accessToken: string };

const HOSTIFY_BASE_URL = "https://api-rms.hostify.com";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date in YYYY-MM-DD format");
const paging = {
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(50).default(20),
};

const blockedKeys = new Set([
  "lock_pin", "lock_link", "lockbox_code", "access_code", "access_codes",
  "door_code", "pin", "hostify_checkin_form_link", "email", "phone"
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !blockedKeys.has(key.toLowerCase()))
        .map(([key, item]) => [key, redact(item)]),
    );
  }
  return value;
}

function result(data: unknown) {
  const safe = redact(data);
  return { content: [{ type: "text" as const, text: JSON.stringify(safe) }] };
}

export class HostifyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer(
    { name: "Home to Host – Hostify", version: "1.0.0" },
    { instructions: "Read-only Hostify access. Never expose secrets, door codes, lock PINs, guest email addresses, or phone numbers." },
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

  async init() {
    this.server.tool(
      "list_listings",
      "List Hostify properties. Use this to find listing IDs, names, locations, status and basic property information.",
      { ...paging, include_related_objects: z.boolean().default(false) },
      async ({ page, per_page, include_related_objects }) => result(await this.hostify("/listings", { page, per_page, include_related_objects: include_related_objects ? 1 : 0 })),
    );

    this.server.tool(
      "get_listing",
      "Get detailed information for one Hostify listing. Sensitive access and contact fields are removed.",
      { listing_id: z.number().int().positive(), include_related_objects: z.boolean().default(true) },
      async ({ listing_id, include_related_objects }) => result(await this.hostify(`/listings/${listing_id}`, { include_related_objects: include_related_objects ? 1 : 0 })),
    );

    this.server.tool(
      "list_reservations",
      "List reservations for a date range, optionally for one listing. Use for arrivals, departures, occupancy, booking source and revenue analysis.",
      {
        ...paging,
        listing_id: z.number().int().positive().optional(),
        start_date: date,
        end_date: date,
        status: z.string().optional().describe("Optional Hostify status such as accepted, pending, cancelled"),
        sort: z.enum(["checkIn", "checkOut", "confirmed_at"]).default("checkIn"),
        include_fees: z.boolean().default(false),
      },
      async ({ page, per_page, listing_id, start_date, end_date, status, sort, include_fees }) => {
        const filters = status ? [{ field: "status", operator: "=", value: status }] : undefined;
        return result(await this.hostify("/reservations", { page, per_page, listing_id, start_date, end_date, sort, fees: include_fees ? 1 : 0, filters }));
      },
    );

    this.server.tool(
      "get_reservation",
      "Get one reservation including pricing and fee breakdown. Door codes and guest contact details are always removed.",
      { reservation_id: z.number().int().positive(), include_fees: z.boolean().default(true) },
      async ({ reservation_id, include_fees }) => result(await this.hostify(`/reservations/${reservation_id}`, { fees: include_fees ? 1 : 0 })),
    );

    this.server.tool(
      "get_calendar",
      "Get nightly availability, price, minimum stay and booking status for one listing and date range.",
      { listing_id: z.number().int().positive(), start_date: date, end_date: date },
      async ({ listing_id, start_date, end_date }) => result(await this.hostify("/calendar", { listing_id, start_date, end_date })),
    );

    this.server.tool(
      "list_reviews",
      "List guest reviews and ratings within a date range, optionally filtered by city.",
      { ...paging, created_from: date, created_to: date, city: z.string().optional() },
      async ({ page, per_page, created_from, created_to, city }) => result(await this.hostify("/reviews", { page, per_page, created_from, created_to, city })),
    );

    this.server.tool(
      "list_transactions",
      "List Hostify transactions, optionally for a reservation or listing.",
      { ...paging, reservation_id: z.number().int().positive().optional(), listing_id: z.number().int().positive().optional() },
      async ({ page, per_page, reservation_id, listing_id }) => result(await this.hostify("/transactions", { page, per_page, reservation_id, listing_id })),
    );

    this.server.tool(
      "search_hostify",
      "Search Hostify across listings, reservations, guests or integrations. Guest contact details are removed.",
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
