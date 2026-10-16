# MP4/MOV Spatial Metadata Studio

**Live Demo:** [https://dskhanal.github.io/spatial-video-metadata/](https://dskhanal.github.io/spatial-video-metadata/)

A 100% client-side, zero-re-encoding MP4 and MOV binary editor built with vanilla JavaScript, HTML5, and Three.js[cite: 2, 3]. Rather than re-compressing video or audio streams (`mdat`), this studio parses and reconstructs ISO Base Media File Format (`ISOBMFF`) header atoms (`moov`) directly in browser memory—making exports instantaneous and completely lossless[cite: 2, 3].

---

## Key Features

### 1. 360° Spatial Video & Interactive WebGL Viewport (`uuid`)
* **Live 360° Equirectangular Preview:** Maps your video onto an inverted Three.js 3D sphere so you can drag to pan (Yaw), tilt (Pitch), scroll to zoom (FOV `30°–110°`), and adjust horizon Roll in real time[cite: 2, 3]. Includes a toggleable **Flat View** mode[cite: 2, 3].
* **One-Click Initial Pose Capture:** Frame your desired starting subject in the 360° viewport and click **Set Current View as Initial** to write `InitialViewHeadingDegrees`, `InitialViewPitchDegrees`, and `InitialViewRollDegrees` into the Spherical Video V1 XML `uuid` atom[cite: 2, 3].
* **3D Stereo Signaling:** Configure `Monoscopic (2D 360°)`, `Top-Bottom (3D Over/Under)`, or `Left-Right (3D Side-by-Side)` layouts recognized by YouTube, Meta Quest, VLC, and VR players[cite: 2, 3].

### 2. Panopto-Style Non-Destructive Timeline & Sync (`edts` / `elst`)
* **Multi-Segment Cuts & Skips:** Mark timeline ranges to skip during playback[cite: 2, 3]. The tool compiles your kept intervals into standard MP4 Edit List (`elst`) entries and updates `mvhd` and `tkhd` durations so media players display the trimmed runtime while 100% of the original footage remains preserved inside the file[cite: 2, 3].
* **Speed Ramps & Freeze Frames:** Assign per-segment playback rates (`0.5x` slow-mo, `2x`, `4x` timelapse, or `0x` freeze-frame dwell) using `16.16` fixed-point `elst` rate integers[cite: 2, 3].
* **Audio/Video Sync Offset:** Fix out-of-sync audio tracks down to the millisecond[cite: 2, 3]. Positive delays inject a standard `media_time = -1` empty edit at the start of the audio track; negative offsets advance the audio track's starting `media_time`[cite: 2, 3].

### 3. Lossless Geometry & Orientation (`tkhd` Matrix)
* **Instant Rotation & Mirroring:** Rewrites the 36-byte `3x3` fixed-point transformation matrix inside the video Track Header (`tkhd`) to rotate footage (`0°`, `90°`, `180°`, `270°` clockwise) or mirror it (`Horizontal` / `Vertical`) with automatic width/height translation (`tx`, `ty`)[cite: 2, 3].

### 4. Interactive Chapters, Catalog Tags, GPS & Cover Art (`udta`)
* **Chapter Markers (`chpl`):** Injects Nero/QuickTime-compatible chapter timestamps (`100ns` tick resolution) that appear as clickable timeline ticks in VLC, QuickTime, and desktop players[cite: 2, 3].
* **Catalog Metadata (`meta` -> `ilst`):** Embeds Title (`©nam`), Artist/Creator (`©art`), and Comment/Description (`©cmt`) UTF-8 atoms[cite: 2, 3].
* **Geotagging (`©xyz`):** Formats latitude and longitude into ISO-6709 strings so Apple Photos, Google Photos, and media managers plot the video on a map[cite: 2, 3].
* **Custom Cover Thumbnail (`covr`):** Embeds a custom JPEG or PNG image directly into the container header as the file's poster icon[cite: 2, 3].

### 5. Captions (`tx3g`), Transcript (`©lyr`) & Subtitle I/O
* **Standard MP4 Timed Text Track (`sbtl` / `tx3g`):** Compiles captions into a genuine MP4 subtitle track (`trak` + appended `mdat`) with configurable 3-letter ISO-639-2 language codes (`mdhd` + `elng`, default `eng`) and default visibility flags (`tkhd`).
* **Edit-List Synced Subtitles:** Automatically applies your non-destructive cuts, speed ramps, and freeze frames (`edts` -> `elst`) to the subtitle track so captions stay locked in sync with the edited timeline.
* **Import, Inline Edit & Multi-Format Export:** Import `.srt` or `.vtt` files, add or edit cues inline (Start, End, Text), use the **Grab** button to pull playhead timestamps[cite: 2, 3], and download standalone `.srt`, `.vtt`, timestamped `.txt`, or plain-text transcript `.txt` files at any time.
* **Live Viewport Overlay:** Renders active captions over both the 360° WebGL sphere and the 2D flat preview.
* **Embedded Transcript (`©lyr`):** One-click **Build from Captions** populates a free-text transcript box saved inside the MP4 lyrics atom (`©lyr`) and the Studio's state atom.

### 6. Re-Editable Project State (`STUDIO_STATE_UUID`)
* **Round-Trip Non-Destructive Workflow:** Every exported file embeds a custom `uuid` atom storing your cuts, speed rules, chapters, captions, transcript, and 360° camera pose[cite: 3]. Dropping an exported `_studio_360.mp4` file back into the studio restores your entire timeline so you can undo cuts or tweak captions later without duplicating tracks[cite: 3].

---

## Technical Details: How Binary Rebuilding Works
1. **Two-Layer Container Guard:** Validates both the `.mp4`/`.mov` filename extension and the 4-byte ISOBMFF magic signature (`ftyp`, `moov`, `wide`, `mdat`, `free`, `skip`, `pnot`) at byte offset `4` before parsing[cite: 3].
2. **Automatic Chunk Offset Shifting (`stco` / `co64`):** When `moov` precedes `mdat` (fast-start web videos), changing the size of `moov` shifts the byte positions of all media chunks[cite: 3]. The rebuilder automatically traverses every video and audio track's sample table and shifts all 32-bit (`stco`) and 64-bit (`co64`) chunk pointers by the exact byte delta[cite: 3].
3. **Idempotent Subtitle Replacement:** Marks the studio-generated `tx3g` track with a dedicated `STUDIO_TX3G_UUID` so re-exporting replaces only the studio's previous caption track while preserving any pre-existing third-party subtitle tracks.

---

## Limitations & Known Caveats

* **Auto-Captioning Uses Microphone Dictation (Not Direct Audio-Track Decoding):**
  * The built-in auto-captioning feature relies strictly on the browser's native Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`), which listens to your **microphone input** rather than decoding the video's internal audio stream directly.
  * **Speaker Requirement:** As noted in the UI, your speakers must be audible to your microphone while the video plays (unless you route system audio through a virtual loopback driver like BlackHole or VB-Cable).
  * **Noise & Headphones:** Because it captures live acoustic audio via the mic, it will pick up ambient room noise and **will fail if you wear headphones**.
  * **Browser Support:** Native `SpeechRecognition` is supported in Chromium-based browsers (Chrome, Edge) and Safari, and typically requires an active internet connection for the browser vendor's speech service.
* **Strict `.mp4` and `.mov` Container Policy:**
  * Only ISO Base Media (`.mp4`) and QuickTime (`.mov`) files are accepted[cite: 2, 3]. Formats like `.mkv`, `.webm` (EBML), or `.avi` (RIFF) use different binary structures and are rejected[cite: 2, 3].
* **Player Compatibility for `elst` & `tx3g`:**
  * **Desktop & Mobile Players:** Non-destructive Edit Lists (`elst`), chapters (`chpl`), and `tx3g` subtitle tracks work natively in QuickTime Player, iOS/macOS, VLC, MPV, and FFmpeg-based tools.
  * **Web Platforms & Browsers:** Native HTML5 `<video>` tags do not render embedded MP4 `tx3g` subtitle tracks (which is why this studio draws its own live caption overlay), and upload platforms like YouTube ignore embedded `tx3g` captions (use the **Download .SRT / .VTT** buttons to upload captions separately to YouTube).
* **Keyframe (GOP) Boundaries on Non-Destructive Cuts:**
  * Because `mdat` video frames are never re-encoded, cuts that land between keyframes (I-frames) rely on the media player to pre-roll silently from the preceding keyframe[cite: 2, 3].
* **In-Memory (`ArrayBuffer`) File Size Ceiling:**
  * Files are processed entirely in browser RAM[cite: 3]. Videos up to **1–2 GB** export smoothly, while multi-gigabyte 8K files may hit browser tab memory limits[cite: 3].

---

## Future Upgrades & Roadmap
* **Direct Audio-Track Transcription via `transformers.js` & Whisper:** Future upgrades will integrate `@huggingface/transformers` (`transformers.js`) to run OpenAI's **Whisper** speech-to-text model (`whisper-tiny` / `whisper-base`) directly in the browser using WebGPU / WebAssembly.
  * **No Microphone or Speaker Loopback Needed:** Instead of listening through the microphone, the tool will decode the video's internal audio track directly via `OfflineAudioContext` at `16kHz` mono. It will work silently, ignore room noise, and function seamlessly while wearing headphones.
  * **100% Offline & Private After Initial Cache:** Once the browser downloads and caches the Whisper model weights on first run (~40 MB for `tiny` or ~150 MB for `base`), automatic phrase-timestamped caption generation will run completely offline on your local machine.

---

## Local Usage
No build step or server installation is required:
1. Clone or download `index.html`, `style.css`, and `app.js` into the same folder[cite: 1, 2, 3].
2. Open `index.html` in any modern desktop browser (or serve locally via `npx serve` / VS Code Live Server if testing microphone permissions over `http://localhost`)[cite: 2].
