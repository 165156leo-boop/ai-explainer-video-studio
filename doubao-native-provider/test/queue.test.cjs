const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadSchedule(executeJob) {
  const source = readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  const code = source.slice(source.indexOf("function schedule(job)"), source.indexOf("\nfunction json("));
  const context = vm.createContext({ accountQueues: new Map(), executeJob });
  vm.runInContext(code, context);
  return context;
}

test("failed jobs are caught and do not poison the account queue", async () => {
  const context = loadSchedule(async (job) => {
    if (job.fail) throw new Error("simulated failure");
  });
  await assert.rejects(context.schedule({ account_id: "A", media_type: "image", fail: true }), /simulated failure/);
  await context.schedule({ account_id: "A", media_type: "image" });
  await new Promise((done) => setImmediate(done));
  assert.equal(context.accountQueues.size, 0);
});

test("one account runs two image jobs concurrently and queues the third", async () => {
  const releases = [];
  let active = 0;
  let peak = 0;
  const context = loadSchedule(() => new Promise((resolve) => {
    active += 1;
    peak = Math.max(peak, active);
    releases.push(() => {
      active -= 1;
      resolve();
    });
  }));
  const jobs = [1, 2, 3].map((index) =>
    context.schedule({ account_id: "A", media_type: "image", index }),
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(peak, 2);
  assert.equal(releases.length, 2);
  releases.shift()();
  await new Promise((done) => setImmediate(done));
  assert.equal(releases.length, 2);
  releases.splice(0).forEach((release) => release());
  await Promise.all(jobs);
});
