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
 * power levels write and read-back, the seed post, and the bootstrap script's
 * account registration. `clientPath` beside it is the seam every one of those
 * calls spells its urlPath through, so the API version lives in one place, and
 * `roomPath` beside that is the room-scoped half of the same bargain: the
 * `rooms/<id>` segment and its encoding are written once too, rather than
 * re-spelled and re-escaped at each of the four calls that address a room.
 */

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
 * `retry_after_ms`, and the whole Run failed at tick 0.
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
      console.log(
        `  rate limited on ${method} ${urlPath}; waiting ${waitMs}ms and retrying.`,
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
 * later without the homeserver needing a separate join rule.
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
 * Resolves a room's id from its display name against the homeserver's public
 * room directory. Each Run's room is created `visibility: public`
 * (see `createRoom`), so it appears there under the name `roomNameForRun` gave
 * it. Reclamation (packages/runner/src/reclaim.ts) resolves a runId to its room
 * by this lookup rather than reading the room id off the transcript's `message`
 * events, because that id is recorded only on `message` events — a Run that
 * never sent a message would leave no room id in its transcript, while the
 * room-name convention always holds.
 *
 * The directory is paginated with `since` cursors until a room whose `name`
 * matches exactly is found or the pages run out; a directory that does not
 * enumerate (empty chunk, server refusing) returns null so the caller can
 * report the room as not found rather than fail the whole reclamation.
 */
export async function findRoomIdByName(
  baseUrl: string,
  accessToken: string,
  name: string,
): Promise<string | null> {
  const PAGE_LIMIT = 100;
  let since: string | undefined;
  for (;;) {
    const params = `limit=${PAGE_LIMIT}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const res = await csRequest<{ chunk?: Array<{ room_id: string; name?: string }>; next_batch?: string }>(
      baseUrl,
      "GET",
      clientPath(`publicRooms?${params}`),
      { accessToken },
    );
    for (const room of res.chunk ?? []) {
      if (room.name === name) return room.room_id;
    }
    const next = res.next_batch;
    if (!next || !next.length || (res.chunk ?? []).length === 0) return null;
    since = next;
  }
}

/**
 * Deletes a room outright rather than leaving it as a tombstoned shell. Owned by
 * the setup account — which created the room at Run start (ADR-0003) — so the
 * delete succeeds. This is the destructive half of reclamation: a caller (the
 * reclaim command) must only reach it after the Run's verdict is known to be
 * terminal, and only when an operator named the room explicitly.
 */
export async function deleteRoom(
  baseUrl: string,
  accessToken: string,
  roomId: string,
): Promise<void> {
  // The delete endpoint has no room-relative suffix — it is exactly
  // /rooms/{roomId} — so it is spelt here rather than through roomPath, which
  // appends a trailing segment and its joining slash.
  await csRequest(baseUrl, "DELETE", clientPath(`rooms/${encodeURIComponent(roomId)}`), {
    accessToken,
  });
}
