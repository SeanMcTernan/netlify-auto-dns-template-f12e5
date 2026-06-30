// Scheduled function: discover new sites on the team and auto-assign a custom
// domain derived from each site's name ({site.name}.{BASE_DOMAIN}), then wire
// up DNS in the Netlify-managed zone.
//
// Detection is poll-and-diff: Netlify has no "site.created" webhook, so we list
// all sites every run and compare against the processed_sites table in Netlify DB.

import type { Config } from "@netlify/functions";
import { NetlifyApi } from "../../lib/netlify-api";
import {
  ensureSchema,
  getProcessedIds,
  hasSeeded,
  markProcessed,
  markSeeded,
} from "../../lib/db";

export default async (): Promise<Response> => {
  const token = process.env.NETLIFY_API_TOKEN;
  const accountSlug = process.env.NETLIFY_ACCOUNT_SLUG;
  const baseDomain = process.env.BASE_DOMAIN;

  if (!token || !accountSlug || !baseDomain) {
    throw new Error(
      "Missing required env vars: NETLIFY_API_TOKEN, NETLIFY_ACCOUNT_SLUG, BASE_DOMAIN",
    );
  }

  const api = new NetlifyApi(token);
  await ensureSchema();

  // Precondition: the base domain must be covered by a Netlify-managed DNS zone,
  // otherwise PUT /sites/{id}/dns sets a custom domain that never resolves.
  const zones = await api.listDnsZones();
  const zoneCovers = zones.some(
    (z) => baseDomain === z.name || baseDomain.endsWith(`.${z.name}`),
  );
  if (!zoneCovers) {
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
    return new Response(`seeded ${sites.length}`, { status: 200 });
  }

  const processed = await getProcessedIds();
  const newSites = sites.filter((s) => !processed.has(s.id));
  console.log(`Discovered ${newSites.length} new site(s).`);

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

  return new Response(`processed ${newSites.length}`, { status: 200 });
};

// Runs every minute for TESTING. For production, dial this back (e.g. "*/15 * * * *").
export const config: Config = {
  schedule: "* * * * *",
};
