import { describe, test, expect } from "bun:test";
import { WorkflowRunner, MockWorkflowRunner, buildOhMyOpenCodeRunCommand } from "../../src/core/runner.js";
import { AgentType, type RunOptions, type RunResult } from "../../src/core/types.js";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function okJson(result: {
  session_id: string;
  success: boolean;
  duration_ms: number;
  message_count: number;
  summary: string;
}): string {
  return JSON.stringify(result);
}

function makeSignalsSpy() {
  const onCalls: Array<{ event: "SIGINT" | "SIGTERM"; listener: () => void }> = [];
  const removeCalls: Array<{ event: "SIGINT" | "SIGTERM"; listener: () => void }> = [];

  const signals = {
    on(event: "SIGINT" | "SIGTERM", listener: () => void) {
      onCalls.push({ event, listener });
    },
    removeListener(event: "SIGINT" | "SIGTERM", listener: () => void) {
      removeCalls.push({ event, listener });
    },
  };

  return { signals, onCalls, removeCalls };
}

function makeImmediateProc(params: {
  stdoutText: string;
  stderrText?: string;
  exitCode: number;
}) {
  return {
    stdout: streamFromText(params.stdoutText),
    stderr: streamFromText(params.stderrText ?? ""),
    exited: Promise.resolve(params.exitCode),
    kill(_signal?: number | NodeJS.Signals) {},
  };
}

function makeKillControlledProc(params: {
  stdoutText?: string;
  stderrText?: string;
}) {
  const killCalls: Array<number | NodeJS.Signals | undefined> = [];
  let resolveExited: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const proc = {
    stdout: streamFromText(params.stdoutText ?? ""),
    stderr: streamFromText(params.stderrText ?? ""),
    exited,
    kill(signal?: number | NodeJS.Signals) {
      killCalls.push(signal);
      resolveExited?.(typeof signal === "number" ? signal : 143);
    },
  };

  return { proc, killCalls };
}

describe("buildOhMyOpenCodeRunCommand", () => {
  test("basic command construction (agent + message)", () => {
    const options: RunOptions = {
      message: "hello",
      agent: AgentType.Sisyphus,
      directory: "",
    };

    expect(buildOhMyOpenCodeRunCommand(options)).toEqual([
      "oh-my-opencode",
      "run",
      "--agent",
      "sisyphus",
      "--json",
      "hello",
    ]);
  });

  test("includes directory flag when directory is provided", () => {
    const options: RunOptions = {
      message: "hello",
      agent: AgentType.Hephaestus,
      directory: "/tmp/project",
    };

    expect(buildOhMyOpenCodeRunCommand(options)).toEqual([
      "oh-my-opencode",
      "run",
      "--agent",
      "hephaestus",
      "--directory",
      "/tmp/project",
      "--json",
      "hello",
    ]);
  });

  test("omits directory flag when directory is empty", () => {
    const options: RunOptions = {
      message: "m",
      agent: AgentType.Hephaestus,
      directory: "",
    };

    const cmd = buildOhMyOpenCodeRunCommand(options);
    expect(cmd.includes("--directory")).toBe(false);
  });

  test("places --json immediately before message", () => {
    const options: RunOptions = {
      message: "the message",
      agent: AgentType.Sisyphus,
      directory: "/tmp/project",
    };

    const cmd = buildOhMyOpenCodeRunCommand(options);
    const jsonIdx = cmd.indexOf("--json");
    expect(jsonIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[jsonIdx + 1]).toBe(options.message);
  });
});

describe("WorkflowRunner", () => {
  test("spawn throwing returns a failed RunResult", async () => {
    const { signals, onCalls, removeCalls } = makeSignalsSpy();
    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn() {
          throw new Error("spawn boom");
        },
      },
    );

    const result = await runner.run({
      message: "m",
      agent: AgentType.Sisyphus,
      directory: "/tmp/x",
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Failed to spawn process");
    expect(result.summary).toContain("spawn boom");
    expect(onCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });

  test("builds correct command array and spawn options", async () => {
    let capturedCmd: string[] | undefined;
    let capturedCwd: string | undefined;
    let capturedStdout: unknown;
    let capturedStderr: unknown;

    const { signals } = makeSignalsSpy();
    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn(cmd, options) {
          capturedCmd = cmd;
          capturedCwd = options.cwd;
          capturedStdout = options.stdout;
          capturedStderr = options.stderr;
          return makeImmediateProc({
            exitCode: 0,
            stdoutText: okJson({
              session_id: "ses_cmd",
              success: true,
              duration_ms: 10,
              message_count: 1,
              summary: "ok",
            }),
          });
        },
      },
    );

    const options: RunOptions = {
      message: "hello",
      agent: AgentType.Sisyphus,
      directory: "/tmp/project",
    };

    const result = await runner.run(options);
    expect(result.success).toBe(true);

    expect(capturedCmd).toEqual([
      "oh-my-opencode",
      "run",
      "--agent",
      "sisyphus",
      "--directory",
      "/tmp/project",
      "--json",
      "hello",
    ]);
    expect(capturedCwd).toBe("/tmp/project");
    expect(capturedStdout).toBe("pipe");
    expect(capturedStderr).toBe("pipe");
  });

  test("maps successful JSON stdout to RunResult", async () => {
    const { signals } = makeSignalsSpy();
    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn() {
          return makeImmediateProc({
            exitCode: 0,
            stdoutText: okJson({
              session_id: "ses_ok",
              success: true,
              duration_ms: 12345,
              message_count: 42,
              summary: "all good",
            }),
          });
        },
      },
    );

    const result = await runner.run({
      message: "m",
      agent: AgentType.Hephaestus,
      directory: "/tmp/x",
    });

    expect(result).toEqual({
      sessionId: "ses_ok",
      success: true,
      durationMs: 12345,
      messageCount: 42,
      summary: "all good",
    });
  });

  test("handles non-JSON stdout gracefully", async () => {
    const { signals } = makeSignalsSpy();
    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn() {
          return makeImmediateProc({
            exitCode: 0,
            stdoutText: "not json",
            stderrText: "",
          });
        },
      },
    );

    const result = await runner.run({
      message: "m",
      agent: AgentType.Sisyphus,
      directory: "/tmp/x",
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain("not json");
  });

  test("empty stdout returns success=false", async () => {
    const { signals } = makeSignalsSpy();
    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn() {
          return makeImmediateProc({
            exitCode: 0,
            stdoutText: "",
            stderrText: "",
          });
        },
      },
    );

    const result = await runner.run({
      message: "m",
      agent: AgentType.Sisyphus,
      directory: "/tmp/x",
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Failed to parse JSON output");
    expect(result.summary).toContain("Empty stdout");
  });

  test("non-zero exit code returns success=false and includes stderr", async () => {
    const { signals } = makeSignalsSpy();
    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn() {
          return makeImmediateProc({
            exitCode: 2,
            stdoutText: okJson({
              session_id: "ses_fail",
              success: true,
              duration_ms: 99,
              message_count: 7,
              summary: "runner said ok but process failed",
            }),
            stderrText: "boom",
          });
        },
      },
    );

    const result = await runner.run({
      message: "m",
      agent: AgentType.Hephaestus,
      directory: "/tmp/x",
    });

    expect(result.success).toBe(false);
    expect(result.sessionId).toBe("ses_fail");
    expect(result.messageCount).toBe(7);
    expect(result.summary).toContain("Process exited with code 2");
    expect(result.summary).toContain("boom");
  });

  test("timeout returns a failed RunResult and terminates process", async () => {
    const { signals } = makeSignalsSpy();
    const { proc, killCalls } = makeKillControlledProc({});

    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn() {
          return proc;
        },
      },
    );

    const result = await runner.run({
      message: "m",
      agent: AgentType.Sisyphus,
      directory: "/tmp/x",
      timeout: 50,
    });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("Process timed out");
    expect(killCalls).toContain("SIGTERM");
  });

  test("registers and cleans up signal handlers", async () => {
    const { signals, onCalls, removeCalls } = makeSignalsSpy();

    const runner = new WorkflowRunner(
      { timeout: 1_000 },
      {
        signals,
        spawn() {
          return makeImmediateProc({
            exitCode: 0,
            stdoutText: okJson({
              session_id: "ses_sig",
              success: true,
              duration_ms: 1,
              message_count: 1,
              summary: "ok",
            }),
          });
        },
      },
    );

    const result = await runner.run({
      message: "m",
      agent: AgentType.Sisyphus,
      directory: "/tmp/x",
    });
    expect(result.success).toBe(true);

    expect(onCalls).toHaveLength(2);
    expect(removeCalls).toHaveLength(2);

    const onSigint = onCalls.find((c) => c.event === "SIGINT");
    const onSigterm = onCalls.find((c) => c.event === "SIGTERM");
    const offSigint = removeCalls.find((c) => c.event === "SIGINT");
    const offSigterm = removeCalls.find((c) => c.event === "SIGTERM");

    expect(onSigint?.listener).toBe(offSigint?.listener);
    expect(onSigterm?.listener).toBe(offSigterm?.listener);
  });
});

describe("MockWorkflowRunner", () => {
  test("returns configured agent-specific responses", async () => {
    const mock = new MockWorkflowRunner();

    const sis: RunResult = {
      sessionId: "ses_sis",
      success: true,
      durationMs: 1,
      messageCount: 2,
      summary: "sis",
    };

    const hep: RunResult = {
      sessionId: "ses_hep",
      success: true,
      durationMs: 3,
      messageCount: 4,
      summary: "hep",
    };

    mock.setResponse(AgentType.Sisyphus, sis);
    mock.setResponse(AgentType.Hephaestus, hep);

    const r1 = await mock.run({
      message: "m1",
      agent: AgentType.Sisyphus,
      directory: "/tmp/a",
    });
    const r2 = await mock.run({
      message: "m2",
      agent: AgentType.Hephaestus,
      directory: "/tmp/b",
    });

    expect(r1).toEqual(sis);
    expect(r2).toEqual(hep);
  });

  test("uses default response when agent response is missing", async () => {
    const mock = new MockWorkflowRunner();
    const def: RunResult = {
      sessionId: "ses_def",
      success: true,
      durationMs: 10,
      messageCount: 20,
      summary: "default",
    };

    mock.setDefaultResponse(def);

    const r = await mock.run({
      message: "m",
      agent: AgentType.Sisyphus,
      directory: "/tmp/a",
    });

    expect(r).toEqual(def);
  });

  test("tracks call history and helpers work", async () => {
    const mock = new MockWorkflowRunner();
    mock.setDefaultResponse({
      sessionId: "ses",
      success: true,
      durationMs: 0,
      messageCount: 0,
      summary: "ok",
    });

    await mock.run({ message: "a", agent: AgentType.Sisyphus, directory: "/tmp/1" });
    await mock.run({ message: "b", agent: AgentType.Hephaestus, directory: "/tmp/2" });

    expect(mock.getCallCount()).toBe(2);
    expect(mock.getLastCall()).toEqual({ message: "b", agent: AgentType.Hephaestus, directory: "/tmp/2" });
    expect(mock.callHistory).toHaveLength(2);
  });

  test("reset clears configured responses and call history", async () => {
    const mock = new MockWorkflowRunner();
    mock.setResponse(AgentType.Sisyphus, {
      sessionId: "ses",
      success: true,
      durationMs: 1,
      messageCount: 1,
      summary: "ok",
    });
    await mock.run({ message: "a", agent: AgentType.Sisyphus, directory: "/tmp/1" });

    mock.reset();

    expect(mock.getCallCount()).toBe(0);
    expect(mock.getLastCall()).toBeUndefined();

    const r = await mock.run({ message: "x", agent: AgentType.Sisyphus, directory: "/tmp/1" });
    expect(r.success).toBe(false);
    expect(r.summary).toContain("No mock response configured");
  });
});
