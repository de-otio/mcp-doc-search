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
 * Split a markdown file into chunks on heading boundaries.
 *
 * - Skips headings inside code fences
 * - Prepends [DocTitle] breadcrumb for embedding disambiguation
 * - Uses stable IDs based on md5(file:lineNumber)
 * - Splits sections that exceed maxChars, adding overlap context between splits
 * - Adds overlap context (up to 15% or 200 chars) when splitting mid-section
 */
export function chunkMarkdown(
  absolutePath: string,
  workspaceRoot: string,
  maxChars = 4000,
  headingDepth: 1 | 2 = 2,
): DocChunk[] {
  const content = readFileSync(absolutePath, "utf8");
  const rel = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");

  // Path traversal validation
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal blocked: ${absolutePath} is outside workspace`);
  }

  // Find the document title (first # heading, or filename stem)
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const docTitle = titleMatch ? titleMatch[1].trim() : path.parse(absolutePath).name;

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

  // No headings — treat the whole file as one chunk
  if (positions.length === 0) {
    const chunkId = createHash("md5").update(rel).digest("hex").slice(0, 12);
    const text = `[${docTitle}]\n\n${content}`.slice(0, maxChars);
    return [
      {
        id: `${chunkId}-0`,
        text,
        file: rel,
        heading: docTitle,
        lineStart: 0,
      },
    ];
  }

  // Helper to split a single section into multiple chunks if needed
  interface ChunkPart {
    text: string;
    heading: string;
    lineNum: number;
    splitIndex: number;
  }

  function splitSectionIntoChunks(
    sectionText: string,
    heading: string,
    lineNum: number,
  ): ChunkPart[] {
    const breadcrumb = `[${docTitle}]\n\n`;
    const chunks: ChunkPart[] = [];

    let remaining = sectionText;
    let splitIndex = 0;

    while (remaining.length > 0) {
      let fullText: string;

      if (splitIndex === 0) {
        // First chunk: prepend breadcrumb and heading
        fullText = `${breadcrumb}${remaining}`;
      } else {
        // Subsequent chunks: add overlap from the previous chunk
        const prevChunkBody = chunks[chunks.length - 1].text.slice(
          chunks[chunks.length - 1].text.indexOf("\n\n") + 2,
        );
        const overlapSize = Math.min(Math.ceil(prevChunkBody.length * 0.15), 200);
        const overlap = prevChunkBody.slice(-overlapSize);
        fullText = `${breadcrumb}${overlap}\n\n${remaining}`;
      }

      // Truncate to maxChars (overlap is not counted toward budget)
      const truncatedText = fullText.slice(0, maxChars);
      chunks.push({
        text: truncatedText,
        heading,
        lineNum,
        splitIndex,
      });

      // Calculate how much of the remaining text was consumed
      // The consumed text is everything after the breadcrumb+overlap
      let consumedFromRemaining: number;

      if (splitIndex === 0) {
        // First chunk: consumed = truncated - breadcrumb
        consumedFromRemaining = truncatedText.length - breadcrumb.length;
      } else {
        // Later chunks: consumed = truncated - breadcrumb - overlap - separator
        const prevChunkBody = chunks[chunks.length - 2].text.slice(
          chunks[chunks.length - 2].text.indexOf("\n\n") + 2,
        );
        const overlapSize = Math.min(Math.ceil(prevChunkBody.length * 0.15), 200);
        // -2 accounts for the "\n\n" separator between overlap and remaining text
        consumedFromRemaining = truncatedText.length - breadcrumb.length - overlapSize - 2;
      }

      // Stop if we consumed less than what we tried to add (reached end of text)
      if (consumedFromRemaining >= remaining.length) {
        break;
      }

      // Move forward in remaining text
      remaining = remaining.slice(consumedFromRemaining);
      splitIndex++;
    }

    return chunks;
  }

  // Extract chunks between consecutive headings
  const chunks: DocChunk[] = [];

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].offset;
    const end = i + 1 < positions.length ? positions[i + 1].offset : content.length;
    const rawText = content.slice(start, end).trim();

    if (!rawText) continue;

    // Split this section into chunks if needed
    const sectionChunks = splitSectionIntoChunks(
      rawText,
      positions[i].heading.replace(/^#+\s+/, ""),
      positions[i].lineNum,
    );

    // Generate stable IDs and add to chunks list
    for (const sectionChunk of sectionChunks) {
      const chunkId = createHash("md5")
        .update(`${rel}:${sectionChunk.lineNum}:${sectionChunk.splitIndex}`)
        .digest("hex")
        .slice(0, 12);

      chunks.push({
        id: chunkId,
        text: sectionChunk.text,
        file: rel,
        heading: sectionChunk.heading,
        lineStart: sectionChunk.lineNum,
      });
    }
  }

  return chunks;
}
