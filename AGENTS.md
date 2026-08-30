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

- Single source video is the deliberate v1 scope.
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
- Captions, simple text overlays, and B-roll markers/briefs.
- Silence suggestions that can be reviewed before removal.
- Undo/redo, autosave, edit history, and an agent-activity feed.

## Editing model

- Transcript words have stable IDs, source timestamps, and confidence where available.
- Clips reference `[sourceInMs, sourceOutMs)` ranges from the immutable source.
- Timeline positions derive from clip order and transition durations.
- Captions, protected ranges, and B-roll markers anchor to words/clips so they survive reordering.
- Every mutation increments `project_version` and stores enough history for undo/redo.
- Mutating tools receive `expected_version`. If the human changed version 12 to 13, an agent call expecting 12 is rejected as stale and must reread before retrying.

## WebMCP tools

Keep schemas narrow, validate all input, and return the new version plus a structured human-readable diff.

### Inspect

- `get_project_state`
- `get_transcript`
- `search_transcript`
- `inspect_frame`
- `detect_silences`

### Process and edit

- `transcribe_video`
- `split_clip` / `trim_clip` / `delete_clip`
- `remove_segments` (batch)
- `reorder_clips` / `move_clip`
- `adjust_clip` (color, transform, volume, speed, fades)
- `set_transition`
- `set_captions` / `add_caption` / `remove_caption`
- `add_text_overlay` / `remove_text_overlay`
- `protect_segment` / `unprotect_segment`
- `mark_broll` / `remove_broll`
- `undo` / `redo`

### Output

- `render_preview`
- `export_mp4`
- `export_edl`

Register only tools valid for the current project state (uploading, processing, ready, exporting). Tool calls and human controls must invoke the same editing commands.

## Silence removal

Do not infer silence from transcript gaps alone. Use FFmpeg audio silence detection, cross-check candidates against word timestamps, and retain configurable speech padding (initially about 150–250 ms). `detect_silences` returns candidates; the agent or human applies them through `remove_segments`.

## Minimal implementation primitives

- Next.js + TypeScript on Cloudflare Workers; D1 for projects/revisions and R2 for media.
- Native WebMCP imperative API; no wrapper until required.
- FFmpeg in Docker locally and an on-demand Cloudflare Container when deployed.
- Default transcription: Workers AI `@cf/openai/whisper-large-v3-turbo` with word timestamps.
- Optional BYOK: OpenAI `whisper-1`; keys stay session-only and are never stored or logged.
- FFmpeg creates valid audio chunks whose timestamp offsets are merged after transcription.
- Native video/canvas APIs for exact-frame inspection.

No speaker diarization. “Render” means FFmpeg video generation, not Render.com.

## Production bar

- Durable autosave and safe concurrent human/agent editing.
- Validated schemas, permissions, ranges, transition limits, and protected ranges.
- Explicit processing states, progress, cancellation, retry, and useful errors.
- Actual preview/final output must match the saved timeline.
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
- Multiple source videos, multi-camera, or general multi-track editing.
- Generated/sourced B-roll; markers and briefs are sufficient.
- Advanced grading, audio mixing, effects, collaboration, or plugin systems.

## Submission requirements

- Working public URL usable from ChatGPT’s in-app browser or WebMCP-enabled Chrome.
- Public repository with source, setup instructions, assets, and a visible open-source license.
- Concise write-up explaining WebMCP fit, human-agent cooperation, UX improvement, and implementation.
- Public YouTube demo under three minutes with audio.

## Current status

The editor, versioned command layer, 28 direct WebMCP tools, D1/R2 persistence, Workers AI transcription, local FFmpeg pipeline, authenticated media proxy, exports, tests, public Worker, and public repository are implemented. Sliders preview live; the playhead/ruler supports click-drag scrubbing; the unified clip lane includes real FFmpeg-derived waveforms; preview/timeline/lower panes are vertically resizable; and the timeline supports Option/Alt-wheel zoom, drag-edge auto-scroll, explicit gaps, non-ripple trims, linked movement, snapping, X/Y zoom and pan, and keyboard transport/undo. Component styling is Tailwind-first, global CSS contains only tokens and base behavior, and editor controls have responsive layouts, keyboard focus indicators, accessible names, and reduced-motion behavior. The Cloudflare Container image is deployment-ready but the account must be upgraded to Workers Paid before Cloudflare will accept it. Submission assets still needed: final write-up review and a sub-three-minute YouTube demo.
