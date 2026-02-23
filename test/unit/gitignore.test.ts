import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ensureGitignored } from "../../src/core/gitignore.js";

vi.mock("node:fs");

describe("gitignore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create .gitignore if it does not exist", async () => {
    const readMock = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("ENOENT");
      });
    const appendMock = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

    ensureGitignored("/workspace", ".doc-search-index");

    expect(readMock).toHaveBeenCalledWith(
      path.join("/workspace", ".gitignore"),
      "utf8",
    );
    expect(appendMock).toHaveBeenCalledWith(
      path.join("/workspace", ".gitignore"),
      "/.doc-search-index\n",
    );
  });

  it("should append entry when .gitignore exists but does not contain the pattern", () => {
    const readMock = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValue("node_modules/\n");
    const appendMock = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

    ensureGitignored("/workspace", ".doc-search-index");

    expect(readMock).toHaveBeenCalled();
    expect(appendMock).toHaveBeenCalledWith(
      path.join("/workspace", ".gitignore"),
      "/.doc-search-index\n",
    );
  });

  it("should skip when entry already exists in .gitignore", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "node_modules/\n/.doc-search-index\n",
    );
    const appendMock = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

    ensureGitignored("/workspace", ".doc-search-index");

    expect(appendMock).not.toHaveBeenCalled();
  });

  it("should skip when pattern already covers the entry", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("**/.doc-search-index\n");
    const appendMock = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

    ensureGitignored("/workspace", ".doc-search-index");

    expect(appendMock).not.toHaveBeenCalled();
  });

  it("should handle relative paths correctly", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("");
    const appendMock = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

    ensureGitignored("/workspace", "dir/.doc-search-index");

    expect(appendMock).toHaveBeenCalledWith(
      path.join("/workspace", ".gitignore"),
      "/dir/.doc-search-index\n",
    );
  });
});
