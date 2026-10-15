const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
// Electron 44 downloads its runtime lazily through the package entry point.
// Resolving it here keeps a clean `npm ci` checkout runnable.
const electron = require("electron");
const port = 18120 + Math.floor(Math.random() * 400);

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/providers/doubao/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("fake provider did not start");
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "doubao-native-smoke-"));
  const child = spawn(electron, ["--disable-gpu", "--in-process-gpu", root], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DOUBAO_NATIVE_FAKE: "1",
      DOUBAO_NATIVE_PORT: String(port),
      DOUBAO_NATIVE_DATA: temporary,
    },
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    const health = await waitForHealth();
    assert.equal(health.provider, "doubao-native-electron");
    const accounts = await fetch(`http://127.0.0.1:${port}/providers/doubao/accounts`).then((response) => response.json());
    assert.equal(accounts.accounts.length, 1);
    const generated = await fetch(`http://127.0.0.1:${port}/providers/doubao/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: "default", prompt: "contract smoke test" }),
    }).then(async (response) => {
      assert.equal(response.status, 200);
      return response.json();
    });
    assert.equal(generated.data.length, 1);
    const media = await fetch(generated.data[0].url);
    assert.equal(media.headers.get("content-type"), "image/png");
    assert.ok((await media.arrayBuffer()).byteLength > 20);
    const persistedJobs = JSON.parse(await readFile(path.join(temporary, "jobs.json"), "utf8"));
    assert.equal(persistedJobs[0].status, "succeeded");
    console.log(`fake provider smoke passed on ${port}`);
    await fetch(`http://127.0.0.1:${port}/__test/shutdown`, { method: "POST" }).catch(() => undefined);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!child.killed) child.kill();
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
