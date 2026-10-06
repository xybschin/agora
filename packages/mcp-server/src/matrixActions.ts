import type { MatrixClient } from "./matrixPool.js";

export interface RoomMessage {
  eventId: string;
  sender: string;
  /** Display name if we can cheaply resolve it; otherwise the raw user ID. */
  senderDisplayName: string;
  /** The message body (m.text / m.notice / fallback for other types). May be prefixed with "**your message:**" if sent by the caller. */
  content: string;
  replyToEventId?: string;
  /** ISO timestamp, from origin_server_ts (epoch millis). */
  createdAt: string;
}

interface RawEvent {
  event_id: string;
  sender: string;
  type: string;
  content: {
    msgtype?: string;
    body?: string;
    "m.relates_to"?: {
      "m.in_reply_to"?: { event_id?: string };
      rel_type?: string;
      event_id?: string;
      key?: string;
    };
  };
  origin_server_ts?: number;
}

/**
 * These functions call the Matrix Client-Server API directly (raw fetch)
 * rather than going through matrix-js-sdk. That mirrors the previous
 * discordActions.ts decision to use raw REST: it keeps the tools minimal,
 * avoids pulling the heavy SDK (and its crypto/olm dependencies) into the
 * MCP server, and gives us full control of the request/response shape. The
 * three tools map directly onto three CS-API calls:
 *
 *   read ~   GET  /_matrix/client/v3/rooms/{id}/messages?dir=b
 *   send ~   PUT  /_matrix/client/v3/rooms/{id}/send/m.room.message/{txnId}
 *   react ~  PUT  /_matrix/client/v3/rooms/{id}/send/m.reaction/{txnId}
 */

const CLIENT_PREFIX = "/_matrix/client/v3";

async function csRequest<T>(
  client: MatrixClient,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${client.homeServerUrl}${CLIENT_PREFIX}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Matrix API ${method} ${path} failed (${response.status}): ${text}`);
  }
  // 200-empty responses (e.g. some federation no-op) would break JSON.parse;
  // the Matrix API returns null in that case.
  return (await response.json()) as T;
}

/**
 * Resolve the caller's own user id from their access token, not from anything a
 * client asserts. readRoom needs to know which messages are the agent's own, and
 * the only trustworthy source of that is the homeserver's answer for the token
 * (GET /account/whoami): an access token is what Matrix binds identity to, and a
 * client-supplied id can be forged, so `readRoom` resolves it here rather than
 * taking it as a parameter. This is the guarantee that one agent can never have
 * another's messages marked as its own, or its own marked as someone else's.
 */
export async function resolveOwnUserId(client: MatrixClient): Promise<string> {
  const data = await csRequest<{ user_id?: string }>(client, "GET", "/account/whoami");
  if (!data.user_id) {
    throw new Error("Matrix GET /account/whoami returned no user_id");
  }
  return data.user_id;
}

/** Read the most recent messages in a room, oldest of the fetched first. */
export async function readRoom(
  client: MatrixClient,
  roomId: string,
  limit: number,
): Promise<RoomMessage[]> {
  const params = new URLSearchParams({
    dir: "b", // backward: newest first
    limit: String(limit),
    filter: JSON.stringify({ types: ["m.room.message", "m.reaction"] }),
  });
  const data = await csRequest<{ chunk?: RawEvent[] }>(
    client,
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`,
  );

  // Fetch member list to resolve displaynames
  let memberMap: Record<string, string> = {};
  try {
    // /joined_members returns a flat member object per user ({ display_name,
    // avatar_url }) — not the state-event `content` shape — so read the flat
    // display_name field. See agora-ber.
    const membersData = await csRequest<{ joined: Record<string, { display_name?: string }> }>(
      client,
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/joined_members`,
    );
    for (const [userId, member] of Object.entries(membersData.joined ?? {})) {
      memberMap[userId] = member.display_name ?? userId;
    }
  } catch {
    // If joined_members fails, fall back to user IDs
  }

  // Identity comes from the token, never from a client-supplied value, so own
  // messages are recognised by who the homeserver says the token belongs to.
  const ownMatrixUserId = await resolveOwnUserId(client);

  const messages = (data.chunk ?? [])
    .filter((event) => {
      if (event.type === "m.room.message") return true;
      // Only surface reactions attached to a message for annotative signal,
      // like a lightweight agree/disagree indicator.
      if (event.type === "m.reaction") return true;
      return false;
    })
    .reverse(); // dir=b is newest-first; flip to oldest-first like the read tool promises.

  return messages.map((event) => {
    const relatesTo = event.content?.["m.relates_to"];
    const isOwnMessage = ownMatrixUserId && event.sender === ownMatrixUserId;
    let content = summaryText(event);
    if (isOwnMessage) {
      content = `**your message:** ${content}`;
    }
    return {
      eventId: event.event_id,
      sender: event.sender,
      senderDisplayName: memberMap[event.sender] ?? event.sender,
      content,
      replyToEventId: relatesTo?.["m.in_reply_to"]?.event_id,
      createdAt: new Date(event.origin_server_ts ?? Date.now()).toISOString(),
    };
  });
}

function summaryText(event: RawEvent): string {
  const content = event.content ?? {};
  if (event.type === "m.reaction") {
    const key = content["m.relates_to"]?.key ?? "";
    return `[reaction] ${key}`;
  }
  return content.body ?? `[${event.type}]`;
}

function txnId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Strip leading quote syntax from a message, typically added by agents when
 * replying. When a rich reply uses m.in_reply_to, the system provides its own
 * fallback quote, so agent-generated quotes should be removed.
 * Looks for the pattern: > <@...> followed by quoted lines, then a blank line.
 */
export function stripQuote(content: string): string {
  // If content starts with a quote (> <@...) and has a blank line separator,
  // strip everything before and including that separator.
  if (content.startsWith("> <@")) {
    const parts = content.split("\n\n");
    if (parts.length > 1 && parts[0].startsWith("> <@")) {
      return parts.slice(1).join("\n\n");
    }
  }
  return content;
}

/**
 * Build the plain-text fallback for a rich reply, per the Matrix "Rich replies"
 * convention: the `body` starts with the original event quoted sender-prefixed.
 * Clients that cannot render the `m.in_reply_to` relation fall back to this
 * text, so it should be the original message, not a placeholder. Returns
 * undefined when no quote can be produced (original has no body), in which case
 * the relation alone still carries the reply.
 */
async function replyFallback(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<string | undefined> {
  try {
    const original = await csRequest<{
      sender?: string;
      content?: { body?: string };
    }>(client, "GET", `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
    const originalBody = original.content?.body;
    if (!originalBody) return undefined;
    // Each line of the quoted original is prefixed with "> ", with an empty
    // quote line ("> ") before the reply itself, as the spec's fallback does.
    const quoted = originalBody
      .split("\n")
      .map((line) => (line.length > 0 ? `> ${line}` : `> `))
      .join("\n");
    return `> <${original.sender ?? "?"}>\n${quoted}`;
  } catch {
    // Don't block a send on quote-fetch failure; the relation is what matters.
    return undefined;
  }
}

/** Send an m.text message to a room; optionally as a rich reply to an event. */
export async function sendMessage(
  client: MatrixClient,
  roomId: string,
  content: string,
  replyToEventId?: string,
): Promise<{ id: string; createdAt: string }> {
  let body: Record<string, unknown> = {
    msgtype: "m.text",
    body: content,
  };
  if (replyToEventId) {
    // Strip any agent-generated quote prefix before building the rich reply.
    // The system will add its own fallback quote per the spec.
    const cleanContent = stripQuote(content);
    body = {
      msgtype: "m.text",
      body: cleanContent,
      "m.relates_to": {
        // Rich reply -- includes a quoted fallback for clients that don't
        // render the relation. The quote in `body` is required by the spec for
        // plain-text fallback; some homeservers validate it loosely.
        "m.in_reply_to": { event_id: replyToEventId },
      },
    };
    // Wrap the body per the "Rich replies" quoting convention: quote the
    // original message (fetched by id) rather than a "<no-fallback>" stub, so
    // the reply reads correctly in any client that shows the fallback text.
    const fallback = await replyFallback(client, roomId, replyToEventId);
    if (fallback) {
      body["body"] = `${fallback}\n\n${cleanContent}`;
    }
  }
  const sent = await csRequest<{ event_id: string }>(
    client,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId()}`,
    body,
  );
  return { id: sent.event_id, createdAt: new Date().toISOString() };
}

/** React to a message with an emoji (an m.annotation on the target event). */
export async function addReaction(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  reaction: string,
): Promise<void> {
  await csRequest(
    client,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId()}`,
    {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key: reaction,
      },
    },
  );
}

export interface WaitForActivityResult {
  /** True if new room activity (a message or reaction) arrived during the wait. */
  hasActivity: boolean;
  /** Resume token (`next_batch`) to pass as `since` on the next wait. */
  nextBatch: string;
}

/**
 * Long-polls the room for new activity via the Matrix Client-Server /sync
 * endpoint (the CS-API's native long-poll), waking as soon as a message or
 * reaction lands or the bounded timeout elapses. The `timeout` query param
 * tells the homeserver to hold the response open; `since` is a `next_batch`
 * resume token so a later wait starts where this one left off instead of
 * re-reading the whole room.
 *
 * The filter restricts the timeline to the same event types the read tool
 * surfaces (`m.room.message`, `m.reaction`), so "new activity" means exactly
 * what the agent would act on and ignores state noise. `hasActivity` is true
 * whenever such a timeline event arrived. A wait that times out with nothing
 * new is a normal success: it returns `hasActivity: false`, not an error — the
 * loop just goes back to waiting.
 *
 * `roomId` comes from the server's bound MATRIX_ROOM_ID (the handler resolves
 * it from the environment), never from a model-supplied tool argument.
 */
export async function waitForActivity(
  client: MatrixClient,
  roomId: string,
  timeoutMs: number,
  since?: string,
): Promise<WaitForActivityResult> {
  const params = new URLSearchParams({
    timeout: String(timeoutMs),
    filter: JSON.stringify({
      room: { timeline: { types: ["m.room.message", "m.reaction"] } },
    }),
  });
  if (since) params.set("since", since);

  const data = await csRequest<{
    next_batch?: string;
    rooms?: { join?: Record<string, { timeline?: { events?: unknown[] } }> };
  }>(client, "GET", `/sync?${params.toString()}`);

  const events = data.rooms?.join?.[roomId]?.timeline?.events ?? [];
  return {
    hasActivity: events.length > 0,
    nextBatch: data.next_batch ?? (since ?? ""),
  };
}
