// State helpers backed by Netlify DB via Drizzle. The connection lives in db/index.ts
// (drizzle-orm/netlify-db) and is configured automatically — no connection string.

import { eq } from "drizzle-orm";
import { db, schema } from "../db";

const { processedSites, syncMeta } = schema;

export type SiteAction = "seeded" | "assigned" | "skipped_existing_domain";

/** Has the initial seed pass run? Lets a zero-site team leave first-run mode. */
export async function hasSeeded(): Promise<boolean> {
  const rows = await db.select().from(syncMeta).where(eq(syncMeta.key, "seeded")).limit(1);
  return rows.length > 0;
}

export async function markSeeded(): Promise<void> {
  await db.insert(syncMeta).values({ key: "seeded", value: "true" }).onConflictDoNothing();
}

export async function getProcessedIds(): Promise<Set<string>> {
  const rows = await db.select({ siteId: processedSites.siteId }).from(processedSites);
  return new Set(rows.map((r) => r.siteId));
}

export async function markProcessed(
  siteId: string,
  name: string,
  customDomain: string | null,
  action: SiteAction,
): Promise<void> {
  await db
    .insert(processedSites)
    .values({ siteId, name, customDomain, action })
    .onConflictDoNothing();
}
