# Local codec license audit

Scope: installed Mediabunny and four extensions at **1.55.7**, TurboRes **1.2.2**. This is an engineering compliance check, not a legal opinion or patent clearance. No deployment or upstream issue/contact was performed.

## Verified

- Mediabunny, all four extension wrappers and TurboRes declare **MPL-2.0**. Their installed license texts match; a copy is served at `/licenses/MPL-2.0.txt`.
- MPL permits commercial use and larger works under other licenses. Keep notices, make the covered source (including any modifications) available, and tell recipients how to obtain it. Our separate application files need not become MPL merely because they use these libraries. Minified browser JavaScript counts as executable distribution, not preferred source form.
- ProRes uses TurboRes, not the FFmpeg builds discussed below. Versioned source: [ProRes wrapper](https://github.com/Vanilagy/mediabunny/tree/v1.55.7/packages/prores), [TurboRes](https://github.com/Vanilagy/turbores/tree/v1.2.2).
- AAC/AC3/DTS package recipes compile FFmpeg's `libavcodec.a` and `libavutil.a` into the WASM bridge. This is static linkage inside WASM, even though our application imports the resulting JavaScript lazily.
- Those recipes do **not** enable `--enable-gpl`, `--enable-nonfree` or libx264. They select the AAC encoder, AC3/EAC3 coders or DCA coders respectively. This is evidence of intended LGPL builds, not proof of how the prebuilt artifacts were actually compiled.
- FFmpeg's default license is **LGPL-2.1-or-later**; enabling GPL components changes its applicable license. The MPL wrapper cannot relicense FFmpeg. A verbatim LGPL2.1 copy is served at `/licenses/LGPL-2.1.txt`.
- LGPL distribution requires notices/license text and corresponding-source obligations. The static bridge also needs an applicable LGPL section6 path allowing modification/relinking; simply saying “it is WASM” or linking to FFmpeg's homepage is insufficient.

## Unresolved release gate

The package READMEs instruct the builder to clone FFmpeg and set `FFMPEG_PATH`, but do not identify the exact FFmpeg revision, patch set or toolchain used for the shipped WASM. Published installed package sources include bridges/wrappers, not the complete corresponding FFmpeg source.

A local synthetic AAC encode using the installed WASM emitted the encoder identification **`Lavc62.23.103`**. This is useful provenance evidence but does not uniquely identify a source commit or prove the build configuration. In particular, the earlier guessed FFmpeg `n7.1` reference was not supported and has been removed.

**Do not mark these prebuilt FFmpeg extensions cleared for public redistribution yet.** A public MIT application repository plus generic upstream links does not close this gap. Adding license text alone does not close it either.

To close the gate, either:

1. Obtain the exact source revision/patches/configuration and rebuild/relink materials for these artifacts from upstream; verify them and provide the required source access/notices alongside our distribution; or
2. Replace only these prebuilt codec artifacts with builds from a pinned, retained FFmpeg source/toolchain, explicitly disabling GPL/nonfree components. Preserve build scripts, sources/patches and bridge/relink instructions, validate the resulting codecs, and publish the necessary materials with the application.

No paid/proprietary license requirement was found in the MPL/LGPL terms themselves. Codec patent/trademark obligations are separate, jurisdiction/use-dependent questions; this audit does not grant patent clearance.

## Primary references

- [Mozilla MPL FAQ: questions8,11,16](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [FFmpeg official license and compliance checklist](https://ffmpeg.org/legal.html)
- [LGPL2.1 text, especially sections4–6](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)
- Versioned build recipes: [AAC](https://github.com/Vanilagy/mediabunny/blob/v1.55.7/packages/aac-encoder/README.md), [AC3](https://github.com/Vanilagy/mediabunny/blob/v1.55.7/packages/ac3/README.md), [DTS](https://github.com/Vanilagy/mediabunny/blob/v1.55.7/packages/dts/README.md).
