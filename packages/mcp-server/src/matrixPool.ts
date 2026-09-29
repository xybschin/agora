/**
 * Matrix clients are just an access token + homeserver base URL -- there is
 * no persistent gateway connection to hold open the way discord.js had. The
 * "pool" here is trivial: each access token is enough to make authenticated
 * requests to any homeserver, so we key only by token (an agent's identity)
 * and resolve the homeserver URL from the environment at request time via
 * MATRIX_HOME_SERVER_URL (set by composeGenerator.ts from the credentials'
 * containerBaseUrl, e.g. a self-hosted Synapse).
 */
export interface MatrixClient {
  homeServerUrl: string;
  accessToken: string;
}

/**
 * Required, with no default, unlike the tuning vars around it: this URL is
 * what decides who is handed the agent's access token, and the correct value
 * genuinely differs between the host (hostBaseUrl) and a container
 * (containerBaseUrl), so a fallback could only ever be the wrong one. Compose
 * always sets it, which means the failure only ever fires when the server runs
 * outside compose -- exactly when someone has a token in hand. Loudly refusing
 * is the point: quietly pointing at a public homeserver would offer a live
 * agent's credential to a server the run never provisioned.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function getMatrixClient(accessToken: string): MatrixClient {
  // Read inside the call rather than captured at module load, so that it stays
  // a per-call read of the current environment: an operator who fixes the
  // variable is then fixed for the next tool call, with no restart, and a
  // stale captured value can never silently pin a wrong homeserver.
  const homeServerUrl = requireEnv("MATRIX_HOME_SERVER_URL");
  return { homeServerUrl: homeServerUrl.replace(/\/+$/, ""), accessToken };
}
