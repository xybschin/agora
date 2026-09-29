import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { roomPath, csRequest } from "./matrixRooms.js";

/**
 * Posts the Scenario's seedMessage into the Matrix room as the setup user,
 * before tick 1, so agents see a moderator seed on their first read. This is
 * the Matrix replacement for the setup bot that posted the seed to a fresh
 * Discord channel.
 *
 * The room id is passed in rather than read from the credentials file because
 * each Run creates its own room (ADR-0003). That is also why there is no
 * "is the seed already here?" check any more: the room is always new, so the
 * seed cannot already be in it and the check could only ever return false.
 *
 * Like the mcp-server's matrixActions.ts, this talks to the Matrix Client-Server
 * API directly with raw fetch rather than pulling in matrix-js-sdk. The runner
 * runs on the host, so it uses the host-facing base URL and the setup account's
 * access token (never an agent's).
 *
 * The request goes out through the shared `csRequest` in matrixRooms.ts, the one
 * seam every runner-side Client-Server call goes through -- so a homeserver
 * refusal here reads exactly as it would from room creation, an invite or the
 * power levels write. Its path is built by `roomPath` beside that seam, so the
 * API version prefix and the `rooms/<id>` segment are each written once for the
 * whole runner rather than here, and the room id is escaped in exactly one place.
 * What arrives at `csRequest` is still an absolute urlPath and `csRequest` still
 * does no prefixing of its own: the builder is the callers' shorthand, not a
 * second layer the request helper hides.
 */

function txnId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Posts the seed into the room the runner just created for this Run. There is
 * nothing to make idempotent: a fresh room has no messages at all, so the seed
 * is always the room's first and is posted exactly once per Run.
 */
export async function seedRoom(params: {
  scenario: ScenarioConfig;
  credentials: CredentialsFile;
  roomId: string;
}): Promise<void> {
  const { scenario, credentials, roomId } = params;
  const baseUrl = credentials.matrix.hostBaseUrl;
  const accessToken = credentials.matrixSetupAccessToken;
  const setupUserId = credentials.matrixSetupUserId;

  const sent = await csRequest<{ event_id: string }>(
    baseUrl,
    "PUT",
    roomPath(roomId, `send/m.room.message/${txnId()}`),
    {
      accessToken,
      body: { msgtype: "m.text", body: scenario.seedMessage },
    },
  );
  console.log(`Posted seed message as ${setupUserId} (${sent.event_id}).`);
}
