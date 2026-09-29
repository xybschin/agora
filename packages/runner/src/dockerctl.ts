import { spawn } from "node:child_process";

export function composeUp(file: string): Promise<void> {
  return run(["compose", "-f", file, "up", "-d", "--build"]);
}

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
