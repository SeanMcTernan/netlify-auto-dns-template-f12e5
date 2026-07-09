import { describe, expect, it } from "vitest";
import { buildRedirects } from "../lib/redirects";

const NAME = "custard";
const DOMAIN = "custard.vibecode.company.com";
const RULE = `https://${NAME}.netlify.app/* https://${DOMAIN}/:splat 301!`;

describe("buildRedirects", () => {
  it("creates a fresh managed block when no _redirects exists", () => {
    const out = buildRedirects(null, NAME, DOMAIN);
    expect(out).toContain(RULE);
    expect(out.startsWith("# --- auto-dns")).toBe(true);
  });

  it("prepends the managed block and preserves the owner's rules", () => {
    const theirs = "/old-path /new-path 302\n/api/* /.netlify/functions/:splat 200\n";
    const out = buildRedirects(theirs, NAME, DOMAIN);
    // Our forced rule must come first so enforcement wins on the netlify.app host.
    expect(out.indexOf(RULE)).toBeLessThan(out.indexOf("/old-path"));
    expect(out).toContain("/old-path /new-path 302");
    expect(out).toContain("/api/* /.netlify/functions/:splat 200");
  });

  it("replaces a stale managed block instead of stacking a second one", () => {
    const afterRename = buildRedirects(
      buildRedirects("/keep /me 302", "oldname", "oldname.vibecode.company.com"),
      NAME,
      DOMAIN,
    );
    expect(afterRename).toContain(RULE);
    expect(afterRename).not.toContain("oldname.netlify.app");
    expect(afterRename).toContain("/keep /me 302");
    expect(afterRename.match(/auto-dns/g)?.length).toBe(1);
  });

  it("is idempotent — re-running on its own output changes nothing", () => {
    const once = buildRedirects("/keep /me 302", NAME, DOMAIN);
    expect(buildRedirects(once, NAME, DOMAIN)).toBe(once);
  });

  it("is idempotent with no owner rules too", () => {
    const once = buildRedirects(null, NAME, DOMAIN);
    expect(buildRedirects(once, NAME, DOMAIN)).toBe(once);
  });
});
