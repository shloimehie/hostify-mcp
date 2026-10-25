// Keeps the site_homes table in step with Airtable ("Show on website" ticked) and fills each
// home's photos and text from Hostify (via the connector's private SiteData entry point) or
// from the home's shared Google Drive folder.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  HOSTIFY: { listingContent(listingId: number): Promise<Record<string, unknown>> };
  AIRTABLE_TOKEN: string;
  AIRTABLE_BASE: string;
  AIRTABLE_HOMES_TABLE: string;
  AIRTABLE_ENQUIRIES_TABLE: string;
  AIRTABLE_ENQUIRIES_BASE?: string;
  SITE_URL: string;
  ENRICH_PER_RUN?: string;
}

type Row = Record<string, unknown>;

// Airtable field IDs (MAIN table, main base). IDs stay valid if a field is renamed.
export const F = {
  name: "fldIXqPfa2gPd4uj8", address: "fldEzto0CyKERW0jA", beds: "fldGe8BoXpOnajWgp", sleeps: "fldIKNcbOrpiYTRrh",
  baths: "fldXmw9I9YBZUqyRZ", area: "fldJwy3O4vXEhf4fu", city: "fldIPaVwMU9PCezEg", drive: "fldIBaODEqba6lg6y",
  drive2: "fldIBaODEqba6lg6y", hostify: "fldto4wugQjGUAKTV", type: "fldpYNcfxWhHVccO8", parking: "fldJLSuShTogiMelf",
  aircon: "fld5GBQZ4Lpvppzqu", region: "fldfV6WSDSW60sBkE", show: "fldvfaSOACK1ArYjr", webName: "fldbXONvKmfPU4qQR",
  webDesc: "fldZUzX4pel6mytYD", webHighlights: "fldRvgItY8dpJOHaa", cover: "fldejShwrpGqX1pdr",
};

export async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS site_homes (
      rec TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, area TEXT, place TEXT, outcode TEXT,
      beds REAL, baths REAL, sleeps INTEGER, type TEXT, intro TEXT, body TEXT, highlights TEXT, amenities TEXT,
      photos TEXT, hostify_id INTEGER, drive_folder TEXT, min_nights INTEGER, at_hash TEXT, at_json TEXT,
      enriched_at INTEGER DEFAULT 0, seen_at INTEGER DEFAULT 0, visible INTEGER DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS site_state (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS site_enquiry_log (ip TEXT, at INTEGER)`),
  ]);
}

async function state(db: D1Database, key: string) {
  return (await db.prepare("SELECT value FROM site_state WHERE key=?").bind(key).first<{ value: string }>())?.value ?? null;
}
async function setState(db: D1Database, key: string, value: string) {
  await db.prepare("INSERT INTO site_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}

// ---------- small text helpers ----------

const s = (v: unknown) => (v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v)).trim();
const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

export function num(v: unknown): number | null {
  const t = s(v).toLowerCase();
  if (!t) return null;
  if (t.includes("studio")) return 0;
  const m = t.match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Removes emoji, box characters and the "????" left by decorative Unicode in channel listings.
export function cleanText(t: unknown, max = 1400): string {
  let x = s(t)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1D400}-\u{1D7FF}]/gu, "")
    .replace(/[▸▼►•○●■□▪]/g, "")
    .replace(/\?{2,}[^\n]*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .split("\n").map((l) => l.trim()).filter((l) => !/^\?+\s*$/.test(l)).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  if (x.length > max) x = x.slice(0, x.lastIndexOf(".", max) + 1 || max);
  return x;
}

const STREET = /\b(Road|Rd|Street|St|Avenue|Ave|Lane|Gardens|Close|Court|House|Place|Square|Way|Crescent|Terrace|Grove|Hill|Park|Rise|Walk|Mews|Drive|Row|Parade|Green|Vale|View|Wharf|Quay|Yard|Gate|Buildings|Mansions|Lodge|Tower|Point|Heights|Broadway|Esplanade|Promenade)\b/i;

export function streetOf(address: string, fallback: string): string {
  for (const part of address.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (STREET.test(part) && !/^(flat|apartment|unit|room)\b/i.test(part)) {
      const t = part.replace(/\b\d+[A-Za-z]?\b/g, "").replace(/\s{2,}/g, " ").replace(/^[\s\-–/]+|[\s\-–/]+$/g, "");
      if (t.length > 3) return t;
    }
  }
  return fallback.replace(/\d+/g, "").replace(/\s{2,}/g, " ").trim() || "Home";
}

export function outcodeOf(text: string): string {
  const u = text.toUpperCase();
  const m = u.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/) || u.trim().match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*$/);
  return m ? m[1] : "";
}
const letters = (oc: string) => (oc.match(/^[A-Z]+/) || [""])[0];

const LONDON_IN = new Set(["E", "EC", "N", "NW", "SE", "SW", "W", "WC"]);
const OUTER = new Set(["BR", "CR", "DA", "EN", "HA", "IG", "KT", "RM", "SM", "TW", "UB"]);
const DIRECTION: Record<string, string> = {
  N: "North", NW: "North", EN: "North", E: "East", IG: "East", RM: "East", SE: "South", SW: "South", BR: "South",
  CR: "South", DA: "South", SM: "South", KT: "South", W: "West", HA: "West", UB: "West", TW: "West", EC: "Central", WC: "Central",
};
const POSTAREA: Record<string, string> = {
  SS: "Southend-on-Sea", LL: "North Wales", LA: "Lancaster", BD: "Bradford", LS: "Leeds", MK: "Milton Keynes", OX: "Oxford",
  WD: "Watford", SL: "Slough", RG: "Reading", GU: "Guildford", CM: "Chelmsford", AL: "St Albans", LU: "Luton", BH: "Bournemouth",
  CT: "Canterbury", ME: "Medway", M: "Manchester", B: "Birmingham", L: "Liverpool", S: "Sheffield", NG: "Nottingham",
  LE: "Leicester", CV: "Coventry", BS: "Bristol", BA: "Bath", CB: "Cambridge", NR: "Norwich", IP: "Ipswich", CO: "Colchester",
  SO: "Southampton", PO: "Portsmouth", BN: "Brighton", TN: "Tunbridge Wells", RH: "Redhill", SG: "Stevenage", HP: "Hemel Hempstead",
  HX: "Halifax", HD: "Huddersfield", WF: "Wakefield", YO: "York", HU: "Hull", NE: "Newcastle", SR: "Sunderland", DH: "Durham",
  PR: "Preston", BL: "Bolton", OL: "Oldham", SK: "Stockport", WA: "Warrington", CH: "Chester", ST: "Stoke", GL: "Gloucester",
  CF: "Cardiff", SA: "Swansea", EX: "Exeter", PL: "Plymouth", TQ: "Torquay", DT: "Dorset", SN: "Swindon", PE: "Peterborough",
  NN: "Northampton", DE: "Derby", FY: "Blackpool", HG: "Harrogate", KT: "Surrey", TW: "Middlesex", EN: "Enfield", HA: "Harrow", UB: "Uxbridge",
};

function placeFor(f: Row, oc: string): { area: string; place: string } {
  const address = s(f[F.address]);
  const tags = arr(f[F.area]).map((x) => x.trim().toLowerCase());
  const tagged = tags.includes("london") || /,\s*london\b/i.test(address);
  const l = letters(oc);
  let isLondon = l ? (LONDON_IN.has(l) ? true : OUTER.has(l) ? tagged : false) : tagged;
  const city = s(f[F.city]).replace(/🇬🇧|UK/g, "").trim();
  if (city && city.toLowerCase() !== "london") isLondon = false;
  if (isLondon) return { area: DIRECTION[l] || "London", place: "" };
  const segs = address.split(",").map((p) => p.trim()).filter((p) => p && !/\d/.test(p) && !STREET.test(p) && !/^(uk|united kingdom|england|wales)$/i.test(p));
  return { area: "Outside London", place: city || POSTAREA[l] || segs[segs.length - 1] || "UK" };
}

const slugify = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function hash(text: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Airtable ----------

async function airtable(env: Env, path: string, init?: RequestInit, base = env.AIRTABLE_BASE) {
  const r = await fetch(`https://api.airtable.com/v0/${base}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<Row>;
}

async function listTicked(env: Env): Promise<{ id: string; fields: Row }[]> {
  const out: { id: string; fields: Row }[] = [];
  let offset = "";
  const fields = Object.values(F).map((id) => `fields[]=${id}`).join("&");
  for (let page = 0; page < 30; page++) {
    const q = `${env.AIRTABLE_HOMES_TABLE}?pageSize=100&returnFieldsByFieldId=true&${fields}` +
      `&filterByFormula=${encodeURIComponent("{Show on website}")}` + (offset ? `&offset=${offset}` : "");
    const body = await airtable(env, q);
    for (const r of (body.records as Row[]) || []) out.push({ id: r.id as string, fields: (r.fields as Row) || {} });
    offset = (body.offset as string) || "";
    if (!offset) break;
  }
  return out;
}

export async function createEnquiry(env: Env, fields: Row) {
  return airtable(env, env.AIRTABLE_ENQUIRIES_TABLE, {
    method: "POST",
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  }, env.AIRTABLE_ENQUIRIES_BASE || env.AIRTABLE_BASE);
}

// ---------- Google Drive (shared folders) ----------

const DRIVE_ID = /^[\w-]{20,}$/;

async function driveListing(folderId: string): Promise<{ id: string; label: string }[]> {
  const r = await fetch(`https://drive.google.com/drive/folders/${folderId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return [];
  const html = await r.text();
  const items: { id: string; label: string }[] = [];
  const re = /<tr[^>]*data-id="([\w-]{20,})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const seg = html.slice(m.index, m.index + 8000);
    const lab = seg.match(/aria-label="([^"]+)"/);
    if (!items.some((i) => i.id === m![1])) items.push({ id: m[1], label: lab ? lab[1] : "" });
  }
  return items;
}

const isFolder = (label: string) => /folder/i.test(label);
const isImage = (label: string) => /\.(jpe?g|png|webp|heic)\b|image/i.test(label) && !isFolder(label);

function bedsOfLabel(label: string): number | null {
  const l = label.toLowerCase();
  if (l.includes("studio")) return 0;
  const m = l.match(/(\d+)\s*(bd|bed|br)/);
  return m ? Number(m[1]) : null;
}

async function drivePhotos(folderId: string, beds: number | null): Promise<string[]> {
  let items = await driveListing(folderId);
  let photos = items.filter((i) => isImage(i.label)).map((i) => i.id);
  if (!photos.length) {
    const subs = items.filter((i) => isFolder(i.label));
    const pick = subs.find((x) => beds != null && bedsOfLabel(x.label) === beds) || subs[0];
    if (pick) {
      items = await driveListing(pick.id);
      photos = items.filter((i) => isImage(i.label)).map((i) => i.id);
    }
  }
  return photos.slice(0, 8);
}

// ---------- building a home from Airtable (+ Hostify / Drive) ----------

const AMENITY_ORDER = ["Pool", "Hot tub", "Sauna", "Garden or backyard", "Free parking on premises", "EV charger", "Air conditioning",
  "Dedicated Workspace", "Wireless Internet", "Dishwasher", "Washer", "Dryer", "Bathtub", "Indoor fireplace", "Patio or balcony",
  "BBQ grill", "Pack ’n Play/travel crib", "High chair", "Long term stays allowed"];
const AMENITY_LABEL: Record<string, string> = { "Garden or backyard": "Garden", "Free parking on premises": "Free parking",
  "Dedicated Workspace": "Workspace", "Wireless Internet": "Wi-Fi", "Pack ’n Play/travel crib": "Travel cot", "Indoor fireplace": "Fireplace",
  "Patio or balcony": "Patio or balcony", "Long term stays allowed": "Long stays welcome" };

async function enrich(env: Env, rec: string, f: Row) {
  const address = s(f[F.address]);
  const hostifyId = Number((s(f[F.hostify]).match(/\d{4,7}/) || [""])[0]) || null;
  const driveUrl = s(f[F.drive]) || s(f[F.drive2]);
  const folder = (driveUrl.match(/folders\/([\w-]+)/) || [])[1] || null;
  let beds = num(f[F.beds]);
  let baths = num(f[F.baths]);
  let sleeps = num(f[F.sleeps]);
  let photos: { k: "h" | "d"; u: string }[] = [];
  let hostText: Row = {};
  let amenities: string[] = [];
  let zip = "";
  let minNights = 1;

  if (hostifyId) {
    try {
      const c = await env.HOSTIFY.listingContent(hostifyId);
      const l = (c.listing as Row) || {};
      photos = ((c.photos as Row[]) || []).map((p) => ({ k: "h" as const, u: s(p.url) })).filter((p) => /^https:\/\/img\.hostify\.com\//.test(p.u)).slice(0, 12);
      hostText = (c.description as Row) || {};
      const am = ((c.amenities as string[]) || []).map(String);
      amenities = AMENITY_ORDER.filter((a) => am.includes(a)).map((a) => AMENITY_LABEL[a] || a).slice(0, 10);
      beds ??= num(l.bedrooms);
      baths ??= num(l.bathrooms);
      sleeps ??= num(l.capacity);
      zip = s(l.zipcode);
      minNights = Number(l.min_nights) || 1;
    } catch (e) {
      console.log("hostify fail", hostifyId, String(e));
    }
  }
  if (!photos.length && folder && DRIVE_ID.test(folder)) {
    try {
      photos = (await drivePhotos(folder, beds)).map((u) => ({ k: "d" as const, u }));
    } catch (e) {
      console.log("drive fail", folder, String(e));
    }
  }

  // "Website cover photo" in Airtable picks which photo leads (1 = first).
  const coverNo = num(f[F.cover]);
  if (coverNo && coverNo > 1 && coverNo <= photos.length) photos.unshift(...photos.splice(coverNo - 1, 1));

  const oc = outcodeOf(address) || outcodeOf(zip);
  const { area, place } = placeFor(f, oc);
  const name = (s(f[F.webName]) || streetOf(address, s(f[F.name]))).replace(/[\s\-–·,]+$/, "").trim() || "Home";
  const typ = arr(f[F.type])[0]?.trim() || "";

  // Text: Airtable's website fields first, then Hostify's listing, then a plain factual line.
  let paras = s(f[F.webDesc]).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) {
    const src = cleanText(hostText.summary || hostText.description || "");
    const space = cleanText(hostText.space || "", 1200);
    paras = [...src.split(/\n\s*\n/), ...(space && !src.includes(space.slice(0, 60)) ? space.split(/\n\s*\n/) : [])]
      .map((p) => p.replace(/\n/g, " ").trim()).filter((p) => p.length > 30).slice(0, 4);
  }
  if (!paras.length) {
    const bw = beds === 0 ? "studio" : beds ? `${beds}-bedroom` : "";
    const where = area === "Outside London" ? place : area === "London" ? "London" : `${area} London`;
    paras = [`A ${[bw, (typ || "home").toLowerCase()].filter(Boolean).join(" ")} on ${name}, ${where}${oc ? " " + oc : ""}.`.replace(/^A ([aeiou])/i, "An $1")];
  }
  const intro = paras.shift() || "";
  let highlights = s(f[F.webHighlights]).split("\n").map((x) => x.trim()).filter(Boolean);
  if (!highlights.length) {
    if (typ) highlights.push(typ);
    for (const p of arr(f[F.parking])) if (p.trim()) highlights.push(`Parking: ${p.trim().toLowerCase()}`);
    if (f[F.aircon]) highlights.push("Air conditioning");
  }

  const slug = `${slugify(name)}-${rec.slice(3, 9).toLowerCase()}`;
  await env.DB.prepare(`UPDATE site_homes SET slug=?, name=?, area=?, place=?, outcode=?, beds=?, baths=?, sleeps=?, type=?,
      intro=?, body=?, highlights=?, amenities=?, photos=?, hostify_id=?, drive_folder=?, min_nights=?, enriched_at=?, visible=? WHERE rec=?`)
    .bind(slug, name, area, place, oc, beds, baths, sleeps, typ, intro, JSON.stringify(paras), JSON.stringify(highlights.slice(0, 8)),
      JSON.stringify(amenities), JSON.stringify(photos), hostifyId, folder, minNights, Date.now(), photos.length ? 1 : 0, rec)
    .run();
}

// ---------- the cron job ----------

export async function runSync(env: Env) {
  await ensureSchema(env.DB);
  await setState(env.DB, "last_start", String(Date.now()));
  try {
    await syncOnce(env);
    await setState(env.DB, "last_error", "");
  } catch (e) {
    // Shown on /healthz so a bad Airtable key or other failure is easy to spot.
    await setState(env.DB, "last_error", `${new Date().toISOString()} ${String(e).slice(0, 300)}`);
    throw e;
  }
}

async function syncOnce(env: Env) {
  const now = Date.now();
  const lastList = Number((await state(env.DB, "last_list")) || 0);

  if (now - lastList > 10 * 60 * 1000) {
    const ticked = await listTicked(env);
    const stmts: D1PreparedStatement[] = [];
    for (const r of ticked) {
      const json = JSON.stringify(r.fields);
      const h = await hash(json);
      stmts.push(env.DB.prepare(`INSERT INTO site_homes(rec, at_hash, at_json, seen_at, enriched_at) VALUES(?,?,?,?,0)
        ON CONFLICT(rec) DO UPDATE SET seen_at=excluded.seen_at, at_json=excluded.at_json,
        enriched_at=CASE WHEN site_homes.at_hash=excluded.at_hash THEN site_homes.enriched_at ELSE 0 END,
        at_hash=excluded.at_hash`).bind(r.id, h, json, now));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    // Homes un-ticked in Airtable disappear from the site.
    if (ticked.length) await env.DB.prepare("DELETE FROM site_homes WHERE seen_at < ?").bind(now).run();
    await setState(env.DB, "last_list", String(now));
    await setState(env.DB, "ticked", String(ticked.length));
  }

  // Refresh the homes that are new, changed in Airtable, or older than a day.
  const n = Number(env.ENRICH_PER_RUN || 40);
  const due = await env.DB.prepare("SELECT rec, at_json FROM site_homes WHERE enriched_at < ? ORDER BY enriched_at ASC LIMIT ?")
    .bind(now - 24 * 3600 * 1000, n).all<{ rec: string; at_json: string }>();
  for (const row of due.results || []) {
    try {
      await enrich(env, row.rec, JSON.parse(row.at_json));
    } catch (e) {
      console.log("enrich fail", row.rec, String(e));
      await env.DB.prepare("UPDATE site_homes SET enriched_at=? WHERE rec=?").bind(now - 23 * 3600 * 1000, row.rec).run();
    }
  }
  await setState(env.DB, "last_run", String(now));
}
