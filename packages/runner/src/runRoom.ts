/**
 * A Run's Matrix room, created and populated before the agents start.
 *
 * The room used to be provisioned once by `matrixBootstrap.ts` and recorded in
 * credentials.yaml, which meant a second Run of the same Scenario walked into
 * the first Run's conversation and inherited its Transcript. That contradicts
 * the glossary's Run, so the runner now creates a room per Run here and threads
 * its id down to the seed step and the compose generator.
 *
 * This is the one place that knows how a Run's room is assembled, which is why
 * the Scenario's Readers are admitted here rather than at the call site: a
 * Reader is only ever invited into a room whose permissions have already been
 * written and read back, so a Run can never leave a human sitting in a room
 * where they could speak for the population (ADR-0003).
 */

import type { CredentialsFile, ScenarioConfig } from "@agora/shared";
import { createRoom, inviteUserToRoom, joinRoom, setDisplayName } from "./matrixRooms.js";
import { establishRunRoomPermissions, runRoomPowerLevels } from "./roomPermissions.js";

/**
 * The name a Run's room carries. It repeats the Scenario and carries the runId,
 * so a Reader browsing the homeserver can match a room to the transcript in
 * `logs/<runId>/events.jsonl` without being told which room a Run used.
 */
export function roomNameForRun(scenarioName: string, runId: string): string {
  return `Agora - ${scenarioName} - ${runId}`;
}

/**
 * Thrown when a declared or locally-supplied Reader cannot be invited into a
 * Run's room.
 *
 * Its own type because the two room-setup failures the caller has to tell apart
 * are not the same thing: a `RoomPermissionsError` means the room was assembled
 * wrong, while this means the room was right but an account the operator wanted
 * watching could not be admitted. Both abort the Run, and both must record a
 * terminal `run_aborted` event -- the difference is only that this one has to
 * name the Reader, since the reason (rather than the whole room) is what the
 * operator needs to act on.
 */
export class ReaderInviteError extends Error {
  /** The Matrix user id that could not be invited, so the abort can name it. */
  readonly readerId: string;

  constructor(readerId: string, cause: string) {
    super(`could not invite Reader "${readerId}" into the run's room: ${cause}`);
    this.name = "ReaderInviteError";
    this.readerId = readerId;
  }
}

/**
 * Creates this Run's room, admits every agent in the Scenario's roster and every
 * Reader the Scenario declares (plus any the local operator supplied through the
 * git-ignored local source, merged by the caller), and returns the room id for
 * the rest of the Run to use.
 *
 * The setup account owns the room: it creates it, it sends the invites, and it
 * writes the room's permissions. Matrix only lets a user join as themselves, so
 * each agent's join runs with that agent's own access token -- the setup
 * account cannot admit anyone directly.
 *
 * Agents are admitted in roster order rather than in parallel so the homeserver
 * sees a deterministic create-then-invite-then-join sequence, which is both
 * easier to read in a Run's console output and to assert against in a test.
 * Permissions are pinned before any Reader is invited, so the invites that admit
 * humans to watch a Run only ever go to a room already known to be read-only for
 * them.
 */
export async function createRunRoom(params: {
  scenario: ScenarioConfig;
  credentials: CredentialsFile;
  runId: string;
  /**
   * The full list of Readers to invite, as resolved by the caller (the
   * Scenario's `observers` unioned with the git-ignored local source). When
   * omitted, falls back to the Scenario's `observers`; callers that merge a
   * local source pass the merged list here.
   */
  readers?: string[];
}): Promise<string> {
  const { scenario, credentials, runId, readers } = params;
  const baseUrl = credentials.matrix.hostBaseUrl;
  const setupAccessToken = credentials.matrixSetupAccessToken;

  // Resolve the whole roster up front: a room admitted half-way is a room an
  // agent silently cannot read, so a missing credentials entry has to fail the
  // Run before the first invite goes out.
  for (const agent of scenario.agents) {
    if (!credentials.agents[agent.id]) {
      throw new Error(
        `Scenario references agent "${agent.id}" with no credentials entry, so the Run's room cannot admit it`,
      );
    }
  }

  console.log(`Creating a Matrix room for run ${runId}...`);
  const roomId = await createRoom(
    baseUrl,
    setupAccessToken,
    roomNameForRun(scenario.name, runId),
  );
  console.log(`  room: ${roomId}`);

  // The setup account joins the room as the Moderator before any agents join.
  // Its display name is set to "Moderator" so it is visible to agents and Readers
  // as the moderating participant.
  const setupUserId = credentials.matrixSetupUserId;
  await setDisplayName(baseUrl, setupAccessToken, setupUserId, "Moderator");
  await joinRoom(baseUrl, setupAccessToken, roomId);
  console.log(`  setup account joined as Moderator to ${roomId}.`);

  for (const agent of scenario.agents) {
    const cred = credentials.agents[agent.id]!;
    await inviteUserToRoom(baseUrl, setupAccessToken, roomId, cred.matrixUserId);
    await joinRoom(baseUrl, cred.matrixAccessToken, roomId);
  }
  console.log(`Admitted ${scenario.agents.length} agents to ${roomId}.`);

  // A Reader must read the room in full and be refused every send, so the room's
  // permissions are written explicitly and then read back: this throws rather
  // than let a Run continue into a room whose defaults would let a Reader post.
  await establishRunRoomPermissions({
    baseUrl,
    accessToken: setupAccessToken,
    roomId,
    powerLevels: runRoomPowerLevels({
      agentUserIds: scenario.agents.map(
        (agent) => credentials.agents[agent.id]!.matrixUserId,
      ),
    }),
  });
  console.log(
    `  permissions: setup account at 100, agents at 50, everyone else read-only.`,
  );

  // Readers are invited, never joined. The runner holds no token for a Reader --
  // an invite takes a user id and nothing else, and that is the whole reason no
  // Reader credential is ever read or stored -- so a human accepts the invite
  // themselves, once per room.
  //
  // A Reader is a watcher, not a participant. The room has been permission-correct
  // since before the first Reader invite went out, so a Reader who cannot be
  // reached does not compromise the experiment -- but a declared Reader the Run
  // was told to admit is part of what was asked for, so the Run still aborts
  // (fatal), while naming exactly which Reader could not be invited and why. The
  // remaining invites are still attempted, so one unreachable Reader does not
  // silently strand the others.
  const readerList = readers ?? scenario.observers ?? [];
  let firstReaderFailure: { readerId: string; cause: string } | undefined;
  for (const reader of readerList) {
    try {
      await inviteUserToRoom(baseUrl, setupAccessToken, roomId, reader);
    } catch (cause) {
      firstReaderFailure ??= { readerId: reader, cause: messageOf(cause) };
      console.error(`  could not invite Reader ${reader}: ${messageOf(cause)}`);
    }
  }
  if (readerList.length > 0) {
    console.log(`Invited ${readerList.length} Readers to ${roomId}.`);
  }
  if (firstReaderFailure) {
    throw new ReaderInviteError(
      firstReaderFailure.readerId,
      firstReaderFailure.cause,
    );
  }

  return roomId;
}

/** The human-readable text of a thrown value, used when naming a Reader's cause. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
