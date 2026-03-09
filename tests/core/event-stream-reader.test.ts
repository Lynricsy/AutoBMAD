import { describe, test, expect } from "bun:test";

import { EventStreamReader } from "../../src/core/event-stream-reader.js";

describe("EventStreamReader", () => {
  test("feed + drain returns complete lines", () => {
    const reader = new EventStreamReader();

    reader.feed("line1\nline2\n");

    expect(reader.drain()).toEqual(["line1", "line2"]);
  });

  test("combines partial lines across chunks", () => {
    const reader = new EventStreamReader();

    reader.feed("par");
    reader.feed("tial\ncomplete\n");

    expect(reader.drain()).toEqual(["partial", "complete"]);
  });

  test("keeps only the last maxLines entries", () => {
    const reader = new EventStreamReader({ maxLines: 3 });

    reader.feed("line1\nline2\nline3\nline4\nline5\n");

    expect(reader.drain()).toEqual(["line3", "line4", "line5"]);
  });

  test("drain clears buffered lines", () => {
    const reader = new EventStreamReader();

    reader.feed("line1\nline2\n");

    expect(reader.drain()).toEqual(["line1", "line2"]);
    expect(reader.drain()).toEqual([]);
  });

  test("empty input does not add lines", () => {
    const reader = new EventStreamReader();

    reader.feed("");

    expect(reader.drain()).toEqual([]);
  });

  test("getBufferSize counts complete lines only", () => {
    const reader = new EventStreamReader();

    reader.feed("line1\nline2\nline3\n");

    expect(reader.getBufferSize()).toBe(3);
  });

  test("drain preserves partial line for the next chunk", () => {
    const reader = new EventStreamReader();

    reader.feed("par");

    expect(reader.drain()).toEqual([]);

    reader.feed("tial\n");

    expect(reader.drain()).toEqual(["partial"]);
  });
});
