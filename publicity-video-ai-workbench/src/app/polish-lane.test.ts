import assert from "node:assert/strict";
import { PolishLane } from "./polish-lane.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const firstStarted = deferred<void>();
const releaseFirst = deferred<void>();
const order: string[] = [];
const lane = new PolishLane();

lane.enqueue({
  run: async () => {
    order.push("first:start");
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push("first:end");
  },
});
await firstStarted.promise;
lane.enqueue({ run: async () => { order.push("normal"); } });
lane.enqueue({ run: async () => { order.push("priority"); } }, true);
releaseFirst.resolve();
await new Promise((done) => setImmediate(done));
await new Promise((done) => setImmediate(done));
assert.deepEqual(order, ["first:start", "first:end", "priority", "normal"]);

const secondStarted = deferred<void>();
const releaseSecond = deferred<void>();
const resetOrder: string[] = [];
const resetLane = new PolishLane();
resetLane.enqueue({
  run: async () => {
    resetOrder.push("in-flight:start");
    secondStarted.resolve();
    await releaseSecond.promise;
    resetOrder.push("in-flight:end");
  },
});
await secondStarted.promise;
resetLane.enqueue({ run: async () => { resetOrder.push("discarded"); } });
resetLane.reset();
releaseSecond.resolve();
await new Promise((done) => setImmediate(done));
assert.deepEqual(resetOrder, ["in-flight:start", "in-flight:end"]);

const recoveryOrder: string[] = [];
const recoveryLane = new PolishLane();
recoveryLane.enqueue({
  run: async () => {
    recoveryOrder.push("failed");
    throw new Error("expected");
  },
});
recoveryLane.enqueue({ run: async () => { recoveryOrder.push("after-failure"); } });
await new Promise((done) => setImmediate(done));
await new Promise((done) => setImmediate(done));
assert.deepEqual(recoveryOrder, ["failed", "after-failure"]);

console.log("polish lane checks passed");
