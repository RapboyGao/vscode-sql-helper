import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targetDir = path.join(root, "bin");
const executable = process.platform === "win32" ? "sql-analyzer.exe" : "sql-analyzer";
const source = path.join(root, "crates", "sql-analyzer", "target", "release", executable);
const fallback = path.join(root, "target", "release", executable);
const resolvedSource = fs.existsSync(source) ? source : fallback;

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(resolvedSource, path.join(targetDir, executable));
console.log(`Copied ${resolvedSource} -> ${path.join(targetDir, executable)}`);
