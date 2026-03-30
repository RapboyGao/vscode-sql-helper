import type { NativeError } from "@usd/shared";

export function toUserMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "Unexpected error";
}

export function ensureReadonlyAllowed(readonly: boolean, operation: string): NativeError | null {
  if (!readonly) {
    return null;
  }

  if (["insertRows", "updateRows", "deleteRows", "previewDDL", "applyDDL"].includes(operation)) {
    return {
      code: "READONLY",
      message: "This connection is readonly. Write operations are disabled."
    };
  }

  return null;
}

