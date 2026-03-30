import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyConnectionForm, defaultPortForType, SQLITE_FILE_EXTENSIONS } from "./helpers.js";

test("default ports are mapped by database type", () => {
  assert.equal(defaultPortForType("mysql"), 3306);
  assert.equal(defaultPortForType("postgresql"), 5432);
  assert.equal(defaultPortForType("sqlite"), 0);
});

test("sqlite form defaults to file connection", () => {
  const form = createEmptyConnectionForm("sqlite");
  assert.equal(form.kind, "file");
  assert.equal(form.port, 0);
});

test("sqlite extension set includes db3", () => {
  assert.equal(SQLITE_FILE_EXTENSIONS.has(".db3"), true);
});
