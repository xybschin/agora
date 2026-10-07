import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { roomPath, csRequest } from "./matrixRooms.js";

/**
 * Posts the Scenario's seedMessage into the Matrix room as the Scenario's seed
 * author, before any agent acts, so agents see the seed on their first read.
 *
 * The seed author is an agent in the roster, never the setup account. The setup
 * account is the Moderator (ADR-0008), and a seed posted with its token would be
 * marked as the Moderator's own message when it reads the room -- so it read the
 * Run as "I asked something and almost nobody answered". Posted with the
 * author's token, the Moderator sees another participant's message and the
 * author sees its own, which leaves the Moderator posting nothing before its
 * closing message.
 *
 * The room id is passed in rather than read from the credentials file because
 * each Run creates its own room (ADR-0003). That is also why there is no
 * "is the seed already here?" check any more: the room is always new, so the
 * seed cannot already be in it and the check could only ever return false.
 *
 * Like the mcp-server's matrixActions.ts, this talks to the Matrix Client-Server
 * API directly with raw fetch rather than pulling in matrix-js-sdk. The runner
 * runs on the host, so it uses the host-facing base URL and the seed author's
 * access token from the credentials file.
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
  const author = credentials.agents[scenario.seedAuthor];
  if (!author) {
    throw new Error(
      `Scenario's seedAuthor "${scenario.seedAuthor}" has no credentials entry, so the seed cannot be posted`,
    );
  }

  const sent = await csRequest<{ event_id: string }>(
    baseUrl,
    "PUT",
    roomPath(roomId, `send/m.room.message/${txnId()}`),
    {
      accessToken: author.matrixAccessToken,
      body: { msgtype: "m.text", body: scenario.seedMessage },
    },
  );
  console.log(
    `Posted seed message as ${scenario.seedAuthor} (${author.matrixUserId}, ${sent.event_id}).`,
  );
}
