// Builds the _redirects content that force-301s a site's default
// {name}.netlify.app hostname to its primary custom domain.
//
// Our rule lives in a marked "managed block" at the TOP of the file (host-scoped
// forced rules are first-match, and enforcement should win), and merging is
// idempotent: any previous managed block is stripped before the fresh one is
// prepended, so renames and re-injections never accumulate stale rules.

const MARKER = "# --- auto-dns: enforce primary domain (managed block, do not edit) ---";

export function buildRedirects(
  existingRaw: string | null,
  siteName: string,
  customDomain: string,
): string {
  const block = `${MARKER}\nhttps://${siteName}.netlify.app/* https://${customDomain}/:splat 301!\n`;
  if (!existingRaw) return block;

  // Drop any previous managed block: the marker line plus the rule line after it.
  const lines = existingRaw.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === MARKER) {
      i++; // also skip the rule line that follows the marker
      continue;
    }
    kept.push(lines[i]);
  }
  const rest = kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return rest ? `${block}\n${rest}\n` : block;
}
