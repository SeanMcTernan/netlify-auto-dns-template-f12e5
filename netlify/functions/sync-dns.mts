// Scheduled function that keeps team sites' custom domains in sync with their names:
//   - NEW site      -> assign {site.name}.{BASE_DOMAIN} and wire up DNS
//   - RENAMED site  -> move the custom domain to the new name, re-wire DNS,
//                      delete the stale records
//   - ENFORCEMENT   -> inject a forced 301 (_redirects) so {name}.netlify.app
//                      redirects to the custom domain; re-applied whenever the
//                      site publishes a new deploy that lacks the rule
//
// Detection is poll-and-diff: Netlify has no site created/renamed/deployed
// webhooks here, so we list all sites every run and compare against the
// processed_sites table (Netlify DB).

import { createHash } from "node:crypto";
import type { Config } from "@netlify/functions";
import { NetlifyApi, type NetlifySite } from "../../lib/netlify-api";
import { buildRedirects } from "../../lib/redirects";
import {
  getProcessed,
  hasSeeded,
  markProcessed,
  markRedirect,
  markSeeded,
} from "../../lib/db";

export default async (): Promise<void> => {
  const token = Netlify.env.get("NETLIFY_API_TOKEN");
  const accountSlug = Netlify.env.get("NETLIFY_ACCOUNT_SLUG");
  const baseDomain = Netlify.env.get("BASE_DOMAIN");
  // Catch-up guard: a site OLDER than this that shows up as unseen was created
  // while the tool was down (or before install) — seed it, don't domain-ify it.
  const maxAgeMinutes = Number(Netlify.env.get("MAX_SITE_AGE_MINUTES") ?? "1440");

  if (!token || !accountSlug || !baseDomain) {
    throw new Error(
      "Missing required env vars: NETLIFY_API_TOKEN, NETLIFY_ACCOUNT_SLUG, BASE_DOMAIN",
    );
  }

  const api = new NetlifyApi(token);

  // Precondition: the base domain must be covered by a Netlify-managed DNS zone.
  // Pick the MOST SPECIFIC matching zone (e.g. staging.example.com over
  // example.com) — that's where Netlify actually materialises the records, so
  // rename cleanup must look there too.
  const zones = await api.listDnsZones();
  const zone = zones
    .filter((z) => baseDomain === z.name || baseDomain.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
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

  const unseen = sites.filter((s) => !processed.has(s.id));
  const newSites: NetlifySite[] = [];
  for (const site of unseen) {
    const ageMinutes = (Date.now() - Date.parse(site.created_at)) / 60_000;
    if (ageMinutes > maxAgeMinutes) {
      // Created during downtime — too old to auto-domain. Seed it instead.
      await markProcessed(site.id, site.name, site.custom_domain ?? null, "seeded");
      console.log(
        `Seeded stale-unseen site "${site.name}" (${Math.round(ageMinutes)}m old > ${maxAgeMinutes}m window).`,
      );
      continue;
    }
    newSites.push(site);
  }

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
      // This also resets redirect state, so the new domain gets re-injected below.
      await markProcessed(site.id, site.name, desired, "assigned");
      console.log(
        `Re-synced rename: ${oldDomain} -> ${desired} for "${site.name}" (${site.id}); removed ${removed} stale record(s).`,
      );
    } catch (err) {
      console.error(`Rename re-sync failed for "${site.name}" (${site.id}):`, err);
    }
  }

  // ---- Redirect enforcement: {name}.netlify.app -> custom domain (301) ----
  // Re-read state so sites assigned/renamed THIS run are evaluated too.
  const current = await getProcessed();
  for (const site of sites) {
    const rec = current.get(site.id);
    if (!rec || rec.action !== "assigned" || !rec.customDomain) continue;

    const pub = site.published_deploy;
    if (!pub?.id) continue; // nothing deployed yet — revisit once content exists
    if (rec.redirectDeployId === pub.id) continue; // this deploy already evaluated

    try {
      // Guard: a file-digest deploy carries static files only. Injecting onto a
      // site with serverless functions would DROP them — skip those sites.
      if ((pub.available_functions?.length ?? 0) > 0) {
        await markRedirect(site.id, "skipped_functions", pub.id);
        console.log(`Redirect skipped for "${site.name}": deploy has serverless functions.`);
        continue;
      }

      // Copy the published deploy's file manifest, merge in our _redirects rule.
      const files = await api.listSiteFiles(site.id);
      const hasExisting = files.some((f) => f.path === "/_redirects");
      const existingRaw = hasExisting ? await api.getFileRaw(site.id, "_redirects") : null;
      const content = buildRedirects(existingRaw, site.name, rec.customDomain);

      // Already enforced (e.g. our own injected deploy just published, or the
      // owner kept the rule) — stamp it and move on without another deploy.
      if (existingRaw !== null && existingRaw === content) {
        await markRedirect(site.id, "injected", pub.id);
        continue;
      }

      const sha = createHash("sha1").update(content).digest("hex");

      const digest: Record<string, string> = {};
      for (const f of files) digest[f.path] = f.sha;
      digest["/_redirects"] = sha;

      const deploy = await api.createFileDeploy(
        site.id,
        digest,
        "auto-dns: enforce primary domain",
      );
      if (deploy.required.includes(sha)) {
        await api.uploadDeployFile(deploy.id, "_redirects", content);
      }
      await markRedirect(site.id, "injected", deploy.id);
      console.log(
        `Injected netlify.app->custom-domain redirect for "${site.name}" (deploy ${deploy.id}).`,
      );
    } catch (err) {
      console.error(`Redirect enforcement failed for "${site.name}" (${site.id}):`, err);
    }
  }
};

// Runs every minute for TESTING. For production, dial this back (e.g. "*/15 * * * *").
export const config: Config = {
  schedule: "* * * * *",
};
