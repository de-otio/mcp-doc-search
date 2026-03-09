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
  "darwin-arm64": { os: "darwin", arch: "arm64" },
  "darwin-x64": { os: "darwin", arch: "x64" },
  "linux-x64": { os: "linux", arch: "x64" },
  "win32-x64": { os: "win32", arch: "x64" },
};

const target = process.argv[2];
const info = targetToPlatform[target];

if (!info) {
  console.error(`Usage: node scripts/prune-platform-deps.mjs <target>`);
  console.error(`  target: darwin-arm64 | darwin-x64 | linux-x64 | win32-x64`);
  process.exit(1);
}

const { os: platform, arch } = info;
let saved = 0;

function rmDir(p, label) {
  if (existsSync(p)) {
    console.log(`Removing ${label}`);
    rmSync(p, { recursive: true, force: true });
  }
}

// onnxruntime-node ships all platform binaries in one package.
// Remove other OS dirs, then remove other arch dirs within the target OS.
const onnxDir = "node_modules/onnxruntime-node/bin/napi-v3";
if (existsSync(onnxDir)) {
  for (const dir of readdirSync(onnxDir)) {
    if (dir !== platform) {
      rmDir(join(onnxDir, dir), `onnxruntime-node/bin/napi-v3/${dir}`);
    }
  }
  // Also remove non-target architectures within the platform dir
  const platformDir = join(onnxDir, platform);
  if (existsSync(platformDir)) {
    for (const archDir of readdirSync(platformDir)) {
      if (archDir !== arch) {
        rmDir(join(platformDir, archDir), `onnxruntime-node/bin/napi-v3/${platform}/${archDir}`);
      }
    }
  }
}

// Remove onnxruntime-node source/script files not needed at runtime
for (const sub of ["lib", "script"]) {
  rmDir(join("node_modules/onnxruntime-node", sub), `onnxruntime-node/${sub}`);
}

// @lancedb installs platform-specific optional packages (e.g. lancedb-linux-x64-gnu)
const lancedbDir = "node_modules/@lancedb";
if (existsSync(lancedbDir)) {
  for (const pkg of readdirSync(lancedbDir)) {
    if (pkg !== "lancedb" && !pkg.startsWith(`lancedb-${target}`)) {
      rmDir(join(lancedbDir, pkg), `@lancedb/${pkg}`);
    }
  }
}
