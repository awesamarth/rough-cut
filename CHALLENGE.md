# ROUGH//CUT — WebMCP Challenge submission draft

## The idea

Video editors usually make people choose between manual control and opaque AI automation. ROUGH//CUT keeps the human in control while giving any WebMCP-compatible agent precise hands inside the same editor.

A human can upload, preview, scrub, split, trim, move, grade, caption, mix background music and export a real video without an agent. An external agent can inspect the same project and perform the same versioned edits through 37 directly registered WebMCP tools. There is no built-in chatbot and no proprietary agent integration.

## Why WebMCP fits

Video editing is stateful and visual. A broad instruction such as “tighten the pacing but preserve the technical explanation” requires an agent to inspect timestamps, protect important ranges, make several edits, and react if the human changes the timeline.

ROUGH//CUT exposes narrow tools for that workflow:

- Read the project, transcript and exact frames.
- Detect real audio silences with FFmpeg.
- Transcribe the source with word timestamps.
- Split, trim, delete, move and reorder clips.
- Adjust color, transforms, speed, volume, fades and transitions.
- Manage and edit styled captions, overlays, protected ranges and B-roll briefs.
- Adjust or remove a human-uploaded background-music track.
- Undo, redo and export MP4 or EDL.

Every mutation requires `expected_version`. If a human edits version 12 while an agent still expects version 12, the agent receives `STALE_VERSION:13`, rereads the project, and plans against reality instead of overwriting the human.

## Human–agent cooperation

Both interaction paths call the same non-destructive command layer:

```text
Human controls ─┐
                ├─ versioned commands → project revisions → preview/export
WebMCP tools ───┘
```

Agent edits immediately appear in the timeline and activity feed. Human edits remain available at all times. Both are undoable. The original upload is immutable; project state stores source ranges, timeline positions and effect parameters.

This makes the agent useful without making it authoritative. The human supplies taste, reviews visible changes, and can refine or reverse any decision.

## Real media pipeline

ROUGH//CUT does not mock media processing:

- Chunked uploads are stored in Cloudflare R2.
- Projects and revisions are stored in D1.
- Cloudflare Whisper Large v3 Turbo produces word timestamps.
- A session-only OpenAI `whisper-1` key is an optional fallback and is never persisted.
- FFmpeg detects silence, extracts transcription audio, generates waveform peaks, renders captions/effects/transitions, inserts black and silent gaps, and produces MP4.
- CMX3600-style EDL export preserves explicit record positions.
- The browser preview uses the immutable source and applies the saved timeline model live.

The FFmpeg service runs in Docker locally and in an on-demand Cloudflare Container in production. Production smoke tests cover waveform extraction, silence detection, transcription preparation, Workers AI invocation, and canonical MP4 rendering.

## UX improvements

The editor includes fixed S1 subtitle, V2 graphics, V1 source-video, A1 linked-audio and A2 background-music lanes with real waveform data, a scalable ruler, draggable playhead, edge trimming, linked clip movement, collision rejection, snapping, edge auto-scroll, pointer-centered timeline zoom, playback-follow scrolling, keyboard transport and undo/redo, resizable work areas, and a responsive inspector.

Clips support explicit gaps and independent X/Y zoom and pan. Preview and FFmpeg export use the same saved values. Component styling is Tailwind-first, controls expose accessible names and states, keyboard focus is visible, and reduced-motion preferences are respected.

## Suggested demo flow

1. Open a prepared transcribed project.
2. Ask an external agent to preserve a technical section, remove genuine silences, tighten pacing, add subtle transitions and captions, and mark B-roll opportunities.
3. Show the agent reading the project/transcript and applying versioned WebMCP commands.
4. Show the timeline and activity feed updating visibly.
5. Make a manual trim or transform adjustment.
6. Let the agent reread the new version and refine around the human edit.
7. Play the real preview and export MP4 plus EDL.

## Links

- Live app: https://rough-cut.samarthsaxena1672003.workers.dev
- Source: https://github.com/awesamarth/rough-cut
- License: MIT
