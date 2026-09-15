import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { serveCloudOutput } from "./cloud-outputs";
import { OUTPUT_CHUNK_BYTES as CHUNK } from "./cloud-output-writer";

// Miniflare transfers Web Streams: run this check in Node, not Bun's incomplete stream-clone implementation.
test("local D1/R2 output admission, capabilities, CAS parts, ranges and cancellation", { skip: !!process.versions.bun, timeout: 150000 }, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('local test'); } }", compatibilityDate: "2026-01-01", d1Databases: { DB: "output-test" }, r2Buckets: ["OUTPUTS"] }));
  try {
    const DB = await mf.getD1Database("DB") as unknown as D1Database;
    const OUTPUTS = await mf.getR2Bucket("OUTPUTS") as unknown as R2Bucket;
    for (const name of ["0002_cloud_usage.sql", "0003_cloud_outputs.sql"]) {
      for (const sql of (await readFile(`migrations/${name}`, "utf8")).replace(/--[^\n]*/g, "").split(";")) if (sql.trim()) await DB.prepare(sql).run();
    }
    const env = { DB, OUTPUTS, CLOUD_OUTPUT_DAILY_MIB: "64", CLOUD_OUTPUT_LIFECYCLE_READY: "1" };
    const request = (method: string, query = "", body?: BodyInit, headers: Record<string, string> = {}) => new Request(`http://localhost/api/outputs${query}`, { method, body, headers: { origin: "http://localhost", ...headers } });
    const admit = () => serveCloudOutput(request("POST", "", JSON.stringify({ filename: "test.mp4", maxBytes: CHUNK * 2 })), env);
    assert.equal((await serveCloudOutput(request("POST"), { ...env, CLOUD_OUTPUT_DAILY_MIB: "0" })).status, 503);
    assert.equal((await serveCloudOutput(request("POST", "", "{}", { origin: "https://other.example" }), env)).status, 403);
    assert.equal((await serveCloudOutput(request("POST"), { ...env, CLOUD_OUTPUT_LIFECYCLE_READY: "0" })).status, 503);
    assert.equal((await serveCloudOutput(request("POST", "", "{}", { host: "127.0.0.1", origin: "http://127.0.0.1" }), env)).status, 400); // Same host, invalid body, no admission.
    assert.equal((await serveCloudOutput(request("POST", "", "{}", { host: "127.0.0.1" }), env)).status, 403);
    assert.equal((await serveCloudOutput(request("POST", "", "{}", { host: "localhost", origin: "https://other.example", "x-forwarded-host": "other.example" }), env)).status, 403);
    const admission = await admit();
    assert.match(admission.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const cookie = admission.headers.get("set-cookie")!.split(";")[0];
    const session = await admission.json() as { id: string };
    assert.equal("token" in session, false);
    const second = await admit(); assert.equal(second.status, 200);
    const secondCookie = second.headers.get("set-cookie")!.split(";")[0];
    const secondSession = await second.json() as { id: string };
    assert.equal((await admit()).status, 429);
    const query = `?id=${session.id}`, auth = { cookie };
    assert.equal((await serveCloudOutput(request("GET", query), env)).status, 404);
    assert.equal((await serveCloudOutput(request("GET", query, undefined, { cookie: `rc-output-${session.id}=${"0".repeat(64)}` }), env)).status, 410);
    assert.equal((await serveCloudOutput(request("PUT", `${query}&part=2`, new Uint8Array([1]), auth), env)).status, 400);
    assert.equal((await serveCloudOutput(request("PUT", `${query}&part=1`, new Uint8Array(64).fill(9), auth), env)).status, 200);
    const first = new Uint8Array(CHUNK).fill(1); first.set(new TextEncoder().encode("ftyp"), 4);
    const writes = await Promise.all([0, 1].map(() => serveCloudOutput(request("PUT", `${query}&part=0`, first, auth), env)));
    assert.deepEqual(writes.map((value) => value.status).sort(), [200, 409]);
    assert.equal((await serveCloudOutput(request("POST", query, JSON.stringify({ bytes: CHUNK }), auth), env)).status, 409);
    assert.equal((await serveCloudOutput(request("POST", query, JSON.stringify({ bytes: CHUNK + 64 }), auth), env)).status, 200);
    const range = await serveCloudOutput(request("GET", query, undefined, { cookie, range: `bytes=${CHUNK - 4}-${CHUNK + 3}` }), env);
    assert.equal(range.status, 206);
    assert.deepEqual([...new Uint8Array(await range.arrayBuffer())], [1, 1, 1, 1, 9, 9, 9, 9]);
    for (let index = 0; index < 9; index++) {
      const download = await serveCloudOutput(request("GET", query, undefined, { ...auth, range: "bytes=0-0" }), env);
      assert.equal(download.status, 206); await download.arrayBuffer();
    }
    assert.equal((await serveCloudOutput(request("GET", query, undefined, auth), env)).status, 429);
    assert.equal((await serveCloudOutput(request("DELETE", query, undefined, auth), env)).status, 200);
    assert.equal((await OUTPUTS.list({ prefix: `rough-cut-output/${session.id}/` })).objects.length, 0);
    assert.equal((await serveCloudOutput(request("GET", query, undefined, auth), env)).status, 409);
    assert.equal((await serveCloudOutput(request("POST", "", JSON.stringify({ filename: "test.mp4", maxBytes: 1 })), { ...env, CLOUD_OUTPUT_DAILY_MIB: "1" })).status, 429);
    await DB.prepare("UPDATE cloud_outputs SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, secondSession.id).run();
    assert.equal((await serveCloudOutput(request("PUT", `?id=${secondSession.id}&part=0`, new Uint8Array([1]), { cookie: secondCookie }), env)).status, 410);
    if (process.env.CLOUD_BROWSER_TEST === "1") {
      env.CLOUD_OUTPUT_DAILY_MIB = "512";
      const server = createServer(async (req, res) => {
        try {
          const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Readable.toWeb(req), duplex: "half" } as RequestInit);
          const response = await serveCloudOutput(request, env);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream).pipe(res);
          else res.end();
        } catch { res.writeHead(500); res.end("Local output test service failed"); }
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      const child = spawn("bun", ["run", "scripts/check-browser-media.ts"], { stdio: "inherit", env: { ...process.env, CLOUD_TEST_ORIGIN: `http://127.0.0.1:${port}` } });
      try { const [code] = await once(child, "exit"); assert.equal(code, 0, "Browser/local-R2 export failed"); }
      finally { child.kill(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  } finally { await mf.dispose(); }
});
