# hometohost.com website

Enquiry-only website for Home to Host. A separate Cloudflare Worker (`hth-website`) in this repo.

## Where the content comes from
- **Which homes:** Airtable → Properties2, every home with **Show on website** ticked. Untick to remove (within ~10 minutes).
- **Name / description / highlights:** the Airtable fields *Website name*, *Website description* (blank line = new paragraph; first paragraph is the heading) and *Website highlights* (one per line). Left empty, the text comes from Hostify.
- **Photos:** Hostify (through the `hostify-mcp` worker's private `SiteData` entry point, so no Hostify key is needed here), otherwise the home's shared Google Drive folder. A home with no photos is hidden.
- A cron runs every 2 minutes: re-reads Airtable every 10 minutes and refreshes up to 40 homes per run; each home is refreshed daily, and straight away when its Airtable row changes.

## Enquiries
`POST /api/enquire` → new row in Airtable **Website Enquiries** (honeypot + max 6 per hour per IP). The Airtable automation "Website enquiry → email info@" emails info@hometohost.com with reply-to set to the guest.

## Setup (once)
1. Cloudflare → Workers → Create → Import repository `shloimehie/hostify-mcp`, name `hth-website`, **root directory `website`**, deploy command `npx wrangler deploy`.
2. Settings → Variables and secrets → add secret `AIRTABLE_TOKEN` (Airtable personal access token, scopes `data.records:read` + `data.records:write`, access to the Home to Host base).
3. Settings → Domains & Routes → add custom domains `hometohost.com` and `www.hometohost.com` once the domain's DNS is on Cloudflare.

Status: `/healthz`.
