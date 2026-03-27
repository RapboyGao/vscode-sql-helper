import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targetTriple = process.env.TARGET_TRIPLE;
const binPlatform = process.env.BIN_PLATFORM ?? process.platform;
const binArch = process.env.BIN_ARCH ?? process.arch;
const targetDir = path.join(root, "bin");
const platformDir = path.join(targetDir, `${binPlatform}-${binArch}`);
const executable = binPlatform === "win32" ? "sql-analyzer.exe" : "sql-analyzer";
const source = targetTriple
  ? path.join(root, "crates", "sql-analyzer", "target", targetTriple, "release", executable)
  : path.join(root, "crates", "sql-analyzer", "target", "release", executable);
const fallback = path.join(root, "target", "release", executable);
const resolvedSource = fs.existsSync(source) ? source : fallback;
const platformTarget = path.join(platformDir, executable);
const legacyTarget = path.join(targetDir, executable);

fs.mkdirSync(targetDir, { recursive: true });
fs.mkdirSync(platformDir, { recursive: true });
fs.copyFileSync(resolvedSource, platformTarget);

if (binPlatform === process.platform && binArch === process.arch) {
  fs.copyFileSync(resolvedSource, legacyTarget);
  console.log(`Copied ${resolvedSource} -> ${platformTarget}`);
  console.log(`Copied ${resolvedSource} -> ${legacyTarget}`);
} else {
  console.log(`Copied ${resolvedSource} -> ${platformTarget}`);
}
