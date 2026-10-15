/**
 * 模块接线回归（2026-09-18 新增）
 *
 * 起因是一次真机事故：真机跑生图时当场报 `MAX_REFERENCE_IMAGES is not defined`。
 * 常量在 `doubao-adapter.cjs` 里定义并**已导出**，注释里也写明「由 doubao-adapter.cjs
 * 统一定义并导出（单一来源）」，但 `main.cjs` 那一行 `require` 的解构**漏了这个名字**。
 *
 * 为什么既有 67 项测试全绿也没发现：
 *   `main.cjs` 第一行 `require("electron")`，它无法在纯 Node 下被单元测试加载，
 *   于是 HTTP 路由层的代码事实上处于**零覆盖**状态；而这条语句只在真正走到
 *   `normalizeReferenceFiles` 时才抛，等于「所有带参考图的提交都会当场失败」。
 *
 * 这类缺陷（同项目内 A 模块导出、B 模块使用、B 忘了 import）可以用静态检查稳定抓出来，
 * 不需要跑 Electron，也不需要真机额度。本文件就是那道闸门。
 */
const assert = require("node:assert");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

/** 把注释与字符串字面量替换成等长空白，避免从注释/文案里误抓名字。 */
function blankOutCommentsAndStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = i + 1 < n ? code[i + 1] : "";
    if (c === "/" && next === "/") {
      let j = code.indexOf("\n", i);
      if (j < 0) j = n;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && next === "*") {
      let j = code.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      out += code.slice(i, j).replace(/[^\n]/gu, " ");
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += code.slice(i, j).replace(/[^\n]/gu, " ");
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function moduleExports(code) {
  const marker = "module.exports";
  const at = code.indexOf(marker);
  if (at < 0) return new Set();
  const open = code.indexOf("{", at);
  if (open < 0) return new Set();
  let depth = 1;
  let i = open + 1;
  while (i < code.length && depth > 0) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
    i += 1;
  }
  const body = code.slice(open + 1, i - 1);
  const names = new Set();
  for (const part of body.split(",")) {
    const key = part.split(":")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/u.test(key)) names.add(key);
  }
  return names;
}

/** 本文件里「被声明过」或「被 import 进来」的名字。 */
function localNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gu)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/gsu)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
    }
  }
  return names;
}

function sourceFiles() {
  return fs
    .readdirSync(SRC)
    .filter((file) => file.endsWith(".cjs"))
    .sort();
}

test("同项目模块导出被别处使用时，必须真的 import 进来", () => {
  const files = sourceFiles();
  assert.ok(files.length >= 3, `src 下应至少有 3 个 .cjs，实际 ${files.length}`);

  const sources = new Map();
  for (const file of files) {
    sources.set(file, blankOutCommentsAndStrings(fs.readFileSync(path.join(SRC, file), "utf8")));
  }

  // 某个名字被哪些模块导出。
  const owners = new Map();
  for (const [file, code] of sources) {
    for (const name of moduleExports(code)) {
      if (!owners.has(name)) owners.set(name, new Set());
      owners.get(name).add(file);
    }
  }

  const problems = [];
  for (const [file, code] of sources) {
    const local = localNames(code);
    for (const [name, exporters] of owners) {
      if (exporters.has(file)) continue;
      // 只关心「裸标识符」用法：排除 `a.NAME` 这类属性访问。
      const bare = new RegExp(`(?<![.\\w$])${name}\\b`, "u");
      if (!bare.test(code)) continue;
      if (local.has(name)) continue;
      problems.push(`${file} 用到了 ${name}（由 ${[...exporters].join("、")} 导出），但没有 import`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `发现未接线的模块导出：\n  - ${problems.join("\n  - ")}\n`
      + "这类缺陷只在真机走到那一行时才抛 ReferenceError（main.cjs 依赖 Electron，不进单测），"
      + "所以必须在这里拦住。",
  );
});

test("单实例锁失败会在继续初始化前退出", () => {
  const code = sources_read("main.cjs");
  assert.match(
    code,
    /if\s*\(!gotLock\)\s*\{\s*app\.quit\(\);\s*process\.exit\(0\);\s*\}/u,
    "拿不到 Electron 单实例锁时必须停止后续 Provider 初始化",
  );
});

test("参考图张数上限只在 doubao-adapter.cjs 定义一次（单一来源）", () => {
  const defined = [];
  for (const file of sourceFiles()) {
    const code = sources_read(file);
    for (const m of code.matchAll(/\bconst\s+MAX_REFERENCE_IMAGES\s*=\s*(\d+)/gu)) {
      defined.push({ file, value: Number(m[1]) });
    }
  }
  assert.equal(
    defined.length,
    1,
    `MAX_REFERENCE_IMAGES 应只在一处定义，实际：${JSON.stringify(defined)}`,
  );
  assert.equal(defined[0].file, "doubao-adapter.cjs");
  assert.equal(defined[0].value, 10);
});

test("首页视频入口优先点击真实 skill button，而不是内部文字节点", () => {
  const code = fs.readFileSync(path.join(SRC, "doubao-adapter.cjs"), "utf8");
  const enter = code.slice(code.indexOf("async function enterVideoModeFromHome"), code.indexOf("async function uploadReferenceImages"));
  assert.match(enter, /el\.closest\('button,\[role="button"\]'\) \|\| el/);
  assert.match(enter, /skill_bar_button_17/);
  assert.match(enter, /a\.priority - b\.priority \|\| a\.area - b\.area/);
});

function sources_read(file) {
  return blankOutCommentsAndStrings(fs.readFileSync(path.join(SRC, file), "utf8"));
}
