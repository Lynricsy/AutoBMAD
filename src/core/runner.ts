import { type IWorkflowRunner, type RunResult, type RunOptions } from "./types.js";

type SpawnOptions = {
  cwd?: string;
  stdout: "pipe";
  stderr: "pipe";
};

type SpawnFn = (cmd: string[], options: SpawnOptions) => SubprocessLike;

interface SubprocessLike {
  stdout: unknown;
  stderr: unknown;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): void;
}

interface WorkflowRunnerDeps {
  spawn: SpawnFn;
  signals: SignalSource;
  now: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

const DEFAULT_TIMEOUT_MS = 18_000_000;
const SIGKILL_GRACE_MS = 5_000;
const MAX_STDERR_BUFFER = 100 * 1024;

export function buildOhMyOpenCodeRunCommand(options: RunOptions, summaryEnabled?: boolean): string[] {
  const cmd = ["oh-my-opencode", "run", "--agent", options.agent];

  if (options.directory) {
    cmd.push("--directory", options.directory);
  }

  if (summaryEnabled === true) {
    cmd.push("--verbose");
  }

  cmd.push("--json", options.message);
  return cmd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... (truncated, ${text.length - maxChars} more chars)`;
}

function normalizeTextOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // 如果整段文本本身就是合法 JSON，直接返回
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  // OpenCode 的 stdout 可能包含非 JSON 前缀行（如 "Auto-selected port 4097"）
  // 从后往前找到最后一个 `{` 开头的行，提取 JSON 对象
  const lastBrace = trimmed.lastIndexOf("\n{");
  if (lastBrace !== -1) {
    return trimmed.slice(lastBrace + 1);
  }

  return trimmed;
}

function hasTextMethod(value: unknown): value is { text: () => Promise<string> } {
  return isRecord(value) && typeof (value as { text?: unknown }).text === "function";
}

function appendCappedText(buffer: string, chunk: string, maxChars: number): string {
  if (!chunk || buffer.length >= maxChars) {
    return buffer;
  }

  return buffer + chunk.slice(0, maxChars - buffer.length);
}

async function readSubprocessText(stream: unknown): Promise<string> {
  if (!stream) return "";
  if (typeof stream === "number") return "";

  if (stream instanceof ReadableStream) {
    return await new Response(stream).text();
  }

  if (hasTextMethod(stream)) {
    return await stream.text();
  }

  return "";
}

async function readStreamingStderr(
  stream: unknown,
  onStderr: (chunk: string) => void,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    const stderrText = await readSubprocessText(stream);
    if (stderrText) {
      onStderr(stderrText);
    }
    return stderrText.slice(0, MAX_STDERR_BUFFER);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stderrBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;

      onStderr(chunk);
      stderrBuffer = appendCappedText(stderrBuffer, chunk, MAX_STDERR_BUFFER);
    }

    const trailingChunk = decoder.decode();
    if (trailingChunk) {
      onStderr(trailingChunk);
      stderrBuffer = appendCappedText(stderrBuffer, trailingChunk, MAX_STDERR_BUFFER);
    }

    return stderrBuffer;
  } finally {
    reader.releaseLock();
  }
}

type ParseOk = {
  ok: true;
  result: RunResult;
};

type ParseErr = {
  ok: false;
  error: string;
};

function parseOhMyOpenCodeJson(stdoutText: string): ParseOk | ParseErr {
  const normalized = normalizeTextOutput(stdoutText);
  if (!normalized) {
    return { ok: false, error: "Empty stdout" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${formatError(err)}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "JSON output is not an object" };
  }

  // OpenCode 输出可能是 camelCase 或 snake_case
  const sessionId = parsed.session_id ?? parsed.sessionId;
  const success = parsed.success;
  const durationMs = parsed.duration_ms ?? parsed.durationMs;
  const messageCount = parsed.message_count ?? parsed.messageCount;
  const summary = parsed.summary;

  if (typeof sessionId !== "string") {
    return { ok: false, error: "Invalid JSON: session_id must be a string" };
  }
  if (typeof success !== "boolean") {
    return { ok: false, error: "Invalid JSON: success must be a boolean" };
  }
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return { ok: false, error: "Invalid JSON: duration_ms must be a finite number" };
  }
  if (typeof messageCount !== "number" || !Number.isFinite(messageCount)) {
    return { ok: false, error: "Invalid JSON: message_count must be a finite number" };
  }
  if (typeof summary !== "string") {
    return { ok: false, error: "Invalid JSON: summary must be a string" };
  }

  return {
    ok: true,
    result: {
      sessionId,
      success,
      durationMs,
      messageCount,
      summary,
    },
  };
}

function makeFailureResult(params: {
  durationMs: number;
  summary: string;
  sessionId?: string;
  messageCount?: number;
}): RunResult {
  return {
    sessionId: params.sessionId ?? "",
    success: false,
    durationMs: params.durationMs,
    messageCount: params.messageCount ?? 0,
    summary: params.summary,
  };
}

function makeSuccessResult(result: RunResult): RunResult {
  return {
    sessionId: result.sessionId,
    success: true,
    durationMs: result.durationMs,
    messageCount: result.messageCount,
    summary: result.summary,
  };
}

export class WorkflowRunner implements IWorkflowRunner {
  private readonly defaultTimeout?: number;
  private readonly deps: WorkflowRunnerDeps;

  constructor(
    config: { timeout?: number } = {},
    deps: Partial<WorkflowRunnerDeps> = {},
  ) {
    this.defaultTimeout = config.timeout;

    this.deps = {
      spawn:
        deps.spawn ??
        ((cmd, options) => Bun.spawn(cmd, options) as unknown as SubprocessLike),
      signals: deps.signals ?? process,
      now: deps.now ?? (() => Date.now()),
      setTimeout: deps.setTimeout ?? globalThis.setTimeout,
      clearTimeout: deps.clearTimeout ?? globalThis.clearTimeout,
    };
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = this.deps.now();
    const timeoutMs = options.timeout ?? this.defaultTimeout ?? DEFAULT_TIMEOUT_MS;

    const cmd = buildOhMyOpenCodeRunCommand(options, options.verbose);

    let proc: SubprocessLike;
    try {
      proc = this.deps.spawn(cmd, {
        cwd: options.directory,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      return makeFailureResult({
        durationMs: this.deps.now() - startedAt,
        summary: `Failed to spawn process: ${formatError(err)}`,
      });
    }

    const stderrReadPromise = options.onStderr
      ? readStreamingStderr(proc.stderr, options.onStderr)
      : undefined;

    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
    let terminateRequested = false;

    const requestTerminate = (): void => {
      if (terminateRequested) return;
      terminateRequested = true;

      try {
        proc.kill("SIGTERM");
      } catch {
      }

      killEscalationTimer = this.deps.setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
        }
      }, SIGKILL_GRACE_MS);
    };

    const clearKillEscalation = (): void => {
      if (killEscalationTimer === undefined) return;
      this.deps.clearTimeout(killEscalationTimer);
      killEscalationTimer = undefined;
    };

    this.deps.signals.on("SIGINT", requestTerminate);
    this.deps.signals.on("SIGTERM", requestTerminate);

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutTimer = this.deps.setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });

    try {
      const outcome = await Promise.race([
        proc.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
        timeoutPromise,
      ]);

      if (timeoutTimer !== undefined) {
        this.deps.clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }

      if (outcome.kind === "timeout") {
        requestTerminate();
        await proc.exited;
        clearKillEscalation();

        if (stderrReadPromise) {
          try {
            await stderrReadPromise;
          } catch {
          }
        }

        return makeFailureResult({
          durationMs: this.deps.now() - startedAt,
          summary: "Process timed out",
        });
      }

      clearKillEscalation();

      const stderrTextPromise = stderrReadPromise ?? readSubprocessText(proc.stderr);

      const [stdoutText, stderrText] = await Promise.all([
        readSubprocessText(proc.stdout),
        stderrTextPromise,
      ]);

      const parsed = parseOhMyOpenCodeJson(stdoutText);

      if (!parsed.ok) {
        const summary = [
          "Failed to parse JSON output",
          parsed.error,
          stdoutText ? `stdout:\n${truncate(stdoutText, 8_000)}` : "stdout: <empty>",
          stderrText ? `stderr:\n${truncate(stderrText, 8_000)}` : "stderr: <empty>",
        ].join("\n");

        return makeFailureResult({
          durationMs: this.deps.now() - startedAt,
          summary,
        });
      }

      if (outcome.exitCode !== 0) {
        const summary = [
          `Process exited with code ${outcome.exitCode}`,
          parsed.result.summary,
          stderrText ? `stderr:\n${truncate(stderrText, 8_000)}` : "stderr: <empty>",
        ].join("\n");

        return makeFailureResult({
          durationMs: parsed.result.durationMs,
          summary,
          sessionId: parsed.result.sessionId,
          messageCount: parsed.result.messageCount,
        });
      }

      if (!parsed.result.success) {
        return makeFailureResult({
          durationMs: parsed.result.durationMs,
          summary: parsed.result.summary,
          sessionId: parsed.result.sessionId,
          messageCount: parsed.result.messageCount,
        });
      }

      return makeSuccessResult(parsed.result);
    } catch (err) {
      requestTerminate();
      try {
        await proc.exited;
      } catch {
      }
      clearKillEscalation();

      if (stderrReadPromise) {
        try {
          await stderrReadPromise;
        } catch {
        }
      }

      return makeFailureResult({
        durationMs: this.deps.now() - startedAt,
        summary: `Runner error: ${formatError(err)}`,
      });
    } finally {
      this.deps.signals.removeListener("SIGINT", requestTerminate);
      this.deps.signals.removeListener("SIGTERM", requestTerminate);
      if (timeoutTimer !== undefined) {
        this.deps.clearTimeout(timeoutTimer);
      }
      clearKillEscalation();
    }
  }
}

export class MockWorkflowRunner implements IWorkflowRunner {
  private responses: Map<string, RunResult> = new Map();
  private defaultResponse: RunResult | undefined;

  public callHistory: RunOptions[] = [];

  setResponse(agent: string, result: RunResult): void {
    this.responses.set(agent, structuredClone(result));
  }

  setDefaultResponse(result: RunResult): void {
    this.defaultResponse = structuredClone(result);
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.callHistory.push(structuredClone(options));

    const configured = this.responses.get(options.agent);
    if (configured) return structuredClone(configured);

    if (this.defaultResponse) return structuredClone(this.defaultResponse);

    return {
      sessionId: "",
      success: false,
      durationMs: 0,
      messageCount: 0,
      summary: `No mock response configured for agent: ${options.agent}`,
    };
  }

  getCallCount(): number {
    return this.callHistory.length;
  }

  getLastCall(): RunOptions | undefined {
    return this.callHistory.at(-1);
  }

  reset(): void {
    this.responses = new Map();
    this.defaultResponse = undefined;
    this.callHistory = [];
  }
}
