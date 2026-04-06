import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(extensionDir, "..", "..");
const binDir = path.join(extensionDir, "bin");
const extensionLicensePath = path.join(extensionDir, "LICENSE");
const rootLicensePath = path.join(workspaceRoot, "LICENSE");
const workflowName = process.env.USD_NATIVE_WORKFLOW ?? "Build Extension And Native Binaries";

async function main() {
  const repo = process.env.USD_GITHUB_REPOSITORY ?? detectGitHubRepository();
  const branch = process.env.USD_GITHUB_BRANCH ?? detectCurrentBranch();
  const runId = process.env.USD_GITHUB_RUN_ID ?? findLatestSuccessfulRunId(repo, branch);
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "usd-native-artifacts-"));

  try {
    console.log(`[package:vsix] repo=${repo}`);
    console.log(`[package:vsix] branch=${branch}`);
    console.log(`[package:vsix] run=${runId}`);

    await fs.rm(binDir, { recursive: true, force: true });
    await fs.mkdir(binDir, { recursive: true });
    await ensureExtensionLicense();

    downloadNativeArtifacts(repo, runId, downloadDir);
    await assembleArtifacts(downloadDir, binDir);

    execFileSync(
      "npx",
      ["@vscode/vsce", "package", "--no-dependencies"],
      {
        cwd: extensionDir,
        stdio: "inherit"
      }
    );
  } finally {
    await fs.rm(downloadDir, { recursive: true, force: true });
  }
}

function run(command, args, cwd = workspaceRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function detectGitHubRepository() {
  const remote = run("git", ["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match?.[1]) {
    throw new Error(`Could not derive GitHub repository from remote: ${remote}`);
  }

  return match[1];
}

function detectCurrentBranch() {
  return run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function findLatestSuccessfulRunId(repo, branch) {
  const output = run("gh", [
    "run",
    "list",
    "-R",
    repo,
    "--workflow",
    workflowName,
    "--branch",
    branch,
    "--limit",
    "20",
    "--json",
    "databaseId,conclusion,status"
  ]);

  const runs = JSON.parse(output);
  const successful = runs.find((run) => run.status === "completed" && run.conclusion === "success");
  if (!successful?.databaseId) {
    throw new Error(`No successful workflow run found for ${workflowName} on ${repo}#${branch}`);
  }

  return String(successful.databaseId);
}

function downloadNativeArtifacts(repo, runId, downloadDir) {
  execFileSync(
    "gh",
    [
      "run",
      "download",
      runId,
      "-R",
      repo,
      "--dir",
      downloadDir,
      "--pattern",
      "native-*"
    ],
    {
      cwd: workspaceRoot,
      stdio: "inherit"
    }
  );
}

async function assembleArtifacts(sourceDir, targetDir) {
  const artifactEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  const nativeArtifacts = artifactEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith("native-"));

  if (!nativeArtifacts.length) {
    throw new Error("No native artifacts were downloaded.");
  }

  for (const artifact of nativeArtifacts) {
    const platformKey = artifact.name.replace(/^native-/, "");
    const artifactPath = path.join(sourceDir, artifact.name);
    const files = await listFiles(artifactPath);

    if (!files.length) {
      throw new Error(`Artifact ${artifact.name} did not contain any files.`);
    }

    const destinationDir = path.join(targetDir, platformKey);
    await fs.mkdir(destinationDir, { recursive: true });

    for (const file of files) {
      const destination = path.join(destinationDir, path.basename(file));
      await fs.copyFile(file, destination);
    }
  }
}

async function ensureExtensionLicense() {
  await fs.copyFile(rootLicensePath, extensionLicensePath);
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

main().catch((error) => {
  console.error(`[package:vsix] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
