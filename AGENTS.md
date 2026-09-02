# ROUGH//CUT

> Living project brief. Read before working and update it whenever scope, architecture, tools, or deployment decisions change.

## Mission

Build a production-ready, human-first, WebMCP-native video editor for **The WebMCP Challenge** (deadline: **4 September 2026, 01:30 IST**). The goal is a winning submission, not a mocked proof of concept.

A human supplies taste and manually edits when desired. Any WebMCP-compatible external agent performs precise, visible, reversible edits through structured tools. **ROUGH//CUT has no built-in agent or chat.**

## Product promise

Upload one real interview, podcast, tutorial, or product demo. ROUGH//CUT transcribes it and presents a synchronized video, transcript, and timeline. Humans and agents edit the same project through the same command layer.

```text
Human controls ─┐
                ├─ editing commands → versioned project → timeline/export
WebMCP tools ───┘
```

## Non-negotiables

- One immutable source video plus one optional background-music asset is the deliberate v1 scope.
- Human UX must be complete; this is agent-native, not agent-only.
- Real uploads, transcription, persistence, processing, and exports—no fake tool results.
- Agent actions visibly update the editor and remain undoable.
- Use direct `document.modelContext.registerTool`; support every compliant external agent.
- Source media is immutable; all editing is non-destructive.
- MP4 and EDL exports stay in scope.
- Use Tailwind utility classes in JSX for component and layout styling. Touch `globals.css` only for root tokens, base resets, keyframes, or selectors that Tailwind cannot express cleanly; do not add component-specific CSS there.

## Human editor

- Video preview with draggable playhead and exact timecode.
- Transcript selection for splitting, deleting, and protecting ranges.
- Timeline with trim handles and drag-to-reorder clips.
- Inspector for brightness, contrast, saturation, hue, volume/mute, and speed.
- Cuts, crossfades, fade-to-black, fade-in, and fade-out.
- Editable caption and text-overlay lanes, caption styling, and B-roll markers/briefs.
- A linked source-audio lane plus one independent background-music lane with trim, move, loop, volume, mute, and fades.
- Silence suggestions that can be reviewed before removal.
- Undo/redo, autosave, edit history, and an agent-activity feed.
- Keyboard editing follows NLE conventions: Backspace lift-deletes and leaves the gap; Delete ripple-deletes and closes the removed span.

## Editing model

- Transcript words have stable IDs, source timestamps, and confidence where available.
- Clips reference `[sourceInMs, sourceOutMs)` ranges from the immutable source.
- Timeline positions derive from clip order and transition durations.
- Captions, protected ranges, and B-roll markers anchor to words/clips so they survive reordering.
- Fixed semantic lanes are S1 subtitles, V2 text/graphics, V1 source video, A1 linked source audio, and A2 background music; this is not a general multi-track compositor.
- Every mutation increments `project_version` and stores enough history for undo/redo.
- Mutating tools receive `expected_version`. If the human changed version 12 to 13, an agent call expecting 12 is rejected as stale and must reread before retrying.

## WebMCP tools

Keep schemas narrow, validate all input, and return the new version plus a structured human-readable diff.

### Start

- `request_video_upload` (landing page; focuses and highlights the human-operated upload control)

### Inspect

- `get_project_state`
- `get_activity`
- `get_transcript`
- `search_transcript`
- `inspect_frame`
- `detect_silences`

### Process and edit

- `rename_project`
- `transcribe_video`
- `split_clip` / `trim_clip` / `delete_clip` / `split_text` / `split_background_music`
- `remove_segments` (batch)
- `reorder_clips` / `move_clip`
- `adjust_clip` (color, transform, volume, speed, fades)
- `set_transition`
- `set_captions` / `add_caption` / `update_caption` / `remove_caption` / `set_caption_style`
- `add_text_overlay` / `update_text_overlay` / `remove_text_overlay`
- `request_background_music_upload` / `adjust_background_music` / `remove_background_music`
- `protect_segment` / `unprotect_segment`
- `mark_broll` / `remove_broll`
- `undo` / `redo`

### Output

- `render_preview`
- `export_mp4`
- `export_edl`
- `export_srt`

Register only tools valid for the current project state (uploading, processing, ready, exporting). Tool calls and human controls must invoke the same editing commands.

## Silence removal

Do not infer silence from transcript gaps alone. Use FFmpeg audio silence detection, cross-check candidates against word timestamps, and retain configurable speech padding (initially about 150–250 ms). `detect_silences` returns candidates; the agent or human applies them through `remove_segments`.

## Minimal implementation primitives

- Next.js + TypeScript on Cloudflare Workers; D1 for projects/revisions and R2 for media.
- Native WebMCP imperative API; no wrapper until required.
- FFmpeg in Docker locally and an on-demand Cloudflare Container when deployed.
- Default transcription: Workers AI `@cf/openai/whisper-large-v3-turbo` with word timestamps.
- Optional BYOK: OpenAI `whisper-1`; keys are forwarded by the app Worker only to OpenAI and are never stored server-side or logged, and users may explicitly remember one in device-local browser storage.
- FFmpeg creates valid five-minute audio chunks and reports each segment's actual timestamp offset for exact merging after transcription.
- Native video/canvas APIs for exact-frame inspection.

No speaker diarization. “Render” means FFmpeg video generation, not Render.com.

## Production bar

- Durable autosave and safe concurrent human/agent editing.
- Validated schemas, permissions, ranges, transition limits, and protected ranges.
- Explicit processing states, progress, cancellation, retry, and useful errors.
- Actual preview/final output must match the saved timeline. Preview and export share a canonical 1920×1080 frame; text uses fixed logical coordinates and the bundled DejaVu Sans Bold font so resizing the editor only scales the completed frame and never reflows it.
- Tests cover command invariants, silence safeguards, undo, stale versions, and export correctness.
- Accessible, responsive controls that work inside ChatGPT’s in-app browser and WebMCP-enabled Chrome.

## Demo story (<3 minutes)

1. Open a prepared project or upload a video.
2. Ask an external agent: “Make this energetic, preserve the technical explanation, add subtle fades and captions, and mark B-roll opportunities.”
3. Agent reads/searches the transcript, protects technical content, and edits through WebMCP.
4. Timeline and activity feed visibly update.
5. Human manually adjusts a clip; agent rereads the new version and refines around it.
6. Play the real preview and export MP4 plus EDL.

## Explicitly out of scope for now

- Built-in LLM, chat, or proprietary agent integration.
- Multiple source videos, multi-camera, or general-purpose multi-track editing beyond the fixed text, linked source audio, and background-music lanes.
- Generated/sourced B-roll; markers and briefs are sufficient.
- Advanced grading, audio mixing, effects, collaboration, or plugin systems.

## Submission requirements

- Working public URL usable from ChatGPT’s in-app browser or WebMCP-enabled Chrome.
- Public repository with source, setup instructions, assets, and a visible open-source license.
- Concise write-up explaining WebMCP fit, human-agent cooperation, UX improvement, and implementation.
- Public YouTube demo under three minutes with audio.

## Current status

The editor, versioned command layer, 40 direct WebMCP tools, D1/R2 persistence, automatic post-upload Workers AI transcription, local and deployed FFmpeg pipelines, authenticated media proxy, exports, tests, public Worker, and public repository are implemented. Sliders preview live; the playhead/ruler supports click-drag scrubbing; fixed S1/V2/V1/A1/A2 lanes expose editable captions, overlays, linked source waveforms, and one real background-music workflow; preview/timeline/lower panes are vertically resizable; and the timeline supports Option/Alt-wheel zoom, drag-edge auto-scroll, explicit gaps, non-ripple trims, linked movement, snapping, X/Y zoom and pan, and keyboard transport/undo. Preview and MP4 export now share a canonical 1920×1080 frame and fixed-coordinate text layout, including the same bundled font, margins, sizing, colours, backgrounds, alignment, and source letterboxing. The landing page keeps a device-local index of opened projects, project renames use the versioned command layer, and MP4 export supports a base-filename dialog plus the native save-location picker where available. WebMCP mutations return compact versioned field diffs instead of complete project snapshots; project state includes only the latest three activity entries, with paginated history available through `get_activity`. Generated captions break at five words, sentence punctuation, long pauses, or three seconds, and clip-speed previews/commits retime affected subtitles locally from their existing timing without retranscription. Component styling is Tailwind-first, global CSS contains only tokens and base behavior, and editor controls have responsive layouts, keyboard focus indicators, accessible names, and reduced-motion behavior. The Cloudflare Container and latest web Worker are deployed; production smoke tests pass for health/FFmpeg, waveform extraction, silence detection, transcription preparation, Workers AI invocation, canonical MP4 rendering, and named downloads. Submission assets still needed: final write-up review and a sub-three-minute YouTube demo.
