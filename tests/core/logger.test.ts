import { test, expect, beforeEach } from "bun:test";
import { Logger, LogLevel, LoggerOptions, initLogger, createLogger } from "../../src/core/logger";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── 测试辅助工具 ────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<LoggerOptions> = {}): LoggerOptions {
  return {
    level: LogLevel.Debug,
    logDir: "/tmp/autobmad-test-logs",
    silent: true,
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "autobmad-logger-test-"));
}

// ─── 日志级别过滤测试 ─────────────────────────────────────────────────────────

test("debug messages are suppressed when level is Info", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "test.jsonl";

  const logger = new Logger("test", makeOptions({
    level: LogLevel.Info,
    logDir: tmpDir,
    logFile,
  }));

  logger.debug("this should not appear");
  logger.info("this should appear");

  await Bun.sleep(50);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record.level).toBe("info");
  expect(record.message).toBe("this should appear");

  await rm(tmpDir, { recursive: true });
});

test("only fatal messages are logged when level is Fatal", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "test.jsonl";

  const logger = new Logger("test", makeOptions({
    level: LogLevel.Fatal,
    logDir: tmpDir,
    logFile,
  }));

  logger.debug("debug");
  logger.info("info");
  logger.warn("warn");
  logger.error("error");
  logger.fatal("fatal");

  await Bun.sleep(50);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record.level).toBe("fatal");

  await rm(tmpDir, { recursive: true });
});

test("all levels are logged when level is Debug", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "test.jsonl";

  const logger = new Logger("test", makeOptions({ logDir: tmpDir, logFile }));

  logger.debug("debug");
  logger.info("info");
  logger.warn("warn");
  logger.error("error");
  logger.fatal("fatal");

  await Bun.sleep(50);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  expect(lines).toHaveLength(5);

  await rm(tmpDir, { recursive: true });
});

// ─── 模块名测试 ───────────────────────────────────────────────────────────────

test("createLogger creates logger with correct module name", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "test.jsonl";

  initLogger({ level: LogLevel.Debug, logDir: tmpDir, logFile, silent: true });
  const logger = createLogger("my-module");

  logger.info("hello from module");

  await Bun.sleep(50);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const record = JSON.parse(content.trim());
  expect(record.module).toBe("my-module");

  await rm(tmpDir, { recursive: true });
});

test("multiple loggers can have different module names", async () => {
  const tmpDir = await makeTempDir();
  const logFileA = "moduleA.jsonl";
  const logFileB = "moduleB.jsonl";

  const loggerA = new Logger("moduleA", makeOptions({ logDir: tmpDir, logFile: logFileA }));
  const loggerB = new Logger("moduleB", makeOptions({ logDir: tmpDir, logFile: logFileB }));

  loggerA.info("from A");
  loggerB.info("from B");

  await Bun.sleep(50);

  const contentA = await readFile(join(tmpDir, logFileA), "utf-8");
  const contentB = await readFile(join(tmpDir, logFileB), "utf-8");

  expect(JSON.parse(contentA.trim()).module).toBe("moduleA");
  expect(JSON.parse(contentB.trim()).module).toBe("moduleB");

  await rm(tmpDir, { recursive: true });
});

// ─── 日志格式测试 ─────────────────────────────────────────────────────────────

test("JSON log record contains all required fields", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "test.jsonl";

  const logger = new Logger("runner", makeOptions({ logDir: tmpDir, logFile }));
  const before = new Date();
  logger.info("Starting workflow", { key: "value" });
  const after = new Date();

  await Bun.sleep(50);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const record = JSON.parse(content.trim());

  expect(record).toHaveProperty("timestamp");
  expect(record).toHaveProperty("level", "info");
  expect(record).toHaveProperty("module", "runner");
  expect(record).toHaveProperty("message", "Starting workflow");
  expect(record).toHaveProperty("data", { key: "value" });

  const ts = new Date(record.timestamp as string);
  expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());

  await rm(tmpDir, { recursive: true });
});

test("JSON log record data defaults to empty object when not provided", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "test.jsonl";

  const logger = new Logger("runner", makeOptions({ logDir: tmpDir, logFile }));
  logger.info("no data");

  await Bun.sleep(50);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const record = JSON.parse(content.trim());
  expect(record.data).toEqual({});

  await rm(tmpDir, { recursive: true });
});

test("multiple log entries are written as separate JSON Lines", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "test.jsonl";

  const logger = new Logger("test", makeOptions({ logDir: tmpDir, logFile }));
  logger.info("line 1");
  logger.warn("line 2");
  logger.error("line 3");

  await Bun.sleep(100);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  expect(lines).toHaveLength(3);

  const r1 = JSON.parse(lines[0]!);
  const r2 = JSON.parse(lines[1]!);
  const r3 = JSON.parse(lines[2]!);

  expect(r1.message).toBe("line 1");
  expect(r2.message).toBe("line 2");
  expect(r3.message).toBe("line 3");

  await rm(tmpDir, { recursive: true });
});

// ─── 表格输出测试 ─────────────────────────────────────────────────────────────

test("table method produces valid box-drawing output", () => {
  const outputs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data: string | Uint8Array) => {
    outputs.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return true;
  };

  const logger = new Logger("test", makeOptions({ silent: false }));
  logger.table(["Story", "Status", "Retries"], [
    ["S-001", "done", "0"],
    ["S-002", "review", "1"],
  ]);

  process.stdout.write = originalWrite;

  const output = outputs.join("");
  expect(output).toContain("┌");
  expect(output).toContain("┐");
  expect(output).toContain("└");
  expect(output).toContain("┘");
  expect(output).toContain("│");
  expect(output).toContain("Story");
  expect(output).toContain("Status");
  expect(output).toContain("Retries");
  expect(output).toContain("S-001");
  expect(output).toContain("S-002");
  expect(output).toContain("done");
  expect(output).toContain("review");
});

test("table with single row renders correctly", () => {
  const outputs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data: string | Uint8Array) => {
    outputs.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return true;
  };

  const logger = new Logger("test", makeOptions({ silent: false }));
  logger.table(["Name", "Value"], [["foo", "bar"]]);

  process.stdout.write = originalWrite;

  const output = outputs.join("");
  expect(output).toContain("Name");
  expect(output).toContain("foo");
  expect(output).toContain("bar");
});

// ─── 静默模式测试 ─────────────────────────────────────────────────────────────

test("silent mode suppresses terminal output", () => {
  const outputs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data: string | Uint8Array) => {
    outputs.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return true;
  };

  const logger = new Logger("test", makeOptions({ silent: true }));
  logger.info("this should not go to terminal");
  logger.warn("this either");

  process.stdout.write = originalWrite;
  expect(outputs).toHaveLength(0);
});

test("silent mode suppresses table terminal output", () => {
  const outputs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data: string | Uint8Array) => {
    outputs.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return true;
  };

  const logger = new Logger("test", makeOptions({ silent: true }));
  logger.table(["A", "B"], [["1", "2"]]);

  process.stdout.write = originalWrite;
  expect(outputs).toHaveLength(0);
});

test("non-silent mode writes to terminal", () => {
  const outputs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data: string | Uint8Array) => {
    outputs.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return true;
  };

  const tmpOpts = makeOptions({ silent: false, logDir: "/tmp/autobmad-test-nosync" });
  const logger = new Logger("test", tmpOpts);
  logger.info("terminal message");

  process.stdout.write = originalWrite;

  const combined = outputs.join("");
  expect(combined).toContain("terminal message");
  expect(combined).toContain("test");
});

// ─── 日志目录懒创建测试 ────────────────────────────────────────────────────────

test("log directory is created lazily on first write", async () => {
  const tmpDir = await makeTempDir();
  const nestedDir = join(tmpDir, "nested", "dir");
  const logFile = "test.jsonl";

  const logger = new Logger("test", makeOptions({ logDir: nestedDir, logFile }));

  const { existsSync } = await import("node:fs");
  expect(existsSync(nestedDir)).toBe(false);

  logger.info("trigger creation");
  await Bun.sleep(100);

  expect(existsSync(nestedDir)).toBe(true);

  await rm(tmpDir, { recursive: true });
});

// ─── initLogger + createLogger 集成测试 ──────────────────────────────────────

test("initLogger sets global options used by createLogger", async () => {
  const tmpDir = await makeTempDir();
  const logFile = "global-test.jsonl";

  initLogger({ level: LogLevel.Warn, logDir: tmpDir, logFile, silent: true });
  const logger = createLogger("global-test");

  logger.debug("filtered out");
  logger.info("also filtered");
  logger.warn("this passes");

  await Bun.sleep(50);

  const content = await readFile(join(tmpDir, logFile), "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).message).toBe("this passes");

  await rm(tmpDir, { recursive: true });
});
