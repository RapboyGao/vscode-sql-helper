import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

type AnalysisResult = {
  databases: string[];
  schemas: string[];
  references: Array<{
    kind: string;
    value: string;
  }>;
  note?: string;
};

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand("sqlHelper.openAnalyzer", async () => {
    const panel = vscode.window.createWebviewPanel(
      "sqlHelperAnalyzer",
      "SQL Helper",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")]
      }
    );

    panel.webview.html = await getWebviewHtml(panel.webview, context.extensionUri);

    panel.webview.onDidReceiveMessage(async (message: { type: string; sql?: string }) => {
      if (message.type !== "analyze") {
        return;
      }

      try {
        const result = await runAnalyzer(context.extensionPath, message.sql ?? "");
        panel.webview.postMessage({ type: "analysisResult", payload: result });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: "analysisError", payload: text });
      }
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}

async function runAnalyzer(extensionPath: string, sql: string): Promise<AnalysisResult> {
  const analyzerPath = getAnalyzerPath(extensionPath);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(analyzerPath, [], {
      cwd: extensionPath
    });

    let output = "";
    let errors = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }

      reject(new Error(errors || `Analyzer exited with code ${code ?? "unknown"}`));
    });

    child.stdin.write(sql);
    child.stdin.end();
  });

  return JSON.parse(stdout) as AnalysisResult;
}

function getAnalyzerPath(extensionPath: string): string {
  const executable = process.platform === "win32" ? "sql-analyzer.exe" : "sql-analyzer";
  return path.join(extensionPath, "bin", executable);
}

async function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const distPath = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const htmlRaw = await fs.readFile(distPath.fsPath + "/index.html", "utf8");

  return htmlRaw.replace(/(?:\.\/)?assets\/([^"]+)/g, (_match, assetPath: string) => {
    const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(distPath, "assets", assetPath));
    return assetUri.toString();
  });
}
