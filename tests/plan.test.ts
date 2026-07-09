import { describe, expect, it } from "vitest";
import { classifySites, deriveDomain, pickZone, type PlanRecord } from "../lib/plan";
import type { NetlifySite } from "../lib/netlify-api";

const NOW = Date.parse("2026-07-09T12:00:00Z");
const BASE = "vibecode.company.com";

function site(over: Partial<NetlifySite>): NetlifySite {
  return {
    id: "id-" + (over.name ?? "x"),
    name: "x",
    custom_domain: null,
    created_at: new Date(NOW - 5 * 60_000).toISOString(), // 5 minutes old
    ...over,
  };
}

function rec(over: Partial<PlanRecord>): PlanRecord {
  return { name: "x", customDomain: null, action: "seeded", ...over };
}

function classify(sites: NetlifySite[], processed: Map<string, PlanRecord>) {
  return classifySites({ sites, processed, baseDomain: BASE, maxAgeMinutes: 60, now: NOW });
}

describe("deriveDomain", () => {
  it("joins site name onto the base domain", () => {
    expect(deriveDomain("custard", BASE)).toBe("custard.vibecode.company.com");
  });
});

describe("classifySites", () => {
  it("puts an unseen recent site in newSites", () => {
    const s = site({ name: "custard" });
    const plan = classify([s], new Map());
    expect(plan.newSites).toEqual([s]);
    expect(plan.staleUnseen).toEqual([]);
    expect(plan.renamed).toEqual([]);
  });

  it("seeds (not assigns) an unseen site older than the window", () => {
    const s = site({ name: "old", created_at: new Date(NOW - 61 * 60_000).toISOString() });
    const plan = classify([s], new Map());
    expect(plan.newSites).toEqual([]);
    expect(plan.staleUnseen).toEqual([s]);
  });

  it("treats a site exactly at the window boundary as new (not stale)", () => {
    const s = site({ name: "edge", created_at: new Date(NOW - 60 * 60_000).toISOString() });
    const plan = classify([s], new Map());
    expect(plan.newSites).toEqual([s]);
  });

  it("does nothing for an assigned site whose name still matches", () => {
    const s = site({ name: "custard" });
    const processed = new Map([
      [s.id, rec({ name: "custard", customDomain: `custard.${BASE}`, action: "assigned" })],
    ]);
    const plan = classify([s], processed);
    expect(plan.newSites).toEqual([]);
    expect(plan.renamed).toEqual([]);
  });

  it("flags an assigned site whose name changed as renamed", () => {
    const s = site({ name: "eclair" });
    const processed = new Map([
      [s.id, rec({ name: "custard", customDomain: `custard.${BASE}`, action: "assigned" })],
    ]);
    expect(classify([s], processed).renamed).toEqual([s]);
  });

  it("never flags seeded or manually-domained sites as renamed", () => {
    const seeded = site({ name: "renamed-seeded" });
    const manual = site({ name: "renamed-manual" });
    const processed = new Map([
      [seeded.id, rec({ name: "original", action: "seeded" })],
      [
        manual.id,
        rec({ name: "original", customDomain: "own.example.com", action: "skipped_existing_domain" }),
      ],
    ]);
    expect(classify([seeded, manual], processed).renamed).toEqual([]);
  });
});

describe("pickZone", () => {
  const zones = [
    { id: "z1", name: "company.com" },
    { id: "z2", name: "staging.company.com" },
  ];

  it("matches the exact zone", () => {
    expect(pickZone(zones, "company.com")?.id).toBe("z1");
  });

  it("matches a base domain under a zone", () => {
    expect(pickZone(zones, "apps.company.com")?.id).toBe("z1");
  });

  it("prefers the most specific zone when several match", () => {
    expect(pickZone(zones, "deploys.staging.company.com")?.id).toBe("z2");
  });

  it("returns undefined when nothing covers the base domain", () => {
    expect(pickZone(zones, "other.org")).toBeUndefined();
  });

  it("does not match a partial label (mycompany.com is not company.com)", () => {
    expect(pickZone(zones, "mycompany.com")).toBeUndefined();
  });
});
