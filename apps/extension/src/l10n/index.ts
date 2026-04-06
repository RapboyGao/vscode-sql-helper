import * as vscode from 'vscode';

export const l10n = vscode.l10n;

export function localize(key: string, defaultValue: string, ...args: any[]): string {
  return l10n.t(key, ...args) || defaultValue;
}
