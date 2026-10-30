import { neon } from "@neondatabase/serverless";

let client: any = null;
// Lazy so `next build` works without DATABASE_URL.
export function db(): any {
  if (!client) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    client = neon(process.env.DATABASE_URL);
  }
  return client;
}

export async function q(text: string, params: any[] = []): Promise<any[]> {
  return db().query(text, params);
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pair_map (
     base text PRIMARY KEY, binance_symbol text NOT NULL, delta_symbol text NOT NULL,
     b_mult real NOT NULL DEFAULT 1, d_mult real NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true)`,
  `CREATE TABLE IF NOT EXISTS funding_history (
     base text NOT NULL, exchange text NOT NULL, ts timestamptz NOT NULL,
     rate double precision NOT NULL, interval_hours real NOT NULL,
     PRIMARY KEY (base, exchange, ts))`,
  `CREATE TABLE IF NOT EXISTS live_snapshot (
     base text PRIMARY KEY, b_rate double precision, d_rate double precision,
     b_interval real, d_interval real, b_mark double precision, d_mark double precision,
     b_vol double precision, d_vol double precision, d_oi double precision, ts timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS pair_stats (
     base text PRIMARY KEY, direction text, days int, ret7 double precision, ret30 double precision,
     net30 double precision, avg_daily double precision, apr double precision, trend3_apr double precision,
     consistency double precision, spread_std double precision, sign_flips int,
     breakeven_days double precision, updated_at timestamptz DEFAULT now())`,
  `ALTER TABLE pair_stats ADD COLUMN IF NOT EXISTS ret90 double precision`,
  `ALTER TABLE pair_stats ADD COLUMN IF NOT EXISTS net90 double precision`,
  `ALTER TABLE pair_stats ADD COLUMN IF NOT EXISTS days90 int`,
  `CREATE TABLE IF NOT EXISTS sync_state (base text PRIMARY KEY, last_synced_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS alert_log (base text PRIMARY KEY, sent_at timestamptz NOT NULL)`,
  `ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS backfill_days int`,
  `CREATE TABLE IF NOT EXISTS pair_features (base text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS wf_obs (
     base text NOT NULL, fold int NOT NULL, m30 double precision, m90 double precision,
     md90 double precision, cons double precision, fwd double precision, PRIMARY KEY (base, fold))`,
  `CREATE TABLE IF NOT EXISTS wf_summary (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS bybit_pair_features (base text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS bybit_wf_obs (
     base text NOT NULL, fold int NOT NULL, m30 double precision, m90 double precision,
     md90 double precision, cons double precision, fwd double precision, PRIMARY KEY (base, fold))`,
  `CREATE TABLE IF NOT EXISTS bybit_wf_summary (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`,
  `ALTER TABLE pair_map ADD COLUMN IF NOT EXISTS coindcx_pair text`,
  `ALTER TABLE pair_map ADD COLUMN IF NOT EXISTS c_interval real`,
  `ALTER TABLE live_snapshot ADD COLUMN IF NOT EXISTS c_rate double precision`,
  `ALTER TABLE live_snapshot ADD COLUMN IF NOT EXISTS c_mark double precision`,
  `ALTER TABLE pair_map ADD COLUMN IF NOT EXISTS bybit_symbol text`,
  `ALTER TABLE pair_map ALTER COLUMN delta_symbol DROP NOT NULL`,
  `ALTER TABLE pair_map ADD COLUMN IF NOT EXISTS y_mult real`,
  `ALTER TABLE pair_map ADD COLUMN IF NOT EXISTS y_interval real`,
  `ALTER TABLE live_snapshot ADD COLUMN IF NOT EXISTS y_rate double precision`,
  `ALTER TABLE live_snapshot ADD COLUMN IF NOT EXISTS y_interval real`,
  `ALTER TABLE live_snapshot ADD COLUMN IF NOT EXISTS y_mark double precision`,
  `ALTER TABLE live_snapshot ADD COLUMN IF NOT EXISTS y_vol double precision`,
  `ALTER TABLE live_snapshot ADD COLUMN IF NOT EXISTS y_oi double precision`,
  `CREATE TABLE IF NOT EXISTS bybit_pair_stats (LIKE pair_stats INCLUDING ALL)`,
];
