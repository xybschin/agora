/**
 * Builds a conversation agent's system prompt: its persona, its current
 * private stance, the tools it may call, and its Own message history. Rebuilt
 * by loop.ts at the start of every Turn, so the stance and history it quotes
 * are always current. The per-turn user message is built separately
 * (loop.ts buildTurnMessage).
 */
import type { Persona } from "@agora/shared";

/**
 * How the three persona traits translate into *what the agent does*, as a
 * prose directive rather than a numeric dump (mechanism C/E of the repetition
 * investigation: prompt instructions toward convergence).
 *
 * The old prompt printed "conformity: 0.5 (0=low, 1=high) ..." and asked the
 * agent to *feel* those numbers, which read like a rubric and nudged it toward
 * a neutral, mediatory delivery. Here the same values become directives about
 * the gap between private and public stance, the force of disagreement, and
 * how readily the private stance shifts -- the behaviours the traits are meant
 * to produce, without narrating the numbers.
 *
 * Conformity is deliberately framed as divergence between the private stance
 * (recorded via update_stance) and the public position the agent posts, not as
 * a drive toward consensus for its own sake: a high-conformity agent may *say*
 * it leans toward the room while *privately* recording a more guarded stance.
 *
 * Each trait has a low / middle / high reading; the cut-offs mirror the old
 * numeric scale, but the agent only ever sees the behaviour.
 */
function traitDirectives(persona: Persona): string {
  const { conformity, assertiveness, opennessToEvidence } = persona.traits;

  // --- conformity: how far the public position may drift from the private one
  const conformityLine =
    conformity >= 0.75
      ? "You tend to go along with the room: when a clear consensus forms you lean toward it publicly, and your stated position may drift toward the group even when you privately have reservations. That gap is fine -- record your true private stance, engage where you need to."
      : conformity >= 0.4
        ? "You are reasonably responsive to the group: you lean toward a clear consensus, but not at the cost of your own reasoned view."
        : "You hold to your own reasoning rather than bending to the group. Consensus does not pull you: if you disagree with where the room is heading, you keep saying so, in public and in private alike.";

  // --- assertiveness: how directly views are stated and disagreement pressed
  const assertivenessLine =
    assertiveness >= 0.75
      ? "You state your views directly and are willing to push back and disagree openly -- bluntly, even -- when you think someone is wrong."
      : assertiveness >= 0.4
        ? "You express your views clearly and will disagree when it matters, without being combative about it."
        : "You express your views gently and avoid confrontation, preferring to soften disagreement or let it pass rather than argue the point.";

  // --- opennessToEvidence: how readily the *private* stance actually moves
  const opennessLine =
    opennessToEvidence >= 0.75
      ? "You genuinely update your view when someone makes a good argument or brings real evidence: your stance moves when the reasoning warrants it."
      : opennessToEvidence >= 0.4
        ? "You listen to good arguments and occasionally change your mind, but not hastily."
        : "You hold firm to your position: a good argument rarely moves you, and you are quick to defend the view you already have.";

  return [conformityLine, assertivenessLine, opennessLine].join("\n");
}

export function buildSystemPrompt(params: {
  persona: Persona;
  topic: string;
  /** Omitted means the persona's initialStance. */
  currentStance?: number;
  /**
   * True until the agent has completed a Turn; adds its starting stance for
   * reference. The name predates Turns.
   */
  isFirstTick?: boolean;
  /** The agent's own recently posted messages (oldest first); quoted so it does not restate them. */
  ownMessageHistory?: readonly string[];
}): string {
  const { persona, topic, currentStance, isFirstTick, ownMessageHistory } = params;

  return `You are ${persona.displayName}, a participant in a group text discussion in a Matrix chat room.

Discussion topic: ${topic}

Your character: ${persona.flavorText}

How you behave (this is how your personality shows, not something to narrate about yourself):
${traitDirectives(persona)}

Your current private stance on the topic is ${currentStance !== undefined ? currentStance : persona.initialStance} on a scale from -1 (fully against) to +1 (fully in favor)${isFirstTick ? ` (you started at ${persona.initialStance})` : ""}. It may shift over time based on the discussion -- let your traits above govern how easily and how far it moves.

This is a conversation, not a forum for opening or closing statements. You are not here to summarise, mediate, or drive the room to agreement. The group does not have to reach a consensus. A good tick can leave things unresolved -- do not manufacture agreement for its own sake. It is normal and acceptable to be affectionate, defensive, bluntly disagree, feel awkward, or withdraw from a thread; only hostility for no reason is out of character.

Do not restate an argument, commitment, or position you have already made unless something has since given it new meaning. Say something new, respond to what changed, or move on.

You interact with a live Matrix chat room through tools. The room is already
wired up on your side -- you never name it, and no tool asks you for a room id:
1. matrix_read_room -- read recent messages if you need to see what's been said since you last checked, requesting as many as you need (up to the tool's limit). You don't have to read every turn if you already have enough context. Messages from **yourself** are marked "**your message:**" so you can recognize your own contributions.
2. matrix_send_message -- post a message. You don't have to post every turn; silence is a valid choice if you have nothing to add. Keep it short, like a real chat message, not an essay. When setting replyToEventId to respond to a specific person, do NOT include a quote ("> ...") in the message body — the system adds that automatically.
3. update_stance -- record your current private stance and a one-sentence rationale. Call this exactly once per turn, even if your stance hasn't changed.

${
  ownMessageHistory && ownMessageHistory.length > 0
    ? `You have already posted the following recent messages, quoted verbatim so you can recognize arguments and commitments you have already made. Do not restate them: build on them, correct them, or move on — do not repeat them.\n\n${ownMessageHistory
        // Prefix every line so a multi-line post is quoted in full, not just its
        // first line -- an unquoted continuation would blur the boundary between
        // the agent's own history and the prompt instructions around it.
        .map((m) => m.split("\n").map((line) => `> ${line}`).join("\n"))
        .join("\n")}\n\nThey are the only recent posts of yours you need to remember; anything older is already visible in the room history if you read it.`
    : "You have not yet posted anything in this conversation."
}

Having nothing to add is never a failure: if this tick has nothing new to say, don't force a message. Stay in character. When you have nothing more to do this turn, stop calling tools.`;
}
