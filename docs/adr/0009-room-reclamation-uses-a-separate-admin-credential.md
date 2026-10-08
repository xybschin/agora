---
status: accepted
---

# Room reclamation uses a separate server-admin credential, and deletes the room before the logs

ADR-0006 gave operators an explicit way to reclaim a finished Run's room, but
the room half never worked: it sent `DELETE` to a Client-Server room path that
the Matrix spec does not define, and the live Synapse answers it with 404
`M_UNRECOGNIZED`. No client can delete a room. Synapse can, through its admin
API (`DELETE /_synapse/admin/v2/rooms/{roomId}`), which runs the purge in the
background and needs a **server-admin** access token. Nothing in the harness
held one: bootstrap registers every account, the setup account included,
through the ordinary `/register` call.

Reclaiming a room therefore uses a dedicated server-admin credential that only
the reclaim entrypoint reads. It lives in `credentials.yaml` alongside the
other tokens, is optional (a missing one makes `--room` refuse up front, while
`--logs` keeps working), and is never written into a generated compose file,
so no container sees it. Bootstrap may create the admin account through
Synapse's shared-secret admin registration when it is given the homeserver's
`registration_shared_secret`; an operator can equally paste in a token for an
admin account made by hand.

The same credential finds the room. ADR-0006 resolved a Run's room by name
against the public room directory, but a homeserver may decline to publish a
room even when `createRoom` asks for `visibility: public`, and the dev Synapse
published none of the Run rooms on it — so that lookup had never found a room.
The room is now found by its name in Synapse's admin room list, which sees
every room on the server. The join is still the room-name convention
(`roomNameForRun`); only the place it is looked up changed, and a logs-only
reclaim no longer calls the homeserver at all.

Reclamation also deletes the room **before** the logs, and only removes
`logs/<runId>` once Synapse reports the room purge complete. A homeserver
failure then leaves both artefacts in place and the Run still eligible, rather
than leaving the logs gone and the room behind — the transcript is the only
place the reclaim gate reads its verdict from, so losing it first would make
the surviving room unreclaimable by the normal path.

## Considered Options

- **Promote the setup account to server admin.** No new credential, and
  bootstrap already registers it. Rejected because the setup account's token is
  handed to the Moderator's container, which is LLM-driven: a server-admin
  token would sit inside a process whose actions come from model output. The
  Moderator reaches Matrix only through the MCP server, but the guarantee
  should not rest on that.
- **Drop room reclamation and keep rooms forever.** ADR-0006 already leans
  toward keeping, and this would remove a credential from the design. Rejected
  for now: deleting a room is the operator's explicit escape hatch in ADR-0006,
  and it is cheap to keep once the admin credential exists.
- **Keep deleting logs first and just report a failed room deletion.**
  Rejected: the failure mode it leaves — no transcript, room still present — is
  the one state the reclaim gate cannot recover from.

## Consequences

- `credentialsFileSchema` gains an optional admin credential; nothing else in
  the Run path reads it.
- `--room` needs the admin credential and fails before touching anything when
  it is absent. Reclamation no longer uses the setup account's token at all.
- Verified on the dev stack (2026-10-08): with no admin credential `--room`
  refused and left the logs; with one, a throwaway Run's room was found by
  name, purged (admin API then answers `M_NOT_FOUND`), and its logs removed.
- A room reclaim waits on Synapse's asynchronous delete status, so it can take
  noticeably longer than a logs-only reclaim.
- Anyone holding the homeserver's `registration_shared_secret` can mint a
  server admin. The dev stack's `homeserver.yaml` ships a placeholder string,
  which works but is public; replace it on any homeserver others can reach.
