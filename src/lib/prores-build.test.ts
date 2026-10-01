import { expect, test } from "bun:test";
import { createRequire } from "node:module";
const requireLoader = createRequire(import.meta.url);
const lower = requireLoader("../../scripts/prores-build-loader.cjs") as (this: { resourcePath: string }, source: string) => string;

test("ProRes build preprocessing preserves NUL/digit payload bytes and template interpolation", () => {
  const original = 'const suffix = "ok"; const payload = `\\x000!e\\x001\\x009\\x00${suffix}\\\\end`;';
  const transformed = lower.call({ resourcePath: "mediabunny-prores.mjs" }, original);
  const evaluate = (source: string): string => new Function(`${source}; return payload;`)();
  expect(evaluate(transformed)).toBe(evaluate(original));
  expect([...evaluate(transformed)].map((char) => char.charCodeAt(0))).toEqual([...evaluate(original)].map((char) => char.charCodeAt(0)));
  expect(transformed).not.toContain("`");
});
