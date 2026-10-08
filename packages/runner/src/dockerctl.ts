/**
 * Thin wrappers over the `docker compose` CLI for a Run's generated compose
 * file. Output goes straight to the runner's terminal (inherited stdio), and
 * each call rejects if docker exits non-zero or cannot be spawned.
 */
import { spawn } from "node:child_process";

/** Builds the images and starts every service detached; resolves once compose returns, not once agents are healthy. */
export function composeUp(file: string): Promise<void> {
  return run(["compose", "-f", file, "up", "-d", "--build"]);
}

/** Stops and removes the Run's containers and networks. Logs live on the host volume and survive. */
export function composeDown(file: string): Promise<void> {
  return run(["compose", "-f", file, "down"]);
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker ${args.join(" ")} exited with code ${code}`));
    });
  });
}
