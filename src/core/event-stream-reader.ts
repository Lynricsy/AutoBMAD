/**
 * EventStreamReader — verbose stderr ストリームの行バッファリングリーダー
 *
 * OpenCode --verbose モードの stderr 出力を行ごとに蓄積し、
 * 定期的に drain() で一括取得するためのバッファ。
 */

export interface EventStreamReaderOptions {
  maxLines?: number; // rolling buffer capacity (default: 200)
}

export class EventStreamReader {
  private buffer: string[] = [];
  private partial: string = ""; // incomplete line carried across chunks
  private readonly maxLines: number;

  constructor(options?: EventStreamReaderOptions) {
    this.maxLines = options?.maxLines ?? 200;
  }

  /**
   * Feed a raw stderr chunk into the reader.
   * Splits by newline, handles partial lines across chunk boundaries.
   */
  feed(chunk: string): void {
    // Prepend any leftover partial line from previous chunk
    const data = this.partial + chunk;
    const lines = data.split("\n");

    // Last element is either empty (chunk ended with \n) or a partial line
    this.partial = lines.pop() ?? "";

    // Add complete lines to buffer
    for (const line of lines) {
      if (line.length > 0) {
        // skip empty lines
        this.buffer.push(line);
      }
    }

    // Enforce rolling buffer: keep only the last maxLines
    if (this.buffer.length > this.maxLines) {
      this.buffer = this.buffer.slice(-this.maxLines);
    }
  }

  /**
   * Drain all buffered lines and clear the buffer.
   * Returns the lines collected since last drain (or construction).
   */
  drain(): string[] {
    const events = [...this.buffer];
    this.buffer = [];
    // NOTE: do NOT clear partial — it belongs to the next chunk
    return events;
  }

  /**
   * Get current buffer size (number of complete lines stored).
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}
