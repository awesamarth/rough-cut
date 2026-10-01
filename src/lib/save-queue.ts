/** Serial optimistic snapshots must stop together after any ambiguous/failed save. */
export class SaveQueue {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private blocked = false;

  enqueue(save: () => Promise<void>): Promise<void> {
    const task = this.tail.then(async () => {
      this.assertWritable();
      try { await save(); }
      catch (error) { this.failure = error; this.blocked = true; throw error; }
    });
    // Observe the rejection, but preserve it for callers awaiting durability.
    this.tail = task;
    void task.catch(() => {});
    return task;
  }

  block(error: unknown) { this.failure = error; this.blocked = true; }

  assertWritable() {
    if (this.blocked) throw new Error("Saving is blocked. Back up your unsaved edits before reloading.", { cause: this.failure });
  }

  async flush() { await this.tail; }
}
