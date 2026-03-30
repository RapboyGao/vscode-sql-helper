import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { nativePlatformKey } from "./platform.js";

const EXECUTABLE_NAME = process.platform === "win32" ? "usd-native.exe" : "usd-native";

export function resolveNativeBinaryPath(extensionUri: vscode.Uri): string {
  const platformKey = nativePlatformKey(process.platform, process.arch);
  const candidates = [
    vscode.Uri.joinPath(extensionUri, "bin", platformKey, EXECUTABLE_NAME).fsPath,
    path.resolve(vscode.Uri.joinPath(extensionUri, "..", "..", "native", "rust-backend", "target", "release", EXECUTABLE_NAME).fsPath)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Native binary for current platform not found");
}
