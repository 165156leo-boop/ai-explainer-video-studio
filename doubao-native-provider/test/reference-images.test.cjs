/**
 * 多张参考图的回归测试（2026-09-18）。
 *
 * 起因（用户原话）：「我本来的意思也是生成一个参考图，你从参考图去发散生成相关视频，
 * 参考图是可以上传好几个的……对于我们自己程序的缺陷，一定要修改，不能太局限，要包容。」
 *
 * 修复前的三处缺陷，每处都钉一条断言：
 *   1. `attachReferenceAndCaptureUri` 用单个 capturedUri + `if (match && !capturedUri)`，
 *      只留第一张 → 第 2..N 张被静默丢弃且零警告；
 *   2. `submitDirectVideoRequest` 的 attachment_block 写死单元素、文件名写死
 *      reference-1.png、image_ori 写死 2848×1600；
 *   3. main.cjs 的 `normalizeReferenceFiles` 用 slice(0, 10) 静默截断。
 *
 * uri 配对这条尤其要盯：实测（tmp/probe-reference-upload.json）豆包的 CommitImageUpload
 * 请求体是 {"SessionKey":"<base64>"}，base64 里带着 uri；但 TOS key 是哈希名，
 * **不回报原始文件名**，所以配对只能按到达顺序，配不上时必须老老实实退回顺序而不是猜。
 *
 * 运行：node --test test/*.test.cjs
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");

const {
  parseImageBufferInfo,
  pairCapturedUris,
  extractUrisFromCommitRequest,
  describeReferenceImages,
  resolveCameraMovement,
  MAX_REFERENCE_IMAGES,
} = require("../src/doubao-adapter.cjs");

const REAL_URI_A = "tos-cn-i-a9rns2rl98/13f16f75ca6e4417b7541541cdd01a31.png";
const REAL_URI_B = "tos-cn-i-a9rns2rl98/c8ba41877fd74a7eadb81c95772427a8.png";

// ---------- 图片头解析：image_ori 用真实尺寸，不再写死 2848×1600 ----------

function pngBuffer(width, height) {
  const buffer = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegBuffer(width, height) {
  const buffer = Buffer.alloc(24);
  buffer[0] = 0xff;
  buffer[1] = 0xd8; // SOI
  buffer[2] = 0xff;
  buffer[3] = 0xe0; // APP0（无 SOF，用来验证会跳过）
  buffer.writeUInt16BE(4, 4);
  buffer[8] = 0xff;
  buffer[9] = 0xc0; // SOF0
  buffer.writeUInt16BE(11, 10);
  buffer[12] = 8;
  buffer.writeUInt16BE(height, 13);
  buffer.writeUInt16BE(width, 15);
  return buffer;
}

function webpBuffer(width, height) {
  const buffer = Buffer.alloc(32);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(24, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8X", 12, "latin1");
  buffer.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buffer[24] = w & 0xff;
  buffer[25] = (w >> 8) & 0xff;
  buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff;
  buffer[28] = (h >> 8) & 0xff;
  buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

function gifBuffer(width, height) {
  const buffer = Buffer.alloc(32);
  buffer.write("GIF89a", 0, "latin1");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

test("parseImageBufferInfo 读出 PNG/JPEG/WebP/GIF 的真实宽高与格式", () => {
  assert.deepEqual(parseImageBufferInfo(pngBuffer(2848, 1600)), {
    width: 2848,
    height: 1600,
    format: "png",
  });
  // 非 16:9、非工作台出图尺寸的素材（视频抽帧就是这种）也必须读对。
  assert.deepEqual(parseImageBufferInfo(pngBuffer(832, 468)), {
    width: 832,
    height: 468,
    format: "png",
  });
  assert.deepEqual(parseImageBufferInfo(jpegBuffer(1280, 720)), {
    width: 1280,
    height: 720,
    format: "jpeg",
  });
  assert.deepEqual(parseImageBufferInfo(webpBuffer(640, 360)), {
    width: 640,
    height: 360,
    format: "webp",
  });
  assert.deepEqual(parseImageBufferInfo(gifBuffer(300, 200)), {
    width: 300,
    height: 200,
    format: "gif",
  });
});

test("parseImageBufferInfo 对垃圾数据/空/截断返回 null，不抛异常", () => {
  assert.equal(parseImageBufferInfo(Buffer.from("not an image at all")), null);
  assert.equal(parseImageBufferInfo(Buffer.alloc(0)), null);
  assert.equal(parseImageBufferInfo(null), null);
  assert.equal(parseImageBufferInfo(undefined), null);
  // 只有 PNG 签名但被截断：读不到宽高，退回由调用方兜底。
  assert.equal(parseImageBufferInfo(pngBuffer(100, 100).subarray(0, 16)), null);
  // 宽高为 0 的坏头也拒绝（0 会让服务端按 0 排版）。
  assert.equal(parseImageBufferInfo(pngBuffer(0, 0)), null);
});

test("describeReferenceImages 用真实头解析，解析不了才回退并留痕", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ref-images-"));
  try {
    const good = path.join(directory, "reference-1.png");
    const bad = path.join(directory, "reference-2.bin");
    await writeFile(good, pngBuffer(1234, 567));
    await writeFile(bad, Buffer.from("definitely not an image"));
    const infos = await describeReferenceImages([good, bad]);
    assert.deepEqual(infos[0], {
      fileName: "reference-1.png",
      width: 1234,
      height: 567,
      format: "png",
      dimensionsSource: "file-header",
    });
    // 回退值等于修复前的行为（2848×1600/png），且明确标出来源不是 file-header。
    assert.deepEqual(infos[1], {
      fileName: "reference-2.bin",
      width: 2848,
      height: 1600,
      format: "png",
      dimensionsSource: "fallback",
    });
    // 顺序必须与传入顺序一致：第 N 张 uri 要对第 N 张本地文件。
    assert.deepEqual(infos.map((info) => info.fileName), ["reference-1.png", "reference-2.bin"]);
    // 不存在的文件也要出结果（回退），不能抛。
    const missing = await describeReferenceImages([path.join(directory, "nope.png")]);
    assert.equal(missing[0].dimensionsSource, "fallback");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------- uri 捕获：全部拿到，不再只留第一张 ----------

test("extractUrisFromCommitRequest 从真实形态的 SessionKey 里取出 uri", () => {
  // 形态照抄实测抓包：{"SessionKey":"<base64>"}，base64 解出带 StoreUri/uri 的 JSON。
  const decoded = JSON.stringify({
    StoreInfos: JSON.stringify([{ StoreUri: REAL_URI_A, Auth: "SpaceKey/x" }]),
    uploadHost: "tos-hl-x.snssdk.com",
    uri: REAL_URI_A,
  });
  const postData = JSON.stringify({ SessionKey: Buffer.from(decoded, "utf8").toString("base64") });
  assert.deepEqual(extractUrisFromCommitRequest(postData), [REAL_URI_A]);
  // 一次请求体带多个 StoreInfos 时，只取第一个（豆包实际是一张一个请求，见探针）。
  assert.deepEqual(extractUrisFromCommitRequest(""), []);
  assert.deepEqual(extractUrisFromCommitRequest("{}"), []);
  assert.deepEqual(extractUrisFromCommitRequest(undefined), []);
});

test("pairCapturedUris 按顺序对应，且不丢图", () => {
  const paths = ["C:/tmp/reference-1.png", "C:/tmp/reference-2.png", "C:/tmp/reference-3.png"];
  const captured = [
    { uri: REAL_URI_A, fileNameHints: [path.basename(REAL_URI_A)] },
    { uri: REAL_URI_B, fileNameHints: [path.basename(REAL_URI_B)] },
    { uri: "tos-cn-i-x/third.png", fileNameHints: ["third.png"] },
  ];
  const paired = pairCapturedUris(paths, captured);
  assert.equal(paired.pairing, "arrival-order", "拿不到原始文件名时只能按到达顺序");
  assert.deepEqual(paired.uris, [REAL_URI_A, REAL_URI_B, "tos-cn-i-x/third.png"]);
  assert.equal(paired.uris.length, paths.length, "三张图必须三张 uri，一张都不能少");
});

test("pairCapturedUris 只在每张都唯一命中文件名时才采信文件名配对", () => {
  const paths = ["C:/tmp/reference-1.png", "C:/tmp/reference-2.png"];
  // 到达顺序与本地顺序相反，但请求/响应体里带了原始文件名 → 可以还原正确配对。
  const captured = [
    { uri: REAL_URI_B, fileNameHints: ["reference-2.png"] },
    { uri: REAL_URI_A, fileNameHints: ["reference-1.png"] },
  ];
  const paired = pairCapturedUris(paths, captured);
  assert.equal(paired.pairing, "file-name");
  assert.deepEqual(paired.uris, [REAL_URI_A, REAL_URI_B]);

  // 只有一半能对上时不许半可信——退回顺序，避免把 uri 配到错的图上。
  const partial = [
    { uri: REAL_URI_B, fileNameHints: ["reference-2.png"] },
    { uri: REAL_URI_A, fileNameHints: [] },
  ];
  const fallback = pairCapturedUris(paths, partial);
  assert.equal(fallback.pairing, "arrival-order");
  assert.deepEqual(fallback.uris, [REAL_URI_B, REAL_URI_A]);
});

test("pairCapturedUris 在 uri 数不足时如实返回，交给上层显式报错", () => {
  const paths = ["C:/tmp/reference-1.png", "C:/tmp/reference-2.png", "C:/tmp/reference-3.png"];
  const paired = pairCapturedUris(paths, [{ uri: REAL_URI_A, fileNameHints: [] }]);
  assert.equal(paired.uris.length, 1);
  // 上层据此抛 REFERENCE_URI_INCOMPLETE（1/3）——绝不静默少发两张。
  assert.equal(paired.pairing, "arrival-order");
  assert.deepEqual(pairCapturedUris(["C:/tmp/a.png"], []), { uris: [], pairing: "arrival-order" });
});

test("参考图张数上限是显式常量，供 main.cjs 复用（不再各处写死）", () => {
  assert.equal(MAX_REFERENCE_IMAGES, 10);
});

// ---------- 运镜参数：去硬编码，但默认值保持不变 ----------

test("resolveCameraMovement 默认仍是 fixed（不改变已验证路径），显式值才覆盖", () => {
  // 默认必须等于修复前的行为，否则等于偷偷改了已验证的通路。
  assert.equal(resolveCameraMovement(undefined), "fixed");
  assert.equal(resolveCameraMovement(""), "fixed");
  assert.equal(resolveCameraMovement("   "), "fixed");
  assert.equal(resolveCameraMovement(null), "fixed");
  // 需要验证「机位锁死是不是成片元凶」时，可以显式传别的值跑对比。
  assert.equal(resolveCameraMovement("auto"), "auto");
  assert.equal(resolveCameraMovement(" fixed "), "fixed");
});
