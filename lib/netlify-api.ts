// Thin client over the Netlify Open API (https://open-api.netlify.com/).
// Auth is a Personal Access Token passed as a Bearer token.

const BASE = "https://api.netlify.com/api/v1";

export interface NetlifySite {
  id: string;
  name: string;
  custom_domain: string | null;
  created_at: string;
  url?: string;
  default_domain?: string;
  account_slug?: string;
  published_deploy?: {
    id: string;
    available_functions?: unknown[];
  } | null;
}

export interface SiteFile {
  path: string; // leading slash, e.g. "/index.html"
  sha: string;
  size: number;
}

export interface DnsZone {
  id: string;
  name: string;
  account_slug?: string;
}

export interface DnsRecord {
  id: string;
  hostname: string;
  type: string;
}

export class NetlifyApi {
  constructor(private readonly token: string) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Netlify API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${body}`,
      );
    }
    return res;
  }

  /** GET /accounts/{slug}/sites — paginated; returns every site on the team. */
  async listSites(accountSlug: string): Promise<NetlifySite[]> {
    const all: NetlifySite[] = [];
    const perPage = 100;
    let page = 1;
    for (;;) {
      // Note: the account-scoped sites endpoint is /{account_slug}/sites — there
      // is NO /accounts/ prefix here (unlike /accounts for listing accounts).
      const res = await this.request(
        `/${accountSlug}/sites?page=${page}&per_page=${perPage}`,
      );
      const batch = (await res.json()) as NetlifySite[];
      all.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }
    return all;
  }

  /** GET /dns_zones — the Netlify-managed DNS zones this token can see. */
  async listDnsZones(): Promise<DnsZone[]> {
    const res = await this.request(`/dns_zones`);
    return (await res.json()) as DnsZone[];
  }

  /** PATCH /sites/{id} — assign the custom domain (updateSite, body siteSetup).
   *  Do NOT send force_ssl here: a brand-new custom domain has no certificate yet,
   *  and forcing SSL before one is provisioned returns 422 "Provision a certificate
   *  before forcing SSL". Netlify provisions the cert asynchronously once the domain
   *  and DNS are set; force-SSL is a later, separate step. */
  async setCustomDomain(siteId: string, customDomain: string): Promise<void> {
    await this.request(`/sites/${siteId}`, {
      method: "PATCH",
      body: JSON.stringify({ custom_domain: customDomain }),
    });
  }

  /** PUT /sites/{id}/dns — configureDNSForSite; no body. Auto-creates the
   *  records in the managed zone for the site's custom domain. */
  async configureDns(siteId: string): Promise<void> {
    await this.request(`/sites/${siteId}/dns`, { method: "PUT" });
  }

  /** GET /dns_zones/{zone_id}/dns_records — all records in a zone. */
  async listDnsRecords(zoneId: string): Promise<DnsRecord[]> {
    const res = await this.request(`/dns_zones/${zoneId}/dns_records`);
    return (await res.json()) as DnsRecord[];
  }

  /** DELETE /dns_zones/{zone_id}/dns_records/{id} — remove one record. */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request(`/dns_zones/${zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
    });
  }

  /** Delete every record in the zone whose hostname matches `hostname`
   *  (a custom domain maps to multiple records, e.g. NETLIFY + NETLIFYv6). */
  async deleteRecordsForHostname(zoneId: string, hostname: string): Promise<number> {
    const records = await this.listDnsRecords(zoneId);
    const matches = records.filter((r) => r.hostname === hostname);
    for (const r of matches) {
      await this.deleteDnsRecord(zoneId, r.id);
    }
    return matches.length;
  }

  /** GET /sites/{id}/files — every file in the published deploy, with SHA1s. */
  async listSiteFiles(siteId: string): Promise<SiteFile[]> {
    const res = await this.request(`/sites/${siteId}/files`);
    return (await res.json()) as SiteFile[];
  }

  /** GET /sites/{id}/files/{path} with the raw Accept header — file content,
   *  or null if the file doesn't exist in the published deploy. */
  async getFileRaw(siteId: string, path: string): Promise<string | null> {
    const clean = path.replace(/^\//, "");
    const res = await fetch(`${BASE}/sites/${siteId}/files/${clean}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.bitballoon.v1.raw",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Netlify API GET file ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  /** POST /sites/{id}/deploys — create a file-digest deploy. Netlify reuses
   *  every blob it already has; `required` lists the SHAs we must upload. */
  async createFileDeploy(
    siteId: string,
    files: Record<string, string>, // "/path" -> sha1
    title: string,
  ): Promise<{ id: string; required: string[] }> {
    const res = await this.request(`/sites/${siteId}/deploys`, {
      method: "POST",
      body: JSON.stringify({ files, title }),
    });
    const deploy = (await res.json()) as { id: string; required?: string[] };
    return { id: deploy.id, required: deploy.required ?? [] };
  }

  /** PUT /deploys/{id}/files/{path} — upload one file's content for a pending deploy. */
  async uploadDeployFile(deployId: string, path: string, content: string): Promise<void> {
    const clean = path.replace(/^\//, "");
    const res = await fetch(`${BASE}/deploys/${deployId}/files/${clean}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: content,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Netlify API upload ${path} failed: ${res.status} ${body}`);
    }
  }
}
