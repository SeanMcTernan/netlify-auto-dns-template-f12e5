# Netlify Auto-DNS Template

Watches a Netlify team for **newly created sites** and automatically gives each one a
custom domain derived from its name — then keeps it that way.

When someone deploys a site that Netlify names `custard.netlify.app`, this tool:

1. sets the site's custom domain to `custard.<BASE_DOMAIN>` (e.g. `custard.vibecode.company.com`),
2. creates the DNS records in your Netlify-managed zone,
3. injects a forced 301 so `custard.netlify.app` redirects to the custom domain,
4. follows renames — rename the site and the subdomain moves with it, stale DNS cleaned up.

No manual steps, ever.

## One-click deploy

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/SeanMcTernan/netlify-auto-dns-template)

The deploy flow prompts for **exactly three** environment variables:

| Variable | What it is |
|---|---|
| `NETLIFY_API_TOKEN` | Personal access token with access to your team and its DNS zone. Create at **User settings → Applications → Personal access tokens**. ⚠️ **Choose a long expiration** — an expired token silently stops the tool (see Troubleshooting). |
| `NETLIFY_ACCOUNT_SLUG` | Your team slug, from the team URL `app.netlify.com/teams/<slug>`. |
| `BASE_DOMAIN` | Domain new sites are placed under, e.g. `vibecode.company.com`. Must be covered by a **Netlify-managed DNS zone** (see Prerequisites). |

The **database is provisioned and connected automatically** by Netlify DB on deploy —
no connection string, nothing else to configure.

## Prerequisites

1. **Your domain must be delegated to Netlify DNS.** `BASE_DOMAIN` (or a parent of it)
   must be a Netlify-managed DNS zone, or assigned domains would never resolve. The
   function checks this on startup and fails loudly if the zone is missing.
2. A **Personal Access Token** for an account with access to the team and the zone.

Subdomain bases work too: `BASE_DOMAIN=staging.company.com` under a managed
`company.com` zone gives new sites `name.staging.company.com`. If several managed
zones match, the most specific one is used.

## How it works

A scheduled Netlify Function (default: **every 15 minutes**) reconciles the team:

| Situation | Action |
|---|---|
| Unseen site, recently created | Assign `{name}.{BASE_DOMAIN}`, create DNS records |
| Unseen site older than `MAX_SITE_AGE_MINUTES` | Seed as already-handled — **no retroactive domains** after downtime |
| Site we assigned was renamed | Move domain to the new name, re-wire DNS, delete stale records |
| Assigned site's deploy lacks the redirect rule | Inject `_redirects` forcing `{name}.netlify.app` → 301 → custom domain |
| Site already had a custom domain when found | Recorded and **never touched** |

Detection is poll-and-diff against a `processed_sites` table in Netlify DB — the
Netlify API has no site created/renamed webhooks. Each site is handled once per change.

### Redirect enforcement details

The `.netlify.app` URL of a site does **not** redirect to its custom domain on its own.
The tool closes that gap by adding a managed rule block to the site's `_redirects` via
an incremental deploy: it copies the published deploy's file manifest, merges the rule
(owner rules are preserved, the managed block is replaced idempotently), and uploads
only that one small file. If the owner later deploys without the rule, it's re-applied
on the next cycle.

**Sites whose deploys contain serverless functions are skipped** (an injected static
deploy would drop their functions) and logged — add the rule to those repos directly:

```
https://<site-name>.netlify.app/* https://<custom-domain>/:splat 301!
```

Note: unique deploy permalinks (`<deploy-id>--<name>.netlify.app`) are not covered by
host-scoped rules and remain reachable.

## Configuration reference

| Env var | Required | Default | Notes |
|---|---|---|---|
| `NETLIFY_API_TOKEN` | yes | — | PAT, Bearer auth |
| `NETLIFY_ACCOUNT_SLUG` | yes | — | team to watch |
| `BASE_DOMAIN` | yes | — | must be under a managed zone |
| `MAX_SITE_AGE_MINUTES` | no | `1440` | unseen sites older than this are seeded, not domain-ified |

## Schedule

Set in [`netlify/functions/sync-dns.mts`](netlify/functions/sync-dns.mts):
`export const config = { schedule: "*/15 * * * *" }`. For rapid testing use
`"* * * * *"` (every minute — Netlify's minimum) and redeploy.

## Safety properties

- **First run seeds, changes nothing.** Existing sites are recorded as-is; only sites
  created afterwards get domains.
- Sites with a deliberately-set custom domain are never clobbered.
- Renames only affect domains **this tool** assigned.
- Function-bearing sites are never redirect-injected.
- Any per-site failure is logged and retried next cycle; one bad site never blocks the rest.
- After downtime, `MAX_SITE_AGE_MINUTES` prevents surprise mass-assignment.

## Local development & tests

```bash
npm install
npm test              # unit tests (pure logic: planning, redirect merging)
npm run typecheck
netlify dev           # runs with a local dev database automatically
```

Schema changes: edit `db/schema.ts` → `npm run db:generate` → commit the migration.
Migrations apply automatically on deploy. **Never delete an applied migration** —
deploys fail with "migration has been removed after being applied".

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Logs: `401 Unauthorized` on every run | **The PAT expired or was revoked.** Mint a new one, `netlify env:set NETLIFY_API_TOKEN <token>`. The tool self-heals next cycle; sites created during the outage are seeded (not domain-ified) per `MAX_SITE_AGE_MINUTES`. |
| Logs: `No Netlify-managed DNS zone covers ...` | `BASE_DOMAIN` isn't under a zone in Netlify DNS. Delegate the domain (Team → Domains) or fix the env var. The tool makes no changes while this fails. |
| New site got a domain but `https://` shows a cert warning briefly | Normal — Netlify provisions the certificate asynchronously after DNS is set. |
| A site's `.netlify.app` URL still serves 200 | Check logs: the site may be **function-bearing (skipped)**, not yet deployed (empty sites are skipped until content exists), or the next cycle hasn't run. |
| Deploy fails: `migration ... has been removed after being applied` | A previously-applied migration was deleted from the repo. Restore it; only add new migrations. |
| `MissingDatabaseConnectionError` after a CLI deploy | Deploy with a current Netlify CLI (v26+) or via Git — old CLIs don't wire the Netlify DB connection into functions. |

## Layout

```
netlify/functions/sync-dns.mts   scheduled reconciler (discover → assign → rename → enforce)
lib/netlify-api.ts               Netlify Open API client (Bearer token)
lib/plan.ts                      pure decision logic (unit-tested)
lib/redirects.ts                 _redirects managed-block builder (unit-tested)
lib/db.ts                        state helpers (Drizzle queries)
db/schema.ts, db/index.ts        Netlify DB schema + zero-config connection
netlify/database/migrations/     generated migrations, auto-applied on deploy
tests/                           vitest unit tests
netlify.toml                     one-click template env vars + functions config
```
