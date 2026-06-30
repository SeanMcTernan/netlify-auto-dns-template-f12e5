import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema";

// Connection is configured automatically by Netlify Database — no string needed.
// Provisioned on first deploy; NETLIFY_DB_URL is injected by the platform.
export const db = drizzle({ schema });
export { schema };
