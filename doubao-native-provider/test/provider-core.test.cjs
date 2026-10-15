const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const {
  VIDEO_DAILY_QUOTA_SECONDS,
  applyVideoQuotaUsage,
  assertReferencePath,
  buildUnwatermarkedVideoApi,
  decodeVideoMainUrl,
  extensionForContentType,
  extractArtifactUrls,
  extractPreferredArtifacts,
  isLoopbackHost,
  isPathInside,
  isReadyArtifactCandidate,
  markVideoQuotaExhausted,
  normalizedPixelDifference,
  publicAccount,
  safeAccountId,
  selectBestVideoArtifact,
  videoQuotaState,
  videoQuotaText,
} = require("../src/provider-core.cjs");

test("provider only accepts loopback hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("account ids are stable safe slugs", () => {
  assert.equal(safeAccountId("豆包 Account A / 01"), "account-a-01");
  assert.equal(safeAccountId("Primary_User"), "primary_user");
});

test("reference paths cannot escape the workbench request folder", () => {
  const root = path.resolve("C:/workbench/media-requests");
  const accepted = path.resolve(root, "job-1", "reference.png");
  assert.equal(isPathInside(accepted, root), true);
  assert.equal(assertReferencePath(accepted, root), accepted);
  assert.equal(isPathInside(path.resolve(root, "../secret.txt"), root), false);
  assert.throws(() => assertReferencePath(path.resolve(root, "../secret.txt"), root), /允许的目录/);
});

test("content types receive workbench-compatible file extensions", () => {
  assert.equal(extensionForContentType("image/webp", "image"), ".webp");
  assert.equal(extensionForContentType("video/mp4", "video"), ".mp4");
  assert.equal(extensionForContentType("", "image"), ".png");
});

test("artifact URLs are recovered from escaped Doubao responses", () => {
  const body = String.raw`{"url":"https:\/\/example.byteimg.com\/result.webp?x=1","icon":"https://example.com/icon.svg"}`;
  assert.deepEqual(extractArtifactUrls(body, "image"), ["https://example.byteimg.com/result.webp?x=1"]);
  assert.deepEqual(extractArtifactUrls('{"play":"https://cdn.example.com/a.mp4?token=x"}', "video"), ["https://cdn.example.com/a.mp4?token=x"]);
});

test("near-identical image previews can be grouped", () => {
  assert.equal(normalizedPixelDifference(Buffer.from([0, 10, 20]), Buffer.from([0, 10, 20])), 0);
  assert.ok(normalizedPixelDifference(Buffer.from([0, 10, 20]), Buffer.from([1, 11, 21])) < 0.01);
  assert.ok(normalizedPixelDifference(Buffer.from([0, 10, 20]), Buffer.from([200, 210, 220])) > 0.5);
});

test("structured Doubao responses prefer image_ori_raw and preserve its dimensions", () => {
  const content = JSON.stringify({
    creations: [{
      image: {
        key: "image-1",
        image_ori_raw: { url: "https://p.example.byteimg.com/raw.webp?x=1&amp;y=2", width: 2848, height: 1600 },
        image_ori: { url: "https://p.example.byteimg.com/watermarked.webp" },
      },
    }],
  });
  const body = `data: ${JSON.stringify({ event_data: JSON.stringify({ message: { content } }) })}\n\n`;
  assert.deepEqual(extractPreferredArtifacts(body, "image"), [{
    url: "https://p.example.byteimg.com/raw.webp?x=1&y=2",
    kind: "image",
    width: 2848,
    height: 1600,
    key: "image-1",
    priority: 100,
    source: "image_ori_raw",
  }]);
});

test("generic response URLs cannot masquerade as completed images", () => {
  assert.equal(isReadyArtifactCandidate({ url: "https://example.com/image-api", source: "generic" }, "image"), false);
  assert.equal(isReadyArtifactCandidate({ url: "https://example.com/result.webp", source: "image_ori_raw" }, "image"), true);
  assert.equal(isReadyArtifactCandidate({ url: "https://example.com/result.webp", width: 2048, height: 1152 }, "image"), true);
  assert.equal(isReadyArtifactCandidate({ url: "https://example.com/icon.webp", width: 256, height: 256 }, "image"), false);
});

test("generic response URLs cannot masquerade as completed videos", () => {
  assert.equal(isReadyArtifactCandidate({ url: "https://www.doubao.com/api/create-video", source: "generic" }, "video"), false);
  assert.equal(isReadyArtifactCandidate({ url: "https://cdn.example.com/result.mp4?token=x", source: "generic" }, "video"), true);
  assert.equal(isReadyArtifactCandidate({ url: "", vid: "video-1", source: "creation_video" }, "video"), true);
});

test("structured Doubao responses retain video ids and trusted fallback APIs", () => {
  const body = JSON.stringify({
    patch_op: [{
      patch_value: {
        content_block: [{
          content: {
            creation_block: {
              creations: [{ video: { vid: "video-1", fallback_api: "https://v26.douyinvod.com/video/fplay/?logo_type=watermarked" } }],
            },
          },
        }],
      },
    }],
  });
  assert.deepEqual(extractPreferredArtifacts(body, "video"), [{
    identity: "video:video-1",
    url: "",
    vid: "video-1",
    fallbackApi: "https://v26.douyinvod.com/video/fplay/?logo_type=watermarked",
    kind: "video",
    width: 0,
    height: 0,
    priority: 100,
    source: "creation_video",
  }]);
});

test("video fallback URLs are restricted and request the unwatermarked codec", () => {
  const url = new URL(buildUnwatermarkedVideoApi("https://v26.douyinvod.com/video/fplay/?logo_type=watermarked&codec_type=0"));
  assert.equal(url.searchParams.get("logo_type"), "unwatermarked");
  assert.equal(url.searchParams.get("codec_type"), "8");
  assert.throws(() => buildUnwatermarkedVideoApi("https://evil.example/video/fplay/?x=1"), /受信任/);
});

test("video responses select the largest stream and decode qAAB URLs", () => {
  const url = "https://v26.douyinvod.com/video/original.mp4?token=test";
  const seed = Buffer.alloc(32, 7);
  const salt = Buffer.from(
    "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
    "hex",
  );
  const firstDigest = crypto.createHash("sha512").update(seed).digest();
  const material = crypto.createHash("sha512").update(Buffer.concat([firstDigest, salt])).digest();
  const cipher = crypto.createCipheriv("aes-128-cbc", material.subarray(0, 16), material.subarray(16, 32));
  const encrypted = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const token = Buffer.concat([Buffer.from([0xa8, 0x00, 0x01, 0x00]), encrypted]).toString("base64");
  assert.equal(decodeVideoMainUrl(token, seed.toString("base64")), url);

  const result = selectBestVideoArtifact({
    video_info: {
      data: {
        vid: "video-1",
        key_seed: seed.toString("base64"),
        video_list: [
          { main_url: Buffer.from("https://cdn.example/720.mp4").toString("base64"), vwidth: 1280, vheight: 720, bitrate: 2 },
          { main_url: token, vwidth: 1920, vheight: 1080, bitrate: 5 },
        ],
      },
    },
  });
  assert.equal(result.url, url);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
});

// 2026-09-16 用户实测的额度模型：额度按 5 秒为单位发放，每天约 10 个单位 = 50 秒，
// 消耗按视频秒数计——所以「额度够不够」必须按本次时长判断，不能只看「有没有剩余」。
test("video quota is metered in seconds, not in number of clips", () => {
  assert.equal(VIDEO_DAILY_QUOTA_SECONDS, 50);

  const fresh = videoQuotaState({});
  assert.equal(fresh.remaining_seconds, 50);
  assert.equal(fresh.can_5s, 10, "50 秒能出 10 条 5 秒");
  assert.equal(fresh.can_10s, 5, "50 秒能出 5 条 10 秒");
  assert.equal(fresh.can_15s, 3, "50 秒能出 3 条 15 秒，还剩 1 个 5 秒单位");

  const account = { account_id: "a", video_quota_day: fresh.day, video_quota_used_seconds: 45 };
  const afterThree15s = videoQuotaState(account);
  assert.equal(afterThree15s.remaining_seconds, 5);
  assert.equal(afterThree15s.can_15s, 0, "剩 5 秒装不下 15 秒镜头");
  assert.equal(afterThree15s.can_5s, 1, "但还够一条 5 秒镜头——不能整个账号一刀切跳过");
  assert.match(videoQuotaText(afterThree15s), /剩余视频额度 5 秒/);
});

test("consuming quota accumulates within the day and resets on a new day", () => {
  const account = {};
  applyVideoQuotaUsage(account, 15, "2026-09-16");
  applyVideoQuotaUsage(account, 10, "2026-09-16");
  assert.equal(videoQuotaState(account, "2026-09-16").used_seconds, 25);
  assert.equal(videoQuotaState(account, "2026-09-16").remaining_seconds, 25);
  // 跨天自动回满（读路径不写回账号）
  assert.equal(videoQuotaState(account, "2026-09-17").remaining_seconds, 50);
  // 消耗时跨天会先把账面归零再扣
  applyVideoQuotaUsage(account, 15, "2026-09-17");
  assert.equal(account.video_quota_day, "2026-09-17");
  assert.equal(account.video_quota_used_seconds, 15);
});

test("a Doubao quota refusal zeroes the rest of the day for that account", () => {
  const account = { video_quota_day: "2026-09-16", video_quota_used_seconds: 10 };
  const quota = markVideoQuotaExhausted(account, "2026-09-16");
  assert.equal(quota.remaining_seconds, 0);
  assert.equal(quota.exhausted, true);
  assert.equal(quota.can_5s, 0);
  assert.match(videoQuotaText(quota), /已用完/);
  // 第二天自然回满
  assert.equal(videoQuotaState(account, "2026-09-17").remaining_seconds, 50);
});

test("publicAccount exposes the seconds-based remaining quota", () => {
  const view = publicAccount({
    account_id: "2",
    display_name: "豆包账号 2",
    video_quota_day: videoQuotaState({}).day,
    video_quota_used_seconds: 45,
  });
  assert.equal(view.video_quota_remaining_seconds, 5);
  assert.equal(view.video_quota_can_15s, 0);
  assert.equal(view.video_quota_can_5s, 1);
  assert.equal(view.video_quota_total_seconds, 50);
  assert.match(view.video_quota_text, /剩余视频额度 5 秒/);
  assert.match(view.quota_balance_text, /剩余视频额度 5 秒/);
});
