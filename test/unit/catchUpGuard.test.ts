import { describe, it, expect } from "vitest";
import {
  decideCatchUp,
  PAUSE_AFTER_UNFINISHED_RUNS,
  unfinishedRunsKey,
} from "../../src/extension/catchUpGuard.js";

const base = { staleCleared: false, count: 0, autoReindex: true, needsReindex: true };

describe("decideCatchUp", () => {
  it("runs the catch-up on a clean start", () => {
    expect(decideCatchUp(base)).toEqual({ run: true, warn: false, nextCount: 0 });
  });

  it("counts a stale lock but still runs the first time", () => {
    expect(decideCatchUp({ ...base, staleCleared: true })).toEqual({
      run: true,
      warn: false,
      nextCount: 1,
    });
  });

  it("pauses and warns when the second stale lock in a row is found", () => {
    expect(decideCatchUp({ ...base, staleCleared: true, count: 1 })).toEqual({
      run: false,
      warn: true,
      nextCount: 2,
    });
  });

  it("stays paused on later activations without a new stale lock", () => {
    expect(decideCatchUp({ ...base, count: 2 })).toEqual({ run: false, warn: true, nextCount: 2 });
    expect(decideCatchUp({ ...base, count: 5 })).toEqual({ run: false, warn: true, nextCount: 5 });
  });

  it("pauses exactly at the threshold, not one before", () => {
    expect(decideCatchUp({ ...base, count: PAUSE_AFTER_UNFINISHED_RUNS - 1 }).run).toBe(true);
    expect(decideCatchUp({ ...base, count: PAUSE_AFTER_UNFINISHED_RUNS }).run).toBe(false);
  });

  it("does nothing, and says nothing, when automatic indexing is off", () => {
    expect(decideCatchUp({ ...base, autoReindex: false, count: 3 })).toEqual({
      run: false,
      warn: false,
      nextCount: 3,
    });
  });

  it("still records a stale lock while automatic indexing is off", () => {
    expect(decideCatchUp({ ...base, autoReindex: false, staleCleared: true })).toMatchObject({
      nextCount: 1,
    });
  });

  it("resets the counter, with no warning, once the index is up to date", () => {
    expect(decideCatchUp({ ...base, needsReindex: false, count: 4, staleCleared: true })).toEqual({
      run: false,
      warn: false,
      nextCount: 0,
    });
  });
});

describe("unfinishedRunsKey", () => {
  it("is stable per workspace and differs between workspaces", () => {
    expect(unfinishedRunsKey("/a/project")).toBe(unfinishedRunsKey("/a/project"));
    expect(unfinishedRunsKey("/a/project")).not.toBe(unfinishedRunsKey("/b/project"));
  });

  it("does not leak the workspace path into the stored key", () => {
    expect(unfinishedRunsKey("/a/project")).not.toContain("project");
  });
});
