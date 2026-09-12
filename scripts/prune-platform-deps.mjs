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

// onnxruntime-node ships all platform binaries in one package under
// bin/napi-v<N>/<os>/<arch>. The N moves between releases (v3 up to 1.21,
// v6 from 1.24) — a hardcoded name silently prunes nothing and the VSIX
// balloons past the size cap, so iterate whatever napi-* dirs exist.
// Remove other OS dirs, then remove other arch dirs within the target OS.
const onnxBin = "node_modules/onnxruntime-node/bin";
const napiDirs = existsSync(onnxBin)
  ? readdirSync(onnxBin).filter((d) => d.startsWith("napi-"))
  : [];
if (napiDirs.length === 0) {
  console.error(`No ${onnxBin}/napi-* directory found; nothing pruned for onnxruntime-node`);
  process.exit(1);
}
for (const napi of napiDirs) {
  const onnxDir = join(onnxBin, napi);
  for (const dir of readdirSync(onnxDir)) {
    if (dir !== platform) {
      rmDir(join(onnxDir, dir), `onnxruntime-node/bin/${napi}/${dir}`);
    }
  }
  const platformDir = join(onnxDir, platform);
  if (existsSync(platformDir)) {
    for (const archDir of readdirSync(platformDir)) {
      if (archDir !== arch) {
        rmDir(join(platformDir, archDir), `onnxruntime-node/bin/${napi}/${platform}/${archDir}`);
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
