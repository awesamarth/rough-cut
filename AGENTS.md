# ROUGH//CUT — working brief and handoff

> Read before working. This is the current decision record, not a claim that planned work is implemented. Update it after meaningful milestones, architecture decisions, or a work-session handoff. Replace stale status; keep a compact progress log, not a transcript of every task.

## Execution status: IMPLEMENTATION AUTHORIZED — migration in progress

### Latest owner decision — remove file sharing

- Removed Web Share buttons from export completion and Saved exports, plus the agent-facing Share instruction. Download remains unchanged; no replacement sharing advice/banner added. Owner encountered Chromium's 50 MiB Web Share ceiling on an 81 MB output and requested removing this feature outright.
- Supersedes earlier plans/checklists for Share handoff: only Download verification remains relevant. No browser automation run. Manual check: completed exports and Saved exports show Download but no Share.

### Latest Inspector resizing

- Added a draggable vertical divider between preview and Inspector in the active shell. Default width remains 270px; resizing clamps Inspector to 220–520px and reserves at least 320px for preview. Existing canvas/aspect-ratio layout remains; Inspector contents scroll independently. Small screens retain stacked layout without the divider.
- Reuses the pane-resize lifecycle; pointer capture, pointer-up/cancel/lost-capture, blur, window resize and unmount clean up listeners/cursor state. Focused divider supports Left/Right arrows (10px), Shift+arrow (40px), and visible focus/hover. Six non-browser bounds assertions, typecheck/lint/diff checks pass. No browser checks run. Manual check: drag boundary both ways, verify preview/Inspector remain usable at limits, Tab+arrows, and existing top/bottom timeline dividers.

### Latest unified Export MP4 destination flow

- The active editor now has one **Export MP4** action and filename modal. A genuine `showSaveFilePicker` path is invoked directly from the form gesture; picker cancellation ends the flow. Without it, the safety-adjusted MP4 estimate is compared with available OPFS quota. Known insufficient space requires a styled human consent dialog before temporary cloud storage; unknown estimates try local storage and are not upload permission.
- If OPFS reports an actual quota failure after its incomplete file is removed, the same immutable project/version, media references and filename may be retried in cloud storage only after a second explicit consent. Cancellation, codec/render/worker errors and direct-file failures never trigger that offer. WebMCP remains local-only and cannot grant cloud consent. Single-flight, state-change rejection, cancellation, cloud cleanup and unmount guards remain in the shared flow.
- Owner-authorized GPT-5.6 Sol medium implemented the flow; parent personally reviewed and corrected quota classification (tag only actual file operations, not encoder/decoder QuotaExceededError), blocked cloud retry if temporary-file cleanup fails, added post-await cancellation guards and kept object-URL allocation outside React state updaters. Six focused non-browser tests / 42 assertions cover routing, operation-scoped errors, worker error transport, cleanup and retry eligibility. Parent full Bun suite: 62 pass / 298 assertions, one Node-only test skipped there; typecheck/lint/build/diff checks pass. No browser automation, media export, paid request, deployment, configuration/budget/bucket change or Container work was performed. Manual check on localhost:3007: direct picker save/cancel where available; OPFS export/download; insufficient-space consent Cancel/Continue; cancel during render; cloud download/reload/delete. A temporary console override of navigator.storage.estimate to return zero quota can exercise consent with a short project; reload restores the native estimate. Embedded-browser cookie/handoff behavior and real quota-race UI remain unverified.

### Latest owner authorization — R2 output enabled, Containers still off

- Owner explicitly authorized enabling cloud **storage** export, not Containers. Supersedes earlier R2-disabled notes. Created dedicated remote Standard bucket `rough-cut-outputs`; added and read-back verified two-day expiry for `rough-cut-output/`. Existing MEDIA bucket/data untouched. New remote `OUTPUTS` binding isolates output storage from legacy source-media routes.
- `wrangler.jsonc` enables `CLOUD_OUTPUT_DAILY_MIB=8192` and attests verified lifecycle; explicitly keeps `CLOUD_EXPORTS_DAILY_LIMIT=0`. Existing 4 GiB/output, 20 attempts/day, two concurrent uploads, one hour/upload, one-attempt parts, 24-hour/ten-request download limits and consent remain. Applied output schema to **local D1 only** and refreshed generated env types. Local runtime uses real R2 but local D1 counters: not an account-wide budget. No app deployment or remote D1 migration authorized/performed. Server restarted on localhost:3007.
- Removed operator-oriented disabled/configuration wording from user-facing cloud output/rendering/transcription errors without weakening admission guards. Fixed Next dev normalizing request.url to localhost for 127.0.0.1 requests: same-origin check uses actual HTTP Host (not forwarded-host); added origin/lifecycle regression cases.
- Verified actual app HTTP admission → 1,579-byte generated MP4 upload → independent Wrangler remote R2 byte check → finalize/download/range → unauthenticated rejection → test-output deletion. No original user media, Containers, browser automation or browser export used. Container export POST still returns 503 before any proxy call. Local Miniflare D1/R2 tests, writer tests, typecheck/lint/build/diff checks pass. Manual next: short real cloud export, download/play, reload and delete. Larger cloud output and embedded-browser cookie/handoff behavior remain unverified.
- Rechecked official R2 pricing: Standard $0.015/GB-month, Class A $4.50/million, Class B $0.36/million, direct egress free; account-wide free allowances are shared and other Workers/D1 usage can cost separately. Expiry deletion can lag. No universal dollar spending cap claimed.

### Deferred Mediabunny opportunities — not requested for implementation now

- Owner asked to retain these ideas for later; do not implement them during current manual UI testing.
- Timeline thumbnail strips using bounded frame extraction; export resolution/quality presets instead of only fixed 1080p/30fps/8 Mbps. These are the suggested first priorities when revisited.
- Earlier source-decode/export-codec compatibility feedback; practical custom codec fallbacks (AAC WASM candidate still needs compatibility/licensing verification, not a universal video fallback).
- Optional packet-copy/remux fast path only for compatible unmodified media/keyframe-aligned trims. Not a replacement for rendering captions, effects, retiming or arbitrary frame-accurate cuts.
- These are potential additions, not shipped features or a commitment to implement them next.

### Latest tiny timeline text geometry fix

- Caption/overlay outer boxes no longer have padding or layout borders that can enlarge very short durations at low zoom. Text padding moved inside; inset rings preserve normal/selected outlines without adding width. Overflow clips text/handles to the true duration box. Snap timestamps unchanged.
- Non-browser timeline markup regression now covers tiny duration widths, no outer padding/borders, inner padding and retained linked selection (22 assertions); typecheck/lint/diff checks pass. No browser automation. Owner manual check: snap to a short caption/overlay edge, zoom out/in without moving playhead; edge should remain aligned, with tiny text clipped rather than the box widened.

### Latest video-frame cleanup fix

- Traced intermittent unclosed VideoSample warnings to renderer disposal clearing readers without returning prefetched-frame iterators, with navigation also able to race an in-flight draw. Shared VideoRenderer now serializes draws, rejects work after disposal, waits for pending drawing, closes all readers, then disposes input. Disposal is asynchronous/idempotent; preview teardown, inspection and export callers updated. Export destination cleanup still runs even if renderer cleanup fails.
- Two non-browser lifecycle regressions (8 assertions) cover late-created readers during disposal, iterator finalization, repeated disposal, rejected new draws and failure cleanup. Typecheck/lint/build/diff checks pass. No browser automation or exports run; exact owner warning is not freshly reproduced. Manual check: seek/play, leave a project, open another repeatedly and watch for the delayed VideoSample warning.

### Latest linked-clip selection fix

- V1/A1 now use the same visible selection tint and lime border, drawn above lane content. Successful blade cuts select the retained linked piece in both lanes. Blade mode hides video-only trim handles so their hover emphasis no longer misleadingly resembles a video-only selection.
- Non-browser rendered-markup regression verifies paired highlight/deselection and blade trim-handle hiding (8 assertions); typecheck/lint/diff checks pass. No browser checks run. Owner manual check: slice through V1 or A1, verify both corresponding pieces highlight together, then exit Blade mode and select/deselect either lane.

### Latest shortcut addition

- Owner clarified B must activate **Blade mode**, not cut immediately. Implemented persistent mode with a highlighted Blade toggle. Latest owner-requested visual pass replaces scissors with a slim custom vertical blade SVG in the toolbar/cursor and a lime dotted hover cut guide. Clicking video/linked audio, text or music splits that clicked item at the pointer's timeline position, accounting for source trim/speed. B now toggles mode on/off (owner follow-up); A or Escape also exits. Clicking the Blade toggle toggles it too. The hover guide spans only the hovered lane (both V1/A1 for linked video/audio), uses the same rounded pointer time as the cut, and updates on scrolling/zoom/resizing without rerendering waveforms on every pointer move. It hides on leaving the track, blur, invalid cut positions or exiting Blade mode. Obsolete scissors cursor removed. Existing Split button remains a separate at-playhead action, without the B shortcut.
- Switching modes cancels any active drag preview. Blade pointer handling intercepts drag/trim handlers; text fields/modals and Cmd/Ctrl/Alt combinations retain native behavior. Existing engine validation, history and persistence still apply; looped music still requires disabling looping before splitting. Boundary clicks do not create empty clips.
- Three non-browser regressions (25 assertions) cover retimed video mapping, clicked text/music, invalid positions and retained loop restriction. Typecheck/lint/build/diff checks pass; no browser automation run. Owner manual check: B toggles mode, hover shows the vertical blade/dotted line, linked video/audio share the guide, click cuts on the line even after zoom/scroll, undo, A/Escape restores normal dragging, and b still types in text fields. Latest visual pass also passes the three split regressions, typecheck/lint/build/diff checks; no browser automation run.

### Latest owner testing preference

- Do not run Chrome/Brave browser checks automatically. Owner will perform manual browser testing; provide a short, specific checklist after UI changes. Run browser automation only if explicitly requested. This supersedes earlier browser-check execution guidance; non-browser checks remain allowed.

### Latest snapping shortcut / manual UI changes

- N now toggles snapping persistently when idle, or temporarily for an active timeline drag. Releasing N does not restore it; drop/cancel/blur/unmount ends the override. Held-key repeats are ignored; text fields and modals retain typing. The Snap magnet button highlights the effective state. Old Alt snapping override removed; Alt+wheel zoom unchanged.
- Shared snapping hook supplies a live ref to drag callbacks, so changing N mid-drag affects the actual drop, not merely the button. Stationary drags recalculate immediately. Text/music dragging now also uses boundary snapping. Drag cancellation clears temporary previews without committing them.
- Focused Chrome/Brave checks cover persistent toggle, repeat suppression, both initial states during drag, key release, stationary snap position, cancel restoration, actual unsnapped video-clip drop, and typing/modal guards. Typecheck/lint/build pass; no export or inference tests.
- Preceding manual tweaks: first source clip selected once on project load (manual deselection retained); Snap label/icon/highlight restored. Backup import is a separate button outside the upload drop zone, and auto-transcription copy uses available width. Server remains on 3007; fallback work stays paused.

### Latest focused controls / timestamp fixes

- Shared shortcut guard now distinguishes typing from range sliders/buttons and blocks background editor shortcuts while a modal is open. Space runs in capture phase, prevents scrolling/button activation and ignores key-repeat. Follow-up: owner wants slider focus cleared on Space, so playback shortcuts now blur the focused control; normal Tab/arrow focus styling remains intact. Updated focused browser check passes. Active and retained old editor use the guard; text inputs/contenteditable keep native typing/undo.
- Traced tiny negative timestamps to Mediabunny PCM conversion trim/rebase feeding its strict WAVE muxer, not video seeking. Both playback/export audio conversion and transcription preparation now normalize only negative round-off within 1 ns before returning PCM samples to the muxer. Genuine negative timings remain invalid.
- Regression feeds both reported timestamps through real Mediabunny PCM muxing. Chrome/Brave focused checks pass fractional seek/playback, Space on sliders/buttons, held Space, text/modal typing and existing modal checks; no exports or inference. Typecheck/lint/build pass. Test startup now waits for the browser page target rather than assuming it appears with the debug port.

### Latest caption styling fix

- Captions now use bundled Inter semibold (600), with a lighter shadow. Overlay font remains DejaVu Bold. Shared canvas text layout uses measured glyph ascent/descent and alphabetic baselines for equal vertical background padding, including multiline captions. Preview, inspection and export share this code.
- Inter source/license are bundled/documented. Layout regression checks single-line and multiline descender padding. Chrome/Brave focused UI checks load the real font and inspect a composed caption frame; no exports/inference run. Typecheck/lint/build pass. Owner continues manual testing on port 3007.

### Current local transcription setup — restored at owner's explicit request

- Owner requested restoration of previously working Workers AI transcription and confirmed extra credits. Local `.env.local` now persists `ENABLE_CLOUD_DEV=1`; ignored `.dev.vars` sets `CLOUD_TRANSCRIPTION_DAILY_MINUTES=600`. Existing 120-request/day admission and consent remain. This is a local D1 counter, not an account-wide spending cap.
- Applied `0002_cloud_usage.sql` to **local D1 only**, so admission has its required tables. Restarted `rough-cut-dev` on port 3007; Cloudflare remote binding connection initializes successfully and app returns HTTP 200. No live inference test, deployment or remote migration performed. Container rendering and R2 output allowances remain disabled.
- Cloud dev initialization is now development-phase-only; production builds do not open the remote proxy just because `.env.local` enables local transcription. Earlier notes saying all local transcription allowances are zero are superseded by this entry.

### Latest manual-testing changes — styled modals

- Owner rejected browser-native confirmation/prompt boxes for project removal and exports. Reused the old export modal's design in shared `modal.tsx`: styled native HTML dialog (not browser confirm), outside-click/Escape/Cancel dismissal, focus trapping and focus restoration.
- Active project removal, MP4 filename entry, cloud-export consent and local/cloud export deletion now use these styled modals. Cloud consent/budget controls remain intact; async consent rechecks project/export state. Follow-up: owner requested all remaining browser prompts replaced too. Shared modal now handles transcription consent (both providers), project rename, B-roll briefs from clip/transcript controls, recovery discard and retained legacy-controller confirmations. No `window.alert/confirm/prompt` calls remain in `src`. The browser-mandated beforeunload warning for unsaved edits remains; it cannot be replaced with an asynchronous custom modal safely.
- Updated focused `LIBRARY_ONLY=1` Chrome/Brave checks pass removal cancel/confirm/outside/Escape/focus, export filename outside-dismiss and cloud-consent cancellation. Expanded checks also pass both transcription-provider consent cancellations, rename/B-roll saves and recovery cancel/confirm with zero native dialogs. Transcription reserves its active controller before asynchronous consent to prevent duplicate starts. No rendering, uploads or paid requests. Typecheck/lint/build and diff check pass. Server remains on 3007.

### Latest manual-testing changes — project cards

- Entire project card now opens the editor (native stretched link, keyboard focus retained). Remove remains an independent button and asks for confirmation; cancel preserves the entry. Warning accurately states this removes only the list entry, not saved edits or original media.
- `LIBRARY_ONLY=1 bun run scripts/check-editor.ts` passes a real Chrome padding click, cancel/confirm, persisted list removal and retained project checks with no exports/cloud requests. Typecheck/lint/build pass.
- Owner remains in manual UI testing; fallback work is paused. Current tmux server: `rough-cut-dev`, http://127.0.0.1:3007. Latest preceding sizing tweak raised default timeline to 310px and minimum track height to 240px (~33% taller baseline clips).

### Current manual-testing fixes — restore editor pane resizing

- Owner found a rewrite regression: the active shell had replaced draggable pane boundaries with height sliders, and the reused timeline did not fill its pane. Sliders removed; top/bottom timeline splitters restored with row-resize hover, keyboard arrows, and pointer-cancel/blur/unmount cleanup. Top edge reallocates preview/timeline space; bottom edge reallocates timeline/lower-panel space.
- Timeline fills its pane; percentage-sized clips and existing full-height waveforms scale together. Below the track minimum, native vertical overflow remains scrollable and lane labels follow it. Normal wheel keeps native axes, Shift+wheel pans horizontally, Alt+wheel still zooms.
- `UI_ONLY=1 bun run scripts/check-editor.ts` uses a short fixture and skips playback/export/recovery checks. Chrome and Brave pass real edge dragging, clip/waveform growth, preview shrinkage, lower-pane resizing, vertical wheel, Shift-wheel and Alt zoom. Typecheck/lint/build pass. Owner explicitly rejected long export tests for this UI fix; do not run them for unrelated UI work. Dev server remains on 127.0.0.1:3004.

### Latest small UX change — remembered auto-transcription opt-in

- Owner wants manual UI testing before further fallback work. Only the requested upload-screen auto-transcription opt-in was added in this pass.
- Checkbox defaults off and clearly discloses Workers AI/audio upload/allowance use; preference is stored in localStorage. Checked new uploads enqueue a one-shot in-memory request (same lifetime as selected source Files). The editor consumes it when ready and uses the existing transcription pipeline without a second consent dialog. Reopens, backups and failed jobs never auto-retry. Manual/provider/agent transcription still confirms; all cloud limits remain unchanged.
- Queue unit check, typecheck/lint/build and real Chrome app checks pass; browser check verifies off-by-default, persistence after reload and opt-out without cloud API requests. No live transcription or paid tests performed. No dev server left running.

### Current fallback implementation — local validation, not enabled remotely

- Owner authorized fallback implementation and mentioned $20 Cloudflare credits. No deployment, remote migration or paid test has been performed; allowances remain disabled. Owner will test ChatGPT Download/Share later.
- **R2 rendered-output overflow is implemented:** human-only confirmation button in `editor-shell.tsx`; shared export worker still renders locally; only encoded MP4 bytes leave the device. Browser/native codec failures remain a separate, unfinished fallback. No original source/project upload and no Container wakeup for storage overflow.
- `cloud-output-writer.ts` retains the first and two trailing 5 MiB chunks for MP4 header/moov corrections and uploads sealed middle chunks once. Chunk objects under `rough-cut-output/` avoid random-write or whole-file buffering requirements. `/api/outputs` streams complete downloads with byte ranges. Native download authentication uses scoped HttpOnly/SameSite cookies, Secure on HTTPS; no capability in URLs or JS persistence. Latest output metadata per project is remembered locally.
- D1 admission: default disabled, hard max 8192 MiB/day, 4096 MiB/output, 20 attempts/day, two concurrent uploads, one pending part/output, one attempt/part, one hour/upload, 24-hour access, ten download requests/output. Failed reservations are not refunded. Cancel deletes stored parts; in-flight writes recheck cancellation. A scoped **two-day R2 object lifecycle** is a mandatory operator prerequisite (`CLOUD_OUTPUT_LIFECYCLE_READY=1` attestation); expiry deletion may lag. Native expiry covers abandoned chunks. Migration `0003_cloud_outputs.sql` is local-only so far.
- Official R2 pricing/lifecycle/Workers API docs reviewed: Standard $0.015/GB-month, Class A $4.50/million, Class B $0.36/million, direct egress free before account-wide included usage. These are not universal $5/$20 spending caps. Keep other cloud allowances zero. Automatic invocation logs disabled in wrangler config to avoid credential metadata logging; no deployment made.
- Tests: bounded writer metadata rewrite/sealing/failure checks; **real local Miniflare D1/R2** admission/concurrency/capability/range/delete checks; real browser-worker encode→local R2→download/decode/delete passes in Chrome. `bun run test:cloud` runs in Node (Miniflare R2 stream transfer fails under Bun); `CLOUD_BROWSER_TEST=1 bun run test:cloud` adds the existing browser probe, no new browser harness. Unit suite skips that Node-specific test and executes it separately. All test storage/services are isolated/local.
- Latest checks: 47 Bun tests pass (Node-only Miniflare test deliberately skipped there and run separately); typecheck/lint/build and built-app Chrome local workflow pass with zero API requests. End-to-end browser-worker→local R2→download/decode/delete passes in Chrome **and Brave**. Native D1/R2 tests additionally verify cross-chunk range bytes, failed capabilities, one-attempt CAS, expiry and ten-download cutoff. `git diff --check` passes.
- Next: whole-app cloud button/download/reload verification and larger multi-chunk cloud output; then separate codec fallback. Official Mediabunny docs identify `@mediabunny/aac-encoder` (FFmpeg WASM, lazy registration when native AAC encoding is absent) as a possible way to avoid Container wakeups; not installed yet—verify bundled FFmpeg licensing/source and force unsupported-native coverage before shipping. Full H.264/unsupported-source Container fallback still requires consent, admission, bounded source handling, deadlines and parity; do not enable the existing generic proxy. Strict cookies in actual ChatGPT embedding still need owner verification. Do not enable cloud or claim fallback complete yet.

### Earlier owner direction — compaction handoff (supersedes older compatibility plans)

- Owner did a brief local UX smoke check and said it looks good; this is not full acceptance testing.
- **The app is not in production. No backward-compatibility work and no separate legacy-cleanup workstream requested.** Do not spend time preserving old cloud projects, migrations for compatibility, or maintaining the old controller. Older preservation/cleanup plans below are historical and superseded. Security/cost controls for any retained or newly enabled cloud services still matter. No remote data deletion or deployment is authorized.
- Owner requested a pause for compaction, then continuation. Resume remaining work after compaction without asking for another implementation go. Keep no-subagents instruction.
- The `rough-cut-dev` tmux session has been killed at the owner's request; port 3000 has no listener. Do not restart a persistent dev server unless needed/requested. Browser tests use temporary servers and clean them up.
- Next priorities: verify latest speed/reflow/text and human-controls edits; extend media parity/music/no-audio/VFR tests; longer exports and real quota/write-failure tests; consented, bounded R2 output overflow and codec fallback. Finish docs/checks. Actual ChatGPT in-app Download/Share needs owner-run verification; cloud spending remains disabled.
- Latest verified regression: **45 tests / 163 assertions**, typecheck/lint/build and actual-app Chrome/Brave tests pass after the speed/reflow and human controls changes. These checks are not exhaustive manual control parity. Browser harnesses now explicitly mute audio.
- Export failure pass: reproduced and fixed cancellation during final metadata staging replacing an existing direct-file destination. The shared exporter now checks cancellation immediately before committing the replacement. Real OPFS writes with injected disk-full errors and late cancellation preserve prior bytes; this is fault injection, not a physically full disk. Worker startup/handle-clone failure also now terminates its worker and clears timers; probe verifies this.
- Expanded Chrome/Brave media checks cover actual silent VFR input and trimmed/looped music with volume, mute, start offset, fades and exported silence timing. Existing crossfade/pitch/AAC/worker/cancellation checks remain green. Worker-start cleanup also passes in Chrome and Brave. Final unit/typecheck/lint/build and fresh built-app Chrome checks pass; `git diff --check` is clean.
- Existing `check-editor.ts` accepts `MEDIA_TEST_SECONDS=3..600` and measures summed descendant browser RSS during export. Chrome 120-second and 600-second actual app export/download/reload/recovery tests passed with zero cloud requests. Ten-minute export took **78.58s**, browser RSS first/peak/last **1508/1634/1501 MiB** (includes shared pages, not exclusive memory). This is not proof for hour-long, high-resolution sources or constrained mobile browsers. Temporary profiles, files and servers are cleaned up; no persistent development server restarted.
- Additional completed work since the older log: Saved exports listing/download/deletion survives navigation (tested in Chrome/Brave); bounded 100-step / 16 MiB shared history; raw corrupt-journal backup/discard; pure retranscription ID/caption reconciliation; PCM WAV preparation preserves timestamp gaps and phase-inverted speech (real delayed-audio fixture passes); cloud development proxy is opt-in via `ENABLE_CLOUD_DEV=1`; media license/source notices added. No cloud processing, deployments, commits or remote migrations.

The owner explicitly said **“go”** after approving this brief. Implementation and local validation are authorized; no deployment or destructive cloud-data changes have been performed or authorized. Continue the plan after a context reset without requesting another implementation go.

Independently trace and fix underlying problems, research official documentation as needed, and validate the result. Do not merely swap libraries while preserving known footguns. Do not use subagents unless the owner changes their earlier no-subagents instruction. Read the progress/handoff section before assuming any planned component has shipped.

## Product and scope

ROUGH//CUT is a human-first, WebMCP-native, non-destructive video editor. A human supplies taste; an external WebMCP agent performs visible, reversible edits in the same editor. **No built-in chatbot, LLM agent, or proprietary agent integration.**

- One immutable source video plus one optional background-music asset, which may be split into timeline clips.
- Fixed lanes: S1 captions, V2 text/graphics, V1 source video, A1 linked source audio, A2 background music. Not a general multi-source compositor.
- Preserve trimming, splitting, explicit gaps, movement/reordering, protected ranges, transcript editing, caption anchors, overlays, B-roll briefs, color/transforms, speed, volume/mute, edge fades and transitions.
- Preserve human controls, transcript/timeline synchronization, undo/redo, autosave and activity visibility. Human UX must not be a second-class subset of agent tools.
- MP4, EDL and SRT exports remain in scope; describe format limitations honestly.
- Backspace lift-deletes (keeps the gap); Delete ripple-deletes (closes the removed span).
- Target the owner's Brave and ChatGPT in-app browser, plus compliant WebMCP browsers. Do not assume all Chromium-derived browsers expose identical APIs.

Original project: The WebMCP Challenge; public repo, deployed app and recorded demo already exist. The immediate objective is architectural improvement and reliability, not preserving the old implementation or its production-readiness claims. There is no requirement to keep a particular framework, database or service; avoid unrelated rewrites without a concrete benefit.

## Owner preferences and cost boundary

- **No account/login requirement for normal editing. Local-first, not necessarily cloud-free.**
- Owner has the $5 Cloudflare Workers plan and accepts useful cloud functionality within a predictable small budget. Container usage exhausted allowances quickly.
- The $5 plan is **not** a universal spending cap for Workers AI, R2 and Containers. Before implementing/enabling cloud fallbacks, check current official pricing, included usage, account configuration where authorized, and enforceable limits. Do not invent allowances or silently enable unbounded overages.
- Normal editing, preview, waveform analysis and browser export must not wake a Container.
- Cloud upload/compute must be explicit to the human, narrowly scoped and bounded. No silent paid retries or hidden full-source uploads.
- Anonymous does not mean unrestricted: validate resource capabilities, expiry, sizes and ownership of temporary operations; add rate limits, bounded concurrency and global usage/admission cutoffs for owner-funded work. Rate limits alone are not a hard monetary cap. Never expose a general paid-service proxy.
- Keep keys out of logs and server persistence. Existing optional OpenAI BYOK is session-only unless the human explicitly remembers it locally. Reassess its browser/proxy path before carrying it forward.

## Agreed target architecture

```text
Human controls ─┐
                ├─ shared dispatch → complete pure editing engine
WebMCP tools ───┘                      → durable versioned local project
                                              │
                                    shared timeline evaluation
                                    + video/audio composition
                                      ├─ interactive preview
                                      ├─ composed-frame inspection
                                      └─ deterministic export

Mediabunny: media metadata, demux/decode, samples, encode/mux, streaming I/O
Browser: source access, waveforms, silence analysis, transcription preparation
Optional cloud: bounded transcription, R2 output overflow, codec fallback
```

### Editing engine and WebMCP

- Keep direct `document.modelContext.registerTool` integration. WebMCP tools execute page JavaScript, not a backend MCP server.
- React hooks/ref-based tool registration and shared human/agent dispatch are **correct and should remain where useful**. The review did not recommend moving WebMCP execution to the server.
- Consolidate semantic editing rules currently split between `applyCommand()` and `useEditor.dispatch()`: caption partition/reconciliation, transcript correction and all final-state validation belong in a testable editing engine.
- Hooks should coordinate React updates, history, persistence and tool lifecycle; not be the only home of important edit rules.
- Preserve stable IDs, source `[in, out)` references and explicit timeline positions/gaps. Define transition overlap, retiming and text-anchor behavior consistently.
- Mutations require `expected_version`, reject stale edits, increment version and return compact structured diffs. Human and agent must see the same state.
- Distinguish optimistic/pending state from durable success. Do not report an agent operation as committed before its persistence boundary succeeds.
- Register/expose tools appropriate to state; propagate cancellation through long operations. Keep existing narrow inspect/edit/export tools unless a justified contract change is documented.

### One browser rendering pathway

- Adopt **Mediabunny**. Verify current APIs/types and official examples during implementation; it is not itself a timeline compositor.
- Share timeline evaluation, transform/color behavior, text layout/layering, transition envelopes and audio rules across preview, inspection and export. Interactive scheduling and deterministic offline scheduling may differ; composition semantics must not.
- Start with the existing canonical 1920×1080 coordinate system and bundled DejaVu Sans Bold. Resizing preview scales composition, not text reflow. Resolution/FPS changes need explicit policy, not accidental renderer defaults.
- Define speed/pitch preservation and audio mixing explicitly. Do not replace pitch-preserving speed changes with pitch-shifting playback accidentally.
- Use workers and bounded sample/decode/encode queues, close media resources, and stream output. No entire recording decoded into memory; no giant output Blob as the default; no recording live preview with MediaRecorder as the export engine.
- Inspect the actual composed frame at a requested timestamp. Await decoded-frame readiness; a fixed delay after seeking is not an exact-frame guarantee.
- Local waveform/silence/audio preparation should avoid unnecessary duplicate decoding and persist reusable small analysis artifacts by immutable asset identity.
- Silence candidates must come from audio analysis, be cross-checked against transcript words and retain configurable speech padding (~200 ms initially). Share safeguards between human and agent candidate generation. Generic explicit range deletion may still delete speech intentionally.

### Output destinations: separate from rendering fallback

1. When `showSaveFilePicker` is genuinely available, stream into the selected writable file.
2. Otherwise, stream into OPFS and offer a tested Download/Share handoff. Check origin quota, handle quota errors, and keep a bounded retry/cleanup window. OPFS is browser-managed disk, not unlimited storage or guaranteed permanent persistence.
3. When local output storage is insufficient, optionally stream **browser-rendered encoded output** into a bounded R2 multipart upload, with consent, then download. This is storage overflow, **not Container rendering**. Validate feasibility, pricing, multipart/MP4 finalization and cleanup before enabling it.
4. Container rendering is a separate, explicit fallback for unsupported required media codecs, after evaluating practical browser codec extensions. Do not route storage shortages or every generic browser error to paid rendering.

A normal browser download may show the macOS destination dialog even when `showSaveFilePicker` is absent. That does not give the page a writable destination handle. Large-file OPFS download/share behavior must be tested in both target browsers, not assumed.

### Temporary Container fallback

Ephemeral jobs/files are acceptable for an occasional fallback. Do **not** add durable D1 job records and permanent R2 outputs merely because temporary files can expire.

- Proposed idle timeout: **10 → 5 minutes initially**, only with verified protection for active rendering/downloads and an understanding of Container lifecycle semantics. Shorter idle time is secondary to eliminating routine Container calls.
- Bound concurrency, duration, input/output sizes and compute admission. Deduplicate repeated starts where appropriate; implement cancellation and process cleanup.
- Show that exports are temporary. Missing/expired jobs are terminal: stop polling, invalidate Download, offer explicit rerender. No 15-minute polling of a lost job.
- Remove stale sources, chunks, outputs and job entries. Do not delete an output merely because an HTTP response started; allow retry.
- Retaining FFmpeg fallback means a second implementation remains. Reuse shared semantics where feasible and maintain explicit parity tests; do not claim one renderer covers it unless it actually does.

### Persistence and transcription

- Local projects/media access by default, without mandatory R2 upload or D1 round trips. Choose the smallest storage design that supports atomic durable project/history updates, multi-tab conflict handling, project backups and source-media relinking.
- Avoid copying large selected media into OPFS automatically; source copies and export output share quota. Account for file permissions/reselection after reload.
- Browser storage can be cleared/evicted; persistence requests do not guarantee more quota or permanent retention. Provide honest saved/pending/error state and user-owned backups.
- Keep transcription functionality. Move audio extraction/chunk preparation into the browser with actual timestamp offsets. Decide cloud Workers AI/BYOK versus on-device inference after capability/cost research; on-device transcription is not yet a committed dependency or proven implementation.
- Checkpoint successful transcription chunks, avoid duplicate in-flight runs, support cancellation/retry, and preserve/reconcile word anchors when correcting or retranscribing.

## Evidence already collected

### Owner-run browser probes (Brave and ChatGPT in-app browser)

Both reported:
- H.264 encode/decode configuration support: `avc1.42E028`, `avc1.4D0028`, `avc1.640028`.
- Encoder configuration: 1920×1080, 30 fps, 8,000,000 bits/s, AVC format.
- AAC-LC (`mp4a.40.2`) encode/decode: stereo, 48 kHz; encoder 192,000 bits/s.
- Secure context, Worker API, OffscreenCanvas and file-sharing capability: available.
- `showSaveFilePicker`: **absent**.
- Actual tiny OPFS write/read/delete: successful.
- Estimated remaining origin storage: ~2 GiB.

These are capability probes, not completed media exports. Bitrates were test settings, not fixed product requirements. Basic decoder queries do not prove every uploaded source works. The ~2 GiB figure is an origin estimate, not Mac free space or a universal browser limit. At the tested bitrate, an hour of output is roughly 3.7 GB, so large-output handling matters. Still needed: actual video+audio encoding/muxing, worker execution, long-file memory/quota behavior, and download/share handoff on each target browser.

### Review baseline

- `bun test`: 22 passed across 4 files; `bun run typecheck` and `bun run lint` passed.
- No production rendering/billing tests were run during this review. Earlier README/brief smoke-test claims are historical, not fresh verification.
- Four local runtime probes confirmed the first four command issues below despite green existing tests. Probes were inline; no regression files were added yet.
- Source was unchanged during review. An existing untracked `youtube-thumbnail.png` was present; preserve unrelated user work.

## Original review findings (resolution status in progress/handoff below)

### Confirmed command failures

`src/lib/editor.ts`:
1. `validateState()` accepts invalid clip fields (e.g. speed -1, volume 999, non-boolean mute and invalid brightness). Calling normalization and discarding its return is not validation.
2. Split → crossfade → change to cut throws `Clips cannot overlap`; transition removal leaves its overlap unresolved.
3. Overlay at 8–9.5s → trim video to 5s: command succeeds but its resulting state fails server validation. Structural edits must reconcile or explicitly reject affected timed content before installation.
4. Reordering two clips with `[A, B, B]` creates duplicate IDs; unique-set size alone is insufficient.

### Persistence/security

- `src/components/use-editor.ts`: fire-and-forget snapshot saves acknowledge edits early; failures reload server state and erase undo/redo. Later queued stale snapshots still run after conflict and can overwrite another tab's changes when versions happen to align. Stop/rebase failed queues, preserve recoverable pending work and test concurrency.
- Undo/history is memory-only; full snapshots/transcripts accumulate locally without a bound. D1 revisions are written but never read and omit transcript history.
- `src/app/api/projects/[id]/route.ts`: accepts client replacement snapshots rather than enforcing command/protection semantics; update and revision insertion are not atomic.
- `src/app/api/media/[...path]/route.ts`: public proxy attaches the shared service token for any caller. Container token authentication is **not user authorization**. Public upload/transcription/project endpoints also lack ownership/usage controls. Remove obsolete exposure or bound remaining anonymous services; do not leave old paid endpoints open after migrating UI calls.
- Upload size trusts declared metadata; completed object size is not verified. No robust upload resume, music upload buffers large bodies, and no project/media deletion lifecycle exists. Local-only source access may retire much of this code.

### Rendering and jobs

- `src/components/editor.tsx` versus `media-worker/src/index.ts`: separate CSS/HTML and FFmpeg/ASS renderers differ in text layout/layer order, filters, fade-black and audio fades. Shared dimensions/fonts do not prove parity.
- Preview edge-fade opacity takes a maximum with old opacity, preventing fade-in opacity from decreasing correctly. Clip edge fades do not consistently affect preview audio.
- Playback cuts rely on coarse `timeupdate`; frame inspection draws raw video after a fixed delay, omitting composed text/effects/transitions and risking the wrong frame.
- Opening the editor automatically requests Container waveform extraction. Cache is RAM-only; analysis/export repeatedly downloads whole sources. Split music clips redownload the same asset separately. Silence FFmpeg command does not disable video output.
- Container uses one `standard-3` instance with 10-minute idle timeout. Job map and `/tmp/jobs` are ephemeral, exports start without concurrency bounds, and completed sources/outputs/transcription chunks lack cleanup. Browser polling does not terminate promptly for missing jobs.
- Editor permits clip counts that exporter rejects (>200). Align support limits at edit/import time rather than surprising users at export.

### Transcript and human UX

- Caption/transcript reconciliation is partly in the React hook, outside the standalone engine/tests. Correcting a caption collapses multiple words into one sentence-sized transcript entry; retranscription replaces IDs without full anchor reconciliation.
- Transcription stores all chunks only at completion; tabs/reloads can duplicate paid work. Automatic transcription has no robust shared cancellation/checkpoint lifecycle.
- Human silence UI adds transcript/padding safeguards; agent detector returns raw candidates. Share safe candidate preparation.
- Transcript active-word highlight compares source timestamps with timeline time; incorrect after structural/speed edits. Per-word `indexOf` causes quadratic rendering work on long transcripts.
- Project list downloads full states/transcripts for card metadata. Waveform resolution is fixed at ~2,000 peaks even for long recordings.
- B-roll/protected ranges lack complete human visibility/management. Several handlers throw without useful error UI; dialogs and pointer-only controls need keyboard/focus/cancel handling.
- WebMCP tools register once regardless of readiness/processing state; execution cancellation is not wired through long tasks.
- EDL is fixed 30 fps and does not faithfully represent speed changes; verify transition semantics and communicate interchange limitations.

## Implementation sequence

1. Inspect current git state and trace affected paths. Research current Mediabunny/WebCodecs/storage APIs and Cloudflare allowances. Record supported behavior and bounded fallback choices, not assumptions. Avoid waking paid infrastructure just to inspect it.
2. Fix/contain paid endpoint exposure and command/persistence data-loss bugs. Add regression checks for confirmed failures and queue/transaction behavior. Establish complete editing semantics before transplanting them.
3. Prove a real browser MP4 with video + audio, worker processing, and actual saving in both target browsers. Exercise cancellation, quota failure and long output. Do not design all fallback infrastructure before this proof.
4. Implement shared preview/inspection/export composition and browser analysis, preserving human/WebMCP parity. Migrate local persistence and source selection safely.
5. Add only justified bounded cloud paths: transcription, optional R2 output overflow and explicit codec fallback. Verify pricing/limits, anonymous capabilities, lifecycle and cleanup before enabling them.
6. Retire obsolete duplicated pipelines/routes/dependencies after replacement coverage passes. Preserve/export existing user projects; do not drop D1/R2 data or deploy destructive changes without approval.
7. Run regression, render/audio parity, failure/recovery and target-browser checks. Update this file with implemented milestones, evidence, unresolved risks and exact next steps before handoff.

## Engineering rules

- Prefer `bun`/`bunx`; use `rg` for discovery. Read code/callers before editing. Reuse existing helpers or native APIs before adding abstractions/dependencies.
- Keep changes focused, but fix root causes across callers. No speculative service layers, CRDT/event-sourcing rewrite, general multi-track engine or framework migration without demonstrated need.
- Do not trade correctness, validation, accessibility or data safety for a smaller diff. No knowingly broken shortcuts disguised as simplicity; state residual risks honestly rather than promising zero bugs.
- Validate trust-boundary inputs and complete resulting project invariants. Share schemas/types where practical without confusing TypeScript assertions with runtime validation.
- Jobs and long operations need bounded memory, cancellation, errors, retries and cleanup. Check every response status. Distinguish unavailable, unsupported, failed, canceled and expired states.
- Tests must cover meaningful branches and regressions, not merely happy paths. Existing 22 green tests do not establish rendering/persistence safety. Test undo with transcript changes, protected edits, stale versions, structural retiming, audio/video sync, transitions and composed frame output.
- Verify playback/export parity with actual rendered fixtures, including gaps, trims, speed, fades, music loop/splits, letterboxing/transforms and multi-line text. Test long/VFR/no-audio sources and unsupported formats as applicable. Do not claim browser validation from static inspection.
- Use Tailwind utilities for component styling. `globals.css` is for tokens, resets, keyframes and otherwise inexpressible selectors. Preserve keyboard/focus, responsive and reduced-motion behavior.
- No secrets in docs, logs or commits. No unauthorized deployment, destructive data changes or unbounded paid tests. Preserve unrelated work; report blockers and exact checks run.

## Progress / handoff log

### First implementation milestone — foundation and local audio (not full migration)

- Owner go received. No subagents, commits, deployments, remote migrations, account changes or paid inference/render tests. Existing untracked `youtube-thumbnail.png` preserved.
- Added Mediabunny **1.55.7**. `media-analysis.worker.ts` now performs decoded multi-channel peak analysis and five-minute mono 16 kHz PCM WAV preparation. Browser waveform/silence/preparation paths no longer call Container endpoints. Analysis is bounded to 24-hour sources (~17 MB peaks), cached by immutable asset key when storage permits, and cancellable by terminating its worker. Missing samples are not treated as silence; opposite-phase channels are not averaged into fake silence.
- Removed automatic transcription on editor open. Explicit transcription confirms cloud audio transfer, prepares audio locally, checkpoints successful chunks in Cache Storage, and supports cancellation. Cross-tab duplicate transcription, anchor-preserving retranscription and full recovery UX still need work.
- Confirmed four command regressions fixed with tests: invalid persisted clip fields, duplicate reorder IDs, transition removal, and text past shortened timeline end. Complete edits now enter `applyEdit({state, transcript}, command)` from the shared hook; caption partition/reconciliation/correction code moved out of React. Existing lossy sentence-sized transcript correction behavior is NOT yet redesigned.
- Saved-state validation is strict; final command states are validated. Current 200-clip limit is enforced before export. Transition changes shift the following section while preserving its gaps. Shortening a timeline clips/removes text beyond the new end. Added finite-number guards. More combinations/property testing remain necessary.
- Added a fail-stop save queue: any failed/ambiguous snapshot stops subsequent queued snapshots. Pending document is journaled before optimistic installation, retained after failure/reload, with explicit JSON backup/discard UI. WebMCP mutations await queued durability. Local in-memory history capped at 100; history still is not fully durable. LocalStorage journal limitations and tab-identity behavior need replacement/verification during IndexedDB local-project migration. Recovery JSON has no import UI yet.
- Legacy D1 update/revision insertion now uses a transactional batch with a conditional revision insert. Bun SQLite tests exercise the same update/revision statements for stale writes and transaction rollback on revision failure. Real D1 batch integration still needs verification.
- Fixed source-vs-timeline transcript highlighting, quadratic transcript `indexOf`, and sticky preview edge-fade opacity; basic edge audio fades now update gain. Full preview/export parity is NOT established.
- Remaining owner-funded routes now fail closed unless `CLOUD_TRANSCRIPTION_DAILY_MINUTES` / `CLOUD_EXPORTS_DAILY_LIMIT` are explicitly configured (>0). Defaults in `.env.example` are **0**. New migration `0002_cloud_usage.sql` is unapplied: global atomic daily admission counters and temporary job admission/expiry records. These records prevent unknown/expired job polling from waking a Container; they do not persist render state/output. Counters reserve actual validated PCM duration, cap transcription at 120 requests/day, and retain failed reservations. Export admission limits timelines to ten minutes. Bounded stream readers enforce body limits without trusting Content-Length.
- Public media proxy is allowlisted to admitted export/job operations; retired waveform/silence/preparation proxy operations return 404. Export polling stops on missing/expired jobs and waits for project durability before starting. Cloud export remains the **legacy editor export**, with explicit confirmation; browser timeline export is NOT integrated yet. With defaults, cloud export intentionally returns a disabled message rather than spend money.
- **Not yet hardened:** public project/media/upload routes, fallback subprocess concurrency/deadlines/cancellation/cleanup, admitted-job polling abuse within its TTL, full anonymous resource ownership. Do not enable cloud allowances or deploy this intermediate migration as fully secured. Container idle timeout is still **10 minutes**; change to five only after verifying active-job/download protection.

### Validation and evidence

- `bun test`: **37 passed**, 9 files, 107 assertions at this milestone. Typecheck and lint pass. Production Next build passes. Rerun after further changes.
- `bun run scripts/check-browser-media.ts` passes in isolated temporary **headless Chrome and Brave** profiles. `BROWSER_BIN` selects Brave. Script builds locally, creates/decodes a real 1080p H.264 + stereo AAC MP4 in OPFS, checks frame colors/audio, runs the actual analysis/preparation worker, checks trimmed WAV duration/offset, and tests pre-aborted analysis. No owner browser profile is used. This is NOT a ChatGPT in-app test, download/share test, long-file test or full renderer parity test.
- Probe output: 29,466-byte synthetic MP4, nominal two seconds but reported **2.069333s**, 99,328 decoded audio frames, detected silent interval ~1060–2070 ms; trimmed 1–2s WAV is 32,044 bytes and one second. **Investigate AAC encoder delay/padding and A/V alignment before accepting the full export engine.** Current smoke tolerance permits encoder padding; it must not be mistaken for sample-accurate parity.
- Official pricing checked: https://developers.cloudflare.com/containers/pricing/ lists 25 GiB-hours memory, 375 vCPU-minutes CPU, 200 GB-hours disk included per month; memory/disk use provisioned size. Current `standard-3` = 2 vCPU, **8 GiB RAM**, 16 GB disk: included memory alone covers ~3.125 uptime hours/month, including idle. This explains why frequent ten-minute wakeups exhausted allowance. Do not treat these historical fetched figures as an account-wide budget guarantee.
- Sources for subsequent checks: https://developers.cloudflare.com/workers-ai/platform/pricing/ ; https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/ (fetched unit price $0.00051/audio minute); https://developers.cloudflare.com/r2/pricing/ ; https://developers.cloudflare.com/containers/container-class/ ; https://mediabunny.dev/guide/converting-media-files ; installed `node_modules/mediabunny/dist/mediabunny.d.ts`.

### Second implementation pass — active, not release-ready

- Local file selection and IndexedDB projects/history are implemented (`local-store.ts`, `uploader.tsx`, `use-media-assets.ts`). Source Files stay in memory, not R2/OPFS; reopening requires explicit filename/size/lastModified relinking. Local saves atomically compare versions across tabs. Backup import validates documents/media/history and assigns a new project identity; history is preserved. Real IndexedDB/reload/failure browser checks are still needed.
- `editor/[id]/page.tsx` now uses `editor-shell.tsx`: shared canvas preview, composed-frame inspection, local MP4 export, existing timeline/inspector/panels, local music, explicit transcription with a cross-tab Web Lock, and protected/B-roll listing/removal. Old `editor.tsx` still contains the now-unrouted legacy controller plus exported reused panels. **Do not consider UI parity verified; run actual app browser tests before deleting that old controller.**
- Added `composition.ts`, `video-renderer.ts`, `audio-renderer.ts`, `use-timeline-player.ts`, `browser-export.ts`, and export worker/destination orchestration. Preview/inspection/export share canvas and audio semantics. Canonical output remains 1080p/30fps, stereo 48kHz, H.264 8Mbps + AAC 192kbps. `@soundtouchjs/core@2.1.1` supplies streaming WSOLA pitch-preserving tempo adjustment. PCM conversion uses NullTarget with actual PCM packets (returning null fails empty WAVE finalization).
- AAC delay is measured per export through a short actual encode/mux/decode probe, rather than hardcoded or dropping input samples. `mp4-timing.ts` inserts an AAC edit list and exact movie/track presentation durations into bounded moov-at-end metadata without changing mdat offsets. Chrome/Brave measure **2112 priming samples**. Native video reports **2.000s**, silence remains **1060–2000ms**, and the worker export passes. Mediabunny packet-scanned duration still reports **2.025333s** because it ignores edit-list segment end duration; do not mistake packet padding for presentation duration. Main-video metadata/analysis now use video-track duration rather than padded audio duration.
- Browser probe additionally checks 2× speed retains a 440Hz tone (not 880Hz), and runs the actual export worker with OPFS handle transfer and worker font loading. Both isolated headless Chrome and Brave pass. These remain short-fixture tests, **not full application playback/long export/ChatGPT Download/Share proof**.
- OPFS output checks estimated quota, supports cancellation and a one-hour execution timeout, and exposes Download/Share plus explicit temporary-file deletion. Direct file writer is used where genuinely available. **No R2 overflow implementation yet.** Temporary exports abandoned across navigation/replacement still need retention/cleanup/recovery work. No silent cloud fallback.
- New source-upload allocation endpoint returns 410, preventing new legacy R2 multipart allocations. Existing uploads' part/completion/cancel endpoints and legacy project/media/music endpoints remain and still need hardening; no stored cloud data was deleted. Cloud allowances remain zero, migration unapplied, Container timeout unchanged.
- Caption correction no longer collapses all edited words into a single sentence entry: unchanged word IDs/timing survive, changed words retain IDs where possible, inserted-word timing is estimated with confidence 0. Added regression coverage. Retranscription anchor reconciliation remains outstanding.
- Latest checks before this note: production Next build passes; lint/typecheck passed before subsequent small transcript/import edits and must be rerun. Added composition/MP4 metadata and transcript tests. No commits, deployments, subagents, remote migrations or paid processing.

### Browser application / recovery verification

- Interrupted large writes reported `terminated` in the owner UI; inspection confirmed no partial `check-editor*` file existed. Recreated `scripts/check-editor.ts` in smaller successful writes. The termination's harness/provider cause remains unknown; it was not normal browser cleanup.
- Actual production-built application checks pass in isolated Chrome and Brave: human-style local selection, shared WebMCP rename/durability, composed inspection, audio-clock playback, worker MP4 render, browser Download, FFprobe validation of the downloaded **3.000s** MP4, reload/relink, and undo history surviving reload. Test blocks `/api/*` and records **zero cloud API requests**. This is real headless browser download, not proof of the macOS save dialog or ChatGPT in-app Share UX.
- Expanded actual-app Chrome check passes a competing IndexedDB write, stale-save rejection, fail-stop queue, pending work surviving reload, and a downloaded pending backup imported as a new local project. Rerun expanded checks in Brave after further edits. Backup now includes source/music descriptions; legacy metadata uses unknown lastModified=null instead of inventing a file timestamp.
- Recovery journal identity now uses a live Web Lock: cloned sessionStorage in duplicated tabs cannot share a live journal. Browser media probe verifies separate live ownership and reclaim after release, atomic competing IndexedDB saves, and backup history/identity restoration.
- Browser media probe also cancels a real in-progress export and confirms an existing destination is unchanged, and forces a zero-quota estimate to verify pre-export rejection. These are not a real disk-full write failure or a long-file memory test.
- WebMCP registration now follows project/media readiness; media-dependent tools disappear while relinking is needed. Bounded integer validation prevents negative/nonfinite/fractional pagination from expanding tool responses. A render failure no longer retries and reports the same error every animation frame. Frame inspection seeks the shared visible canvas without opening an unnecessary modal.
- Latest full unit run: 40 tests / 129 assertions before the additional pagination test. Typecheck/lint pass after current changes. Production build and actual-app Chrome check passed before the latest tool readiness edits; rerun. No deployments, remote migrations or paid tests.

### Next work (continue without another go)

1. Finish export retention/recovery: abandoned OPFS exports currently survive navigation without a listing. Add explicit recovery/deletion UX, bounded lifecycle and failure checks without deleting active downloads or original media. Exercise longer output/memory and actual quota-write failure. R2 overflow remains unimplemented and must remain consented/fail-closed.
2. Finish retranscription anchor reconciliation, bounded history/backup-size consistency, corrupt-journal recovery, and remaining human B-roll/protection/error controls. Verify legacy uninitialized projects and legacy backups/relinking; do not silently abandon cloud data.
3. Expand browser parity fixtures for gaps, transitions, trims, speed, music/loops, text, VFR/no-audio, seek/cancel and continuous playback. Then remove the unrouted old controller/CSS renderer from `editor.tsx`, preserving its reused timeline/panels. Actual ChatGPT in-app long Download/Share still requires an owner-run test; no deployment authorized.
4. Harden remaining legacy upload/music routes and fallback infrastructure (concurrency/deadlines/cancellation/expiry, active-safe five-minute idle, admission and anonymous capabilities). Cloud allowances remain zero and migration unapplied. Real D1 integration remains unverified.
5. Refresh README and this brief, rerun all checks. Overall rearchitecture is **not complete**; do not deploy the intermediate branch as finished.
