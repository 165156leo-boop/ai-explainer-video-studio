export type PolishTask = {
  run: () => Promise<void>;
};

/**
 * A serial queue with an explicit priority lane for user-triggered polish work.
 * reset() drops only tasks that have not started; in-flight work must invalidate itself.
 */
export class PolishLane {
  private queue: PolishTask[] = [];
  private running = false;

  enqueue(task: PolishTask, priority = false) {
    if (priority) this.queue.unshift(task);
    else this.queue.push(task);
    void this.drain();
  }

  reset() {
    this.queue = [];
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift();
        if (!task) break;
        try {
          await task.run();
        } catch {
          // One failed request must not block later queued work.
        }
      }
    } finally {
      this.running = false;
    }
  }
}
