// State helpers backed by Netlify DB via Drizzle. The connection lives in db/index.ts
// (drizzle-orm/netlify-db) and is configured automatically — no connection string.

import { eq } from "drizzle-orm";
import { db, schema } from "../db";

const { processedSites, syncMeta } = schema;

export type SiteAction = "seeded" | "assigned" | "skipped_existing_domain";

export interface ProcessedRecord {
  name: string;
  customDomain: string | null;
  action: SiteAction;
}

/** Has the initial seed pass run? Lets a zero-site team leave first-run mode. */
export async function hasSeeded(): Promise<boolean> {
  const rows = await db.select().from(syncMeta).where(eq(syncMeta.key, "seeded")).limit(1);
  return rows.length > 0;
}

export async function markSeeded(): Promise<void> {
  await db.insert(syncMeta).values({ key: "seeded", value: "true" }).onConflictDoNothing();
}

/** All processed sites, keyed by site id — carries the last-seen name and the
 *  domain we assigned, so the reconcile loop can detect renames. */
export async function getProcessed(): Promise<Map<string, ProcessedRecord>> {
  const rows = await db
    .select({
      siteId: processedSites.siteId,
      name: processedSites.name,
      customDomain: processedSites.customDomain,
      action: processedSites.action,
    })
    .from(processedSites);
  return new Map(
    rows.map((r) => [r.siteId, { name: r.name, customDomain: r.customDomain, action: r.action as SiteAction }]),
  );
}

/** Insert a site's record, or update it in place (used for rename re-sync). */
export async function markProcessed(
  siteId: string,
  name: string,
  customDomain: string | null,
  action: SiteAction,
): Promise<void> {
  await db
    .insert(processedSites)
    .values({ siteId, name, customDomain, action })
    .onConflictDoUpdate({
      target: processedSites.siteId,
      set: { name, customDomain, action, processedAt: new Date() },
    });
}
