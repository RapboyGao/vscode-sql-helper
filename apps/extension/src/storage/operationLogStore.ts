import * as vscode from "vscode";
import type { OperationLogEntry } from "@usd/shared";
import { createId } from "../utils/id.js";

const LOG_KEY = "databaseManager.operationLogs";
const MAX_LOGS = 50;

export class OperationLogStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getAll(): OperationLogEntry[] {
    return this.context.globalState.get<OperationLogEntry[]>(LOG_KEY, []);
  }

  public listForConnection(connectionName: string): OperationLogEntry[] {
    return this.getAll().filter((entry) => entry.connectionName === connectionName);
  }

  public async append(entry: Omit<OperationLogEntry, "id" | "timestamp">): Promise<void> {
    const nextEntry: OperationLogEntry = {
      id: createId("log"),
      timestamp: new Date().toISOString(),
      ...entry
    };
    const next = [nextEntry, ...this.getAll()].slice(0, MAX_LOGS);
    await this.context.globalState.update(LOG_KEY, next);
  }
}

