/**
 * Removes native binary directories for non-target platforms from:
 *   - onnxruntime-node  (bundles darwin/linux/win32 in one package)
 *   - @lancedb          (installs platform optional deps)
 *
 * Usage: node scripts/prune-platform-deps.mjs <target>
 *   target: darwin-arm64 | darwin-x64 | linux-x64 | win32-x64
 */
import { rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const targetToPlatform = {
  "darwin-arm64": "darwin",
  "darwin-x64": "darwin",
  "linux-x64": "linux",
  "win32-x64": "win32",
};

const target = process.argv[2];
const platform = targetToPlatform[target];

if (!platform) {
  console.error(`Usage: node scripts/prune-platform-deps.mjs <target>`);
  console.error(`  target: darwin-arm64 | darwin-x64 | linux-x64 | win32-x64`);
  process.exit(1);
}

// onnxruntime-node ships all platform binaries in one package
const onnxDir = "node_modules/onnxruntime-node/bin/napi-v3";
if (existsSync(onnxDir)) {
  for (const dir of readdirSync(onnxDir)) {
    if (dir !== platform) {
      console.log(`Removing onnxruntime-node/bin/napi-v3/${dir}`);
      rmSync(join(onnxDir, dir), { recursive: true, force: true });
    }
  }
}

// @lancedb installs platform-specific optional packages (e.g. lancedb-linux-x64-gnu)
const lancedbDir = "node_modules/@lancedb";
if (existsSync(lancedbDir)) {
  for (const pkg of readdirSync(lancedbDir)) {
    if (pkg !== "lancedb" && !pkg.startsWith(`lancedb-${platform}`)) {
      console.log(`Removing @lancedb/${pkg}`);
      rmSync(join(lancedbDir, pkg), { recursive: true, force: true });
    }
  }
}
