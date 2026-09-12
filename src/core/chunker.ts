/**
 * Markdown heading-aware chunker.
 * Ported from scripts/mcp/indexer.py — _find_fence_ranges, _in_fence, _chunk_markdown.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DocChunk } from "./types.js";

/**
 * Find line-number ranges (inclusive) that are inside code fences.
 * Unclosed fences are treated as extending to the end of the file.
 */
export function findFenceRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let inFence = false;
  let fenceStart = 0;
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) {
      if (inFence) {
        ranges.push([fenceStart, i]);
        inFence = false;
      } else {
        fenceStart = i;
        inFence = true;
      }
    }
  }

  if (inFence) {
    ranges.push([fenceStart, 999_999]);
  }

  return ranges;
}

/**
 * Check if a given line number falls inside any code fence range.
 */
export function inFence(lineNum: number, fenceRanges: Array<[number, number]>): boolean {
  return fenceRanges.some(([start, end]) => lineNum >= start && lineNum <= end);
}

/**
 * Compute a stable docid for a file's content.
 * Returns the first 6 chars of the SHA-256 hex digest of the content.
 */
export function computeDocid(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6);
}

/**
 * Character ranges `[start, end)` of blocks a mid-section split must not land
 * inside: fenced code (``` … ```) and pipe tables (consecutive lines whose
 * first non-blank character is `|`). `end` is the end of the block's last
 * line, excluding its newline. An unclosed fence runs to the end of the text.
 */
export function findProtectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = text.split("\n");
  let offset = 0;
  let fenceStart = -1;
  let tableStart = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    const lineEnd = offset + line.length;

    if (fenceStart >= 0) {
      if (trimmed.startsWith("```")) {
        ranges.push([fenceStart, lineEnd]);
        fenceStart = -1;
      }
    } else if (trimmed.startsWith("```")) {
      if (tableStart >= 0) {
        ranges.push([tableStart, offset - 1]);
        tableStart = -1;
      }
      fenceStart = offset;
    } else if (trimmed.startsWith("|")) {
      if (tableStart < 0) tableStart = offset;
    } else if (tableStart >= 0) {
      ranges.push([tableStart, offset - 1]);
      tableStart = -1;
    }

    offset = lineEnd + 1;
  }

  if (fenceStart >= 0) ranges.push([fenceStart, text.length]);
  if (tableStart >= 0) ranges.push([tableStart, text.length]);
  return ranges;
}

/** Separator between breadcrumb segments. */
export const BREADCRUMB_SEPARATOR = " › ";

/** Longest breadcrumb worth spending chunk budget on. */
const MAX_BREADCRUMB_CHARS = 200;

/**
 * Build the `[path › H1 › H2]` prefix that places a chunk in its corpus.
 * Empty heading segments are skipped, so an H2 with no preceding H1 gets
 * `[path › H2]` and a headingless file gets `[path]`.
 */
export function buildBreadcrumb(file: string, ...headings: Array<string | undefined>): string {
  const parts = [file, ...headings.filter((h): h is string => typeof h === "string" && h !== "")];
  let crumb = parts.join(BREADCRUMB_SEPARATOR);
  if (crumb.length > MAX_BREADCRUMB_CHARS) {
    crumb = `${crumb.slice(0, MAX_BREADCRUMB_CHARS - 1)}…`;
  }
  return `[${crumb}]`;
}

/** Overlap carried from a chunk into its mid-section successor: 15 %, capped. */
const OVERLAP_RATIO = 0.15;
const OVERLAP_CAP_CHARS = 200;

/**
 * Least section text a split chunk must consume. Only matters when a
 * breadcrumb plus overlap is wider than a (pathologically small) maxChars;
 * without it the loop would stall or slice from the wrong end.
 */
const MIN_SPLIT_PROGRESS = 32;

/** Start of the protected block that strictly contains `pos`, if any. */
function protectedBlockStart(ranges: Array<[number, number]>, pos: number): number | undefined {
  for (const [start, end] of ranges) {
    if (start < pos && pos < end) return start;
  }
  return undefined;
}

/**
 * Split one section into chunk texts of at most `maxChars`, each prefixed
 * with `breadcrumb` (which ends in a blank line). Mid-section splits carry
 * an overlap of the previous chunk's tail, and never land inside a code
 * fence or a table: the cut moves back to the block's first line so the
 * block starts the next chunk intact. A block longer than the budget cannot
 * fit any chunk and is hard-cut.
 *
 * WHY move the cut back rather than stretch the chunk to the block's end:
 * the budget exists because the model truncates silently past its window,
 * so a chunk stretched over a fence would lose exactly that fence's tail.
 */
function splitSection(sectionText: string, breadcrumb: string, maxChars: number): string[] {
  const protectedRanges = findProtectedRanges(sectionText);
  const texts: string[] = [];
  let consumed = 0;
  let prevBody = "";

  for (;;) {
    const remaining = sectionText.slice(consumed);
    let head = breadcrumb;
    if (texts.length > 0) {
      const overlapSize = Math.min(Math.ceil(prevBody.length * OVERLAP_RATIO), OVERLAP_CAP_CHARS);
      head += `${prevBody.slice(-overlapSize)}\n\n`;
    }

    const budget = maxChars - head.length;
    if (remaining.length <= budget) {
      texts.push(head + remaining);
      break;
    }

    let cut: number;
    if (budget < MIN_SPLIT_PROGRESS) {
      cut = MIN_SPLIT_PROGRESS;
    } else {
      cut = budget;
      const blockStart = protectedBlockStart(protectedRanges, consumed + cut);
      if (blockStart !== undefined && blockStart > consumed) {
        cut = blockStart - consumed;
      }
    }
    cut = Math.min(cut, remaining.length);

    const text = head + remaining.slice(0, cut);
    texts.push(text);
    prevBody = text.slice(breadcrumb.length);
    consumed += cut;
    if (consumed >= sectionText.length) break;
  }

  return texts;
}

/** Heading level from the raw `#…` line, and its text with the marker stripped. */
function parseHeading(raw: string): { level: number; title: string } {
  const hashes = raw.match(/^#+/)?.[0].length ?? 0;
  return { level: hashes, title: raw.replace(/^#+\s+/, "").trim() };
}

/**
 * Split a markdown file into chunks on heading boundaries.
 *
 * - Skips headings inside code fences
 * - Prepends a `[path › H1 › H2]` breadcrumb so every chunk embeds with its
 *   place in the corpus, not just its own words
 * - Uses stable IDs based on md5(file:lineNumber:splitIndex)
 * - Splits sections that exceed maxChars, adding 15% (cap 200 chars) overlap
 *   context between mid-section splits, never cutting a code fence or table
 * - All chunks share the same docid (SHA-256 of file content, first 6 chars)
 *
 * When `fileKey` is provided it is used verbatim as the chunk `file` key
 * (e.g. an `ext://<root>/<rel>` external-root key); the caller is then
 * responsible for having validated containment. Without it, the key is the
 * workspace-relative path and must stay inside the workspace.
 */
export function chunkMarkdown(
  absolutePath: string,
  workspaceRoot: string,
  maxChars = 4000,
  headingDepth: 1 | 2 = 2,
  fileKey?: string,
): DocChunk[] {
  const content = readFileSync(absolutePath, "utf8");
  const rel = fileKey ?? path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");

  // Path traversal validation (workspace-relative keys only; an explicit
  // fileKey was containment-checked by the caller against its own root)
  if (fileKey === undefined && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`Path traversal blocked: ${absolutePath} is outside workspace`);
  }

  // Stable content-based docid shared by all chunks from this file
  const docid = computeDocid(content);

  // Build fence ranges to skip headings inside code blocks
  const fenceRanges = findFenceRanges(content);

  // Build heading pattern based on depth
  const pattern = headingDepth === 1 ? /^(#\s+.+)$/gm : /^(#{1,2}\s+.+)$/gm;

  // Find heading positions, skipping those inside code fences
  const positions: Array<{ offset: number; heading: string; lineNum: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const lineNum = content.slice(0, match.index).split("\n").length - 1;
    if (!inFence(lineNum, fenceRanges)) {
      positions.push({
        offset: match.index,
        heading: match[0],
        lineNum,
      });
    }
  }

  // No headings — the whole file is one section, titled by its filename stem
  if (positions.length === 0) {
    const baseId = createHash("md5").update(rel).digest("hex").slice(0, 12);
    const texts = splitSection(content, `${buildBreadcrumb(rel)}\n\n`, maxChars);
    return texts.map((text, splitIndex) => ({
      id: `${baseId}-${splitIndex}`,
      text,
      file: rel,
      heading: path.parse(absolutePath).name,
      lineStart: 0,
      docid,
    }));
  }

  // Extract chunks between consecutive headings
  const chunks: DocChunk[] = [];
  let currentH1: string | undefined;

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].offset;
    const end = i + 1 < positions.length ? positions[i + 1].offset : content.length;
    const rawText = content.slice(start, end).trim();

    const { level, title } = parseHeading(positions[i].heading);
    if (level === 1) currentH1 = title;
    if (!rawText) continue;

    const breadcrumb =
      level === 1 ? buildBreadcrumb(rel, title) : buildBreadcrumb(rel, currentH1, title);
    const texts = splitSection(rawText, `${breadcrumb}\n\n`, maxChars);

    texts.forEach((text, splitIndex) => {
      const chunkId = createHash("md5")
        .update(`${rel}:${positions[i].lineNum}:${splitIndex}`)
        .digest("hex")
        .slice(0, 12);

      chunks.push({
        id: chunkId,
        text,
        file: rel,
        heading: title,
        lineStart: positions[i].lineNum,
        docid,
      });
    });
  }

  return chunks;
}
