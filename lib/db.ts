// State store backed by Netlify DB (Neon Postgres).
// @netlify/neon reads NETLIFY_DATABASE_URL from the environment automatically.

import { neon } from "@netlify/neon";

const sql = neon();

export type SiteAction = "seeded" | "assigned" | "skipped_existing_domain";

/** Create tables if they don't exist. Safe to run every invocation. */
export async function ensureSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS processed_sites (
      site_id       TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      custom_domain TEXT,
      action        TEXT NOT NULL,
      processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
}

/** Has the initial seed pass run? Used so a team that starts with zero sites
 *  still leaves first-run mode (an empty processed_sites table can't tell us). */
export async function hasSeeded(): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM sync_meta WHERE key = 'seeded' LIMIT 1`;
  return rows.length > 0;
}

export async function markSeeded(): Promise<void> {
  await sql`
    INSERT INTO sync_meta (key, value) VALUES ('seeded', 'true')
    ON CONFLICT (key) DO NOTHING
  `;
}

export async function getProcessedIds(): Promise<Set<string>> {
  const rows = await sql`SELECT site_id FROM processed_sites`;
  return new Set(rows.map((r) => r.site_id as string));
}

export async function markProcessed(
  siteId: string,
  name: string,
  customDomain: string | null,
  action: SiteAction,
): Promise<void> {
  await sql`
    INSERT INTO processed_sites (site_id, name, custom_domain, action)
    VALUES (${siteId}, ${name}, ${customDomain}, ${action})
    ON CONFLICT (site_id) DO NOTHING
  `;
}
