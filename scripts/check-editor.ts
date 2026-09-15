// bun run build && bun run scripts/check-editor.ts
// Isolated local app/profile and synthetic media; never uses the owner's browser or cloud APIs.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const uiOnly = process.env.UI_ONLY === "1";
const libraryOnly = process.env.LIBRARY_ONLY === "1";
const acceptDialog = true;
const dialogs: string[] = [];
const duration = Number(process.env.MEDIA_TEST_SECONDS || (uiOnly ? 10 : 3));
if (!Number.isInteger(duration) || duration < 3 || duration > 600) throw new Error("MEDIA_TEST_SECONDS must be an integer from 3 to 600");
const directory = await mkdtemp(path.join(tmpdir(), "rough-cut-editor-check-"));
const fixture = path.join(directory, "fixture.mp4");
let backupFile: string | undefined;
const fixtureServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new Response(Bun.file(new URL(request.url).pathname === "/backup" && backupFile ? backupFile : fixture), { headers: { "Access-Control-Allow-Origin": "*" } }) });
const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = reservation.port; reservation.stop();
let app: ReturnType<typeof Bun.spawn> | undefined;
let browser: ReturnType<typeof Bun.spawn> | undefined;
let socket: WebSocket | undefined;
let sequence = 0;
let memoryTimer: ReturnType<typeof setInterval> | undefined;
const memorySamples: number[] = [];
function sampleBrowserMemory() {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="]);
  if (ps.exitCode || !browser) return;
  const rows = new TextDecoder().decode(ps.stdout).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const pids = new Set([browser.pid]);
  for (let previous = -1; previous !== pids.size;) {
    previous = pids.size;
    for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
  }
  memorySamples.push(rows.reduce((sum, [pid, , rss]) => sum + (pids.has(pid) ? rss : 0), 0) / 1024);
}
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const errors: string[] = [];
const apiRequests: string[] = [];
async function until<T>(check: () => Promise<T>, label: string, milliseconds = 30000): Promise<NonNullable<T>> {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await Bun.sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
function cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, Math.max(60000, duration * 2000));
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value as T); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket!.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate<T = unknown>(expression: string): Promise<T> {
  const value = await cdp<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
const tool = (name: string, input: unknown = {}) => evaluate(`window.testTools.get(${JSON.stringify(name)}).execute(${JSON.stringify(input)})`);
async function selectFile(backup = false) {
  await evaluate(`(async () => {
    const file = new File([await (await fetch('http://127.0.0.1:${fixtureServer.port}${backup ? "/backup" : ""}')).blob()], '${backup ? "backup.json" : "fixture.mp4"}', {type:'${backup ? "application/json" : "video/mp4"}', lastModified:1000});
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('input[type=file][accept${backup ? "^=\"application/json\"" : "=\"video/*\""}]');
    input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
}
function assert(value: unknown, message: string) { if (!value) throw new Error(message); }

try {
  const make = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", String(duration), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture], { stdout: "ignore", stderr: "inherit" });
  if (await make.exited) throw new Error("Fixture generation failed");
  app = Bun.spawn(["bun", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { stdout: "ignore", stderr: "inherit" });
  await until(async () => (await fetch(`http://127.0.0.1:${port}`)).ok, "local app");
  browser = Bun.spawn([process.env.BROWSER_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${path.join(directory, "profile")}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const debugPort = await until(async () => Number((await readFile(path.join(directory, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]), "browser debugger");
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    return targets.find((target) => target.type === "page");
  }, "browser page target");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Debugger connection failed")); });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) { const task = pending.get(message.id); pending.delete(message.id); if (message.error) task?.reject(new Error(JSON.stringify(message.error))); else task?.resolve(message.result); }
    if (message.method === "Page.javascriptDialogOpening") { dialogs.push(message.params.message); void cdp("Page.handleJavaScriptDialog", { accept: acceptDialog }); }
    if (message.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(message.params.exceptionDetails));
    if (message.method === "Network.requestWillBeSent" && message.params.request.url.includes("/api/")) apiRequests.push(message.params.request.url);
  };
  await cdp("Runtime.enable"); await cdp("Network.enable"); await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Network.setBlockedURLs", { urls: ["*/api/*"] });
  await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.testTools = new Map(); Object.defineProperty(document, 'modelContext', {value:{registerTool:async (tool, options) => { window.testTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.testTools.delete(tool.name)); }}});` });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}` });
  await until(() => evaluate("window.testTools?.has('request_video_upload')"), "hydrated video picker");
  assert(await evaluate("document.querySelector('input[type=checkbox]').checked === false"), "Auto transcription was enabled without consent");
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await cdp("Page.reload");
  await until(() => evaluate("window.testTools?.has('request_video_upload') && document.querySelector('input[type=checkbox]')?.checked"), "remembered auto transcription preference");
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await selectFile();
  await until(() => evaluate("location.pathname.startsWith('/editor/') && !!document.querySelector('canvas')"), "local editor");
  await until(() => tool("get_project_state"), "project tools");
  if (libraryOnly) {
    await until(() => evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent==='Add B-roll brief')"), 'source clip selected on load');
    const snapBorder = await evaluate<string>("getComputedStyle([...document.querySelectorAll('button')].find(button=>button.textContent==='Snap')).borderColor");
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Snap').click()");
    await until(() => evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Snap').getAttribute('aria-pressed')==='false'"), 'snap toggle off');
    assert(await evaluate(`getComputedStyle([...document.querySelectorAll('button')].find(button=>button.textContent==='Snap')).borderColor !== ${JSON.stringify(snapBorder)}`), 'Snap highlight did not change');
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Snap').click()");
    await evaluate("document.querySelector('.timeline-track').click()");
    await until(() => evaluate("document.body.innerText.includes('Select a clip, text or music to edit.')"), 'manual deselection stays cleared');
    const nKey = async (repeat = false) => {
      await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'n',code:'KeyN',text:'n',windowsVirtualKeyCode:78,autoRepeat:repeat});
      await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'n',code:'KeyN',windowsVirtualKeyCode:78});
    };
    const snapOn = () => evaluate<boolean>("[...document.querySelectorAll('button')].find(button=>button.textContent==='Snap').getAttribute('aria-pressed')==='true'");
    await nKey(); await until(async () => !await snapOn(), 'N toggles persistent snapping off');
    await nKey(true); assert(!await snapOn(), 'Held N repeatedly toggled snapping');
    await nKey(); await until(snapOn, 'N toggles persistent snapping on');
    for (const baseline of [true, false]) {
      if ((await snapOn()) !== baseline) await nKey();
      const point = await evaluate<{x:number;y:number}>("(() => { const r=document.querySelector('.timeline-track').getBoundingClientRect(); return {x:r.left+6,y:r.top-10}; })()");
      await cdp('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
      await nKey();
      await until(async () => (await snapOn()) !== baseline, 'N overrides snapping during drag, even after key release');
      await until(() => evaluate(`Number(document.querySelector('[aria-label=Playhead]').value) ${baseline ? '> 0' : '=== 0'}`), 'stationary drag recalculates actual snapped position');
      await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:1});
      await until(async () => (await snapOn()) === baseline, 'drag end restores original snapping');
    }
    await nKey(); await until(snapOn, 'reset snapping for remaining checks');
    const cancelPoint = await evaluate<{x:number;y:number}>("(() => { const r=document.querySelector('.timeline-track').getBoundingClientRect(); return {x:r.left+6,y:r.top-10}; })()");
    await cdp('Input.dispatchMouseEvent', {type:'mousePressed',...cancelPoint,button:'left',clickCount:1});
    await nKey(); await until(async () => !await snapOn(), 'temporary override before cancellation');
    await evaluate("window.dispatchEvent(new PointerEvent('pointercancel'))");
    await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',...cancelPoint,button:'left',clickCount:1});
    await until(snapOn, 'pointer cancellation restores snapping');
    await tool('inspect_frame', {timeline_ms:500});
    const clipDrag = await evaluate<{x:number;y:number;dx:number}>("(() => { const r=document.querySelector('[data-trim-handle]').parentElement.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,dx:document.querySelector('.timeline-track').clientWidth/6-5}; })()");
    await cdp('Input.dispatchMouseEvent', {type:'mousePressed',x:clipDrag.x,y:clipDrag.y,button:'left',clickCount:1});
    await cdp('Input.dispatchMouseEvent', {type:'mouseMoved',x:clipDrag.x+clipDrag.dx,y:clipDrag.y,buttons:1});
    await nKey(); await until(async () => !await snapOn(), 'clip drag overrides snapping');
    await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',x:clipDrag.x+clipDrag.dx,y:clipDrag.y,button:'left',clickCount:1});
    await until(snapOn, 'clip drop restores snapping');
    const movedClip = await tool('get_project_state') as {version:number;clips:Array<{timelineStartMs:number}>};
    assert(movedClip.clips[0].timelineStartMs > 450 && movedClip.clips[0].timelineStartMs < 500, 'Clip drop ignored temporary snap-off state');
    await tool('undo', {expected_version:movedClip.version});
    const projectUrl = await evaluate<string>("location.href");
    const openLibrary = async () => {
      await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/` });
      await until(() => evaluate("!!document.querySelector('article button')"), "project card");
    };
    const clickCard = async (remove: boolean) => {
      const point = await evaluate<{ x: number; y: number }>(`(() => {
        const node = document.querySelector('${remove ? "article button" : "article"}');
        node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect();
        return {x:r.x+${remove ? "r.width/2" : "6"},y:r.y+${remove ? "r.height/2" : "6"}};
      })()`);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    await openLibrary();
    await clickCard(false); // Padding, not the title link.
    await until(() => evaluate(`location.href === ${JSON.stringify(projectUrl)}`), "whole-card navigation");
    await openLibrary();
    await clickCard(true);
    await until(() => evaluate("!!document.querySelector('dialog[open]')"), "styled remove confirmation");
    assert(await evaluate("document.querySelector('dialog').innerText.includes('fixture') && document.querySelector('dialog').innerText.includes('does not delete')"), "Missing project-specific removal warning");
    await evaluate("document.querySelector('dialog button').click()");
    await until(() => evaluate("!document.querySelector('dialog')"), "cancel closes modal");
    assert(await evaluate("location.pathname === '/' && !!document.querySelector('article')"), "Cancel removed the project or navigated");
    await openLibrary(); // Cancellation also preserves the persisted list.
    await clickCard(true);
    await until(() => evaluate("!!document.querySelector('dialog[open]')"), "remove modal reopened");
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
    await until(() => evaluate("!document.querySelector('dialog') && !!document.querySelector('article')"), "outside click cancels removal");
    await clickCard(true);
    await until(() => evaluate("!!document.querySelector('dialog[open]')"), "remove modal reopened for keyboard");
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await until(() => evaluate("!document.querySelector('dialog') && document.activeElement?.textContent === 'Remove from list'"), "Escape cancels and restores focus");
    await clickCard(true);
    await until(() => evaluate("!!document.querySelector('dialog[open]')"), "remove modal reopened for confirmation");
    await evaluate("[...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Remove').click()");
    await until(() => evaluate("location.pathname === '/' && !document.querySelector('article')"), "confirmed removal without navigation");
    assert(dialogs.length === 0, "Native browser dialog was used");
    await cdp("Page.reload");
    await until(() => evaluate("window.testTools?.has('request_video_upload')"), "reloaded library");
    assert(await evaluate("JSON.parse(localStorage.getItem('rough-cut-projects')).length === 0"), "Removal did not persist");
    await cdp("Page.navigate", { url: projectUrl });
    await until(() => evaluate("document.body.innerText.includes('fixture') && !!document.querySelector('canvas')"), "saved project retained after list removal");
    await selectFile();
    await until(() => tool("get_project_state"), "relinked project for export modal");
    const space = async () => {
      await cdp('Input.dispatchKeyEvent', { type:'keyDown', key:' ', code:'Space', text:' ', windowsVirtualKeyCode:32 });
      await cdp('Input.dispatchKeyEvent', { type:'keyUp', key:' ', code:'Space', windowsVirtualKeyCode:32 });
    };
    for (const time of [533.3333333333334, 1666.6666666666667, 2688.0000000000005]) {
      await tool('inspect_frame', { timeline_ms:time });
      await evaluate("document.querySelector('[aria-label=Playhead]').focus()");
      await space();
      await until(() => evaluate("!!document.querySelector('button[aria-label=Pause]')"), 'Space starts playback from focused slider');
      await cdp('Input.dispatchKeyEvent', { type:'keyDown', key:' ', code:'Space', autoRepeat:true, windowsVirtualKeyCode:32 });
      assert(await evaluate("!!document.querySelector('button[aria-label=Pause]')"), 'Held Space toggled repeatedly');
      await space();
      await until(() => evaluate("!!document.querySelector('button[aria-label=Play]')"), 'Space pauses playback from slider');
      assert(await evaluate("document.activeElement?.getAttribute('aria-label')!=='Playhead' && !document.body.innerText.includes('Timestamps must')"), 'Playback shortcut left slider focused or PCM timestamp failed');
    }
    await tool('inspect_frame', {timeline_ms:500});
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Snap').focus()");
    await space();
    await until(() => evaluate("!!document.querySelector('button[aria-label=Pause]')"), 'Space works on focused buttons');
    await space();
    await until(() => evaluate("!!document.querySelector('button[aria-label=Play]')"), 'Space pauses from button');
    assert(await evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent==='Snap' && button.getAttribute('aria-pressed')==='true')"), 'Space accidentally activated focused button');
    await evaluate("document.querySelector('[aria-label=\"Search transcript\"]').focus()");
    await space();
    assert(await evaluate("document.querySelector('[aria-label=\"Search transcript\"]').value===' ' && !!document.querySelector('button[aria-label=Play]')"), 'Space interrupted text entry');
    await nKey();
    assert(await snapOn() && await evaluate("document.querySelector('[aria-label=\"Search transcript\"]').value.includes('n')"), 'N shortcut interrupted text entry');
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Export MP4').click()");
    await until(() => evaluate("!!document.querySelector('dialog[open] input')"), "styled export filename modal");
    assert(await evaluate("document.querySelector('dialog input').value === 'fixture' && document.activeElement === document.querySelector('dialog input')"), "Export name/focus missing");
    await nKey(); assert(await snapOn(), 'N toggled snapping behind a modal');
    await space();
    assert(await evaluate("document.querySelector('dialog input').value.includes(' ') && !!document.querySelector('button[aria-label=Play]')"), 'Editor shortcuts intercepted modal input');
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
    await until(() => evaluate("!document.querySelector('dialog')"), "outside click closes export modal without rendering");
    await evaluate("window.__roughCutEstimate=navigator.storage.estimate; navigator.storage.estimate=async()=>({quota:1,usage:1}); [...document.querySelectorAll('button')].find(button=>button.textContent==='Export MP4').click()");
    await until(() => evaluate("!!document.querySelector('dialog[open] input')"), "unified export filename modal");
    await evaluate("[...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Export').click()");
    await until(() => evaluate("document.querySelector('dialog[open]')?.innerText.includes('temporary cloud storage')"), "styled cloud export confirmation");
    await evaluate("document.querySelector('dialog button').click(); navigator.storage.estimate=window.__roughCutEstimate; delete window.__roughCutEstimate");
    await until(() => evaluate("!document.querySelector('dialog')"), "cloud export canceled without upload");
    for (const provider of ["cloudflare", "openai"]) {
      await evaluate(`(() => { const select=document.querySelector('[role="tabpanel"] select'); select.value='${provider}'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      if (provider === 'openai') await evaluate("(() => { const input=document.querySelector('[aria-label=\"OpenAI API key\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'test-only-not-a-real-key'); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
      await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Transcribe video').click()");
      await until(() => evaluate("!!document.querySelector('dialog[open]')"), "transcription consent modal");
      assert(await evaluate(`document.querySelector('dialog').innerText.includes('${provider === "openai" ? "OpenAI" : "Cloudflare"}')`), "Wrong transcription provider in consent");
      await evaluate("document.querySelector('dialog button').click()");
      await until(() => evaluate("!document.querySelector('dialog')"), "transcription canceled without upload");
    }
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.includes('fixture ✎')).click()");
    await until(() => evaluate("!!document.querySelector('dialog input')"), "rename modal");
    await evaluate("(() => { const input=document.querySelector('dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Renamed fixture'); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await evaluate("document.querySelector('dialog form').requestSubmit()");
    await until(() => evaluate("!document.querySelector('dialog') && document.body.innerText.includes('Renamed fixture ✎')"), "rename saved");
    await until(() => evaluate("!!document.querySelector('.timeline-track svg[preserveAspectRatio=\"none\"]')"), "waveform clip for selection");
    await evaluate("document.querySelector('.timeline-track svg[preserveAspectRatio=\"none\"]').parentElement.click()");
    await until(() => evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent==='Add B-roll brief')"), "clip inspector");
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Add B-roll brief').click()");
    await until(() => evaluate("!!document.querySelector('dialog input')"), "B-roll prompt modal");
    await evaluate("(() => { const input=document.querySelector('dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'City skyline'); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await evaluate("document.querySelector('dialog form').requestSubmit()");
    await until(() => evaluate("!document.querySelector('dialog')"), "B-roll saved");
    assert((await tool('get_project_state') as {broll: Array<{label: string}>}).broll.some(item=>item.label==='City skyline'), "B-roll brief did not save");
    const captionState = await tool('get_project_state') as { version: number };
    await tool('add_caption', { expected_version: captionState.version, text: 'transactions for', start_ms: 0, end_ms: 2000, position: 'bottom' });
    await tool('inspect_frame', { timeline_ms: 500 });
    assert(await evaluate("[...document.fonts].some(font=>font.family==='RoughCutCaptions' && font.status==='loaded') && document.fonts.check('600 48px RoughCutCaptions')"), "Bundled semibold caption font did not load");
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await until(() => evaluate("document.body.innerText.includes('Saved in this browser')"), "B-roll durability before recovery check");
    await evaluate("(() => { const id=location.pathname.split('/').at(-1); localStorage.setItem('rough-cut.recovery:'+id+':'+sessionStorage.getItem('rough-cut.tab:'+id), '{broken'); })()");
    await cdp("Page.reload");
    await until(() => evaluate("document.body.innerText.includes('Pending recovery data is unreadable')"), "recovery warning");
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Discard pending / reload saved').click()");
    await until(() => evaluate("!!document.querySelector('dialog[open]')"), "recovery discard modal");
    await evaluate("document.querySelector('dialog button').click()");
    await until(() => evaluate("!document.querySelector('dialog') && document.body.innerText.includes('Pending recovery data is unreadable')"), "cancel preserves recovery");
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Discard pending / reload saved').click()");
    await until(() => evaluate("!!document.querySelector('dialog[open]')"), "recovery confirmation reopened");
    await evaluate("[...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Discard').click()");
    await until(() => evaluate("!!document.querySelector('canvas') && !document.body.innerText.includes('Pending recovery data is unreadable')"), "confirmed recovery discard");
    assert(dialogs.length === 0 && !errors.length && !apiRequests.length, "Modal check had browser dialogs, errors or cloud requests");
    console.log(JSON.stringify({ok:true, wholeCardClickable:true, removeCancel:true, removeConfirm:true, savedProjectRetained:true, transcriptionConsent:true, renameAndBroll:true, recoveryModal:true, nativeDialogs:dialogs.length, focusedControlShortcuts:true, dragScopedSnapping:true, fractionalSeekPlayback:true, exportRun:false}));
  } else {
  const geometry = () => evaluate<{ track: number; wave: number; preview: number; lower: number; x: number; y: number; horizontal: boolean; left: number; top: number }>(`(() => {
    const track = document.querySelector('.timeline-track'), viewport = track.parentElement;
    const wave = track.querySelector('svg[preserveAspectRatio="none"]');
    const rect = viewport.getBoundingClientRect();
    return {track:track.clientHeight, wave:wave?.getBoundingClientRect().height || 0, preview:document.querySelector('canvas').getBoundingClientRect().height, lower:document.querySelector('[aria-label="Resize timeline and transcript"]').parentElement.clientHeight, x:rect.x+rect.width/2, y:rect.y+rect.height/2, horizontal:viewport.scrollWidth>viewport.clientWidth, left:viewport.scrollLeft, top:viewport.scrollTop};
  })()`);
  const resize = async (label: string, delta: number) => {
    const point = await evaluate<{ x: number; y: number }>(`(() => { const element=document.querySelector('[aria-label="${label}"]'); const rect=element.getBoundingClientRect(); if(getComputedStyle(element).cursor!=='row-resize') throw Error('Missing resize cursor'); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y + delta, buttons: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y + delta, button: "left", clickCount: 1 });
  };
  await until(async () => (await geometry()).wave > 0, "source waveform");
  if (uiOnly) {
    const point = await geometry();
    await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -1000, modifiers: 1 });
    await until(async () => (await geometry()).horizontal, "timeline zoom creates horizontal overflow");
  }
  const beforeResize = await geometry();
  assert(await evaluate("!document.querySelector('[aria-label=\"Timeline height\"]') && !document.querySelector('[aria-label=\"Lower panel height\"]')"), "Height sliders remain");
  await resize("Resize preview and timeline", -80);
  await until(async () => (await geometry()).track > beforeResize.track + 40 && (await geometry()).wave > beforeResize.wave + 8, "clips and waveforms grow with pane");
  assert((await geometry()).preview < beforeResize.preview - 40, "Preview did not shrink when timeline grew");
  await resize("Resize timeline and transcript", -40);
  await until(async () => (await geometry()).lower > beforeResize.lower + 30, "lower pane edge resizing");
  await resize("Resize preview and timeline", 300);
  const wheelAt = await geometry();
  await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: 60 });
  await until(async () => (await geometry()).top > 0, "regular wheel scrolls vertically");
  assert((await geometry()).left === wheelAt.left, "Regular wheel scrolled horizontally");
  if (wheelAt.horizontal) {
    await Bun.sleep(300); // Separate native wheel gestures before changing modifiers.
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: wheelAt.x, y: wheelAt.y, modifiers: 8 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: 100, modifiers: 8 });
    await until(async () => (await geometry()).left > wheelAt.left, "Shift-wheel scrolls horizontally");
  }
  await resize("Resize preview and timeline", -90);
  if (uiOnly) {
    assert(await evaluate("document.body.style.cursor !== 'row-resize' && document.body.style.userSelect !== 'none'"), "Resize left the cursor/selection locked");
    assert(!apiRequests.length && !errors.length, "UI check made cloud requests or threw browser errors");
    console.log(JSON.stringify({ ok: true, paneEdgeDragging: true, clipAndWaveformScaling: true, regularWheelVertical: true, shiftWheelHorizontal: true, altWheelZoom: true, exportRun: false }));
  } else {
  await tool("rename_project", { expected_version: 0, name: "Browser verified" });
  const inspection = await tool("inspect_frame", { timeline_ms: 1000 }) as { timelineMs: number; image: string };
  assert(inspection.timelineMs === 1000 && inspection.image.startsWith("data:image/jpeg;base64,"), "Composed inspection failed");
  await evaluate("document.querySelector('dialog button')?.click(); document.querySelector('button[aria-label=\"Play\"]').click()");
  await until(() => evaluate("Number(document.querySelector('input[aria-label=\"Playhead\"]').value) > 1500"), "audio-clock playback");
  await evaluate("document.querySelector('button[aria-label=\"Pause\"]')?.click()");
  sampleBrowserMemory();
  memoryTimer = setInterval(sampleBrowserMemory, 2000);
  const exportStarted = performance.now();
  const exported = await tool("export_mp4") as { status: string };
  const exportSeconds = (performance.now() - exportStarted) / 1000;
  clearInterval(memoryTimer); sampleBrowserMemory();
  assert(exported.status === "human_action_required", "Export did not expose the local download handoff");
  await evaluate("document.querySelector('a[download$=\".mp4\"]').click()");
  await until(async () => (await readdir(directory)).includes("Browser verified.mp4"), "MP4 download");
  const probe = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path.join(directory, "Browser verified.mp4")], { stdout: "pipe", stderr: "inherit" });
  const metadata = JSON.parse(await new Response(probe.stdout).text());
  assert(await probe.exited === 0 && Math.abs(Number(metadata.format.duration) - duration) < 0.001, "Downloaded MP4 duration differs from timeline");
  await cdp("Page.reload");
  await until(() => evaluate("document.body.innerText.includes('Relink fixture.mp4')"), "source relinking after reload");
  const restored = await tool("get_project_state") as { name: string; version: number };
  assert(restored.name === "Browser verified" && restored.version === 1, "IndexedDB save did not survive reload");
  await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Saved exports').click()");
  await until(() => evaluate("!!document.querySelector('a[download=\"Browser verified.mp4\"]')"), "export recovery after reload");
  await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Delete browser copy').click()");
  await until(() => evaluate("!!document.querySelector('dialog[open]')"), "delete export confirmation");
  await evaluate("[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Delete').click()");
  await until(() => evaluate("document.body.innerText.includes('No finished browser copies')"), "explicit export cleanup");
  assert((await readFile(path.join(directory, "Browser verified.mp4"))).length > 1000, "Browser-copy deletion removed the downloaded file");
  await tool("undo", { expected_version: 1 });
  const undone = await tool("get_project_state") as { name: string };
  assert(undone.name === "fixture", "Durable undo history did not survive reload");
  await selectFile();
  await until(() => evaluate("!document.body.innerText.includes('Relink fixture.mp4')"), "source relinking");
  await evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('rough-cut-local'); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('projects', 'readwrite'), store = tx.objectStore('projects');
      const get = store.get(location.pathname.split('/').at(-1));
      get.onsuccess = () => { const value = get.result; value.state = {...value.state, version:value.state.version + 1, name:'Other tab'}; store.put(value); };
      tx.oncomplete = () => { db.close(); resolve(true); }; tx.onabort = () => { db.close(); reject(tx.error); };
    };
  })`);
  const conflictingEdit = await evaluate(`(async () => { try { await window.testTools.get('rename_project').execute({expected_version:2, name:'Pending edit'}); return false; } catch (error) { return String(error); } })()`);
  assert(String(conflictingEdit).includes("STALE_VERSION"), "Concurrent write did not reject stale editor state");
  const stopped = await evaluate(`(async () => { try { await window.testTools.get('rename_project').execute({expected_version:3, name:'Must not overwrite'}); return false; } catch { return true; } })()`);
  assert(stopped, "Failed save queue accepted a subsequent mutation");
  await cdp("Page.reload");
  await until(() => evaluate("document.body.innerText.includes('Recovered pending edits')"), "pending-edit recovery");
  const recovered = await tool("get_project_state") as { name: string };
  assert(recovered.name === "Pending edit", "Reload erased pending work");
  await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Back up pending edits').click()");
  backupFile = path.join(directory, "Pending edit-pending.rough-cut.json");
  await until(async () => JSON.parse(await readFile(backupFile!, 'utf8')).source?.name === 'fixture.mp4', "importable pending backup");
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await until(() => evaluate("window.testTools?.has('request_video_upload')"), "backup import picker");
  await selectFile(true);
  await until(() => evaluate("location.pathname.startsWith('/editor/') && document.body.innerText.includes('Relink fixture.mp4')"), "backup import");
  const imported = await tool("get_project_state") as { name: string; version: number };
  assert(imported.name === "Pending edit" && imported.version === 0, "Pending backup did not restore as a new local project");
  await evaluate("(() => { const id=location.pathname.split('/').at(-1); localStorage.setItem('rough-cut.recovery:'+id+':'+sessionStorage.getItem('rough-cut.tab:'+id), '{broken'); })()");
  await cdp("Page.reload");
  await until(() => evaluate("document.body.innerText.includes('Pending recovery data is unreadable')"), "corrupt journal containment");
  await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Download raw recovery').click()");
  await until(async () => await readFile(path.join(directory, 'Pending edit-raw-recovery.txt'), 'utf8') === '{broken', "raw recovery backup");
  await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Discard pending / reload saved').click()");
  await until(() => evaluate("!!document.querySelector('dialog[open]')"), "recovery discard confirmation");
  await evaluate("[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Discard').click()");
  await until(() => evaluate("!!document.querySelector('canvas') && !document.body.innerText.includes('Pending recovery data is unreadable')"), "explicit recovery discard");
  await until(() => tool("get_project_state"), "reloaded project");
  await tool("rename_project", { expected_version: 0, name: "After recovery" });
  assert(!apiRequests.length, `Local editor called cloud APIs: ${apiRequests.join(', ')}`);
  assert(!errors.length, `Uncaught browser exceptions: ${errors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, localProject: true, composedInspection: true, playback: true, exportSeconds, browserProcessRssMiB: { first: memorySamples[0], peak: Math.max(...memorySamples), last: memorySamples.at(-1), note: "Sum of browser process RSS, includes shared pages; not exclusive memory or an hour-long bound" }, downloadedMp4Seconds: Number(metadata.format.duration), durableUndo: true, relinking: true, staleWriteRecovery: true, pendingBackupImport: true, exportRecoveryAndDeletion: true, corruptJournalContainment: true, cloudRequests: apiRequests }, null, 2));
  }
  }
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) console.error(await evaluate("({url:location.href, text:document.body.innerText})").catch(() => "Page diagnostics unavailable"));
  console.error({ errors, apiRequests });
  throw error;
} finally {
  clearInterval(memoryTimer);
  socket?.close(); browser?.kill(); app?.kill();
  await Promise.all([browser?.exited, app?.exited]);
  fixtureServer.stop(true);
  await rm(directory, { recursive: true, force: true });
}
