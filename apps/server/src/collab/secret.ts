import { createHmac } from "node:crypto";

/**
 * The shared secret between the API and the collab service, for the calls
 * each makes to the other on loopback. Derived from SECRET_KEY, which both
 * processes have, so there is nothing more to provision; `COLLAB_SECRET`
 * overrides it. In development without either there is a fixed one -- the
 * API's internal routes also refuse anything not from loopback.
 */
export function collabSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.COLLAB_SECRET) return env.COLLAB_SECRET;
  if (env.SECRET_KEY) return createHmac("sha256", env.SECRET_KEY).update("ucch:collab").digest("hex");
  return env.NODE_ENV === "production" ? null : "ucch-collab-development";
}

export const COLLAB_SECRET_HEADER = "x-ucch-collab";
