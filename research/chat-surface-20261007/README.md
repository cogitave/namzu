# Conversation surface audit

The bounded baseline audit uses the actual Desktop App, transcript, Pal context and composer components in an isolated loopback Vite preview. [audit.json](artifacts/audit.json) records dimensions, selected source hashes and image hashes. Selected source files stayed unchanged; there were zero browser page errors, native actions, provider requests or user-data reads.

| Condition | Screenshot |
| --- | --- |
| Normal, 1280 × 900, dark, work expanded | [Wide normal](artifacts/normal-wide-dark.png) |
| Normal, 640 × 720, light, three-line draft | [Narrow normal](artifacts/normal-narrow-light.png) |
| Pal, 1280 × 900, dark, profile open | [Wide Pal](artifacts/pal-wide-dark.png) |
| Pal, 560 × 480, light, profile open | [Minimum short Pal](artifacts/pal-minimum-short-light.png) |

## Concrete findings

1. **The narrow Pal profile takes too much of the chat pane.** At 560 × 480, the chat stage is 512 px wide. Its profile column reserves 264 px, leaving the transcript 248 px, composer 224 px and textarea 94 px wide. The empty “Send a message” placeholder wraps into two lines, growing the composer from 44 to 64 px. Friend-style message bubbles become unnecessarily narrow. The shared cause is `.chat-stage[data-pal-context="true"]` in `style.css`, whose column stays at least 264 px. Use the actual available pane width to switch to a compact profile trigger/popover; a viewport-only breakpoint will miss split panes and sidebar changes.
2. **Two identical plus icons represent different actions in Pal chat.** The nearby tab-strip plus creates a conversation; the far-right plus opens the Pal computer. Both appear together in the narrow screenshot. Their accessible names are distinct in source, but their resting visual treatment does not communicate that distinction. A computer-specific icon and tooltip would make the second action clearer.

The wide profile is 300 × 408 px. At minimum/short size it is 240 × 364 px and needs internal scrolling. Its two empty sections account for about 140 px of height; omitting empty sections would let the meaningful body fit more comfortably in an anchored popover.

Normal surfaces fit at the inspected widths: the table, text, and three-line draft remain inside the pane. The 640 px composer textarea is 526 px wide and 76.25 px high. The overflow scan also records intentionally hidden form proxies and small glyph/avatar overhangs; these are not reported as conversation overflow defects.

## Scope

Pal/project/conversation creation happens only in the preview's disposable sample catalogue. Messages and model labels are fixtures, and the computer is explicitly stopped. These images establish the inspected layout and hierarchy, not native behavior, harness correctness or reference-app pixel parity. All four images were visually inspected. Later focused verification can use the same four conditions without a large motion matrix.

```sh
node research/chat-surface-20261007/audit.mjs .
```

## Final focused verification

[verification.json](artifacts/verification.json) records the final four-condition pass against 19 unchanged renderer source fingerprints, including the shared footer, copy controls, responsive Pal context and enabled voice setting. There were zero browser page errors, native actions, provider requests or user-data reads. The four images below are the authoritative regenerated final captures; earlier `verification-before-*` and failed-runner receipts remain historical.

| Condition | Final screenshot |
| --- | --- |
| Normal, 1280 × 900, dark, work expanded | [Wide normal](artifacts/verified-normal-wide-dark.png) |
| Normal, 640 × 720, light, three-line draft | [Narrow normal](artifacts/verified-normal-narrow-light.png) |
| Pal, 1280 × 900, dark, profile open | [Wide Pal](artifacts/verified-pal-wide-dark.png) |
| Pal, 560 × 480, light, compact profile | [Minimum short Pal](artifacts/verified-pal-minimum-short-light.png) |

- **One stable message footer:** known time, voice and copy share the same vertical center in all four conditions. Resting opacity is 0; actual wide-screen transitions sampled at 0/80/160 ms give 0/0.684643/1, then return to 0 on leaving. Keyboard focus reveals the row. Narrow/short reduced-motion conditions reveal without animation. Message, parent, action/clock boxes, transcript scroll position and scroll height stay exactly unchanged across reveal and focus.
- **Settlement keeps the reserved height:** a normal known-clock partial reply stays 24 px before and after turn settlement. The minimum Pal keeps provisional chunks hidden; its completed message delivered during a running turn has a 28 px clock-only footer, which remains 28 px when settlement adds voice/copy.
- **Enabled voice settings fit:** Pal's language button now measures 65.05 px wide, or 67.05 px at minimum width. Its speaker icon and “Türkçe” label stay inside the button, with a 6 px gap to Send. The earlier 32 px button overlap is preserved in the historical receipt. Voice state is mocked; no speech, audio or speech-settings action is invoked.
- **Copy follows completion:** reply actions are absent on user/commentary rows and on normal partial replies. Empty code cannot copy. Real Markdown parser values retain Unicode, internal CRLF/blank lines and unclosed-fence newline semantics; full reply copy retains literal Markdown. Synthetic deferred clipboard promises exercise pending, rejection, retry and success only after resolution, with stable accessible names.
- **Tables scroll locally:** the named, keyboard-focusable Table region actually overflows and moves on a trusted ArrowRight scroll event; document width and message bounds remain unchanged.
- **Pal context uses available pane width:** minimum chat composer is 488 × 44 px, rather than the baseline 224 × 64 px. A 320 × 252 px popover fits the short viewport; Escape restores trigger focus and outside click dismisses. A 900 px viewport with a sidebar and 564 px chat stage also selects compact context. Settings/Customize open usable focused dialogs; empty profile sections stay absent. Computer status is only inspected/focused, never started.

All final images were visually inspected. Clipboard and speech state are disposable preview mocks; this proof does not establish OS clipboard, audio, native lifecycle or provider behavior.

```sh
node research/chat-surface-20261007/audit.mjs . --verify
```

## Native delivery and verification limits

[native-delivery.json](artifacts/native-delivery.json) records the Desktop-only update of the owned Windows app from PID 16492 to 25184. The fresh preparation passed; the complete 742-file Desktop payload was installed after graceful closure, retaining its predecessor as a backup. No CLI or SDK modules were copied. The historical native guards, preparation, snapshots and failed activation receipt remain unchanged and private on the Windows host; the public record contains counts and hashes rather than authored text.

**The original full activation remains FAILED.** Its strict presentation digest changed: the transcript stayed at scrollTop 0, but its scroll range changed from 1218 to 1209 px. The sessions digest also differs because live records and cold history carry different metadata. The subsequent content audit does not accept those differences, restore an older layout, or relabel the failed receipt. The protected catalogue, project, profile, computer and group digests match; drafts, settings, attachments, jobs, partials, tasks and retries match in the private before/after snapshots.

The separate [read-only authored-content audit](artifacts/native-authored-readonly-summary.json) passed for all four authored owners, four unchanged journals and 20 messages. Their roles, exact text hashes, order and known durable IDs match. All 20 current clocks match authoritative journal records; twelve formerly live host clocks now use journal clocks, six missing live IDs gain durable IDs, and two ephemeral text-part IDs disappear in cold history. The current layout stayed unchanged during observation. The installed Desktop is byte-exact against the built 742-file source manifest; CLI and SDK payloads remain byte-exact against their pre-update inventories. This is bounded content, clock, ownership and payload evidence, not a full preservation pass.

The [actual native footer check](artifacts/native-current-footer-proof.json) passed in the existing selected ordinary conversation. Its clock, voice and copy centers all measure 1166.6875 px; its reserved row is 24 px high. Opacity changes 0 → 1 → 0 while message, footer, controls and transcript geometry stay unchanged. The [cropped capture](artifacts/native-footer-25184-7cdfc28e-2516-4f99-b454-074ce2f35922.png) contains only that row. Three pointer moves and two temporary reader scrolls were used; the freshly observed DOM scroll position, owner, layout and focus were restored/preserved. Automatic-follow preference was not verified. No clipboard write, speech action or model request occurred. Native Pal navigation was not exercised; the isolated four-condition renderer proof covers Pal layout.

Earlier helper outcomes remain historical: the preparation's first non-unique seam refusal, the footer observer's refusal of a non-Pal selected owner, and read-only verifier message-classification attempts. The final read-only verifier identifies the original assertion by its first line while retaining Node's digest suffix in the unchanged failed receipt. The four wrapper tests cover inert defaults and exact compiled seams, not adversarial native mutation simulation.

The supplied rich source-hover-card reference is not implemented. Assistant HTTP(S) links currently open in the system browser. There is no page-preview title, description and image projection or hover card in this delivery.
