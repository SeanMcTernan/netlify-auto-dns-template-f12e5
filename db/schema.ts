import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// One row per site we've already handled. Presence = "seen"; we never reprocess.
export const processedSites = pgTable("processed_sites", {
  siteId: text("site_id").primaryKey(),
  name: text("name").notNull(),
  customDomain: text("custom_domain"), // null when skipped
  action: text("action").notNull(), // 'seeded' | 'assigned' | 'skipped_existing_domain'
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Tiny key/value for run state. `seeded=true` marks that the initial seed pass ran,
// so a team that starts with zero sites still leaves first-run mode.
export const syncMeta = pgTable("sync_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
