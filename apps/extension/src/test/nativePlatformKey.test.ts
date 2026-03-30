import test from "node:test";
import assert from "node:assert/strict";
import { nativePlatformKey } from "../native/platform.js";

test("native platform key is stable", () => {
  assert.equal(nativePlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(nativePlatformKey("win32", "x64"), "win32-x64");
});
