#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatRunId } from "@agora/shared";
import { createRunLifecycle } from "./runLifecycle.js";
import { loadScenario, loadCredentials } from "./loadConfig.js";
import { generateComposeFile } from "./composeGenerator.js";
import { composeUp, composeDown } from "./dockerctl.js";
import { waitForHealth, runTicks } from "./orchestrator.js";
import { BudgetTracker } from "./budget.js";
import { seedRoom } from "./seedRoom.js";
import { createRunRoom } from "./runRoom.js";
import { RoomPermissionsError } from "./roomPermissions.js";
import type { RunOutcome } from "./runLifecycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const LOG_DIR = path.join(REPO_ROOT, "logs");

// Owns how this Run's transcript ends, and who gets to say so. A cancel is a
// normal outcome, not a crash: SIGINT/SIGTERM record it as `run_aborted` so the
// transcript says why it stopped, rather than leaving an operator to guess
// between a kill and a still-running Run. A hard kill (SIGKILL, OOM) cannot be
// caught, and stays recorded only by the absence of a terminal event — which is
// now the honest "incomplete" signature rather than an ambiguity shared with a
// Run still in progress.
const lifecycle = createRunLifecycle({ logDir: LOG_DIR, composeDown });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // 128 + signal number, the conventional shell code, so a script can tell a
    // deliberate cancel from a Run that finished.
    const code = signal === "SIGINT" ? 130 : 143;
    void lifecycle
      .closeOutRun(signal)
      .then(() => process.exit(code))
      .catch((err) => {
        console.error(`failed to record cancellation:`, err);
        process.exit(1);
      });
  });
}

async function main(): Promise<void> {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error("Usage: agora <scenario.yaml> [--credentials <credentials.yaml>]");
    process.exit(1);
  }

  const credFlagIndex = process.argv.indexOf("--credentials");
  const credentialsPath =
    credFlagIndex !== -1 && process.argv[credFlagIndex + 1]
      ? process.argv[credFlagIndex + 1]!
      : path.join(REPO_ROOT, "credentials.yaml");

  const scenario = await loadScenario(scenarioPath);
  const credentials = await loadCredentials(credentialsPath);

  for (const agent of scenario.agents) {
    if (!credentials.agents[agent.id]) {
      throw new Error(`Scenario references agent "${agent.id}" with no matching entry in ${credentialsPath}`);
    }
  }

  // The runId is <scenario>-<YYYYMMDD-HHMM> in UTC (formatRunId, the single
  // source shared with parseRunId), so both a human and a reader of the room
  // name can tell this Run apart from earlier ones of the same Scenario. It
  // drives the transcript directory and the Matrix room name unchanged.
  const runId = formatRunId(scenario.name, new Date());
  console.log(`Starting run ${runId}`);

  // Marked in flight before anything that can fail, so a signal arriving during
  // room setup or container startup is still recorded as a cancellation. This
  // is also what tells deriveRunStatus that a transcript with no terminal event
  // belongs to a Run that actually began, rather than an empty directory.
  await lifecycle.begin(runId);

  // Each Run gets its own room (ADR-0003), so the Scenario is never executed
  // against a previous Run's Transcript. The room is created here, named for
  // this Run, and admitted to by the roster; the id is a per-Run value from here
  // on rather than something recorded in credentials.yaml.
  //
  // createRunRoom refuses a Run whose room does not hold the permissions it asked
  // for, which is the last point before a human is admitted and agents start.
  // The refusal is recorded here rather than in runRoom.ts because this is the
  // module that owns the Transcript, and Run status is read off it: a Run whose
  // Transcript carries a terminal event has a verdict, so without this event a
  // Run stopped for want of permissions would read as merely incomplete. Tick 0
  // is the honest value -- the room never got far enough for a tick 1.
  let roomId: string;
  try {
    roomId = await createRunRoom({ scenario, credentials, runId });
  } catch (err) {
    if (err instanceof RoomPermissionsError) {
      console.error(`Aborting run ${runId}: ${err.message}`);
      await lifecycle.recordOutcome(runId, {
        type: "permissionsRefused",
        reason: err.message,
      });
    }
    throw err;
  }

  // Post the Scenario's seed as the setup user before any agent acts, so the
  // conversation starts with a moderator seed rather than a cold room.
  await seedRoom({ scenario, credentials, roomId });

  const { yamlText, agentPorts } = generateComposeFile({
    runId,
    roomId,
    scenario,
    credentials,
  });
  const generatedDir = path.join(REPO_ROOT, "runner-generated");
  await mkdir(generatedDir, { recursive: true });
  const composeFile = path.join(generatedDir, `docker-compose.${runId}.yml`);
  await writeFile(composeFile, yamlText, "utf8");
  console.log(`Generated ${composeFile}`);

  // From here a cancellation can also tear down, not just record.
  lifecycle.attachComposeFile(composeFile);

  const budget = new BudgetTracker(scenario.budget.maxTotalTokens);

  try {
    console.log("Starting containers...");
    await composeUp(composeFile);

    const healthUrls = Object.values(agentPorts).map((port) => `http://localhost:${port}/health`);
    console.log("Waiting for agents to become healthy...");
    await waitForHealth(healthUrls);

    console.log(`Running ${scenario.ticks} ticks...`);
    const result = await runTicks({
      scenario,
      agentPorts,
      budget,
      runId,
      logDir: LOG_DIR,
      stopWhen: () => !lifecycle.isActive(),
    });

    if (result.aborted) {
      console.warn(`Run aborted after ${result.ticksRun} ticks: ${result.reason}`);
      const outcome: RunOutcome = {
        type: "ticksAborted",
        ticksRun: result.ticksRun,
        reason: result.reason ?? "unknown",
      };
      await lifecycle.recordOutcome(runId, outcome);
    } else if (!lifecycle.isActive()) {
      // A signal landed between the last tick and here. The transcript already
      // carries the abort, so there is nothing to write -- but reporting
      // "completed" here would be the one false all-clear this ADR set out to
      // remove, so it is not said.
      console.warn("Run cancelled after the final tick; see run_aborted in the transcript.");
    } else {
      console.log(`Run completed all ${result.ticksRun} ticks.`);
      const outcome: RunOutcome = {
        type: "completed",
        ticksRun: result.ticksRun,
      };
      await lifecycle.recordOutcome(runId, outcome);
    }
    console.log("Budget summary:", budget.summary());
    console.log(`Logs: logs/${runId}/events.jsonl`);
    console.log(`Matrix room left in place for review: ${roomId}`);
  } finally {
    console.log("Tearing down containers...");
    await lifecycle.teardownContainers(composeFile);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
