// Scheduled function that keeps team sites' custom domains in sync with their names:
//   - NEW site  -> assign {site.name}.{BASE_DOMAIN} and wire up DNS
//   - RENAMED site (one we assigned) -> move the custom domain to the new name,
//     re-wire DNS, and delete the stale records
//
// Detection is poll-and-diff: Netlify has no "site created/renamed" webhook, so we
// list all sites every run and compare against the processed_sites table (Netlify DB).
// A rename is just "current site.name no longer maps to the domain we stored".

import type { Config } from "@netlify/functions";
import { NetlifyApi } from "../../lib/netlify-api";
import { getProcessed, hasSeeded, markProcessed, markSeeded } from "../../lib/db";

export default async (): Promise<void> => {
  const token = Netlify.env.get("NETLIFY_API_TOKEN");
  const accountSlug = Netlify.env.get("NETLIFY_ACCOUNT_SLUG");
  const baseDomain = Netlify.env.get("BASE_DOMAIN");

  if (!token || !accountSlug || !baseDomain) {
    throw new Error(
      "Missing required env vars: NETLIFY_API_TOKEN, NETLIFY_ACCOUNT_SLUG, BASE_DOMAIN",
    );
  }

  const api = new NetlifyApi(token);

  // Precondition: the base domain must be covered by a Netlify-managed DNS zone,
  // otherwise PUT /sites/{id}/dns sets a custom domain that never resolves.
  const zones = await api.listDnsZones();
  const zone = zones.find(
    (z) => baseDomain === z.name || baseDomain.endsWith(`.${z.name}`),
  );
  if (!zone) {
    throw new Error(
      `No Netlify-managed DNS zone covers "${baseDomain}". Delegate the domain to Netlify DNS before running this.`,
    );
  }

  const sites = await api.listSites(accountSlug);

  // First run: record every existing site as already-handled. We do NOT backfill
  // domains onto sites that predate this tool.
  if (!(await hasSeeded())) {
    for (const s of sites) {
      await markProcessed(s.id, s.name, s.custom_domain ?? null, "seeded");
    }
    await markSeeded();
    console.log(`First run: seeded ${sites.length} existing site(s); none modified.`);
    return;
  }

  const processed = await getProcessed();

  const newSites = sites.filter((s) => !processed.has(s.id));
  // A rename only concerns sites WE assigned: current name no longer maps to the
  // domain we recorded. We never touch 'seeded' or 'skipped_existing_domain' sites.
  const renamedSites = sites.filter((s) => {
    const rec = processed.get(s.id);
    return rec?.action === "assigned" && `${s.name}.${baseDomain}` !== rec.customDomain;
  });
  console.log(`Discovered ${newSites.length} new site(s), ${renamedSites.length} renamed site(s).`);

  for (const site of newSites) {
    try {
      // Never clobber a domain someone set deliberately.
      if (site.custom_domain) {
        await markProcessed(site.id, site.name, site.custom_domain, "skipped_existing_domain");
        console.log(`Skip "${site.name}": already has custom domain ${site.custom_domain}`);
        continue;
      }
      const customDomain = `${site.name}.${baseDomain}`;
      await api.setCustomDomain(site.id, customDomain);
      await api.configureDns(site.id);
      await markProcessed(site.id, site.name, customDomain, "assigned");
      console.log(`Assigned ${customDomain} to "${site.name}" (${site.id}).`);
    } catch (err) {
      // Leave it unprocessed so the next run retries it.
      console.error(`Failed for "${site.name}" (${site.id}):`, err);
    }
  }

  for (const site of renamedSites) {
    const oldDomain = processed.get(site.id)!.customDomain;
    const desired = `${site.name}.${baseDomain}`;
    try {
      await api.setCustomDomain(site.id, desired);
      await api.configureDns(site.id);
      // Best-effort: drop the previous subdomain's now-orphaned records.
      let removed = 0;
      if (oldDomain) {
        try {
          removed = await api.deleteRecordsForHostname(zone.id, oldDomain);
        } catch (e) {
          console.error(`Cleanup of stale records for ${oldDomain} failed:`, e);
        }
      }
      // Only record success after the domain move so a failure retries next run.
      await markProcessed(site.id, site.name, desired, "assigned");
      console.log(
        `Re-synced rename: ${oldDomain} -> ${desired} for "${site.name}" (${site.id}); removed ${removed} stale record(s).`,
      );
    } catch (err) {
      console.error(`Rename re-sync failed for "${site.name}" (${site.id}):`, err);
    }
  }
};

// Runs every minute for TESTING. For production, dial this back (e.g. "*/15 * * * *").
export const config: Config = {
  schedule: "* * * * *",
};
