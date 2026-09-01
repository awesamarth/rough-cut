# ROUGH//CUT

A human-first, WebMCP-native video editor. Humans edit through the timeline and transcript; compatible browser agents call the same versioned editing commands through `document.modelContext.registerTool`.

**Live app:** https://rough-cut.samarthsaxena1672003.workers.dev  
**Source:** https://github.com/awesamarth/rough-cut

## What works

- Chunked video uploads to R2 and durable project revisions in D1
- Non-destructive split, non-ripple trim, delete, reorder, explicit gaps, protected ranges, undo and redo
- Brightness, contrast, saturation, hue, independent X/Y zoom and pan, volume, mute and speed controls
- Crossfades, fade-through-black, edge fades, editable styled captions and text overlays
- Fixed S1/V2/V1/A1/A2 lanes with linked source audio and one background-music track
- B-roll markers and exact-frame inspection
- FFmpeg silence detection with configurable speech padding
- Automatic post-upload Cloudflare Whisper Large v3 Turbo transcription with word timestamps
- Optional session-only OpenAI `whisper-1` key
- Canonical 1920×1080 browser preview and FFmpeg MP4 output with fixed-layout text parity, plus CMX3600-style EDL export
- 37 direct WebMCP tools with optimistic version checks
- Responsive, keyboard-accessible editor UI styled with Tailwind utilities
- Editor shortcuts: Space play/pause, Backspace lift-delete, Delete ripple-delete, and Cmd/Ctrl+Z undo

No built-in chat or agent is included. Open the app inside a WebMCP-compatible agent browser.

## Local development

Requirements: Bun, Docker Desktop, Wrangler authentication, and a browser-playable source video (H.264/AAC MP4 works best).

```bash
bun install
cp .env.example .dev.vars
bun run db:migrate:local
docker compose up --build -d
bun run dev
```

Open http://localhost:3000. The local media service runs at http://localhost:8788.

Useful checks:

```bash
bun run typecheck
bun test
curl http://localhost:8788/health
docker compose logs -f media
```

## Cloudflare

The app uses:

- Worker: `rough-cut`
- D1: `rough-cut-db`
- R2 media: `rough-cut-media`
- R2 Next cache: `rough-cut-next-opennext-cache`
- Workers AI: `@cf/openai/whisper-large-v3-turbo`

For a new Cloudflare account, create those resources, replace the D1 ID and worker URLs in the Wrangler configs, then run:

```bash
bunx wrangler login
bun run db:migrate:remote

TOKEN=$(openssl rand -hex 32)
printf '%s' "$TOKEN" | bunx wrangler secret put MEDIA_WORKER_TOKEN --config media-worker/wrangler.jsonc
printf '%s' "$TOKEN" | bunx wrangler secret put MEDIA_WORKER_TOKEN --config wrangler.jsonc

bun run media:deploy
bun run deploy
```

Production media processing runs in an on-demand Cloudflare Container on Workers Paid. The browser talks only to the Next.js `/api/media/*` proxy; the separate media Worker rejects requests without the shared secret.

## Media architecture

Uploaded originals remain immutable. Every edit is stored as source timestamps and parameters. Browser preview and FFmpeg share a canonical 1920×1080 frame, source letterboxing, and fixed-coordinate text layout using the same bundled font and styling.

```text
Browser UI ─┐
WebMCP tools ├─ editing commands → D1 revisions
             └─ authenticated API proxy → FFmpeg Container → MP4
                                          └→ audio chunks → Workers AI transcript
```

## WebMCP tools

Open an editor project in ChatGPT's in-app browser or enable `chrome://flags/#enable-webmcp-testing`. Tools register directly through `document.modelContext.registerTool`; no agent SDK or built-in chat is used.

- Inspect: `get_project_state`, `get_transcript`, `search_transcript`, `inspect_frame`, `detect_silences`
- Process: `transcribe_video`
- Project: `rename_project`
- Timeline: `split_clip`, `split_text`, `split_background_music`, `trim_clip`, `delete_clip`, `remove_segments`, `reorder_clips`, `move_clip`, `adjust_clip`, `set_transition`
- Text and markers: `set_captions`, `add_caption`, `update_caption`, `remove_caption`, `set_caption_style`, `add_text_overlay`, `update_text_overlay`, `remove_text_overlay`, `protect_segment`, `unprotect_segment`, `mark_broll`, `remove_broll`
- Music: `adjust_background_music`, `remove_background_music`
- History: `undo`, `redo`
- Output: `render_preview`, `export_mp4`, `export_edl`, `export_srt`

Every mutation requires the version returned by `get_project_state`. A stale agent receives `STALE_VERSION:<current>` and must reread before retrying. Human and agent actions call the same command layer, increment the same version, remain undoable, and appear in the activity panel.

## License

MIT
