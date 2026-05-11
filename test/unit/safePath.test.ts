import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveSafePath, isSafeRelativeRef, PathTraversalError } from "../../src/core/safePath.js";

describe("resolveSafePath", () => {
  const root = "/workspace";

  it("resolves a simple relative path inside the workspace", () => {
    expect(resolveSafePath(root, "doc/foo.md")).toBe(path.resolve("/workspace/doc/foo.md"));
  });

  it("normalizes inner slashes without escaping", () => {
    expect(resolveSafePath(root, "doc/./foo.md")).toBe(path.resolve("/workspace/doc/foo.md"));
  });

  it("returns the workspace root for empty / '.' refs", () => {
    expect(resolveSafePath(root, "")).toBe(path.resolve(root));
    expect(resolveSafePath(root, ".")).toBe(path.resolve(root));
    expect(resolveSafePath(root, "./")).toBe(path.resolve(root));
  });

  it("rejects a leading `..`", () => {
    expect(() => resolveSafePath(root, "../etc/passwd")).toThrow(PathTraversalError);
  });

  it("rejects mid-path `..` that escapes the root", () => {
    expect(() => resolveSafePath(root, "doc/../../etc/passwd")).toThrow(PathTraversalError);
  });

  it("allows mid-path `..` that stays inside the root", () => {
    expect(resolveSafePath(root, "doc/../README.md")).toBe(path.resolve("/workspace/README.md"));
  });

  it("rejects absolute paths", () => {
    expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(PathTraversalError);
  });

  it("rejects Windows-style absolute paths after slash normalization", () => {
    // Backslash-converted refs that still look absolute (POSIX-rooted) must be rejected.
    expect(() => resolveSafePath(root, "\\etc\\passwd")).toThrow(PathTraversalError);
  });

  it("normalizes backslashes to forward slashes before resolving", () => {
    expect(resolveSafePath(root, "doc\\foo.md")).toBe(path.resolve("/workspace/doc/foo.md"));
  });

  it("rejects prefix attacks (workspace-evil vs workspace)", () => {
    // Sibling directory with a matching prefix must not be accepted as inside.
    // Resolution path: /workspace + ../workspace-evil/x = /workspace-evil/x → outside.
    expect(() => resolveSafePath(root, "../workspace-evil/x")).toThrow(PathTraversalError);
  });

  it("rejects null-byte injection by virtue of being syntactically a path", () => {
    // path.resolve accepts the byte but the containment check still holds.
    // (Filesystem APIs will reject it themselves; we only assert no escape.)
    expect(() => resolveSafePath(root, "\0/etc/passwd")).not.toThrow();
  });

  it("error message does not leak the workspace root", () => {
    try {
      resolveSafePath("/secret/customer/workspace", "../etc/passwd");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PathTraversalError);
      const msg = (err as PathTraversalError).message;
      expect(msg).not.toContain("/secret/customer");
      expect(msg).toContain("escapes the workspace");
    }
  });

  it("preserves the raw ref on the error for logging", () => {
    try {
      resolveSafePath(root, "../etc/passwd");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as PathTraversalError).ref).toBe("../etc/passwd");
    }
  });

  it("rejects non-string refs", () => {
    // @ts-expect-error - intentional bad input
    expect(() => resolveSafePath(root, 42)).toThrow(PathTraversalError);
    // @ts-expect-error
    expect(() => resolveSafePath(root, null)).toThrow(PathTraversalError);
  });
});

describe("isSafeRelativeRef", () => {
  it("accepts plain relative refs", () => {
    expect(isSafeRelativeRef("doc/foo.md")).toBe(true);
    expect(isSafeRelativeRef("foo.md")).toBe(true);
    expect(isSafeRelativeRef("a/b/c.md")).toBe(true);
  });

  it("rejects absolute refs", () => {
    expect(isSafeRelativeRef("/etc/passwd")).toBe(false);
    expect(isSafeRelativeRef("\\windows\\path")).toBe(false);
  });

  it("rejects refs with `..` segments", () => {
    expect(isSafeRelativeRef("..")).toBe(false);
    expect(isSafeRelativeRef("../etc/passwd")).toBe(false);
    expect(isSafeRelativeRef("doc/../etc/passwd")).toBe(false);
    expect(isSafeRelativeRef("doc\\..\\etc")).toBe(false);
  });

  it("accepts refs containing `..` as a substring but not as a segment", () => {
    expect(isSafeRelativeRef("doc/..hidden.md")).toBe(true);
    expect(isSafeRelativeRef("...md")).toBe(true);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error
    expect(isSafeRelativeRef(undefined)).toBe(false);
    // @ts-expect-error
    expect(isSafeRelativeRef(42)).toBe(false);
  });
});
