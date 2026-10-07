# Package evaluation (all trials run in scratchpad/pkg-eval, nothing in the repo; no native builds, no admin needed by any candidate)

Metadata fetched 2026-10-07 via `npm view`.

## 1. Keyboard shortcuts (conversation-actions.ts + app.tsx handler)
Hand-rolled core: SHORTCUTS table, conversationShortcut() (~25 lines of logic), two label formatters. Guards: event.code match, AltGraph, isComposing/keyCode 229, Mac Cmd-without-Ctrl.

| pkg | version | modified | size | verdict |
|---|---|---|---|---|
| tinykeys | 4.0.1 | 2026-09-25 | 77 kB unpacked | REJECT: AltGraph handling is inverted. Trial: Ctrl+Alt+KeyR bound; a synthetic AltGr+R event (ctrl+alt+AltGraph true) FIRES. It treats AltGraph as satisfying Ctrl and Alt. Source `s()`: `getModifierState(t)\|\|i.includes(t)&&getModifierState('AltGraph')`. This is exactly the Turkish-Q bug we guard against. Has isComposing guard only. |
| react-hotkeys-hook | 5.3.3 | 2026-06-26 | 31 kB | REJECT: matches by code, reads AltGraph once in its matcher, but no isComposing/229 handling in dist. Hook-per-binding model does not fit one global dispatcher with dialog gating. |
| hotkeys-js | 4.0.8 | 2026-09-09 | 4.9 MB | REJECT: keyCode-based, no AltGraph/IME story, huge. |
| @tanstack/hotkeys (core) + @tanstack/react-hotkeys | 0.11.0 / 0.13.0 | 2026-10-04 | 200 kB / 56 kB | ONLY credible one, but pre-1.0 (0.x, API churn; two releases within days). MIT, React >=16.8 (19 ok), node >=20, pure JS, deps: @tanstack/store only. |

@tanstack/hotkeys trial (`matchesKeyboardEvent(event, 'Mod+Alt+R', platform)`, synthetic events, `t2.mjs`):
- real Ctrl+Alt+R on windows: match. Cyrillic layout (key='к', code KeyR): match (code fallback). 
- AltGr+R (ctrl+alt+AltGraph): NO match (source: `if (normalized.altGraph && (parsed.ctrl||parsed.alt)) return noMatch`). Good.
- Mac Cmd+Opt+R: match; Cmd+Ctrl+Opt+R: no match (same as ours). Mod+Shift+A match, AltGr variant no match.
- IME: isComposing or key==='Process'/'Unidentified' blocks. GAP: keyCode 229 with a normal key and isComposing=false still matches (ours blocks it). Wrapper must keep `event.keyCode === 229` check.
- AltGraph read is skipped on mac (ours reads it everywhere; harmless, Mac Option is not AltGr).
- Display: `formatForDisplay('Mod+Alt+R')` -> mac "⌥ ⌘ R" (spaced, order differs from our "⌥⌘R"), windows "Ctrl+Alt+R". aria-keyshortcuts string we would still build ourselves.

Conclusion: KEEP (hand-rolled). Adopting @tanstack/hotkeys would delete ~20 lines (the loop + mac/primary logic) but must be wrapped to restore keyCode 229, re-do label format, and ties us to a 0.x API for four chords. Revisit when it hits 1.0; at that point a thin `matchesKeyboardEvent` wrapper (core package only, no React package; keep the `ShortcutEvent`-shaped test suite as the contract) is the integration shape. Do NOT adopt tinykeys.

## 2. Git reader (desktop-host-header.ts)
81 lines, of which the git part ~55. Repo has no git library in any package.json or lockfile (grep: 0 hits).
- simple-git 4.0.2 (2026-09-26, MIT, 1.7 MB, shells out to git, no native): supports `timeout.block`, `config`, `.env()`. But its "unsafe" plugin REJECTS our hardening: `config: ['core.fsmonitor=false']` throws "Configuring core.fsmonitor is not permitted without enabling allowUnsafeFsMonitor"; passing `{...process.env}` throws on GIT_EDITOR; `GIT_OPTIONAL_LOCKS` throws "blocked by the environment guard - add it to allowEnvironment". Each needs opt-in flags (`unsafe.allowUnsafe...`, `allowEnvironment`). No output cap (maxBuffer) option found. We would still be passing the same raw args via `.raw()`. Net: more config than the 20 lines it replaces. KEEP.
- isomorphic-git 1.43.1 (2026-10-06, MIT, 4.9 MB, pure JS, no spawn): on this repo currentBranch 3 ms, log depth 1 5 ms (git CLI is ~1-2 ms). Works with pure fs, so no spawn/timeouts/fsmonitor issue at all. Risks: no support for reftable and some newer repo extensions (worktreeConfig, sha256, partial clones/promisor objects, split index not an issue for these two calls but pack-v2/multi-pack-index reading in huge repos is slower and memory-heavy), linked worktrees (this machine has several) need `gitdir` resolution correctness, Windows path/CRLF behaviour unverified here (no Windows host). It is also read-only-correct but diverges from what the user's real `git` says on exotic repos. Would delete runGit and the 4 constants, but we lose "same answer as git". KEEP unless we need to drop the git binary requirement; if so, adopt isomorphic-git@1.43.1 behind the existing GitRun-free `createProjectGit` (cache stays).
Conclusion: KEEP execFile.

## 3. Link preview (main/link-preview.ts 495 lines, link-preview-electron.ts 139)
- SSRF guard (BlockList over IANA special-purpose v4/v6, previewTarget, redirect revalidation, hostAllowed via ses.resolveHost): KEEP. request-filtering-agent 3.2.1 (2026-06-29, MIT, 43 kB, dep ipaddr.js) and ssrf-req-filter 1.1.1 (last release 2024-05) are `http.Agent` subclasses that filter at socket connect (they would close the DNS-rebinding gap our comment admits), but Electron `net.request` does not accept a Node agent, so they cannot be plugged in. Switching to node:https would lose the system certificate store and proxy configuration (hard requirement) and the isolated session. Their IP tables are not better than ours (ours already covers 64:ff9b, 2002, 3fff, 192.31.196 etc.). Unusable; keep.
- OG parsing: already done by the platform's inert `DOMParser` in the renderer (renderer/link-preview-parse.ts 163 lines, mostly selection policy). open-graph-scraper 6.12.0 pulls cheerio + undici + chardet + iconv-lite and does its own fetching; metascraper 5.58.1 is a plugin framework needing per-rule packages and node>=22. Both strictly heavier than DOMParser. KEEP.
- Image sniffing (sniffImage, 11 lines, allowlist of png/jpeg/gif/webp/avif/ico): file-type 22.1.1 (2026-09-17, MIT, 168 kB, 4 small deps: strtok3, token-types, uint8array-extras, @tokenizer/inflate; ESM, node>=22, Electron 44 ships Node 24 so OK, pure JS). Trial (`f.mjs`) correctly identified png, ico (`image/x-icon`), avif, webp; svg and html -> undefined (good, we do not want them); heic also detected (we would still need an allowlist filter). It deletes ~11 lines and adds 5 packages to the main-process bundle, and our code is stricter on avif brands. Not a clear win; OPTIONAL. If adopted: `file-type@22.1.1`, `const t = await fileTypeFromBuffer(bytes); return ALLOW.has(t?.mime) && (kind==='icon' || t.mime!=='image/x-icon') ? t.mime : undefined`.
- Head scanner (scanHead/readPage), charset sniff, byte caps: no maintained library fits (they all buffer whole responses). KEEP.

## 4. Date/duration
transcript-layout.ts `elapsedLabel` (6 lines, "1h 2m"/"3m 4s"/"5s") and message.tsx `Intl.DateTimeFormat` clocks: trivial and correct. Intl.DurationFormat would localise but yields "1 hr, 2 min" style and is not worth it. Nothing non-trivial hand-rolled. No action.

## Summary
| piece | decision | adopt |
|---|---|---|
| shortcuts | keep | none now; revisit @tanstack/hotkeys >=1.0 (core only, wrapper must retain keyCode 229). Never tinykeys (AltGr fires). |
| git reader | keep | none (simple-git blocks our hardening by default; isomorphic-git 1.43.1 is the only no-spawn alternative, not recommended) |
| SSRF guard | keep | none (agents cannot plug into Electron net) |
| OG parse | keep | none (DOMParser already) |
| image sniff | optional | file-type@22.1.1, saves ~11 lines, +5 deps |
| date/duration | keep | none |
Trial scripts: scratchpad/pkg-eval/{t.mjs,t2.mjs,g.mjs,i.mjs,f.mjs}. No native builds, no admin rights for any candidate.
