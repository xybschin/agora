---
status: accepted
---

# Agents choose explicitly between a Reply and a Room post

Agents could always answer a message as a Matrix rich reply
(`matrix_send_message` with an optional `replyToEventId`), but almost never
did: 1 reply in 58 messages across the two Runs on record. A message with no
reply link was therefore ambiguous — talking to the room, or answering
someone without saying so — and the transcript could not show who answered
whom, which is the structure polarization, pile-ons and coalitions are read
from. Agents must now quote, as a rich reply, whenever they answer someone
else's message.

`matrix_send_message` is replaced by two tools: `matrix_reply({ eventId,
content })` and `matrix_post({ content })`. Picking a tool is the choice, so
every agent message is exactly one **Reply** or one **Room post** (see
`docs/CONTEXT.md`). A Reply's target must be an `m.room.message` in the Run's
room sent by someone else; the MCP server checks this before sending and
returns `{ rejected: <reason> }` as an ordinary result, which the agent loop
feeds back to the model within the same Turn (recording `reply_rejected`)
rather than failing the Turn. The Moderator is given only `matrix_post`: a
judge that Replies to one agent would appear to address one party. The rule
is fixed, not a Scenario setting.

## Considered Options

- **Prompt-only nudge, reply link still optional.** Already the status quo,
  and agents ignored it.
- **Every message must be a Reply.** Fully enforceable, but it forbids
  addressing the room, pushing the conversation into artificial one-to-one
  exchanges and distorting who-addresses-whom — the thing being observed.
- **One tool with exactly one of `replyToEventId` / `toRoom`.** Tool-call
  JSON schemas express "exactly one of" poorly (most providers ignore
  `oneOf`; a zod refinement never reaches the model), so the model learns the
  rule only by being rejected, costing tool steps.
- **A Scenario toggle between explicit and free addressing.** Doubles the
  tools, prompts and tests for an experiment nobody has asked for; adding it
  later is a contained change.

## Consequences

- **A missing reply link changes meaning at this ADR.** In Runs from after
  it, a `message` event without `replyToEventId` is a deliberate Room post.
  In earlier Runs it is ambiguous; analysis must not read those as Room posts.
- **A message answering several participants** Replies to the one it answers
  most directly and names the others in its text, so a Reply's link records
  its primary target only.
- **`matrix_read_room` strips the rich-reply fallback quote** from a Reply's
  body and shows `replyTo: { eventId, senderDisplayName, excerpt }` instead,
  the excerpt cut from the stripped fallback. With most messages now Replies,
  the full quote would roughly double every read; the excerpt keeps a Reply
  intelligible when its target has scrolled out of the read window. The room
  itself is unchanged, so Readers' clients still show the full quote.
