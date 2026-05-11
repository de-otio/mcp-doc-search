import { describe, it, expect, vi } from "vitest";
import { sanitizeForClient, stripAbsolutePaths } from "../../src/mcp/errors.js";

describe("stripAbsolutePaths", () => {
  it("redacts POSIX absolute paths", () => {
    const msg = "ENOENT: no such file or directory, open '/Users/alice/repos/foo/bar.md'";
    const out = stripAbsolutePaths(msg);
    expect(out).not.toContain("/Users/alice");
    expect(out).toContain("<path>");
  });

  it("redacts Windows drive-letter paths", () => {
    expect(stripAbsolutePaths("Cannot find C:\\Users\\bob\\Documents\\foo.md")).toBe(
      "Cannot find <path>",
    );
    expect(stripAbsolutePaths("Cannot find C:/Users/bob/Documents/foo.md")).toBe(
      "Cannot find <path>",
    );
  });

  it("redacts UNC paths", () => {
    expect(stripAbsolutePaths("Read failed on \\\\share\\team\\docs\\f.md")).toBe(
      "Read failed on <path>",
    );
  });

  it("leaves relative paths alone", () => {
    expect(stripAbsolutePaths("File not found: doc/missing.md")).toBe(
      "File not found: doc/missing.md",
    );
    expect(stripAbsolutePaths("error in src/core/indexer.ts")).toBe("error in src/core/indexer.ts");
  });

  it("handles multiple paths in a single message", () => {
    const msg = "copy from /etc/foo to /tmp/bar failed";
    const out = stripAbsolutePaths(msg);
    expect(out).not.toMatch(/\/etc/);
    expect(out).not.toMatch(/\/tmp/);
    expect((out.match(/<path>/g) ?? []).length).toBe(2);
  });

  it("handles a path-only message", () => {
    expect(stripAbsolutePaths("/Users/alice/secret/project/file.md")).toBe("<path>");
  });
});

describe("sanitizeForClient", () => {
  it("logs the raw error to stderr and returns the sanitized message", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const out = sanitizeForClient(new Error("blew up at /Users/alice/repos/foo/bar.md"));
      expect(out).not.toContain("/Users/alice");

      const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain("/Users/alice/repos/foo/bar.md"); // raw for operator
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("handles non-Error throwables via String()", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(sanitizeForClient("plain string error")).toBe("plain string error");
      expect(sanitizeForClient({ toString: () => "/abs/path" })).toBe("<path>");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("prefixes the operator log with the context hint when supplied", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      sanitizeForClient(new Error("boom"), "reindex");
      const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain("reindex: boom");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
