// bun run scripts/check-browser-media.ts
// Uses an isolated temporary browser profile; never opens the owner's real profile or cloud endpoints.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const browser = process.env.BROWSER_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const directory = await mkdtemp(path.join(tmpdir(), "rough-cut-media-check-"));
const build = await Bun.build({ entrypoints: ["scripts/browser-media-probe.ts", "src/lib/media-analysis.worker.ts", "src/lib/export.worker.ts"], target: "browser", outdir: directory, naming: "[name].js" });
if (!build.success) throw new Error(build.logs.join("\n"));
const delayed = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=30", "-itsoffset", "0.25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-c:a", "aac", path.join(directory, "delayed.mp4")], { stdout: "ignore", stderr: "inherit" });
if (await delayed.exited) { await rm(directory, { recursive: true, force: true }); throw new Error("Delayed-audio fixture failed"); }
const silent = Bun.spawn(["ffmpeg", "-v", "error", "-i", path.join(directory, "delayed.mp4"), "-an", "-vf", "select='if(lt(t,1),not(mod(n,3)),1)'", "-fps_mode", "vfr", path.join(directory, "silent-vfr.mp4")], { stdout: "ignore", stderr: "inherit" });
if (await silent.exited) { await rm(directory, { recursive: true, force: true }); throw new Error("Silent VFR fixture failed"); }
let finish!: (result: { ok: boolean; error?: string; [key: string]: unknown }) => void;
const result = new Promise<{ ok: boolean; error?: string; [key: string]: unknown }>((resolve) => { finish = resolve; });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/cloud-test-enabled") return Response.json(!!process.env.CLOUD_TEST_ORIGIN);
    if (url.pathname === "/api/outputs" && process.env.CLOUD_TEST_ORIGIN) {
      const target = new URL(url.pathname + url.search, process.env.CLOUD_TEST_ORIGIN);
      const headers = new Headers(request.headers); headers.set("host", url.host);
      return fetch(new Request(target, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit));
    }
    if (url.pathname === "/result" && request.method === "POST") { finish(await request.json()); return new Response("ok"); }
    if (url.pathname === "/") return new Response('<!doctype html><title>Local media smoke test</title><script type="module" src="/browser-media-probe.js"></script>', { headers: { "content-type": "text/html" } });
    if (["/delayed.mp4", "/silent-vfr.mp4"].includes(url.pathname)) return new Response(Bun.file(path.join(directory, url.pathname.slice(1))));
    if (["/fonts/DejaVuSans-Bold.ttf", "/fonts/Inter.ttf"].includes(url.pathname)) return new Response(Bun.file(`public${url.pathname}`), { headers: { "content-type": "font/ttf" } });
    const name = url.pathname === "/browser-media-probe.js" ? "browser-media-probe.js" : url.pathname === "/media-analysis.worker.ts" ? "media-analysis.worker.js" : url.pathname === "/export.worker.ts" ? "export.worker.js" : null;
    if (!name) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(path.join(directory, name)), { headers: { "content-type": "text/javascript" } });
  },
});
const child = Bun.spawn([browser, "--headless=new", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", `--user-data-dir=${path.join(directory, "profile")}`, `http://127.0.0.1:${server.port}/`], { stdout: "ignore", stderr: "pipe" });
const logs = new Response(child.stderr).text();
const timeout = setTimeout(() => finish({ ok: false, error: "Browser media check timed out after 90 seconds" }), 90_000);
try {
  const report = await result;
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.kill();
  await child.exited;
  const stderr = await logs;
  if (process.exitCode) console.error(stderr.slice(-6000));
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
