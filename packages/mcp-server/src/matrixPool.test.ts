import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getMatrixClient } from "./matrixPool.js";

// The MCP server talks to Matrix on behalf of an agent, and every request it
// makes carries that agent's access token. So an unconfigured homeserver is
// not an inconvenience to paper over with a default: falling back to a public
// homeserver would offer a live agent's token to a server the run never
// provisioned. The URL therefore has to be required, the same way the agent
// requires its own Matrix variables (config.ts's requireEnv). What the run is
// pointed at differs between the host and a container, so there is no default
// that is right in both places and none at all.

const ENV_VAR = "MATRIX_HOME_SERVER_URL";

let savedHomeServerUrl: string | undefined;

beforeEach(() => {
  savedHomeServerUrl = process.env[ENV_VAR];
});

afterEach(() => {
  if (savedHomeServerUrl === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedHomeServerUrl;
});

describe("getMatrixClient", () => {
  test("refuses to hand out a client when the homeserver is not configured", () => {
    delete process.env[ENV_VAR];
    expect(() => getMatrixClient("syt_alex")).toThrow(`Missing required env var ${ENV_VAR}`);
  });

  test("treats an empty homeserver as unconfigured, not as a URL", () => {
    // An empty string would otherwise become an empty base URL and every
    // request would resolve against the MCP server itself.
    process.env[ENV_VAR] = "";
    expect(() => getMatrixClient("syt_alex")).toThrow(`Missing required env var ${ENV_VAR}`);
  });

  test("normalises the configured homeserver, stripping trailing slashes", () => {
    // csRequest concatenates `${homeServerUrl}/_matrix/client/v3/...`, so a
    // trailing slash on the configured value would double up in every path.
    process.env[ENV_VAR] = "http://synapse:8008";
    expect(getMatrixClient("syt_alex").homeServerUrl).toBe("http://synapse:8008");

    process.env[ENV_VAR] = "http://synapse:8008/";
    expect(getMatrixClient("syt_alex").homeServerUrl).toBe("http://synapse:8008");

    process.env[ENV_VAR] = "http://synapse:8008///";
    expect(getMatrixClient("syt_alex").homeServerUrl).toBe("http://synapse:8008");
  });

  test("passes the caller's access token through untouched", () => {
    // The token is the agent's identity (the tool takes no agent_id), so the
    // pool must not reshape or cache it on the way through.
    process.env[ENV_VAR] = "http://synapse:8008";
    expect(getMatrixClient("syt_alex").accessToken).toBe("syt_alex");
  });

  test("reads the homeserver at call time, so a changed environment is honoured", () => {
    // Deliberately not resolved once at module load: an operator who fixes the
    // environment has to be able to fix it without restarting the process, and
    // a stale captured value would be a silent wrong-homeserver bug.
    process.env[ENV_VAR] = "http://synapse:8008";
    expect(getMatrixClient("syt_alex").homeServerUrl).toBe("http://synapse:8008");

    process.env[ENV_VAR] = "https://matrix.example.org";
    expect(getMatrixClient("syt_alex").homeServerUrl).toBe("https://matrix.example.org");
  });
});
