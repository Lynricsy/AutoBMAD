/**
 * 终端仪表板 — 使用 Unicode 方框绘制、ANSI 颜色和 Emoji 状态图标的 Sprint 进度可视化
 */

import type {
  AutoBMADConfig,
  SprintResult,
  StoryResult,
} from "../core/types.js";
import type { WorkflowType } from "../core/types.js";

// ─── ANSI 颜色代码 ─────────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
} as const;

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

/** 步骤显示信息 */
export interface StepDisplay {
  workflow: WorkflowType;
  status: "completed" | "running" | "pending";
}

// ─── 常量 ──────────────────────────────────────────────────────────────────────

/** 方框内部宽度（两侧 ║ 之间的字符数） */
const BOX_INNER_WIDTH = 54;

// ─── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 去除 ANSI 转义码，用于日志文件输出
 */
export function stripAnsi(text: string): string {
  const ESC = "\x1b";
  return text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

/**
 * 计算字符串的终端视觉宽度（处理 Emoji 双宽度和零宽度字符）
 */
function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const cp = char.codePointAt(0)!;
    // 变体选择符 VS16 — 零宽度
    if (cp === 0xfe0f) continue;
    // 补充平面字符（大部分 Emoji 如 🚀📁📝🔄📊💡）— 双宽度
    if (cp > 0xffff) {
      width += 2;
    } else if (
      (cp >= 0x2300 && cp <= 0x23ff) || // 杂项技术符号（⏱ 等）
      (cp >= 0x2600 && cp <= 0x27bf) || // 杂项符号（✅❌⚠ 等）
      (cp >= 0x2b00 && cp <= 0x2bff) // 杂项符号与箭头（⬜ 等）
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function boxTop(): string {
  return "╔" + "═".repeat(BOX_INNER_WIDTH) + "╗";
}

function boxBottom(): string {
  return "╚" + "═".repeat(BOX_INNER_WIDTH) + "╝";
}

function boxLine(content: string): string {
  const stripped = stripAnsi(content);
  const vw = visualWidth(stripped);
  const pad = Math.max(0, BOX_INNER_WIDTH - vw);
  return "║" + content + " ".repeat(pad) + "║";
}

function boxEmpty(): string {
  return "║" + " ".repeat(BOX_INNER_WIDTH) + "║";
}

/**
 * 格式化持续时间（毫秒 → 人类可读字符串）
 *
 * @example formatDuration(500)     → "0s"
 * @example formatDuration(45000)   → "45s"
 * @example formatDuration(125000)  → "2m 5s"
 * @example formatDuration(5025000) → "1h 23m 45s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [`${hours}h`];
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

// ─── 渲染函数 ──────────────────────────────────────────────────────────────────

/**
 * 渲染 Sprint 启动横幅
 */
export function renderSprintBanner(
  config: AutoBMADConfig,
  storyCount: number,
): void {
  const title = `  ${ANSI.bold}${ANSI.cyan}🚀 AutoBMAD Sprint Runner${ANSI.reset}`;
  const lines = [
    boxTop(),
    boxLine(title),
    boxEmpty(),
    boxLine(`  📁 Project:     ${config.projectDir}`),
    boxLine(`  📝 Stories:     ${storyCount}`),
    boxLine(`  🔄 Max Retries: ${config.maxRetries}`),
    boxLine(`  ⏱️  Timeout:     ${config.timeout}s`),
    boxBottom(),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * 渲染故事进度（含步骤状态图标）
 */
export function renderStoryProgress(
  storyKey: string,
  storyIndex: number,
  totalStories: number,
  steps: StepDisplay[],
): void {
  const header = `━━━ Story ${storyKey} (${storyIndex}/${totalStories}) ━━━`;
  const stepLines = steps.map((step) => {
    const icon =
      step.status === "completed"
        ? "✅"
        : step.status === "running"
          ? "⏳"
          : "⬜";
    const suffix =
      step.status === "completed"
        ? " — completed"
        : step.status === "running"
          ? " — running..."
          : " — pending";
    return `  ${icon} ${step.workflow}${suffix}`;
  });
  const output = [header, ...stepLines].join("\n");
  process.stdout.write(output + "\n");
}

/**
 * 渲染代码审查修复循环重试指示器
 */
export function renderFixLoop(
  _storyKey: string,
  attempt: number,
  maxRetries: number,
): void {
  const line = `  ${ANSI.yellow}⚠️  code-review found issues — retry ${attempt}/${maxRetries}${ANSI.reset}`;
  process.stdout.write(line + "\n");
}

/**
 * 渲染 Sprint 完成摘要
 */
export function renderSprintSummary(
  result: SprintResult,
  durationMs: number,
): void {
  const title = `  ${ANSI.bold}${ANSI.cyan}📊 Sprint Complete${ANSI.reset}`;
  const lines = [
    boxTop(),
    boxLine(title),
    boxEmpty(),
    boxLine(`  ✅ Completed:  ${result.completed}`),
    boxLine(`  ⚠️  Needs Help: ${result.skipped}`),
    boxLine(`  ❌ Failed:     ${result.failed}`),
    boxEmpty(),
    boxLine(`  ⏱️  Duration:   ${formatDuration(durationMs)}`),
    boxBottom(),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * 渲染错误信息（Sprint 暂停时显示）
 */
export function renderError(
  storyKey: string,
  workflow: WorkflowType,
  error: string,
): void {
  const lines = [
    `  ${ANSI.red}❌ Error in story ${storyKey} during ${workflow}${ANSI.reset}`,
    `     Error: ${error}`,
    "",
    `  💡 Resume with: autobmad resume --dir /path/to/project`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * 渲染单个故事完成状态
 */
export function renderStoryComplete(
  storyKey: string,
  result: StoryResult,
): void {
  const duration = formatDuration(result.durationMs);
  if (result.success) {
    process.stdout.write(
      `  ✅ Story ${storyKey} — done (${result.retries} retries, ${duration})\n`,
    );
  } else {
    process.stdout.write(
      `  ⚠️  Story ${storyKey} — needs-human-intervention (${result.retries} retries, ${duration})\n`,
    );
  }
}
