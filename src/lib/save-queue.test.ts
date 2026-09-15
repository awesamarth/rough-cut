import { expect, test } from "bun:test";
import { SaveQueue } from "./save-queue";

test("a failed snapshot prevents every later queued snapshot from being sent", async () => {
  const queue = new SaveQueue();
  const sent: number[] = [];
  const first = queue.enqueue(async () => { sent.push(1); throw new Error("Conflict at remote version 2"); });
  const second = queue.enqueue(async () => { sent.push(2); });
  await expect(first).rejects.toThrow("Conflict");
  await expect(second).rejects.toThrow("Conflict");
  await expect(queue.flush()).rejects.toThrow("Conflict");
  expect(sent).toEqual([1]);
  expect(() => queue.assertWritable()).toThrow("blocked");
});

test("durability waits for all ordered writes", async () => {
  const queue = new SaveQueue();
  const sent: number[] = [];
  queue.enqueue(async () => { await Promise.resolve(); sent.push(1); });
  queue.enqueue(async () => { sent.push(2); });
  await queue.flush();
  expect(sent).toEqual([1, 2]);
});
