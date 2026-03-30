import * as fs from "node:fs/promises";
import * as vscode from "vscode";

export async function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): Promise<string> {
  const distDir = vscode.Uri.joinPath(extensionUri, "media", "webview");
  const indexPath = vscode.Uri.joinPath(distDir, "index.html").fsPath;
  const html = await fs.readFile(indexPath, "utf8");
  const assetBase = webview.asWebviewUri(vscode.Uri.joinPath(distDir, "assets")).toString();
  return html
    .replace(/__WEBVIEW_TITLE__/g, title)
    .replace(/(src|href)="\.\/assets\/(.*?)"/g, `$1="${assetBase}/$2"`)
    .replace(/(src|href)="\/assets\/(.*?)"/g, `$1="${assetBase}/$2"`);
}
