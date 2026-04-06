import * as vscode from "vscode";

export const l10n = vscode.l10n;

const runtimeMessages: Record<string, Record<string, string>> = {
  "zh-cn": {
    addConnection: "添加连接",
    openSqliteFile: "打开 SQLite 文件",
    savedConnections: "已保存的连接",
    openDatabase: "打开数据库",
    selectDatabaseType: "选择数据库类型",
    newSqliteConnection: "新的 SQLite 连接",
    newMysqlConnection: "新的 MySQL 连接",
    newPostgresqlConnection: "新的 PostgreSQL 连接",
    removeConnectionWarning: "要删除这个已保存的连接吗？",
    removeButton: "删除",
    connectionSuccessful: "连接成功",
    connectionFailed: "连接失败",
    connectionSaveCouldNotBeVerified: "无法验证连接保存结果",
    connectionSaveDidNotPersistReadonly: "连接保存后没有保留最新的只读状态",
    connectionOperationFailed: "连接操作失败",
    connectionTitle: "连接: {name}"
  }
};

function currentLocale(): string {
  return vscode.env.language.toLowerCase();
}

export function localize(key: string, defaultValue: string, args?: Record<string, string | number>): string {
  const bundle = runtimeMessages[currentLocale()] ?? {};
  const template = bundle[key] ?? defaultValue;
  return template.replace(/\{(\w+)\}/g, (_, token) => String(args?.[token] ?? `{${token}}`));
}
