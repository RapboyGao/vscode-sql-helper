import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { NativeRequest, NativeResponse, SavedConnection } from "@usd/shared";
import { createId } from "../utils/id.js";
import { ensureReadonlyAllowed } from "../utils/errors.js";
import { ConnectionStore } from "../storage/connectionStore.js";
import { resolveNativeBinaryPath } from "./binaryResolver.js";

export class NativeBridge {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore
  ) {}

  public async call<TPayload, TData>(
    connection: SavedConnection,
    operation: NativeRequest<TPayload>["operation"],
    payload?: TPayload
  ): Promise<NativeResponse<TData>> {
    const readonlyError = ensureReadonlyAllowed(connection.readonly, operation);
    if (readonlyError) {
      return {
        requestId: createId("request"),
        success: false,
        error: readonlyError
      };
    }

    const request: NativeRequest<TPayload> = {
      requestId: createId("request"),
      operation,
      connection: await this.connectionStore.toNativeConnection(connection),
      readonly: connection.readonly,
      payload
    };

    const executable = resolveNativeBinaryPath(this.context.extensionUri);

    return await new Promise<NativeResponse<TData>>((resolve, reject) => {
      const child = spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", () => {
        if (!stdout.trim()) {
          reject(new Error(stderr || "Native process returned no output"));
          return;
        }

        resolve(JSON.parse(stdout) as NativeResponse<TData>);
      });

      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    });
  }
}

