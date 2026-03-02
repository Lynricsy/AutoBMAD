/**
 * 双通道日志系统 - 同时写入终端（彩色）和 JSON Lines 文件（结构化）
 */

// ─── 日志级别 ──────────────────────────────────────────────────────────────────

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
  Fatal = "fatal",
}

// 级别优先级映射（数字越大越严重）
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.Debug]: 0,
  [LogLevel.Info]: 1,
  [LogLevel.Warn]: 2,
  [LogLevel.Error]: 3,
  [LogLevel.Fatal]: 4,
};

// ─── ANSI 颜色代码 ─────────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  redBold: "\x1b[1;31m",
} as const;

// 每个级别对应的颜色
const LEVEL_COLOR: Record<LogLevel, string> = {
  [LogLevel.Debug]: ANSI.gray,
  [LogLevel.Info]: ANSI.cyan,
  [LogLevel.Warn]: ANSI.yellow,
  [LogLevel.Error]: ANSI.red,
  [LogLevel.Fatal]: ANSI.redBold,
};

// ─── 接口定义 ──────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  /** 最低日志级别，低于此级别的日志将被忽略 */
  level: LogLevel;
  /** 日志文件目录，默认 ".autobmad-logs" */
  logDir: string;
  /** 日志文件名，不设置则自动生成 run-{timestamp}.jsonl */
  logFile?: string;
  /** 静默模式 - 不输出到终端（测试时使用） */
  silent?: boolean;
}

/** JSON Lines 文件的单条记录结构 */
interface LogRecord {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data: Record<string, unknown>;
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 将当前时间格式化为 HH:MM:SS（本地时间）
 */
function formatTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 生成日志文件名（基于启动时间戳）
 */
function generateLogFileName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `run-${ts}.jsonl`;
}

// ─── Logger 类 ────────────────────────────────────────────────────────────────

export class Logger {
  private readonly logFilePath: string;
  private logDirCreated: boolean = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly module: string,
    private readonly options: LoggerOptions,
  ) {
    const fileName = options.logFile ?? generateLogFileName();
    this.logFilePath = `${options.logDir}/${fileName}`;
  }

  /** 是否处于静默模式（不输出到终端） */
  get silent(): boolean {
    return this.options.silent ?? false;
  }

  // ── 公共日志方法 ───────────────────────────────────────────────────────────

  debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Debug, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Info, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Warn, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Error, message, data);
  }

  fatal(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Fatal, message, data);
  }

  /**
   * 以 ASCII/Unicode 表格形式输出数据（如 Sprint 状态展示）
   */
  table(headers: string[], rows: string[][]): void {
    if (this.options.silent) return;

    // 计算每列最大宽度
    const colWidths = headers.map((h, i) => {
      const cellMax = rows.reduce((max, row) => {
        const cell = row[i] ?? "";
        return Math.max(max, cell.length);
      }, 0);
      return Math.max(h.length, cellMax);
    });

    const pad = (str: string, width: number) => str.padEnd(width, " ");
    const separator = (left: string, mid: string, right: string, fill: string) => {
      const cols = colWidths.map((w) => fill.repeat(w + 2));
      return left + cols.join(mid) + right;
    };

    const top = separator("┌", "┬", "┐", "─");
    const headSep = separator("├", "┼", "┤", "─");
    const bottom = separator("└", "┴", "┘", "─");

    const headerRow =
      "│ " + headers.map((h, i) => pad(h, colWidths[i]!)).join(" │ ") + " │";

    const dataRows = rows.map(
      (row) =>
        "│ " + headers.map((_, i) => pad(row[i] ?? "", colWidths[i]!)).join(" │ ") + " │",
    );

    const output = [top, headerRow, headSep, ...dataRows, bottom].join("\n");
    process.stdout.write(output + "\n");
  }

  // ── 私有核心方法 ───────────────────────────────────────────────────────────

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // 级别过滤
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.options.level]) return;

    const now = new Date();
    const resolvedData = data ?? {};

    // 写入终端
    if (!this.options.silent) {
      this.writeTerminal(level, message, now);
    }

    this.writeQueue = this.writeQueue
      .then(() => this.writeFile(level, message, resolvedData, now))
      .catch((err) => {
        process.stderr.write(`[Logger] Failed to write log file: ${String(err)}\n`);
      });
  }

  private writeTerminal(level: LogLevel, message: string, date: Date): void {
    const color = LEVEL_COLOR[level];
    const time = formatTime(date);
    const levelStr = level.toUpperCase().padEnd(5);
    const line = `${ANSI.gray}[${time}]${ANSI.reset} ${ANSI.gray}[${this.module}]${ANSI.reset} ${color}${levelStr}${ANSI.reset} ${message}\n`;
    process.stdout.write(line);
  }

  private async writeFile(
    level: LogLevel,
    message: string,
    data: Record<string, unknown>,
    date: Date,
  ): Promise<void> {
    // 懒创建日志目录（首次写入时）
    if (!this.logDirCreated) {
      await this.ensureLogDir();
      this.logDirCreated = true;
    }

    const record: LogRecord = {
      timestamp: date.toISOString(),
      level,
      module: this.module,
      message,
      data,
    };

    const line = JSON.stringify(record) + "\n";

    // 使用 Bun 文件 API 追加写入
    const file = Bun.file(this.logFilePath);
    let existing = "";
    try {
      existing = await file.text();
    } catch {
      // 文件不存在时从空内容开始
      existing = "";
    }
    await Bun.write(this.logFilePath, existing + line);
  }

  private async ensureLogDir(): Promise<void> {
    // 使用 Bun shell 创建目录
    await Bun.$`mkdir -p ${this.options.logDir}`.quiet();
  }
}

// ─── 全局工厂函数 ─────────────────────────────────────────────────────────────

/** 全局 Logger 配置（启动时设置一次） */
let globalOptions: LoggerOptions | null = null;

/**
 * 初始化全局 Logger 配置（在应用启动时调用一次）
 */
export function initLogger(options: Partial<LoggerOptions>): void {
  globalOptions = {
    level: options.level ?? LogLevel.Info,
    logDir: options.logDir ?? ".autobmad-logs",
    logFile: options.logFile,
    silent: options.silent ?? false,
  };
}

/**
 * 为指定模块创建 Logger 实例
 */
export function createLogger(module: string): Logger {
  if (!globalOptions) {
    // 未初始化时使用默认配置
    initLogger({});
  }
  return new Logger(module, globalOptions!);
}
