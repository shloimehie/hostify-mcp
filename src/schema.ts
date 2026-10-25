// D1 schema for the Hostify cache (v3).
// New "h_" tables replace the v2 tables, which stored the wrong name fields
// and raw payloads containing access codes. Statements are idempotent and are
// applied automatically on first use in each isolate.

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS h_listings (
    id INTEGER PRIMARY KEY,
    nickname TEXT,
    name TEXT,
    street TEXT,
    city TEXT,
    zipcode TEXT,
    bedrooms REAL,
    bathrooms REAL,
    capacity INTEGER,
    property_type TEXT,
    is_listed INTEGER,
    parent_listing_id INTEGER,
    tags TEXT,
    currency TEXT,
    default_price REAL,
    min_nights INTEGER,
    synced_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS h_reservations (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER,
    listing_nickname TEXT,
    guest_name TEXT,
    status TEXT,
    is_booking INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    confirmation_code TEXT,
    check_in TEXT,
    check_out TEXT,
    nights INTEGER,
    guests INTEGER,
    currency TEXT,
    base_price REAL,
    cleaning_fee REAL,
    channel_commission REAL,
    subtotal REAL,
    total_price REAL,
    revenue REAL,
    payout_price REAL,
    owner_revenue REAL,
    net_revenue REAL,
    paid_part TEXT,
    created_at TEXT,
    confirmed_at TEXT,
    cancelled_at TEXT,
    hostify_updated_at TEXT,
    synced_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS h_res_listing_dates ON h_reservations(listing_id, check_in, check_out)`,
  `CREATE INDEX IF NOT EXISTS h_res_check_in ON h_reservations(check_in)`,
  `CREATE TABLE IF NOT EXISTS h_reviews (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER,
    listing_nickname TEXT,
    reservation_id INTEGER,
    guest_name TEXT,
    rating REAL,
    review_text TEXT,
    response_text TEXT,
    review_date TEXT,
    source TEXT,
    synced_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS h_rev_listing_date ON h_reviews(listing_id, review_date)`,
  `CREATE TABLE IF NOT EXISTS h_transactions (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER,
    reservation_id INTEGER,
    txn_date TEXT,
    txn_type TEXT,
    description TEXT,
    amount REAL,
    currency TEXT,
    status TEXT,
    synced_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS h_txn_listing_date ON h_transactions(listing_id, txn_date)`,
  // One row per sync job. A "pass" walks every page of one fixed window;
  // when it finishes the job rests until restart_after, then starts again.
  `CREATE TABLE IF NOT EXISTS h_sync_jobs (
    job TEXT PRIMARY KEY,
    next_page INTEGER NOT NULL DEFAULT 1,
    window_from TEXT,
    window_to TEXT,
    pass_started_at TEXT,
    last_page_at TEXT,
    last_pass_completed_at TEXT,
    rows_this_pass INTEGER NOT NULL DEFAULT 0,
    total_expected INTEGER,
    restart_after TEXT,
    last_error TEXT,
    last_error_at TEXT
  )`,
];

// D1's free plan allows 100,000 rows written per day, and every index on a
// table adds a write per row. Keep only the indexes the queries need.
SCHEMA.push(
  "DROP INDEX IF EXISTS h_res_check_out",
  "DROP INDEX IF EXISTS h_res_guest",
  "DROP INDEX IF EXISTS h_res_code",
  "DROP INDEX IF EXISTS h_rev_date",
  "DROP INDEX IF EXISTS h_txn_reservation",
  // Rows written per UTC day by the sync, so it can stay under the daily cap.
  `CREATE TABLE IF NOT EXISTS h_daily_writes (day TEXT PRIMARY KEY, rows_written INTEGER NOT NULL DEFAULT 0)`,
  // 18 Oct 2026: the account had already used ~88% of the day's cap before
  // this counter existed, so start that day near the limit.
  `INSERT OR IGNORE INTO h_daily_writes (day, rows_written) VALUES ('2026-10-18', 90000)`,
  // Write actions: previews awaiting confirmation, and the audit log of sent ones.
  `CREATE TABLE IF NOT EXISTS h_pending_writes (
    token TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    payload TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    confirmed_at TEXT,
    confirmed_by TEXT,
    result TEXT
  )`,
);

let applied = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (applied) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  applied = true;
}
