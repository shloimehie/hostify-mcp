# Hostify MCP

Private, read-only Hostify connection for Claude and ChatGPT, deployed on Cloudflare Workers and protected with GitHub OAuth.

## How it stays fast

A cron trigger (`*/2 * * * *` in `wrangler.jsonc`) syncs Hostify into the D1 database `hostify-data` in the background. Each run pulls a small number of pages (`SYNC_PAGES_PER_RUN`, default 8) so it stays inside Cloudflare's per-invocation limits, and saves a cursor so the next run continues where it stopped.

| Job | What | Refreshed |
| --- | --- | --- |
| `listings` | All properties (nickname, address, bedrooms, parent listing) | every 6 h |
| `reservations_hot` | Stays from 2 weeks ago to 3 months ahead | continuously (~every 5 min once caught up) |
| `reviews` | Last 2 years | every 3 h |
| `reservations_full` | 2 years back to 18 months ahead | every 12 h |
| `transactions` | All | every 12 h |

The first full fill takes roughly an hour or two; after that the cache stays current on its own. Tables are created automatically (`src/schema.ts`).

Only allowlisted fields are stored or returned (`src/hostify.ts`). Custom fields (lockbox codes, WiFi passwords, phone numbers), guest emails and phones are never cached or shown.

## Tools

Cached, instant: `find_property`, `property_performance`, `portfolio_performance`, `arrivals_departures`, `find_reservation`, `property_reviews`, `cache_status`, `sync_now`.

Live from Hostify: `get_calendar`, `get_reservation`, `get_listing`, `get_listing_content`, `list_reservations_live`, `search_hostify`.

`get_listing_content` returns only public, guest-facing content for the website: photo URLs with captions, the public description sections (summary, description, space, neighbourhood, transit) and amenity names. Access, check-in and house-manual text is never read. If photos or a description can't be found, it returns the response's key names (never values) under `diagnostics` so the right field can be added.

Revenue figures count confirmed bookings only, clip nights to the requested range and pro-rate money by nights. Channel copies of a listing (those with a `parent_listing_id`) roll up into the parent property.

## Secrets

Never commit these values. Add them in Cloudflare as encrypted secrets:

- `HOSTIFY_API_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`

## Deploy

```
npm install
npx wrangler deploy
```

The old v2 cache tables (`listings`, `reservations`, `reviews`, `transactions`, `sync_status`) are no longer used. They hold raw Hostify payloads including access codes, so drop them after deploying:

```
npx wrangler d1 execute hostify-data --remote --command "DROP TABLE IF EXISTS listings; DROP TABLE IF EXISTS reservations; DROP TABLE IF EXISTS reviews; DROP TABLE IF EXISTS transactions; DROP TABLE IF EXISTS sync_status;"
```
