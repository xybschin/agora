import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "./loadConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = path.resolve(__dirname, "../../../scenarios/abortion-policy.yaml");

// The family Scenario (agora-c75.4) is a real, shipped scenario file, so it is
// a fixture of scenarioConfigSchema the same way credentials.example.yaml is a
// fixture of credentialsFileSchema (see loadConfig.test.ts). Read it through
// loadScenario rather than parseScenarioConfig alone, so the test covers the
// path the runner actually hits: the file on disk, yaml.load, then the schema.
//
// The path leaves the package, which is worth naming. It is not a new
// convention: loadConfig.test.ts and index.ts both resolve "../../.." to find
// repo-root files (credentials.yaml, scenarios/), so the runner already depends
// on scenarios living at the repo root. Move the file and this test fails in
// the same place the runner does.
//
// The ticket's last acceptance point asks to "compare first few turns to ensure
// no infinite waiting for Karen". A faithful turn-level comparison needs a
// running homeserver and a reachable LLM, which no unit test here has. What is
// testable deterministically is the seed-level guarantee that removes the
// dependency, and that is asserted below: the seed now carries every piece of
// logistics (clinic, appointment, cost) an agent would otherwise have to wait
// on off-screen Karen for, and Karen steps out of the coordination role, so the
// group is never information-blocked on someone who is not in the room.
describe("scenarios/abortion-policy.yaml", () => {
  test("parses and boots through the runner's load path", async () => {
    const scenario = await loadScenario(SCENARIO_PATH);
    expect(scenario.name).toBe("abortion-policy");
    // The roster is six distinct, active agents; nobody waits on an off-screen
    // party to be able to act.
    expect(scenario.agents.map((a) => a.id)).toEqual([
      "alex",
      "bri",
      "casey",
      "devon",
      "eli",
      "fara",
    ]);
  });

  test("seed carries the trip logistics so no one waits on off-screen Karen", async () => {
    const { seedMessage } = await loadScenario(SCENARIO_PATH);
    // The clinic, the appointment time, and the itemised cost all live in the
    // seed itself. Previously the seed only said Maya "needs about $600 and
    // someone to drive her", leaving the details (and so the ability to act)
    // with off-screen Karen.
    expect(seedMessage).toContain("Cedar Ridge Women's Health Center");
    expect(seedMessage).toContain("1420 Maple Drive");
    expect(seedMessage).toContain("9:00 AM");
    expect(seedMessage).toContain("$600 total");
    expect(seedMessage).toContain("$350");
    expect(seedMessage).toContain("$180");
    expect(seedMessage).toContain("$70");
    expect(seedMessage).toContain("Maya has $150");
  });

  test("Karen no longer holds the coordination role (it is left to emerge)", async () => {
    const { seedMessage, agents } = await loadScenario(SCENARIO_PATH);
    const agentIds = new Set(agents.map((a) => a.id));
    // Karen relays Maya's off-screen request, then explicitly steps back rather
    // than channelling the drive and the money through herself.
    expect(seedMessage).toContain("I'm not able to organize the");
    expect(seedMessage).toContain("it's in your hands");
    // And Karen is not in the roster, so no one can keep deferring to her. The
    // coordination work is left to the agents actually in the room to arrange
    // among themselves, not pre-assigned to a single one as a cast constraint.
    expect(agentIds.has("karen")).toBe(false);
  });

  test("preserves the cast's traits, stances, and runtime tuning", async () => {
    const scenario = await loadScenario(SCENARIO_PATH);
    // Runtime tuning is updated to use wall-clock limit: maxRuntimeMs (wall-clock),
    // maxToolStepsPerTurn (per-turn tool cap), and token budget.
    expect(scenario.maxRuntimeMs).toBe(200_000); // 200 seconds wall-clock limit
    expect(scenario.maxToolStepsPerTurn).toBe(10);
    expect(scenario.budget.maxTotalTokens).toBe(2_000_000);

    // Numeric traits and initial stances are preserved verbatim for every agent.
    const expected = {
      alex: { conformity: 0.1, assertiveness: 0.9, opennessToEvidence: 0.1, stance: -0.95 },
      bri: { conformity: 0.2, assertiveness: 0.9, opennessToEvidence: 0.2, stance: 0.95 },
      casey: { conformity: 0.6, assertiveness: 0.4, opennessToEvidence: 0.7, stance: 0 },
      devon: { conformity: 0.4, assertiveness: 0.6, opennessToEvidence: 0.8, stance: 0.3 },
      eli: { conformity: 0.7, assertiveness: 0.3, opennessToEvidence: 0.4, stance: -0.6 },
      fara: { conformity: 0.3, assertiveness: 0.7, opennessToEvidence: 0.6, stance: 0.1 },
    } as const;
    for (const agent of scenario.agents) {
      const want = expected[agent.id as keyof typeof expected];
      expect(want, `no expectation recorded for agent ${agent.id}`).toBeDefined();
      expect(agent.persona.traits.conformity).toBe(want.conformity);
      expect(agent.persona.traits.assertiveness).toBe(want.assertiveness);
      expect(agent.persona.traits.opennessToEvidence).toBe(want.opennessToEvidence);
      expect(agent.persona.initialStance).toBe(want.stance);
    }
  });
});
