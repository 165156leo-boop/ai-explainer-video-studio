import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { readJsonWithBackup, writeJsonAtomic } from "./json-storage.ts";

function sourceFunctions(file: string, names: Set<string>) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
      found.set(node.name.text, node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual([...found.keys()].sort(), [...names].sort(), "认证读写函数缺失");
  return ts.transpileModule([...found.values()].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const directory = await mkdtemp(path.join(tmpdir(), "workbench-auth-test-"));
const usersFile = path.join(directory, "users.json");
const backupFile = path.join(directory, "users.backup.json");
const context = vm.createContext({
  USERS_FILE: usersFile,
  USERS_BACKUP_FILE: backupFile,
  readJsonWithBackup,
  writeJsonAtomic,
});

try {
  vm.runInContext(sourceFunctions("./auth.ts", new Set(["readUsers", "writeUsers"])), context);
  await vm.runInContext("writeUsers([{ email: 'first@example.test', passwordHash: 'hash-one', createdAt: 'first' }])", context);
  await vm.runInContext("writeUsers([{ email: 'first@example.test', passwordHash: 'hash-one', createdAt: 'first' }, { email: 'second@example.test', passwordHash: 'hash-two', createdAt: 'second' }])", context);

  const backupUsers = JSON.parse(await readFile(backupFile, "utf8"));
  assert.equal(backupUsers.length, 1);
  assert.equal(backupUsers[0].email, "first@example.test");

  await writeFile(usersFile, "{");
  const recovered = await vm.runInContext("readUsers()", context);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].email, "first@example.test");
  console.log("auth backup recovery checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
