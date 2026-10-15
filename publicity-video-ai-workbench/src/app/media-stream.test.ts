import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 2026-09-30：候选媒体预览的文件流回归。
//
// 背景：浏览器取消候选媒体预览（内置预览面板开关/刷新、快速切换镜头）时，
// 旧的 `Readable.toWeb(createReadStream(...))` 会在控制器已关闭后继续写入，
// 抛 `ERR_INVALID_STATE: Controller is already closed`，反复 uncaughtException
// 把 `next start` 进程打死（见 `.workbuddy/memory/2026-09-28.md`）。
// 修复方式是 `media-provider.ts` 内的显式可取消文件流。这里直接执行源码里那个
// 函数（不是副本），锁住「取消后 end/error 到达不得再次关闭控制器」。
function sourceFunction(file: string, name: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let result = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = node.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, `Missing function ${name}`);
  return ts.transpileModule(result.replace(/^export\s+/u, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const { createReadStream } = await import("node:fs");
const sandbox = vm.createContext({
  createReadStream,
  Buffer,
  ReadableStream,
  Uint8Array,
});
vm.runInContext(sourceFunction("./media-provider.ts", "fileReadStream"), sandbox);
const fileReadStream = vm.runInContext("fileReadStream", sandbox) as (
  filePath: string,
) => ReadableStream<Uint8Array>;

const directory = await mkdtemp(path.join(tmpdir(), "media-stream-"));
const bigFile = path.join(directory, "big.bin");
const smallFile = path.join(directory, "small.bin");
const payload = Buffer.alloc(4 * 1024 * 1024, 7);
await writeFile(bigFile, payload);
await writeFile(smallFile, "tail-frame-bytes");

// 不吞异常：把未捕获异常收集起来断言，而不是让它把测试进程打死。
const crashes: unknown[] = [];
const onCrash = (error: unknown) => {
  crashes.push(error);
};
process.on("uncaughtException", onCrash);
process.on("unhandledRejection", onCrash);

try {
  // 1. 正常读完：内容完整、流正常关闭。
  const whole = fileReadStream(smallFile);
  const wholeReader = whole.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const step = await wholeReader.read();
    if (step.done) break;
    chunks.push(step.value);
  }
  assert.equal(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    "tail-frame-bytes",
    "文件流必须完整送达内容",
  );

  // 2. 读取中途取消：底层读取流被销毁，后续 end/data 不得再触碰控制器。
  const cancelled = fileReadStream(bigFile);
  const cancelledReader = cancelled.getReader();
  const first = await cancelledReader.read();
  assert.ok(first.value && first.value.length > 0, "取消前应已拿到至少一个数据块");
  await cancelledReader.cancel();
  // 4 MiB 分块读取，取消时必然还有大量 data/end 事件在路上。
  await new Promise((done) => setTimeout(done, 120));
  assert.equal(crashes.length, 0, "取消后到达的 end/data 不得抛异常");
  // 取消后的读取按 Web Streams 语义直接结束，不得重新打开源头继续供数。
  assert.equal(
    (await cancelledReader.read()).done,
    true,
    "取消后的读取必须立即结束，而不是重新打开源头",
  );

  // 3. 取消后底层流报错：不得转成流的 error，也不得抛。
  const cancelledOnError = fileReadStream(bigFile);
  const errorReader = cancelledOnError.getReader();
  await errorReader.read();
  await errorReader.cancel();
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(crashes.length, 0, "取消后到达的 error 不得抛异常");

  // 4. 未取消时读取失败仍要如实传播（不能因为加了取消保护就把错误吞掉）。
  const missing = fileReadStream(path.join(directory, "does-not-exist.bin"));
  await assert.rejects(
    () => missing.getReader().read(),
    "源文件不存在时必须把错误传给读取方",
  );
} finally {
  process.off("uncaughtException", onCrash);
  process.off("unhandledRejection", onCrash);
  await rm(directory, { recursive: true, force: true });
}

console.log("media file stream cancellation checks passed");
