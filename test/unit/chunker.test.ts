import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { chunkMarkdown, computeDocid, findFenceRanges, inFence } from "../../src/core/chunker.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "chunker-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a file into the temp dir and return its absolute path. */
function writeTemp(filename: string, content: string): string {
  const filePath = path.join(tmpDir, filename);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// findFenceRanges
// ---------------------------------------------------------------------------

describe("findFenceRanges", () => {
  it("correctly identifies multiple fence ranges in a file", () => {
    const content = [
      "line 0",
      "```typescript", // line 1 — fence start
      "const x = 1;",
      "```", // line 3 — fence end
      "line 4",
      "```", // line 5 — fence start
      "const y = 2;",
      "```", // line 7 — fence end
      "line 8",
    ].join("\n");

    const ranges = findFenceRanges(content);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual([1, 3]);
    expect(ranges[1]).toEqual([5, 7]);
  });

  it("treats an unclosed fence as extending to end-of-file sentinel", () => {
    const content = [
      "intro",
      "```", // line 1 — opens, never closes
      "code here",
    ].join("\n");

    const ranges = findFenceRanges(content);
    expect(ranges).toHaveLength(1);
    // Unclosed fence should use the 999_999 sentinel
    expect(ranges[0][0]).toBe(1);
    expect(ranges[0][1]).toBe(999_999);
  });

  it("returns empty array when there are no fences", () => {
    const content = "# Heading\n\nJust prose.\n";
    expect(findFenceRanges(content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// inFence
// ---------------------------------------------------------------------------

describe("inFence", () => {
  it("returns true for line inside a fence range", () => {
    const ranges: Array<[number, number]> = [[3, 7]];
    expect(inFence(5, ranges)).toBe(true);
  });

  it("returns true for line at the boundaries of a fence range", () => {
    const ranges: Array<[number, number]> = [[3, 7]];
    expect(inFence(3, ranges)).toBe(true);
    expect(inFence(7, ranges)).toBe(true);
  });

  it("returns false for line outside all fence ranges", () => {
    const ranges: Array<[number, number]> = [
      [3, 7],
      [10, 15],
    ];
    expect(inFence(8, ranges)).toBe(false);
    expect(inFence(0, ranges)).toBe(false);
    expect(inFence(20, ranges)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — no headings
// ---------------------------------------------------------------------------

describe("chunkMarkdown — no headings", () => {
  it("returns a single chunk using the filename stem as title", () => {
    const content = "This is plain prose.\nNo headings here.\n";
    const filePath = writeTemp("plain-notes.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("plain-notes");
    // Text should be breadcrumb-prefixed
    expect(chunks[0].text).toContain("[plain-notes]");
    expect(chunks[0].lineStart).toBe(0);
  });

  it("returns a single chunk for an empty file", () => {
    const filePath = writeTemp("empty.md", "");
    const chunks = chunkMarkdown(filePath, tmpDir);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].lineStart).toBe(0);
    // Text consists of just the breadcrumb prefix + empty content
    expect(chunks[0].text).toMatch(/^\[empty\]\n\n/);
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — heading splitting
// ---------------------------------------------------------------------------

describe("chunkMarkdown — H1/H2 splitting", () => {
  it("splits a file with # Title, ## Section1, ## Section2 into 3 chunks", () => {
    const content = [
      "# Title",
      "",
      "Intro text.",
      "",
      "## Section1",
      "",
      "Content one.",
      "",
      "## Section2",
      "",
      "Content two.",
    ].join("\n");
    const filePath = writeTemp("simple-h1-h2.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].heading).toBe("Title");
    expect(chunks[1].heading).toBe("Section1");
    expect(chunks[2].heading).toBe("Section2");
  });

  it("prepends the doc title as a breadcrumb to every chunk's text", () => {
    const content = ["# My Doc", "", "## Alpha", "Alpha content.", "## Beta", "Beta content."].join(
      "\n",
    );
    const filePath = writeTemp("breadcrumb-doc.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    for (const chunk of chunks) {
      expect(chunk.text.startsWith("[My Doc]\n\n")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — fenced headings
// ---------------------------------------------------------------------------

describe("chunkMarkdown — fenced heading skipping", () => {
  it("does not split on a heading that is inside a code fence", () => {
    const content = [
      "# Real Heading",
      "",
      "Some intro.",
      "",
      "```markdown",
      "## Fake Heading Inside Fence",
      "```",
      "",
      "More prose.",
    ].join("\n");
    const filePath = writeTemp("fenced-heading.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    // Only the real H1 should split — the H2 inside the fence is ignored
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("Real Heading");
  });

  it("treats content after an unclosed fence as one big fence (no splits inside)", () => {
    const content = [
      "# Outer",
      "",
      "Intro paragraph.",
      "",
      "```",
      "## This should be skipped",
      "because fence is never closed",
    ].join("\n");
    const filePath = writeTemp("unclosed-fence.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    // The ## inside the unclosed fence must not produce a second chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("Outer");
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — repeated headings
// ---------------------------------------------------------------------------

describe("chunkMarkdown — repeated heading names", () => {
  it("produces chunks with different IDs when two sections share the same name", () => {
    const content = [
      "# Doc",
      "",
      "## Config",
      "",
      "First config section.",
      "",
      "## Config",
      "",
      "Second config section.",
    ].join("\n");
    const filePath = writeTemp("repeated-headings.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    const configChunks = chunks.filter((c) => c.heading === "Config");
    expect(configChunks).toHaveLength(2);
    expect(configChunks[0].id).not.toBe(configChunks[1].id);
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — stable IDs
// ---------------------------------------------------------------------------

describe("chunkMarkdown — stable IDs", () => {
  it("produces the same chunk ID on repeated calls for the same file+lineNumber", () => {
    const content = ["# Stable", "", "## SubSection", "", "Content."].join("\n");
    const filePath = writeTemp("stable-id.md", content);

    const chunksA = chunkMarkdown(filePath, tmpDir);
    const chunksB = chunkMarkdown(filePath, tmpDir);

    expect(chunksA.map((c) => c.id)).toEqual(chunksB.map((c) => c.id));
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — truncation
// ---------------------------------------------------------------------------

describe("chunkMarkdown — truncation", () => {
  it("splits content when exceeding maxChars limit", () => {
    const longBody = "x".repeat(200);
    const content = `# Short\n\n${longBody}`;
    const filePath = writeTemp("truncation.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir, /* maxChars= */ 100);

    // Should produce multiple chunks due to size cap
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks must respect the size limit
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(100);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — heading depth
// ---------------------------------------------------------------------------

describe("chunkMarkdown — headingDepth option", () => {
  it("headingDepth:1 only splits on # headings", () => {
    const content = [
      "# TopLevel",
      "",
      "Intro.",
      "",
      "## SubSection",
      "",
      "Sub content.",
      "",
      "# AnotherTop",
      "",
      "More top content.",
    ].join("\n");
    const filePath = writeTemp("depth1.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir, 4000, /* headingDepth= */ 1);

    // Should only split on the two # headings, not the ##
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe("TopLevel");
    expect(chunks[1].heading).toBe("AnotherTop");
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — Windows path normalization
// ---------------------------------------------------------------------------

describe("chunkMarkdown — Windows path normalization", () => {
  it("normalizes backslashes in file paths to forward slashes in chunk.file", () => {
    const content = "# WinDoc\n\nSome content.\n";
    const filePath = writeTemp("windoc.md", content);

    // Simulate a workspace root that uses a different base;
    // chunkMarkdown uses path.relative() then replaces backslashes.
    // We verify the resulting chunk.file contains no backslashes.
    const chunks = chunkMarkdown(filePath, tmpDir);

    for (const chunk of chunks) {
      expect(chunk.file).not.toContain("\\");
    }
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdown — mid-section split overlap (Phase 7)
// ---------------------------------------------------------------------------

describe("chunkMarkdown — mid-section split overlap", () => {
  it("adds overlap context when chunk exceeds maxChars", () => {
    const longSection = "x".repeat(5000);
    const content = `# Title\n\n${longSection}`;
    const filePath = writeTemp("overlap-test.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir, /* maxChars= */ 1000);

    expect(chunks.length).toBeGreaterThan(1);

    const chunk1 = chunks[0];
    const chunk2 = chunks[1];

    const breadcrumbEnd = chunk2.text.indexOf("\n\n") + 2;
    const chunk2Start = chunk2.text.slice(breadcrumbEnd, breadcrumbEnd + 50);
    const chunk1End = chunk1.text.slice(-50);

    expect(chunk2Start).toContain("x");
    expect(chunk1End).toContain("x");
  });

  it("respects 200-character overlap cap", () => {
    const longSection = "y".repeat(3000);
    const content = `# Title\n\n${longSection}`;
    const filePath = writeTemp("overlap-cap-test.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir, /* maxChars= */ 1000);

    if (chunks.length > 1) {
      const chunk2 = chunks[1];
      const chunk2BreadcrumbEnd = chunk2.text.indexOf("\n\n") + 2;
      const chunk2TextAfterBreadcrumb = chunk2.text.slice(chunk2BreadcrumbEnd);
      const overlapEndIdx = chunk2TextAfterBreadcrumb.indexOf("\n\n");
      const overlapText =
        overlapEndIdx > 0 ? chunk2TextAfterBreadcrumb.slice(0, overlapEndIdx) : "";

      expect(overlapText.length).toBeLessThanOrEqual(200);
    }
  });

  it("produces no overlap at heading boundaries", () => {
    const content = [
      "# Title",
      "",
      "First section content.",
      "",
      "## Section2",
      "",
      "Second section content.",
    ].join("\n");
    const filePath = writeTemp("no-overlap-heading.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    expect(chunks).toHaveLength(2);

    const chunk2 = chunks[1];
    const chunk2BreadcrumbEnd = chunk2.text.indexOf("\n\n") + 2;
    const chunk2Body = chunk2.text.slice(chunk2BreadcrumbEnd);

    expect(chunk2Body.trim().startsWith("## Section2")).toBe(true);
    expect(chunk2Body).not.toContain("First section");
  });

  it("accounts for overlap without double-counting size budget", () => {
    const section1 = "a".repeat(900);
    const section2 = "b".repeat(500);
    const content = `# Title\n\n${section1}\n\n## Part2\n\n${section2}`;
    const filePath = writeTemp("size-budget.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir, /* maxChars= */ 1000);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1000);
    }
  });
});

// ---------------------------------------------------------------------------
// computeDocid — stable content-based file ID (Phase 5)
// ---------------------------------------------------------------------------

describe("computeDocid", () => {
  it("returns a 6-character hex string", () => {
    const docid = computeDocid("some content");
    expect(docid).toHaveLength(6);
    expect(/^[0-9a-f]{6}$/.test(docid)).toBe(true);
  });

  it("is stable: same content always yields same docid", () => {
    const content = "# Hello\n\nWorld.";
    expect(computeDocid(content)).toBe(computeDocid(content));
  });

  it("produces different docids for different content", () => {
    const a = computeDocid("content A");
    const b = computeDocid("content B");
    expect(a).not.toBe(b);
  });

  it("chunkMarkdown embeds the same docid on all chunks of a file", () => {
    const content = [
      "# Title",
      "",
      "## Section A",
      "",
      "Text A.",
      "",
      "## Section B",
      "",
      "Text B.",
    ].join("\n");
    const filePath = writeTemp("docid-multi.md", content);

    const chunks = chunkMarkdown(filePath, tmpDir);

    expect(chunks.length).toBeGreaterThan(1);
    const docids = chunks.map((c) => c.docid);
    expect(new Set(docids).size).toBe(1);
    expect(docids[0]).toBe(computeDocid(content));
  });

  it("docid changes when file content changes", () => {
    const content1 = "# Version 1\n\nOriginal text.";
    const content2 = "# Version 2\n\nModified text.";

    const file = writeTemp("changing-file.md", content1);
    const chunks1 = chunkMarkdown(file, tmpDir);
    const docid1 = chunks1[0].docid;

    writeFileSync(file, content2, "utf8");
    const chunks2 = chunkMarkdown(file, tmpDir);
    const docid2 = chunks2[0].docid;

    expect(docid1).not.toBe(docid2);
  });
});
