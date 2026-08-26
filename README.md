# Hostify MCP

Private, read-only Hostify connection for ChatGPT, deployed on Cloudflare Workers and protected with GitHub OAuth.

## Secrets

Never commit these values. Add them in Cloudflare as encrypted secrets:

- `HOSTIFY_API_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`

## Initial tools

- Listings and listing details
- Reservations and reservation details
- Availability calendar
- Reviews
- Transactions
- Hostify search

Sensitive access-code fields are removed from returned data. Every tool is read-only.
