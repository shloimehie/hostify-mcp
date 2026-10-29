# Hostify MCP

Private Hostify connection for Claude and ChatGPT, deployed on Cloudflare Workers and protected with GitHub OAuth. It is read-only by default; write actions (creating reservations) can be switched on and always go through a preview → confirm step.

## How it stays fast

A cron trigger (`*/2 * * * *` in `wrangler.jsonc`) syncs Hostify into the D1 database `hostify-data` in the background. Each run pulls a small number of pages (`SYNC_PAGES_PER_RUN`, default 8) so it stays inside Cloudflare's per-invocation limits, and saves a cursor so the next run continues where it stopped.

| Job | What | Refreshed |
| --- | --- | --- |
| `listings` | All properties (nickname, address, bedrooms, parent listing) | every 6 h |
| `reservations_hot` | Stays from 2 weeks ago to 3 months ahead | continuously (~every 5 min once caught up) |
| `reviews` | Last 2 years | every 3 h |
| `reservations_full` | 2 years back to 18 months ahead | every 12 h |
| `transactions` | All | every 12 h |
| `inbox_threads` | Every guest conversation thread (full history) | daily |
| `inbox_recent` | Threads with the latest activity | every ~5 min |
| `inbox_messages` | Messages inside new or changed threads (first runs backfill all history) | up to a third of each run |

The first full fill takes roughly an hour or two; after that the cache stays current on its own. Tables are created automatically (`src/schema.ts`).

Only allowlisted fields are stored or returned (`src/hostify.ts`). Custom fields (lockbox codes, WiFi passwords, phone numbers), guest emails and phones are never cached or shown.

Guest messages (`src/inbox.ts`) are stored with guest emails, phone numbers and access details (door codes, PINs, WiFi passwords) cut out. Automatic template messages are skipped.

## Tools

Cached, instant: `find_property`, `property_performance`, `portfolio_performance`, `arrivals_departures`, `find_reservation`, `property_reviews`, `guest_message_history`, `cache_status`, `sync_now`.

Live from Hostify: `get_calendar`, `get_reservation`, `get_listing`, `get_listing_content`, `list_reservations_live`, `search_hostify`, `inbox_diagnostics`.

`get_listing_content` returns only public, guest-facing content for the website: photo URLs with captions, the public description sections (summary, description, space, neighbourhood, transit) and amenity names. Access, check-in and house-manual text is never read. If photos or a description can't be found, it returns the response's key names (never values) under `diagnostics` so the right field can be added.

Revenue figures count confirmed bookings only, clip nights to the requested range and pro-rate money by nights. Channel copies of a listing (those with a `parent_listing_id`) roll up into the parent property.

## Write actions (v3.1.0)

Off unless the Worker has `WRITES_ENABLED` set to `true` (add it in Cloudflare as a secret so deploys don't reset it). Code lives in `src/writes.ts`.

Every write is two steps:

1. **Preview** – e.g. `create_reservation` validates the input, resolves the property (must be exactly one match), checks the live calendar and cached bookings for clashes, and stores the exact Hostify request in `h_pending_writes`. Nothing is sent to Hostify.
2. **Confirm** – `confirm_write` with the preview's `confirm_token` sends exactly the stored request, once. Tokens expire after 15 minutes and can't be reused.

| Tool | What |
| --- | --- |
| `create_reservation` | Step 1: preview a new direct / corporate booking |
| `confirm_write` | Step 2: send a previewed change to Hostify |
| `write_log` | Recent changes sent through the connector (who, when, what, result) |

Guest emails and phones are hidden in previews and never returned in results. Every confirmed write stays in `h_pending_writes` as an audit log. Hostify field names for `POST /reservations` are set in one place, `buildReservationBody` in `src/writes.ts`.

## Secrets

Never commit these values. Add them in Cloudflare as encrypted secrets:

- `HOSTIFY_API_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`
- `WRITES_ENABLED` (optional; `true` turns on write actions)

## Deploy

```
npm install
npx wrangler deploy
```

The old v2 cache tables (`listings`, `reservations`, `reviews`, `transactions`, `sync_status`) are no longer used. They hold raw Hostify payloads including access codes, so drop them after deploying:

```
npx wrangler d1 execute hostify-data --remote --command "DROP TABLE IF EXISTS listings; DROP TABLE IF EXISTS reservations; DROP TABLE IF EXISTS reviews; DROP TABLE IF EXISTS transactions; DROP TABLE IF EXISTS sync_status;"
```
