function showHelp(): void {
  console.log(`AutoBMAD CLI

Usage:
  autobmad <command> [options]

Commands:
  start    Start or continue a sprint run (runs planning if needed)
  resume   Resume a paused sprint run from .autobmad-state.json
  status   Show sprint status summary from sprint-status.yaml
  reset    Reset local run state (.autobmad-state.json)
  run-all  Run all sprints to completion (multi-sprint mode)

Options:
  --dir, -d <path>    Project directory (default: cwd)
  --verbose, -v       Verbose logging
  --help, -h          Show help
`);
}

function resolveExitCode(fallback: number = 0): number {
  const code = process.exitCode;
  if (typeof code === "number") return code;
  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const prevArgv = process.argv;
  process.argv = argv;

  const command = argv[2];

  if (command === undefined || command === "--help" || command === "-h") {
    showHelp();
    process.argv = prevArgv;
    return 0;
  }

  try {
    switch (command) {
      case "start": {
        const { startCommand } = await import("./commands/start.js");
        await startCommand();
        return resolveExitCode();
      }
      case "resume": {
        const { resumeCommand } = await import("./commands/resume.js");
        await resumeCommand();
        return resolveExitCode();
      }
      case "status": {
        const { statusCommand } = await import("./commands/status.js");
        await statusCommand();
        return resolveExitCode();
      }
      case "reset": {
        const { resetCommand } = await import("./commands/reset.js");
        await resetCommand();
        return resolveExitCode();
      }
      case "run-all": {
        const { runAllCommand } = await import("./commands/run-all.js");
        await runAllCommand();
        return resolveExitCode();
      }
      default:
        showHelp();
        return 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[autobmad] ${message}\n`);
    return 1;
  } finally {
    process.argv = prevArgv;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv);
  process.exit(exitCode);
}
