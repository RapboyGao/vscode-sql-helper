import fs from "node:fs";
import path from "node:path";

const platformKey = process.env.PLATFORM_KEY;
const binaryName = process.env.BINARY_NAME;
const source = process.env.SOURCE_BINARY;

if (!platformKey || !binaryName || !source) {
  throw new Error("PLATFORM_KEY, BINARY_NAME, and SOURCE_BINARY are required");
}

const targetDir = path.resolve("apps/extension/bin", platformKey);
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, path.join(targetDir, binaryName));

