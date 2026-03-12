import type { SummaryConfig } from "./types.js";
import { LLMClient } from "./llm-client.js";
import { EventStreamReader } from "./event-stream-reader.js";
import { createLogger } from "./logger.js";

const log = createLogger("summarizer");

export async function getGitDiff(dir: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "diff", "--stat", "--patch"], { cwd: dir });
    const text = await new Response(proc.stdout).text();
    return text;
  } catch (_e) {
    return "";
  }
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return "[...truncated...]\n" + text.slice(-maxChars);
}

export class ActivitySummarizer {
  private streamReader: EventStreamReader;
  private llmClient: LLMClient;
  private renderFn: (summary: string) => void;
  private intervalMs: number;
  private timer: Timer | null = null;
  private isSummarizing: boolean = false;
  private projectDir: string;
  private stopped: boolean = false;
  private gitDiffFn: (dir: string) => Promise<string>;

  constructor(config: {
    summaryConfig: SummaryConfig;
    projectDir: string;
    renderFn: (summary: string) => void;
    intervalMs?: number;
    llmClient?: LLMClient;
    streamReader?: EventStreamReader;
    gitDiffFn?: (dir: string) => Promise<string>;
  }) {
    this.intervalMs = config.intervalMs ?? 60000;
    this.renderFn = config.renderFn;
    this.projectDir = config.projectDir;
    this.streamReader = config.streamReader ?? new EventStreamReader();
    this.llmClient = config.llmClient ?? new LLMClient(config.summaryConfig);
    this.gitDiffFn = config.gitDiffFn ?? getGitDiff;
  }

  async start(): Promise<void> {
    log.debug("Initializing LLM client and starting summary timer", { intervalMs: this.intervalMs });
    this.llmClient.initialize();
    this.stopped = false;
    this.scheduleNext();
    log.debug("ActivitySummarizer started successfully");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  handleStderrChunk(chunk: string): void {
    this.streamReader.feed(chunk);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runSummary();
    }, this.intervalMs);
  }

  private async runSummary(): Promise<void> {
    if (this.isSummarizing || this.stopped) return;

    this.isSummarizing = true;

    try {
      const events = this.streamReader.drain();
      log.debug("runSummary triggered", { eventCount: events.length, stopped: this.stopped });
      if (events.length === 0) {
        log.debug("No stderr events accumulated, skipping summary");
        return;
      }

      const gitDiff = await this.gitDiffFn(this.projectDir);
      const truncatedEvents = truncate(events.join("\n"), 10000);
      const truncatedDiff = truncate(gitDiff, 10000);
      log.debug("Calling LLM for summary", { eventsChars: truncatedEvents.length, diffChars: truncatedDiff.length });
      const summary = await this.llmClient.generateSummary([truncatedEvents], truncatedDiff);
      log.debug("LLM summary received", { summaryLength: summary.length });
      this.renderFn(summary);
    } catch (err) {
      log.warn("runSummary failed silently", { error: String(err) });
    } finally {
      this.isSummarizing = false;
      this.scheduleNext();
    }
  }
}
