import { join } from "node:path";
import { RunStateStore } from "../../core/run-state.js";

function parseDir(argv: string[]): string {
  const idx = argv.findIndex((arg) => arg === "--dir" || arg === "-d");
  if (idx === -1) return process.cwd();
  const value = argv[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("Missing value for --dir");
  }
  return value;
}

export async function resetCommand(): Promise<void> {
  const argv = process.argv;
  const projectDir = parseDir(argv);
  const statePath = join(projectDir, ".autobmad-state.json");

  const runState = new RunStateStore(statePath);
  await runState.reset();

  console.log(`Reset run state: ${statePath}`);
  process.exitCode = 0;
}
