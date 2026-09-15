import { expect, test } from "bun:test";
import { VideoRenderer } from "./video-renderer";
import { createProjectState } from "./editor";

const state = createProjectState("00000000-0000-4000-8000-000000000000", "Cleanup", 3000);
const context = {} as OffscreenCanvasRenderingContext2D;

test("dispose waits for drawing and returns prefetched-frame iterators before disposing input", async () => {
  const events: string[] = [];
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const readers = new Map();
  const renderer = Object.assign(Object.create(VideoRenderer.prototype) as object, {
    pending: Promise.resolve(), readers,
    input: { dispose() { events.push("input closed"); } },
    async render() {
      started.resolve(); await release.promise;
      const iterator = (async function* () {
        try { yield "prefetched frame"; } finally { events.push("samples closed"); }
      })();
      await iterator.next();
      readers.set("late reader", { close: () => iterator.return() });
      events.push("draw finished");
    },
  }) as unknown as VideoRenderer;
  const draw = renderer.draw(context, state, 0);
  await started.promise;
  const closing = renderer.dispose();
  expect(renderer.dispose()).toBe(closing);
  expect(events).toEqual([]);
  await expect(renderer.draw(context, state, 1)).rejects.toThrow("Renderer closed");
  release.resolve();
  await draw; await closing;
  expect(events).toEqual(["draw finished", "samples closed", "input closed"]);
  expect(readers.size).toBe(0);
});

test("failed drawing/reader cleanup still closes every reader and the input", async () => {
  const events: string[] = [];
  const renderer = Object.assign(Object.create(VideoRenderer.prototype) as object, {
    pending: Promise.resolve(),
    readers: new Map([
      ["bad", { close: async () => { throw new Error("close failed"); } }],
      ["good", { close: async () => { events.push("reader closed"); } }],
    ]),
    input: { dispose() { events.push("input closed"); } },
    async render() { throw new Error("draw failed"); },
  }) as unknown as VideoRenderer;
  await expect(renderer.draw(context, state, 0)).rejects.toThrow("draw failed");
  await expect(renderer.dispose()).rejects.toThrow("close failed");
  expect(events).toEqual(["reader closed", "input closed"]);
});
