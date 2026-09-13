# Conversation evidence presentation control

2026-09-13. The generic terminal presenter extracted a JSON response's `text`
field. For `read_conversation`, that hid source identity, retained-preview flags,
page completion and the original tool's error status. Search printed its JSON
guidance before its matches. The model still received the complete response;
this was a presentation defect, not missing model context.

The TUI now gives these two CLI-owned tools a compact view. All returned fields
and exact text strings remain in the formatted JSON detail; the model and
durable event output are unchanged. A successful archive read remains distinct
from the success or failure of the original tool. Page completion never means
task completion, independent verification or full conversation coverage.

## Terminal procedure

Run `node research/conversation-evidence/presentation-tui-fixture.mjs --seed`
after building. It prints a new temporary root and session ID. The fixture seeds
one scoped, closed run via `RunDiskStore`, then stores a replacement conversation
summary. Its archive contains long tool text, an assistant claim and a truncated
tool result with an error status. These records are constructed test inputs;
this does not claim a model originally performed those observations.

In the generated `workspace` directory, launch the built CLI in a 100-column,
28-row PTY with `NAMZU_PRESENTATION_ROOT=<root>` and `NAMZU_HOME=<root>/home`:

```sh
node --import /absolute/path/to/namzu/research/conversation-evidence/presentation-tui-fixture.mjs \
  /absolute/path/to/namzu/packages/cli/dist/bin.js --yolo resume <session-id>
```

Trust only that generated test directory. Type `Inspect retained archive pages.`
and press Enter separately. The scripted provider permits six archive calls
and a final response; actual CLI Session, tool execution, scope checks, storage
and terminal rendering are used. The fixture verifies the exact concatenated
read text and unchanged SHA-256 values for the source transcript and run metadata.
No vendor inference occurs despite the configured model label in the status bar.

After the final response, Ctrl+O opens the missing-address error. Left arrow
selects the preceding retained-preview receipt. Its full JSON shows
`complete: true`, `retainedPreview: true`, `recordKind: tool_result`, and
`isError: true` together. Close with `q`, then `/exit`.

## Observed result

The successful artifact root is `/tmp/namzu-evidence-presentation-2aO68U`:

- Session: `ab3c10fe-ad46-4ce2-a513-1e978d7a4396`.
- Original run: `92821670-f603-4fef-ac01-4abe15c65413`.
- `trace.jsonl` contains six actual tool receipts. Search returned three matches
  and remained incomplete because one original was a preview.
- The first and final read pages exactly reconstructed the long retained part.
  Their summaries distinguished “Partial page” from “Last page”; the latter did
  not claim earlier text was present on that page.
- The assistant record was labelled “Assistant message”. Reading the preview
  succeeded while its metadata reported the original tool's error. The absent
  event address produced a retrieval error with recovery guidance.
- `terminal.ansi` records the PTY, which exited with code 0. Replaying its terminal
  control sequences through the installed `@xterm/headless` at 100×28 produced
  `screen.txt` and `details-screen.txt`. Final scrollback contained one search
  summary and four read summaries, with no duplicate rows from opening/closing
  the detail window. The detail snapshot retained source and error metadata.

An earlier fixture at `/tmp/namzu-evidence-presentation-xgDOOR` mistakenly used
`message` instead of the recorder event's `content` field for the assistant
record. The scripted assertion stopped after search, before any read. The error
trace was retained, the fixture was corrected, and the successful procedure used
a fresh root. It is not counted as a completed control.

Focused tests cover 40- and 100-column rendering, full JSON recovery, an empty
lookup page, incomplete search without continuation, retained-preview versus
page completion, absent original status and retrieval failure. This experiment
tests operator presentation and unchanged tool contracts. It makes no claim
about model reasoning improvement, natural recovery accuracy or token savings.

Validation passed: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm -r build`,
`pnpm docs:check` and `node tools/check-doc-fences.mjs`. The workspace suite
included 6,684 SDK tests and 2,974 CLI tests (five CLI tests skipped). The focused
presentation/output suite passed all 24 tests. Existing lint warnings remain;
no new warning came from these files. These checks do not cover all release-only
gates, and no push or publish was performed.
