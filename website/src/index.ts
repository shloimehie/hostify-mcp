// hometohost.com: enquiry-only website. Homes come from Airtable ("Show on website" ticked),
// photos and text from Hostify or the home's Google Drive folder. See sync.ts.

import { Env, ensureSchema, runSync, createEnquiry } from "./sync";
import { Home, homePage, homeDetail, enquirePage, notFoundPage, esc } from "./render";

type DbRow = Record<string, unknown>;
const json = (v: unknown, fallback: unknown) => { try { return v ? JSON.parse(String(v)) : fallback; } catch { return fallback; } };

function toHome(r: DbRow): Home {
  return {
    rec: String(r.rec), slug: String(r.slug), name: String(r.name ?? ""), area: String(r.area ?? ""), place: String(r.place ?? ""),
    outcode: String(r.outcode ?? ""), beds: r.beds == null ? null : Number(r.beds), baths: r.baths == null ? null : Number(r.baths),
    sleeps: r.sleeps == null ? null : Number(r.sleeps), type: String(r.type ?? ""), intro: String(r.intro ?? ""),
    body: json(r.body, []), highlights: json(r.highlights, []), amenities: json(r.amenities, []), photos: json(r.photos, []),
    min_nights: Number(r.min_nights ?? 0),
  };
}

const ORDER = "ORDER BY CASE area WHEN 'Central' THEN 0 WHEN 'West' THEN 1 WHEN 'North' THEN 2 WHEN 'South' THEN 3 WHEN 'East' THEN 4 WHEN 'London' THEN 5 ELSE 6 END, beds DESC, name";

async function allHomes(env: Env): Promise<Home[]> {
  const r = await env.DB.prepare(`SELECT * FROM site_homes WHERE visible=1 ${ORDER}`).all<DbRow>();
  return (r.results ?? []).map(toHome);
}

const html = (body: string, status = 200, maxAge = 120) =>
  new Response(body, { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=60, s-maxage=${maxAge}`,
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN",
  } });
const jsonRes = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TYPE_NAMES: Record<string, string> = { stay: "A stay", corporate: "Corporate / long stay", owner: "Listing my home" };
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

async function enquire(req: Request, env: Env, site: string) {
  let d: DbRow;
  const ct = req.headers.get("content-type") || "";
  try { d = ct.includes("json") ? await req.json() : Object.fromEntries(await req.formData()); } catch { return jsonRes({ error: "Couldn't read the form" }, 400); }
  if (clip(d.website, 10)) return jsonRes({ ok: true }); // honeypot: pretend success
  const name = clip(d.name, 120), email = clip(d.email, 200);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes({ error: "Add your name and a valid email" }, 400);

  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_enquiry_log WHERE ip=? AND at>?").bind(ip, now - 3600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 6) return jsonRes({ error: "Too many enquiries from this connection. Please email info@hometohost.com" }, 429);

  const slug = clip(d.home, 120);
  const home = slug ? await env.DB.prepare("SELECT name, area, place FROM site_homes WHERE slug=?").bind(slug).first<DbRow>() : null;
  const arrival = clip(d.arrival, 10), departure = clip(d.departure, 10);
  // Field IDs of "Website Enquiries" in the Reservations base (appTXzJPcK4XvfdM0).
  const fields: DbRow = {
    fldAuF48Dd6s0gbAc: name,
    fldY0pND3iM8d7l1W: email,
    fldAgClf7mWXkz0NS: clip(d.phone, 40) || undefined,
    fldOXvMENTHm7csGD: clip(d.company, 120) || undefined,
    fldBJklouaUBb87ey: TYPE_NAMES[clip(d.type, 20)] ?? "A stay",
    fldzwfReQxZNKFqwS: home ? `${home.name}` : undefined,
    fldqBHlPY1I4exZR1: home ? `${site}/homes/${slug}` : undefined,
    fldCw4wTDi13K7Mrx: isDate(arrival) ? arrival : undefined,
    fld7XCDbiKp1Tpzk9: isDate(departure) ? departure : undefined,
    fldKEhUU3RKlFkwEY: clip(d.guests, 20) || undefined,
    fld0RUAQBwEQsyG91: clip(d.message, 4000) || undefined,
    fldtyd7p6NkZ3ivjz: "New",
  };
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  try {
    await createEnquiry(env, fields);
  } catch (e) {
    console.error("enquiry failed", e);
    return jsonRes({ error: "We couldn't send that just now" }, 502);
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO site_enquiry_log(ip, at) VALUES(?,?)").bind(ip, now),
    env.DB.prepare("DELETE FROM site_enquiry_log WHERE at<?").bind(now - 86400_000),
  ]);
  return jsonRes({ ok: true });
}

// Drive photos are served through the site (cached at the edge) so pages never link to Google directly.
async function driveImage(req: Request, id: string, ctx: ExecutionContext) {
  if (!/^[\w-]{20,80}$/.test(id)) return new Response("Not found", { status: 404 });
  const wq = Number(new URL(req.url).searchParams.get("w")) || 1200;
  const w = [500, 800, 1200, 1600].find((x) => x >= wq) ?? 1600;
  const key = new Request(`https://img.cache/d/${id}/${w}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(`https://drive.google.com/thumbnail?id=${id}&sz=w${w}`, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=600" } });
  const res = new Response(r.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=2592000, immutable" } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const site = (env.SITE_URL || url.origin).replace(/\/$/, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // www → apex
    if (url.hostname.startsWith("www.")) return Response.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 301);

    try {
      if (path === "/api/enquire") {
        if (req.method !== "POST") return jsonRes({ error: "POST only" }, 405);
        await ensureSchema(env.DB);
        return enquire(req, env, site);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

      if (path.startsWith("/img/d/")) return driveImage(req, decodeURIComponent(path.slice(7)), ctx);

      if (path === "/healthz") {
        await ensureSchema(env.DB);
        const c = await env.DB.prepare("SELECT COUNT(*) AS all_homes, SUM(visible) AS visible, SUM(enriched_at>0) AS enriched FROM site_homes").first();
        const st = await env.DB.prepare("SELECT key, value FROM site_state").all();
        return jsonRes({ ok: true, homes: c, state: Object.fromEntries((st.results ?? []).map((r: DbRow) => [r.key, r.value])) });
      }
      if (path === "/robots.txt") return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${site}/sitemap.xml\n`, { headers: { "Content-Type": "text/plain" } });
      if (path === "/sitemap.xml") {
        const r = await env.DB.prepare("SELECT slug FROM site_homes WHERE visible=1").all<{ slug: string }>();
        const urls = [`${site}/`, `${site}/enquire`, ...(r.results ?? []).map((x) => `${site}/homes/${x.slug}`)];
        return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join("")}</urlset>`,
          { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" } });
      }

      if (path === "/") return html(homePage(await allHomes(env), site));
      if (path === "/enquire") {
        const r = await env.DB.prepare(`SELECT slug, name, area, place, beds FROM site_homes WHERE visible=1`).all<DbRow>();
        const list = (r.results ?? []).map((x) => ({ slug: String(x.slug), name: String(x.name), area: String(x.area), place: String(x.place ?? ""), beds: x.beds == null ? null : Number(x.beds) }));
        return html(enquirePage(list, site, { home: url.searchParams.get("home") ?? undefined, type: url.searchParams.get("type") ?? undefined }), 200, 600);
      }
      const m = path.match(/^\/homes\/([a-z0-9-]{3,140})$/);
      if (m) {
        const r = await env.DB.prepare("SELECT * FROM site_homes WHERE slug=? AND visible=1").bind(m[1]).first<DbRow>();
        return r ? html(homeDetail(toHome(r), site)) : html(notFoundPage(site), 404, 60);
      }

      // Static files in public/ (hero.jpg, favicon)
      const asset = await env.ASSETS.fetch(req);
      if (asset.status !== 404) return asset;
      return html(notFoundPage(site), 404, 60);
    } catch (e) {
      // First request before the tables exist: create them, then show the empty site rather than an error.
      if (String(e).includes("no such table")) { await ensureSchema(env.DB); return html(homePage([], site), 200, 10); }
      console.error(e);
      return new Response("Something went wrong. Please call 020 3488 2323 or email info@hometohost.com.", { status: 500 });
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSync(env));
  },
} satisfies ExportedHandler<Env>;
