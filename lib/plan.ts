// Pure decision logic for the sync loop — no I/O, fully unit-testable.
// The scheduled function fetches state, calls these, then executes the plan.

import type { DnsZone, NetlifySite } from "./netlify-api";

/** Minimal shape of a processed_sites row the planner needs. */
export interface PlanRecord {
  name: string;
  customDomain: string | null;
  action: string; // 'seeded' | 'assigned' | 'skipped_existing_domain'
}

export interface Plan {
  /** Unseen sites young enough to auto-domain. */
  newSites: NetlifySite[];
  /** Unseen sites older than the window (created during downtime) — seed only. */
  staleUnseen: NetlifySite[];
  /** Sites we assigned whose name no longer maps to the stored domain. */
  renamed: NetlifySite[];
}

export function deriveDomain(siteName: string, baseDomain: string): string {
  return `${siteName}.${baseDomain}`;
}

/** Classify every site on the team into the actions this run should take. */
export function classifySites(input: {
  sites: NetlifySite[];
  processed: Map<string, PlanRecord>;
  baseDomain: string;
  maxAgeMinutes: number;
  now: number; // epoch ms — passed in so the logic stays pure
}): Plan {
  const newSites: NetlifySite[] = [];
  const staleUnseen: NetlifySite[] = [];
  const renamed: NetlifySite[] = [];

  for (const site of input.sites) {
    const rec = input.processed.get(site.id);
    if (!rec) {
      const ageMinutes = (input.now - Date.parse(site.created_at)) / 60_000;
      if (ageMinutes > input.maxAgeMinutes) staleUnseen.push(site);
      else newSites.push(site);
      continue;
    }
    // A rename only concerns sites WE assigned; 'seeded' and
    // 'skipped_existing_domain' sites are never touched.
    if (
      rec.action === "assigned" &&
      deriveDomain(site.name, input.baseDomain) !== rec.customDomain
    ) {
      renamed.push(site);
    }
  }

  return { newSites, staleUnseen, renamed };
}

/** The managed zone covering baseDomain. Most specific wins: with zones for
 *  both example.com and staging.example.com, records for x.staging.example.com
 *  materialise in the staging zone — cleanup must look there. */
export function pickZone(zones: DnsZone[], baseDomain: string): DnsZone | undefined {
  return zones
    .filter((z) => baseDomain === z.name || baseDomain.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}
