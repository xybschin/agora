// matrixPool.ts
//
// Turns a caller's access token into the MatrixClient that matrixActions.ts
// sends requests with. Despite the name, nothing is pooled: a Matrix client is
// just an access token plus a homeserver base URL, with no persistent
// connection to hold open, so a fresh client per call costs nothing. The token
// is the caller's identity; the homeserver URL comes from
// MATRIX_HOME_SERVER_URL, which composeGenerator.ts sets from the credentials'
// containerBaseUrl (the self-hosted Synapse as seen from inside Docker).

export interface MatrixClient {
  homeServerUrl: string;
  accessToken: string;
}

/**
 * Reads a required environment variable, throwing if it is unset or empty.
 *
 * MATRIX_HOME_SERVER_URL has no default on purpose: this URL is what decides
 * who is handed the agent's access token, and the correct value genuinely
 * differs between the host (hostBaseUrl) and a container (containerBaseUrl),
 * so a fallback could only ever be the wrong one. Compose
 * always sets it, which means the failure only ever fires when the server runs
 * outside compose -- exactly when someone has a token in hand. Loudly refusing
 * is the point: quietly pointing at a public homeserver would offer a live
 * agent's credential to a server the Run never provisioned.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * Returns a client for the caller's token against the configured homeserver,
 * with trailing slashes stripped from the URL so request paths can be appended
 * directly. Throws if MATRIX_HOME_SERVER_URL is unset or empty.
 */
export function getMatrixClient(accessToken: string): MatrixClient {
  // Read inside the call rather than captured at module load, so that it stays
  // a per-call read of the current environment: an operator who fixes the
  // variable is then fixed for the next tool call, with no restart, and a
  // stale captured value can never silently pin a wrong homeserver.
  const homeServerUrl = requireEnv("MATRIX_HOME_SERVER_URL");
  return { homeServerUrl: homeServerUrl.replace(/\/+$/, ""), accessToken };
}
