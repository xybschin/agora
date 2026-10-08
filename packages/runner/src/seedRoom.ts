/**
 * Posts the Scenario's seed message into a Run's room as the Scenario's
 * `seedAuthor`, before any agent acts, so every agent sees the seed on its first
 * read.
 *
 * The seed author is an agent in the roster, never the setup account. The setup
 * account is the Moderator (ADR-0008), and a seed posted with its token would be
 * marked as the Moderator's own message when it reads the room -- so it read the
 * Run as "I asked something and almost nobody answered". Posted with the
 * author's token, the Moderator sees another participant's message, the author
 * sees its own (and it opens the author's Own message history), and the
 * Moderator posts nothing before its closing message.
 *
 * The room id is passed in rather than read from the credentials file because
 * each Run creates its own room (ADR-0003). That is also why there is no
 * "is the seed already here?" check: the room is always new, so the seed cannot
 * already be in it.
 *
 * The runner runs on the host, so this uses the host-facing base URL. The
 * request goes through the shared `csRequest` and `roomPath` in matrixRooms.ts,
 * so a homeserver refusal here reads exactly as it would from room creation, an
 * invite or the power levels write.
 */
import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { roomPath, csRequest } from "./matrixRooms.js";
import { createLogger } from "@agora/shared";

const log = createLogger("runner");

/**
 * A fresh Matrix transaction id. The homeserver dedupes sends that reuse a
 * txnId under the same token, so each call must be unique.
 */
function txnId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Posts the seed into the room the runner just created for this Run. There is
 * nothing to make idempotent: a fresh room has no messages at all, so the seed
 * is always the room's first and is posted exactly once per Run.
 *
 * Throws if the Scenario's `seedAuthor` has no credentials entry, or if the
 * homeserver refuses the send.
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
  log.info(
    `Posted seed message as ${scenario.seedAuthor} (${author.matrixUserId}, ${sent.event_id}).`,
  );
}
