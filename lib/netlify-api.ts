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
}

export interface DnsZone {
  id: string;
  name: string;
  account_slug?: string;
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
}
