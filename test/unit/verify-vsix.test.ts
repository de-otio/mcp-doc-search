import { describe, expect, it } from "vitest";
import { MAX_MB, parseUnzipListing, verifyEntries } from "../../scripts/verify-vsix.mjs";

const GOOD = [
  "extension/package.json",
  "extension/dist/extension.js",
  "extension/dist/mcp-server.js",
  "extension/node_modules/@huggingface/transformers/dist/transformers.node.cjs",
  "extension/node_modules/@lancedb/lancedb/dist/index.js",
  "extension/node_modules/",
];

describe("verifyEntries", () => {
  it("passes a clean archive", () => {
    expect(verifyEntries(GOOD, 40)).toEqual([]);
  });

  it("reports a missing required bundle", () => {
    const entries = GOOD.filter((e) => e !== "extension/dist/mcp-server.js");
    expect(verifyEntries(entries, 40)).toEqual(["MISSING: extension/dist/mcp-server.js"]);
  });

  it("reports leaked dev paths by prefix", () => {
    const failures = verifyEntries([...GOOD, "extension/src/core/indexer.ts"], 40);
    expect(failures).toEqual(["LEAKED:  extension/src/"]);
  });

  it("rejects the size cap", () => {
    expect(verifyEntries(GOOD, MAX_MB + 0.1)).toEqual([`OVERSIZED: 80.1 MB > ${MAX_MB} MB cap`]);
  });

  it.each([
    "extension/.env",
    "extension/.env.local",
    "extension/certs/server.pem",
    "extension/certs/server.key",
    "extension/.npmrc",
    "extension/node_modules/some-lib/.npmrc",
    "extension/id_rsa",
    "extension/node_modules/some-lib/id_ed25519",
    "extension/github-token.txt",
    "extension/node_modules/some-lib/token.json",
    "extension/secrets.yaml",
    "extension/node_modules/deep/er/client_secret.json",
    "extension/.ENV",
    "extension/Token.txt",
  ])("rejects credential-shaped file %s at any depth", (path) => {
    const failures = verifyEntries([...GOOD, path], 40);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^SECRET: {2}/);
    expect(failures[0]).toContain(path);
  });

  it.each([
    "extension/node_modules/@huggingface/transformers/dist/tokenizers.js",
    "extension/node_modules/protobufjs/dist/tokenize.js",
    "extension/node_modules/some-lib/lib/secretbox.cjs",
    "extension/node_modules/some-lib/lib/id_generator.mjs",
    "extension/node_modules/some-lib/lib/tokens.js.map",
  ])("does not flag library source named like a credential: %s", (path) => {
    expect(verifyEntries([...GOOD, path], 40)).toEqual([]);
  });

  it("does not exempt file-type patterns on code-looking names", () => {
    // A key is a key, whatever else the name contains.
    expect(verifyEntries([...GOOD, "extension/lib/signing.js.key"], 40)).toHaveLength(1);
  });

  it("ignores directory entries", () => {
    expect(verifyEntries([...GOOD, "extension/node_modules/token-lib/"], 40)).toEqual([]);
  });

  it("does not stop at the first failure", () => {
    const entries = [
      "extension/dist/extension.js",
      "extension/src/x.ts",
      "extension/.env",
      "extension/node_modules/onnxruntime-web/dist/ort.js",
    ];
    const failures = verifyEntries(entries, 90);
    expect(failures).toEqual([
      "MISSING: extension/dist/mcp-server.js",
      "LEAKED:  extension/src/",
      "LEAKED:  extension/node_modules/onnxruntime-web/",
      "SECRET:  extension/.env (matches .env*)",
      "OVERSIZED: 90.0 MB > 80 MB cap",
    ]);
  });
});

describe("parseUnzipListing", () => {
  it("extracts entry names, keeping spaces, and skips header/footer lines", () => {
    const listing = [
      "Archive:  doc-search-0.7.1@linux-x64.vsix",
      "  Length      Date    Time    Name",
      "---------  ---------- -----   ----",
      "     1234  2026-09-12 10:00   extension/package.json",
      "        0  2026-09-12 10:00   extension/dist/",
      "   567890  2026-09-12 10:00   extension/dist/extension.js",
      "       12  2026-09-12 10:00   extension/media/with space.png",
      "---------                     -------",
      "   569136                     4 files",
      "",
    ].join("\n");
    expect(parseUnzipListing(listing)).toEqual([
      "extension/package.json",
      "extension/dist/",
      "extension/dist/extension.js",
      "extension/media/with space.png",
    ]);
  });

  it("returns an empty list for unparseable input", () => {
    expect(parseUnzipListing("garbage\n")).toEqual([]);
  });
});
