# Netlify Auto-DNS Template

A self-contained Netlify project that watches a team for **newly created sites** and
automatically assigns each one a custom domain derived from its name.

When someone deploys a site that Netlify names `custard.netlify.app`, this tool sets the
site's custom domain to `custard.<BASE_DOMAIN>` (e.g. `custard.vibecode.company.com`) and
wires up the DNS records in your Netlify-managed zone — no manual step.

## How it works

A scheduled Netlify Function runs on a cron and:

1. Lists every site on the team — `GET /accounts/{slug}/sites` (paginated).
2. Diffs against the `processed_sites` table in **Netlify DB** (Neon Postgres) to find sites it hasn't seen.
3. For each new site: `PATCH /sites/{id}` to set `custom_domain = {site.name}.{BASE_DOMAIN}`, then `PUT /sites/{id}/dns` to create the DNS records.
4. Records the result so each site is handled once.

There is no "site created" webhook in the Netlify API, so detection is poll-and-diff.

## Prerequisites

1. **Delegate your domain to Netlify DNS.** `BASE_DOMAIN` (or its apex) must be a
   **Netlify-managed DNS zone** — otherwise the DNS step assigns a domain that never
   resolves. The function checks this on startup and fails loudly if the zone is missing.
2. **A Personal Access Token** with access to the team and its DNS zone.

## Setup

```bash
npm install
netlify link            # link to the customer's Netlify team/site
netlify db init         # provision Netlify DB (Neon); injects NETLIFY_DATABASE_URL
```

Set the three config values (locally in `.env`, in production via the Netlify UI or CLI):

```bash
netlify env:set NETLIFY_API_TOKEN     "<personal-access-token>"
netlify env:set NETLIFY_ACCOUNT_SLUG  "<team-slug>"
netlify env:set BASE_DOMAIN           "vibecode.company.com"
```

Copy `.env.example` to `.env` for local runs. See it for what each value is.

## Deploy

```bash
netlify deploy --prod
```

## First run behaviour

The **first** execution seeds every existing site as already-handled and changes nothing —
it does **not** backfill domains onto sites that predate the tool. Only sites created
*after* that first run get a custom domain.

## Schedule

Set in [`netlify/functions/sync-dns.mts`](netlify/functions/sync-dns.mts) via
`export const config = { schedule: "* * * * *" }`.

It ships at **every minute** for testing. **Before production, dial it back** — e.g.
`"*/15 * * * *"` for every 15 minutes.

## Configuration

| Env var | What it is |
|---|---|
| `NETLIFY_API_TOKEN` | Personal Access Token (Bearer auth) for the Open API. |
| `NETLIFY_ACCOUNT_SLUG` | Team slug whose sites are watched. |
| `BASE_DOMAIN` | Domain new sites are placed under. Must be a Netlify-managed DNS zone. |
| `NETLIFY_DATABASE_URL` | Set automatically by `netlify db init`. Don't set by hand. |

## Safety

- A site that already has a custom domain is recorded and **left untouched** (never clobbered).
- A site that errors is left unprocessed and retried on the next run.
- The tool only ever acts on sites in the configured team.

## Layout

```
netlify/functions/sync-dns.mts   scheduled fn: discover -> diff -> assign
lib/netlify-api.ts               Open API client (Bearer token)
lib/db.ts                        Netlify DB (Neon) state helpers
db/schema.sql                    reference schema (auto-created at runtime)
netlify.toml                     functions config
.env.example                     config template
```
