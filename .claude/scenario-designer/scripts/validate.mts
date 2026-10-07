/**
 * Scenario safety net + YAML renderer.
 *
 * The model authors a scenario as a STRUCTURED JSON document (matching the
 * ScenarioConfig shape), and this script is the deterministic backstop:
 *  1. Parses the JSON and validates it against the project's real zod schema
 *     (packages/shared/src/schema.ts) — authors never hand-write YAML text.
 *  2. Runs design-heuristic checks that catch casts which would manufacture
 *     (rather than test) a phenomenon.
 *  3. Renders and writes the validated Scenario to scenarios/<name>.yaml.
 *
 * Usage:
 *   bun .claude/scenario-designer/scripts/validate.mts <input.json> [out.yaml]
 * Output defaults to scenarios/<name>.yaml. Exit 0 on success, non-zero with
 * the full list of problems otherwise.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
/// <reference path="./js-yaml-shim.d.ts" />
import yaml from "../../../packages/shared/node_modules/js-yaml/index.js";
import { parseScenarioConfig } from "../../../packages/shared/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: validate.mts <input.json> [out.yaml]");
  process.exit(2);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

let raw: unknown;
try {
  raw = JSON.parse(await readFile(inputPath, "utf8"));
} catch (e) {
  console.error(`could not read/parse ${inputPath}: ${errMsg(e)}`);
  process.exit(2);
}

interface ZodIssue {
  path: (string | number)[];
  message: string;
}

// ---- 1. Structural validation against the real schema ----
// Assignment inside the try is fine: we bail (exit) before `config` is read if
// parsing failed, so the narrow happens before any use.
let config: ReturnType<typeof parseScenarioConfig> | undefined;
try {
  config = parseScenarioConfig(raw);
} catch (e) {
  const issues = (e as { issues?: ZodIssue[] }).issues;
  if (Array.isArray(issues)) {
    for (const i of issues) console.error(`schema: ${i.path.join(".") || "(root)"} -> ${i.message}`);
  } else {
    console.error(`schema: ${errMsg(e)}`);
  }
  process.exit(1);
}

// ---- 2. Design heuristics (only if the document is at least structurable) ----
const agents = (raw as { agents?: unknown[] } | undefined)?.agents;
if (Array.isArray(agents) && agents.length >= 2) {
  const designProblems = designChecks(raw as { agents: AgentRow[]; maxRuntimeMs?: unknown });
  if (designProblems.length > 0) {
    designProblems.forEach((p) => console.error(p));
    process.exit(1);
  }
}

// ---- 3. Render ----
if (config === undefined) {
  console.error("internal error: config is undefined after successful parse");
  process.exit(1);
}
const outName = process.argv[3] ?? resolve(REPO_ROOT, "scenarios", `${config.name}.yaml`);
const rendered = renderYaml(config);
await writeFile(outName, rendered, "utf8");
console.log(`wrote ${outName}`);
console.log(`agents: ${config.agents.length}, maxRuntimeMs: ${config.maxRuntimeMs}`);
console.log(
  config.agents.map((a) => `  ${a.id.padEnd(10)} ${a.persona.displayName.padEnd(8)} C=${a.persona.traits.conformity} A=${a.persona.traits.assertiveness} O=${a.persona.traits.opennessToEvidence} S=${a.persona.initialStance}`).join("\n"),
);

interface AgentRow {
  id?: string;
  persona?: {
    displayName?: string;
    traits?: {
      conformity?: number;
      assertiveness?: number;
      opennessToEvidence?: number;
    };
    initialStance?: number;
  };
}

function designChecks(input: { agents: AgentRow[]; maxRuntimeMs?: unknown }): string[] {
  const problems: string[] = [];
  const rows = input.agents;
  const trait = (r: AgentRow, k: "conformity" | "assertiveness" | "opennessToEvidence") =>
    r.persona?.traits?.[k];
  const stance = (r: AgentRow) => r.persona?.initialStance;

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  // Every agent should be reachable/thin on one axis or the other — a cast
  // where everyone is mid on everything produces a bland echo, not a test.
  const flat = rows.filter((r) => {
    const c = num(trait(r, "conformity"));
    const a = num(trait(r, "assertiveness"));
    const o = num(trait(r, "opennessToEvidence"));
    if ([c, a, o].some((x) => x === undefined)) return false;
    return [c!, a!, o!].every((x) => x >= 0.35 && x <= 0.65);
  });
  if (flat.length === rows.length) {
    problems.push("design: every agent is mid (0.35-0.65) on all three traits — spread the cast out so personalities genuinely differ.");
  }

  // Duplicate / near-identical stances across everyone kills the tension.
  const stances = rows.map((r) => num(stance(r))).filter((x): x is number => x !== undefined);
  if (stances.length >= 2 && Math.max(...stances) - Math.min(...stances) < 0.3) {
    problems.push("design: all initial stances are within 0.3 of each other — polarizing phenomena need spread, and even cooperative ones need friction.");
  }

  // A lone, low-assertiveness, low-openness agent with no near ally is a
  // target by construction — it manufactures the phenomenon rather than
  // testing it.
  const lowAs = rows.filter((r) => num(trait(r, "assertiveness")) !== undefined && num(trait(r, "assertiveness"))! <= 0.25);
  for (const target of lowAs) {
    const tStance = num(stance(target));
    const hasAlly = rows.some((r) => {
      if (r === target) return false;
      const s = num(stance(r));
      const a = num(trait(r, "assertiveness"));
      if (s === undefined || a === undefined || tStance === undefined) return false;
      return a >= 0.4 && Math.abs(s - tStance) <= 0.3; // someone assertive who roughly agrees
    });
    if (!hasAlly) {
      problems.push(
        `design: ${target.id ?? "(agent)"} is low-assertiveness (${trait(target, "assertiveness")}) with no assertive ally near its stance — it's an isolated target by construction. Give it an ally, or raise its assertiveness, or this measures manufactured bullying, not emergent behavior.`,
      );
    }
  }

  // Wall-clock limit too short to allow several exchanges. Agents are
  // event-driven (not tick-scheduled), so a discussion needs enough running
  // time for multiple turns each; a sub-minute cap usually ends the Run before
  // any phenomenon can develop.
  const maxRuntimeMs = num(input.maxRuntimeMs);
  if (maxRuntimeMs !== undefined && maxRuntimeMs < 60_000) {
    problems.push(`design: maxRuntimeMs of ${maxRuntimeMs}ms is very short — events, not ticks, drive turns, so give the discussion room for several exchanges; consider >= 120000 (2 minutes).`);
  }
  return problems;
}

function renderYaml(c: ScenarioConfigLike): string {
  const body: Record<string, unknown> = {
    name: c.name,
    topic: c.topic,
    seedMessage: c.seedMessage,
    seedAuthor: c.seedAuthor,
    maxRuntimeMs: c.maxRuntimeMs,
    maxToolStepsPerTurn: c.maxToolStepsPerTurn,
    budget: c.budget,
    agents: c.agents.map((a) => ({
      id: a.id,
      persona: a.persona,
    })),
  };
  // Optional, and omitted when absent: a Scenario that names no Readers must
  // render no `observers` key at all, which is not the same thing as an empty
  // list to the runner -- see ScenarioConfig.observers in packages/shared.
  if (c.observers !== undefined) body.observers = c.observers;
  const lines = yaml.dump(body, { lineWidth: 80, noRefs: true, quotingType: '"' });
  // Keep multi-line strings as block scalars and drop trailing newline noise.
  return lines.replace(/\n$/, "") + "\n";
}

type ScenarioConfigLike = {
  name: string;
  topic: string;
  seedMessage: string;
  seedAuthor: string;
  maxRuntimeMs: number;
  maxToolStepsPerTurn: number;
  budget: { maxTotalTokens?: number; maxTotalCostUsd?: number };
  agents: { id: string; persona: Record<string, unknown> }[];
  observers?: string[];
};
