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
  `CREATE INDEX IF NOT EXISTS h_res_check_out ON h_reservations(check_out)`,
  `CREATE INDEX IF NOT EXISTS h_res_guest ON h_reservations(guest_name COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS h_res_code ON h_reservations(confirmation_code)`,
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
  `CREATE INDEX IF NOT EXISTS h_rev_date ON h_reviews(review_date)`,
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
  `CREATE INDEX IF NOT EXISTS h_txn_reservation ON h_transactions(reservation_id)`,
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

let applied = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (applied) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  applied = true;
}
