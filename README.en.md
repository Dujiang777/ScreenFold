# ScreenFold

**English** · [简体中文](README.md)

> A screen that doesn't look like a video.

A small always-on-top panel that lives on your desktop. The title bar reads `feed.aggregator.ts`, the status bar says `main · M 2 · Ln 42, Col 8`, and there's a gutter of line numbers down the left — from any angle, it's an open source file.

It only turns into Douyin / Bilibili / Huya / Kuaishou when you actually ask for it.

---

## Quick start

**Double-click `start.cmd`.** No terminal, no paths to type, no npm.

The launcher `cd`s to its own directory, clears `ELECTRON_RUN_AS_NODE`, and starts Electron directly — so it works no matter where the folder lives or where you double-click from.

Running it from a terminal works too — **mind the path** (`screenfold` is not in your home directory):

```bash
cd /d "C:\Users\AMBITIOUS_YUAN\WorkBuddy\2026-09-17-15-42-00\screenfold"
npm start
```

> If `ELECTRON_RUN_AS_NODE` is set in your environment, Electron degrades into plain Node and throws `Cannot read properties of undefined (reading 'commandLine')`. `start.cmd` clears it for you; to do it by hand: `unset ELECTRON_RUN_AS_NODE` (Windows: `set ELECTRON_RUN_AS_NODE=`).

With arguments it runs in the foreground so you can watch the output (useful for the self-test):

```bash
start.cmd --shot=shots      # takes 14 screenshots, then exits on its own
```

---

## How to use it (no keys to remember)

**The entire daily routine is one gesture: move your mouse onto the window.**

```
mouse in    →  the video appears
mouse away  →  it folds back into fake code
```

That's it. Nothing to memorize.

Everything else is "if you can see it, you can click it":

| What you want | Where to click |
|---|---|
| **Switch source** | Move the mouse onto the window → the action bar appears at the bottom → click **Source** (or just **scroll** the tab strip) |
| **Switch disguise** | Action bar → **Mask** (or click `TypeScript` at the bottom-right of the status bar) |
| **Resize** | Drag any **edge or corner** of the window (there's a hatched grip in the bottom-right); or action bar → **Size** |
| **Watch faster** | Action bar → **Speed** (1× / 1.25× / 1.5× / 2× — remembered per source) |
| **Too many overlays** | Action bar → **Declutter** (covers login prompts, "open the app" banners, splash ads) |
| **Pin the video** | **Double-click the picture** to pin / unpin; or action bar → **Pin** |
| **Mute / reload / settings** | The three icons on the right of the action bar |
| **Can't find something?** | **Right-click anywhere in the window** — everything is in that menu |
| **Hide right now** | Just move the mouse away; if you're in a hurry, right-click → "Hide now" |

The action bar looks like this — it appears the moment the mouse enters, and steps aside after 2.4 seconds of stillness:

```
   ⌷ Source   ▣ Mask   ⤢ Size   ⏩ Speed   ⚡ Declutter   │   📌 Pin   🔊   ↻   ⚙
```

The status bar is clickable too; hover and it lights up:

```
main ▾     M 2  ✓ 0  ⚠ 0                   296×578    TypeScript ▾      👁 Pin
└─ click: switch source                          └─ click: size  └─ click: mask     └─ click: pin
```

### Three optional shortcuts

**None of these are required — the mouse does all of it.** They exist only in case they happen to feel natural:

| Key | What it does |
|---|---|
| `Alt` + `` ` `` | Pin / unpin the video |
| `Alt` + `V` | Flash the video for a few seconds, then hide automatically |
| `Alt` + `X` | Panic hide (someone is walking over) |

Inside the window there's also `Ctrl+P` for sources, `Ctrl+,` for settings, `Ctrl+D` to pin, `Esc` to hide, and `1`–`5` to switch masks — all optional. They only fire while the window is focused, so they never leak to other applications and never steal a shortcut from your editor.

> If one of them collides with something else, it doesn't matter. The mouse still works.

---

## Why it's hard to notice

Four layers, outside in:

### 1. Consistency is the layer that matters most (the v3 focus)

What gives a fake UI away isn't pixel fidelity — it's **a mismatch**:

> The tab says `media.player.tsx`, but the contents are the source of `route.ts`.

That's exactly what the previous version did: all three masks were hardcoded to the same Next.js route. Switch sources and the filename changed, but the code didn't. One glance from behind is enough.

Now it's a **content library**: every source is bound to its own source file, so the **tab filename / code inside the mask / window title** are always the same file.

| What the tab shows | What's actually inside the mask |
|---|---|
| `feed.aggregator.ts` | Next.js feed route: auth, rate limiting, cursor pagination, sorting |
| `media.player.tsx` | React player component: playback state, progress, speed |
| `live.room.ts` | Live room: heartbeat, danmaku buffer, gift merging |
| `stream.pipeline.ts` | Streaming pipeline: backpressure, framing, zstd decompression |
| `realtime.socket.ts` | Realtime channel: exponential backoff with jitter |
| `notes.index.tsx` | Notes list: infinite scroll, debounced search |
| `timeline.cache.ts` | Timeline cache: in-memory LRU + on-disk KV, idempotent merges |
| `cdn.proxy.ts` | Media origin proxy: Range passthrough, allowlist |
| `qa.thread.tsx` | Q&A thread: collapse, sort, vote |

The **code review** (diff) mask isn't hardcoded either — it **generates a unified diff on the fly** from the current file. The line numbers in the hunk header `@@ -14,9 +14,12 @@` and the context lines are taken from the real source, and the path follows the filename. The **build log** mentions the current file in its compile lines too.

There's a **"mask follows the tab"** setting (on by default). Turn it off and you're back to the old behavior: fixed mask content. Not recommended, unless a fixed thing is exactly what you want.

### 2. Window layer

- **Not in the taskbar**, and avoids Alt-Tab where possible
- The window title follows the current file: `media.player.tsx — inkstack — Visual Studio Code`
- **Capture protection**: when enabled, this window doesn't show up in screen shares, recordings, or screenshots (on Windows this uses `SetWindowDisplayAffinity` — the other side sees a blank area)

### 3. Shell layer (always present)

Tab bar + gutter + status bar. These three never disappear, no matter what you're watching. So even if you never manage to do anything at all, from a distance it's still just an editor pane.

The content area switches between fake code and the real picture instantly — no cross-fade, no intermediate frames.

**All five masks move** (a frozen fake UI is itself suspicious):

| Mask | What it looks like |
|---|---|
| Source | Syntax-highlighted TypeScript / TSX, blinking cursor, slow scroll, occasionally types a couple of characters and deletes them |
| Code review | A git diff generated live from the current file — green/red lines with a real hunk header |
| Build log | `next dev` output, a line appended every 1–2 seconds, colored ✓/○/▲ |
| Test run | `vitest run` output, tests ticking through one by one; the build dot in the status bar breathes along |
| Commit history | `git log --graph`, interleaved branches, colored hashes, message-type highlighting |

The `Ln 42, Col 8` in the status bar tracks your actual scroll position, and the `M 2` on the left follows the current mask.

### 4. The safety net (this is the real trick)

"Didn't have time to hide it" stops being a problem, because **you never have to hide it**:

| Mechanism | What it does | Default |
|---|---|---|
| Reveal on hover | This is the main path — no keys involved | on |
| Fold on leave | Back to the mask **0.4 s** after the mouse leaves the window | on |
| Fold on blur | Click another window and the mask returns immediately | on |
| Mute when folded | Mutes as the video hides, so there's no audio tell | on |
| Hide cursor while revealed | After 2 s of stillness, the pointer vanishes too | on |
| **Lock the mask** | Nothing reveals the video no matter where you move — for when someone is standing behind you | off |

In other words: **the default state is the mask, and you just rest the mouse on it for a peek.** Move your hand and it folds itself back.

> Cursor position is read **directly from the system cursor by the main process**, not from DOM events — the video lives in a separate webview, so the host page never sees pointer events over it. That's also why "fold on leave" is just as reliable over the video area.

#### Two flavors of "on leave"

After the mouse leaves, either keep the shell or drop it entirely:

| Mode | What happens | How to get back |
|---|---|---|
| **Back to code** (default) | The video folds, the code mask stays put — "didn't hide in time" is no longer obvious | Move the mouse back in |
| **Hide the whole window** | The shell goes too; nothing is left on screen | Click the tray icon, or press `Alt+V` |

Both are reachable from **three places**: the right-click menu → "On leave", the settings panel → "When idle", and the **tray menu** (in hide mode the window is gone, so the tray is the only thing you can still click — that toggle has to live there as well).

It won't hide while the video is pinned or a menu / settings panel is open — in those cases you're clearly still using it.

---

## Built-in sources

Every "filename" in the tab strip is a source. The menu shows the real name alongside it, so you can tell them apart.

| Tab shows | Actual source | Entry point | Ratio |
|---|---|---|---|
| `feed.aggregator.ts` | Douyin | Desktop (no usable mobile site) | wide |
| `media.player.tsx` | Bilibili | Mobile | wide |
| `live.room.ts` | Huya | Mobile | wide |
| `stream.pipeline.ts` | Kuaishou | Mobile | tall |
| `realtime.socket.ts` | Douyu | Mobile | wide |
| `notes.index.tsx` | Xiaohongshu | Desktop | tall |
| `timeline.cache.ts` | Weibo | Mobile | wide |
| `cdn.proxy.ts` | YouTube | Mobile (needs your own network route) | wide |
| `qa.thread.tsx` | Zhihu | Desktop | wide |

> **Douyin opens on a QR login page** the first time, not the feed — scan once and it's remembered (login state persists per source). The window reminds you once when you first enter that source.
>
> **Pin the video first** (or double-click it) before logging in — otherwise the video folds the moment your mouse leaves the window and you can't type the phone number or the verification code.

### Declutter

The most conspicuous thing in a small window usually isn't the video — it's the overlays: "open in app" banners, login nudges, splash ads. **Declutter** on the action bar injects a bit of CSS to cover them, and swaps the chunky system scrollbar for a thin one.

It's written conservatively — matching class-name keywords only (`login-guide` / `open-app` / `interstitial` and friends), with no layout-level guessing, so it won't touch the actual content. If it covers too much, click again to turn it off. **Remembered per source.**

### About bright pages

Pages like Douyin are pure white, which stands out inside a dark editor shell. There's a **Dim video** setting (15% by default) that lays a dark scrim over the picture so it's less obvious from a side glance. Set it to 0 if you don't like how it looks.

### Adding your own

Edit the config file (tray → Open config folder → `screenfold.json`) and add an entry to the `custom` array:

```json
{
  "id": "custom-1",
  "real": "Something",
  "file": "worker.queue.ts",
  "lang": "typescript",
  "url": "https://example.com",
  "ua": "mobile",
  "ratio": "short",
  "dot": "#7fd4c1"
}
```

- `ua`: `mobile` loads the mobile site (which looks better in a small window), `desktop` loads the desktop site
- `ratio`: `short` for 9:16 portrait / `wide` for 16:9 landscape. The window switches to a matching ratio **automatically** so the video fills it with no letterboxing
- Custom sources have no dedicated source file, so their mask falls back to the default `feed.aggregator.ts`

---

## Window sizes

| Preset | Content area | Ratio |
|---|---|---|
| Sliver | 168 × 299 | 9:16 |
| Narrow | 240 × 427 | 9:16 |
| Mini | 264 × 149 | 16:9 |
| Portrait S | 296 × 526 | 9:16 |
| Portrait L | 340 × 604 | 9:16 |
| Landscape | 528 × 297 | 16:9 |

The menu sorts them from smallest to largest, so you can see at a glance that there's room to go smaller or bigger. Switching sources auto-switches to a matching ratio — full bleed, no letterboxing.

**Drag the window edges** to resize freely (this uses native OS resizing; there's a hatched grip in the bottom-right as a hint). Once you've resized it yourself it counts as a "custom size" — switching sources afterwards only adjusts the height to match the ratio, and won't override what you set.

The window snaps to screen edges.

**The minimum size is 150 × 132 — you can drag it all the way down to a slim side panel.** 150 px is roughly 24 characters of code per line, which is exactly what an editor's outline / side panel looks like. Narrower than that and it stops resembling anything, so that's where it ends.

> ⚠️ A mistake worth recording: early on, to make accidental drags less painful, I raised the minimum to 240 and the **usable threshold** to 260 — with the result that **you couldn't deliberately shrink it either**. Drag below 260 and it snapped back to the previous size, which felt like "why is this window stuck at this size". The floor should stay low; accidental drags are handled by the gate below, not by a high floor.

The defenses against accidental drags (**not** a higher floor):

1. **For 1.5 seconds after the window appears**, any resize request is discarded entirely — that's the real fix for the "the mouse happened to be holding the left button when the window popped up" scenario.
2. Only a genuine drag below 164 px wide counts as accidental: it restores the previous size and voids the whole gesture (so it doesn't tug-of-war with the restore), and the size is never written to config, so the next launch is unaffected.

See the `--sf-debug` output for the actual logs.

---

## Tray

Right-click the tray icon (an unremarkable dark square):

- Show / hide the panel
- Source (switch between sources, with real names)
- Window size (six presets)
- Invisible to capture / fold on blur / reveal on hover / always on top
- Quit

Clicking the tray icon toggles the panel.

---

## Packaging as an exe

```bash
npm i -D electron-builder
npx electron-builder --win portable
```

In `package.json`:

```json
"build": {
  "appId": "local.screenfold",
  "win": { "target": "portable" },
  "files": ["src/**/*", "package.json"]
}
```

---

## Project layout

```
start.cmd              launcher (double-click; no npm, no console window)
selftest.cmd           self-test: runs with an isolated profile and screenshots it
selftest-seed.json     fixed starting config for the self-test (reproducible shots)
shots/                 self-test screenshot output
tools/probe.js         checks whether each site's mobile / desktop entry still works (node tools/probe.js)
src/
├── shared/sites.js      source list + presets + mask list + default config (shared by main and renderer)
├── main/
│   ├── main.js          window / tray / window-level defenses / cursor polling / title sync / self-test
│   └── icon.js          generates the tray icon at runtime (no external assets)
├── preload/
│   ├── preload.js       contextBridge surface
│   └── guest.js         recovers events the page swallows inside the webview (double-click)
└── renderer/
    ├── index.html       shell markup
    ├── style.css        skin (hand-rolled "deep indigo + amber" theme)
    ├── masks.js         content library (9 source files) + five masks + live diff/log generation
    └── app.js           state machine / action bar / menus / fallback logic / source plumbing
```

---

## Self-test mode

Runs the app and screenshots it, to confirm the disguise still holds up. **Double-click `selftest.cmd`**, or pass arguments (`selftest.cmd --shot=shots`).

It writes **14 images** into `shots/`: the five masks, the revealed video, the action bar, three menus, settings, the source-sync behavior after switching tabs, plus one of the source mask at the **minimum "sliver" size** and one of the **"on leave" menu**.

> The last two are deliberately a **different size** from the first 12 (those share one window size; the last two are taken after shrinking to the minimum). That's the point — they verify the window really can shrink to 168 px wide.

Every image is preceded by a `[state]` line in the log with the current `mask / site / file / dock / menu`, plus `[title]` (the window title). The first 12 should all match in size and have consecutive timestamps.

**Exit code 0 = all 14 were written.** Non-zero means some image didn't happen (`[shot fail]` / `[capture timeout]`) — don't assume it finished just because the log looks clean.

The self-test uses an **isolated profile** (`.selftest-userdata/`), for three reasons:

1. **It doesn't fight your running instance for the single-instance lock** — otherwise the new instance silently exits after 6 seconds with zero images;
2. **Your own config is never touched** (the self-test switches sources, masks, and sizes, all of which live in config);
3. Every run starts from the fixed config in `selftest-seed.json`, so **results are reproducible** regardless of your current settings.

> There's also a 180-second hard timeout: if a step hangs (a webview that won't come back, say), it exits instead of leaving an invisible Electron process behind.

---

## Interaction design mistakes (kept so I don't repeat them)

- **Don't hang features on shortcuts.** v1 made source / size / mask all hotkeys, and nobody remembered them. A tool like this needs to be usable at a glance.
- **Don't register global `Ctrl+Alt+↑/↓` hotkeys** — that's exactly VS Code's "add cursor above / below", and you'd be stealing the user's editor. These are all in-window clicks now.
- **Don't use DOM `mouseenter` to detect the cursor crossing in and out** — the video lives in a separate webview, so the host page gets no events over it, and "fold on leave" silently stops working. Poll the system cursor from the main process instead.
- **The dim layer has to live inside the video layer**, or when the video folds it stays on screen and dims the mask too.
- **Consistency beats polish in disguise content.** Filename, code, and window title must be the same file — a mismatch is far more noticeable than ugliness.
- **Don't fight accidental drags with a higher minimum size.** To stop a single stray drag from shrinking the window to a sliver, I once raised the floor to 240 and the usable threshold to 260 — with the result that **you couldn't deliberately shrink it either**, and it earned a "why is this window stuck at this size". The correct split is: **accidental drags are handled by a time gate** (the whole gesture is void for 1.5 s after the window appears), and **the floor only guarantees "still a viewable screen down here"**.
- **Once the window can get narrow, re-check every horizontal row of UI for clipping.** The bottom action bar was `flex: none` with no wrapping; once narrow, its right-hand buttons were cut out of the visible area by an ancestor's `overflow: hidden` and became **completely unclickable** — while the screenshot only looked like "there are fewer buttons". Very easy to miss. It wraps now. **Any change to sizing code must be followed by another screenshot at small size with the buttons counted one by one.**
- **`capturePage()` can hang.** Shrink the window to something tiny with a video ratio that doesn't match the container, and the screenshot never returns — one image drags the whole self-test into the watchdog timeout. There's now a 12-second timeout plus retry, and a failed capture makes the exit code non-zero instead of being silently swallowed.
- **`autoFit` shouldn't jump to a fixed preset when switching sources.** It used to be "ratio doesn't match → switch straight to `short` / `wide`", so a "sliver" you'd carefully dialed in would **snap back to 528-wide landscape** the moment you switched sources. It now picks whichever preset of the matching ratio has the closest width.

---

## License

MIT License — use it, change it, don't blame me. Full text in [`LICENSE`](LICENSE).
