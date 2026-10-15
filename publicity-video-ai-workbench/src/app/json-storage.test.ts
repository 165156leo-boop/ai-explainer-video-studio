import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJsonWithBackup, writeJsonAtomic } from "./json-storage.ts";

const directory = await mkdtemp(path.join(tmpdir(), "workbench-storage-test-"));
const file = path.join(directory, "data.json");
const backup = path.join(directory, "backup.json");
const decode = (value: unknown) => {
  assert.ok(Array.isArray(value));
  return value;
};
try {
  assert.deepEqual(await readJsonWithBackup(file, backup, decode, []), []);
  await writeJsonAtomic(file, ["current"]);
  await writeJsonAtomic(backup, ["previous"]);
  await assert.rejects(writeJsonAtomic(file, BigInt(1)));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), ["current"]);
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith(".tmp")));
  for (const damaged of ["{", "null", "{}"] ) {
    await writeFile(file, damaged);
    assert.deepEqual(await readJsonWithBackup(file, backup, decode, []), ["previous"]);
  }
  const recovered = await readJsonWithBackup(file, backup, decode, []);
  await writeJsonAtomic(backup, recovered);
  await writeJsonAtomic(file, ["new"]);
  assert.deepEqual(await readJsonWithBackup(file, backup, decode, []), ["new"]);
  await rm(file);
  assert.deepEqual(await readJsonWithBackup(file, backup, decode, []), ["previous"]);
  await writeFile(file, "{");
  await writeFile(backup, "{");
  await assert.rejects(readJsonWithBackup(file, backup, decode, []));
  console.log("atomic storage and backup recovery checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
