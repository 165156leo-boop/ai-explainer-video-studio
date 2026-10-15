// 手动启动包装器：防止浏览器端断开连接（内置预览面板开关/刷新）触发的流式响应
// uncaughtException（ERR_INVALID_STATE: Controller is already closed）
// 把 next start 进程打崩。只吞掉这一类流错误，其余照旧退出。
//
// 用法：node next-start-resilient.cjs start -p 3001
// 常规启动走 scripts\start-workbench.cmd（它直接调 `npm run start`），
// 不经过本文件；这里只服务于需要额外容错的手动启动。
//
// 两点顺序/模块约束：
//   1. 两个 process 处理器必须先于 Next.js CLI 装载，否则崩溃发生在注册之前。
//      因此下面用动态 `import()` 而不是静态 `import`——静态导入会被提升到本模块
//      所有语句之前执行，等于把顺序写反。
//   2. 项目是 `"type": "module"`，这个 `.cjs` 是唯一的 CommonJS 文件；
//      不要在这里写 `require()`，lint 的 no-require-imports 就是为了拦住它。
process.on("uncaughtException", (err) => {
  const text = `${err?.code ?? ""} ${err?.message ?? ""}`;
  if (/ERR_INVALID_STATE/.test(text) || /Controller is already closed/.test(text)) {
    console.warn(`[resilient] ignored stream error: ${err.message}`);
    return;
  }
  console.error("[resilient] fatal uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const text = String(reason);
  if (/ERR_INVALID_STATE/.test(text) || /Controller is already closed/.test(text)) {
    console.warn(`[resilient] ignored stream rejection: ${text}`);
    return;
  }
  console.error("[resilient] fatal unhandledRejection:", reason);
  process.exit(1);
});

import("./node_modules/next/dist/bin/next").catch((error) => {
  console.error("[resilient] failed to load the Next.js CLI:", error);
  process.exit(1);
});
