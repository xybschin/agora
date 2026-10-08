/**
 * The Matrix Client-Server calls that the bootstrap script and the runner share.
 *
 * A Run gets its own room (ADR-0003), so the runner has to create, populate and
 * join rooms. The bootstrap script provisions the accounts those rooms need and
 * reaches the homeserver through the same request seam, but creates no room of
 * its own. The calls live here rather than in either caller, and importing this
 * module deliberately does nothing: it registers no account, creates no room,
 * writes no file. Whoever imports it decides when to act, which is what lets a
 * test import it without touching a homeserver.
 *
 * Like the mcp-server's `matrixActions.ts`, the runner's Matrix access talks to
 * the Client-Server API directly with raw fetch rather than pulling in
 * matrix-js-sdk. `csRequest` below is the single seam every runner-side
 * Client-Server call goes through: room creation, the invites, the joins, the
 * Moderator's display name, the power levels write and read-back, the seed
 * post, the bootstrap script's account registration, and -- through the Synapse
 * admin API, which needs a server-admin token (ADR-0009) -- the admin account's
 * registration and reclamation's room lookup and room delete. `clientPath` beside it is the seam every one of those
 * calls spells its urlPath through, so the API version lives in one place, and
 * `roomPath` beside that is the room-scoped half of the same bargain: the
 * `rooms/<id>` segment and its encoding are written once too, rather than
 * re-spelled and re-escaped at each of the four calls that address a room.
 */

import { createHmac } from "node:crypto";
import { createLogger } from "@agora/shared";

const log = createLogger("matrix");

/**
 * The Client-Server API version this harness speaks. Matrix versions the whole
 * CS API together, so this is a property of the runner, not of any one call.
 */
const CLIENT_PREFIX = "/_matrix/client/v3";

/**
 * Builds the absolute urlPath a Client-Server call takes, from the endpoint
 * onwards: `clientPath("createRoom")`.
 *
 * The prefix is written here once so a wrong version segment cannot reach a
 * homeserver -- nothing but a live 404 would tell us the literal was wrong, and
 * a Run is a long way from where a 404 surfaces. This also owns the joining
 * slash, so a callsite cannot leave it out, and the empty suffix is the prefix
 * itself, which is what a caller trimming a full urlPath back to its endpoint
 * needs.
 *
 * This is the general half of the path pair: it is for the endpoints that do not
 * address a room (`createRoom`, `register`). A call that does address a room
 * goes through `roomPath` below, which is this plus the room segment -- spelling
 * `rooms/<id>` into a `clientPath` suffix is how that segment came to be
 * written out four times.
 *
 * The result is still an absolute path because `csRequest` takes one. That is
 * deliberate: it keeps the helper honest about the whole of what it calls, and
 * its error text can name the endpoint as the homeserver refused it. (The
 * mcp-server's own client takes a prefix-relative path and prepends inside its
 * request helper; that is a different seam, and the runner does not adopt it.)
 */
export function clientPath(suffix: string): string {
  return suffix === "" ? CLIENT_PREFIX : `${CLIENT_PREFIX}/${suffix}`;
}

/**
 * Builds the absolute urlPath a room-scoped Client-Server call takes, from the
 * room onwards: `roomPath("!room:localhost", "invite")`. The suffix is everything
 * under the room -- "state/m.room.power_levels", "send/m.room.message/<txnId>" --
 * joined with a single slash here.
 *
 * The room id is encoded here rather than at the four callsites, because a Matrix
 * room id carries a `:` and a callsite that spells its own segment can leave the
 * escaping out or apply it twice, and neither mistake is anything more than a
 * homeserver 404 until a Run is already under way. So `roomId` is the raw id a
 * homeserver handed back -- what `createRoom` returns and what `runRoom` threads
 * down to the seed and the permissions -- and passing one that is already
 * percent-encoded would double-encode it into a 404. Every room id the runner
 * holds is raw for exactly that reason.
 *
 * The suffix stays a plain string on purpose, which is the same bargain
 * `clientPath` makes and not a stronger one: a typo inside `"invite"` is still a
 * 404, so what this buys is that the segment and its encoding are written once,
 * not that a wrong endpoint cannot get through. The joining slash is owned here;
 * the suffix is not trimmed or normalised, so the one caller that addresses a
 * state event by its key -- the power levels write, whose key is the empty one
 * that power levels live at -- appends its own trailing slash and keeps both
 * forms of that endpoint distinct.
 */
export function roomPath(roomId: string, suffix: string): string {
  return clientPath(`rooms/${encodeURIComponent(roomId)}/${suffix}`);
}

/** How many times one request may be re-sent after a 429 before giving up. */
const RATE_LIMIT_RETRIES = 5;

/**
 * Issues one authenticated Client-Server API request. Every helper below is a
 * thin wrapper over this, so the homeserver's status and body text survive
 * into the thrown error instead of being swallowed.
 *
 * A 429 is retried rather than raised, because `retry_after_ms` in the body is
 * the homeserver telling us when it will accept the request again, and the
 * Client-Server API asks clients to honour it. Skipping invites is not an
 * option: a Run that admits five of its six agents is worse than one that
 * waits, and the first live Run died on it -- six invites fired back to back,
 * Synapse's per-user limiter admitted the first few and answered 429 with
 * `retry_after_ms`, and the whole Run failed during room setup.
 *
 * The retries are bounded and the wait is capped, so a homeserver that
 * ratelimits indefinitely fails as a real error rather than hanging.
 */
export async function csRequest<T>(
  baseUrl: string,
  method: string,
  urlPath: string,
  opts: { accessToken?: string; body?: unknown } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.accessToken
          ? { Authorization: `Bearer ${opts.accessToken}` }
          : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();

    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const waitMs = retryAfterMs(text);
      log.warn(
        `rate limited on ${method} ${urlPath}; waiting ${waitMs}ms and retrying.`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    if (!res.ok) {
      throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${text}`);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}

/**
 * The homeserver's own answer to "how long should I wait", when it gives one.
 * Anything unparseable falls back to a delay long enough to be safe, since
 * retrying immediately is what the 429 was warning against.
 */
function retryAfterMs(body: string): number {
  const DEFAULT_WAIT_MS = 1_000;
  const MAX_WAIT_MS = 10_000;
  try {
    const parsed = JSON.parse(body) as { retry_after_ms?: unknown };
    const suggested = parsed.retry_after_ms;
    if (typeof suggested === "number" && Number.isFinite(suggested)) {
      return Math.min(Math.max(suggested, 0), MAX_WAIT_MS);
    }
  } catch {
    // Not JSON, or no retry_after_ms: fall through to the default.
  }
  return DEFAULT_WAIT_MS;
}

/**
 * Creates the room a Run happens in, owned by the setup account, and returns
 * its ID. Public rather than invite-only so a human Reader can be admitted
 * later without the homeserver needing a separate join rule. It also asks for
 * `visibility: public`, but a homeserver may decline to publish it to the room
 * directory (the dev Synapse publishes none), so reclamation finds the room by
 * name through the admin API instead (`findRoomIdByName`, ADR-0009).
 *
 * The `public_chat` preset lets every member post; `establishRunRoomPermissions`
 * overwrites that before any Reader is invited.
 */
export async function createRoom(
  baseUrl: string,
  setupAccessToken: string,
  name: string,
): Promise<string> {
  const res = await csRequest<{ room_id: string }>(
    baseUrl,
    "POST",
    clientPath("createRoom"),
    {
      accessToken: setupAccessToken,
      body: {
        name,
        preset: "public_chat",
        visibility: "public",
      },
    },
  );
  return res.room_id;
}

/** Invites a user into a room; the setup account does this, not the user. */
export async function inviteUserToRoom(
  baseUrl: string,
  setupAccessToken: string,
  roomId: string,
  userId: string,
): Promise<void> {
  await csRequest(
    baseUrl,
    "POST",
    roomPath(roomId, "invite"),
    {
      accessToken: setupAccessToken,
      body: { user_id: userId },
    },
  );
}

/**
 * Joins the setup account's own user or an agent into a room. Takes the
 * joining user's token rather than a third party's, because Matrix only lets
 * a user join as themselves.
 */
export async function joinRoom(
  baseUrl: string,
  userAccessToken: string,
  roomId: string,
): Promise<void> {
  await csRequest(
    baseUrl,
    "POST",
    roomPath(roomId, "join"),
    {
      accessToken: userAccessToken,
      body: {},
    },
  );
}

/**
 * Sets the display name for a user account globally (not per-room). The setup
 * account uses this to set its display name to "Moderator" before joining a Run's
 * room, so agents and Readers see it identified as such in the room.
 */
export async function setDisplayName(
  baseUrl: string,
  userAccessToken: string,
  userId: string,
  displayName: string,
): Promise<void> {
  await csRequest(
    baseUrl,
    "PUT",
    clientPath(`profile/${encodeURIComponent(userId)}/displayname`),
    {
      accessToken: userAccessToken,
      body: { displayname: displayName },
    },
  );
}

/**
 * Resolves a room's id from its display name by searching Synapse's admin room
 * list, so `accessToken` must be a server admin's (ADR-0009). Reclamation
 * (packages/runner/src/reclaim.ts) resolves a runId to its room by the name
 * `roomNameForRun` gave it rather than reading the room id off the transcript's
 * `message` events, because that id is recorded only on `message` events — a
 * Run that never sent a message would leave no room id in its transcript, while
 * the room-name convention always holds.
 *
 * The admin list rather than the public room directory: a Run's room asks to be
 * published, but a homeserver may refuse, and the dev Synapse publishes none,
 * so a directory lookup never found a Run's room there. The search is a
 * substring match, so pages (followed by `next_batch`) are scanned for a room
 * whose `name` is exactly `name`; null means no room on the server has it.
 */
export async function findRoomIdByName(
  baseUrl: string,
  accessToken: string,
  name: string,
): Promise<string | null> {
  const PAGE_LIMIT = 100;
  let from: number | undefined;
  for (;;) {
    const params = new URLSearchParams({ search_term: name, limit: String(PAGE_LIMIT) });
    if (from !== undefined) params.set("from", String(from));
    const res = await csRequest<{
      rooms?: Array<{ room_id: string; name?: string | null }>;
      next_batch?: number;
    }>(baseUrl, "GET", synapseAdminPath(`v1/rooms?${params}`), { accessToken });
    for (const room of res.rooms ?? []) {
      if (room.name === name) return room.room_id;
    }
    if (res.next_batch === undefined || (res.rooms ?? []).length === 0) return null;
    from = res.next_batch;
  }
}

/**
 * Builds the absolute urlPath of a Synapse admin API call:
 * `synapseAdminPath("v2/rooms/<id>")`. The admin API is Synapse's own, outside
 * the Client-Server API, so it has its own prefix and versions each endpoint
 * separately -- which is why the version is part of the suffix here rather than
 * fixed like `CLIENT_PREFIX`.
 */
export function synapseAdminPath(suffix: string): string {
  return `/_synapse/admin/${suffix}`;
}

/** How often `deleteRoom` asks Synapse whether its background purge is done. */
const DELETE_STATUS_POLL_MS = 1_000;
/** How long `deleteRoom` waits for the purge before treating it as failed. */
const DELETE_STATUS_TIMEOUT_MS = 120_000;

/**
 * Deletes a room from the homeserver and purges its history, returning only
 * once Synapse reports the purge complete. This is the destructive half of
 * reclamation: a caller must only reach it after the Run's verdict is known to
 * be terminal, and only when an operator asked for the room (ADR-0006).
 *
 * No Client-Server endpoint deletes a room, so this uses Synapse's admin API
 * (ADR-0009), and `adminAccessToken` must belong to a server admin -- not the
 * setup account, whose token is handed to the Moderator's container. Synapse
 * runs the purge in the background and hands back a `delete_id`; this polls its
 * status every `DELETE_STATUS_POLL_MS` and throws if the purge reports `failed`
 * or has not completed within `DELETE_STATUS_TIMEOUT_MS`. A thrown error means
 * the room may still exist, which is why reclamation removes a Run's logs only
 * after this resolves.
 */
export async function deleteRoom(
  baseUrl: string,
  adminAccessToken: string,
  roomId: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? DELETE_STATUS_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DELETE_STATUS_TIMEOUT_MS;

  const { delete_id: deleteId } = await csRequest<{ delete_id: string }>(
    baseUrl,
    "DELETE",
    synapseAdminPath(`v2/rooms/${encodeURIComponent(roomId)}`),
    { accessToken: adminAccessToken, body: { purge: true } },
  );

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await csRequest<{ status: string; error?: string }>(
      baseUrl,
      "GET",
      synapseAdminPath(`v2/rooms/delete_status/${encodeURIComponent(deleteId)}`),
      { accessToken: adminAccessToken },
    );
    if (status.status === "complete") return;
    if (status.status === "failed") {
      throw new Error(`deleting room ${roomId} failed: ${status.error ?? "no error given"}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `deleting room ${roomId} did not complete within ${timeoutMs}ms (last status: ${status.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Registers a server-admin account through Synapse's shared-secret
 * registration, for the credential reclamation deletes rooms with (ADR-0009).
 *
 * `sharedSecret` is the homeserver's `registration_shared_secret`; it never
 * leaves this process -- only an HMAC-SHA1 over the nonce, username, password
 * and the literal "admin" is sent. Unlike `/register` this needs no open
 * registration, but it fails if the homeserver has no shared secret configured
 * or the username is taken.
 */
export async function registerAdminAccount(
  baseUrl: string,
  sharedSecret: string,
  username: string,
  password: string,
): Promise<{ userId: string; accessToken: string }> {
  const path = synapseAdminPath("v1/register");
  const { nonce } = await csRequest<{ nonce: string }>(baseUrl, "GET", path);
  const mac = createHmac("sha1", sharedSecret)
    .update(`${nonce}\0${username}\0${password}\0admin`)
    .digest("hex");
  const res = await csRequest<{ user_id: string; access_token: string }>(baseUrl, "POST", path, {
    body: { nonce, username, password, admin: true, mac },
  });
  return { userId: res.user_id, accessToken: res.access_token };
}
