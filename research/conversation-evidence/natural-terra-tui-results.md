# Natural conversation through the built TUI

2026-09-14, source `258a99d2`, displayed CLI version 24.0.0. This is one
diagnostic conversation with short Turkish messages, real files, two real child
agents and a separately launched resume process. It is not an estimated success
rate, a cross-harness benchmark or evidence of learning/RSI.

[Retained evidence](natural-terra-tui-results.json) includes the exact messages,
file snapshots, terminal frames, original transcript hashes, tool calls and
results, terminal outcomes and usage. Provider-native envelopes, credentials
and reasoning events are excluded. Paths are normalized to `$STUDY`.

## Setup and messages

The production `packages/cli/dist/bin.js` ran in a 120×34 Linux PTY. Installed
`@xterm/headless` replayed the real ANSI output. The workspace and `NAMZU_HOME`
were newly created temporary directories. Existing Codex credentials were
discovered without changing personal credentials or preferences. The initial
parent selected GPT-5.6 Terra and `/effort low`. Permission prompts stayed on;
the operator approved each requested file mutation and the two-agent batch.
Web search and sandboxing were off in this synthetic scratch workspace.

No project instructions, prescribed tool calls, expected answers or recovery
procedure were supplied to the model. The conversational sequence was:

1. “Kanka denemek için küçük bir selamlama dosyası oluştur, içine de Namzu hakkında bir cümle yaz.”
2. “Güzel, sonuna bir cümle daha ekle kafana göre.”
3. “Bir de en alta iyi çalışmalar yaz.”
4. “İki ajan açsana, biri mavi.txt dosyasına baksın öteki yesil.txt dosyasına. Kim nerede ne zaman toplanıyor, kısaca söylesinler.”
5. While both child runs were active: “Onlar bakarken söyle, az önce dosyaya en son ne ekledik?”
6. “Peki ajanların sonucu ne oldu?”
7. After `/exit` and `namzu resume <same-conversation-id>`: “Kanka kaldığımız yerden devam. Mavi ekibin sorumlusu kimdi, selamlama dosyasına da en son ne eklemiştik?”

Between messages 2 and 3, the operator appended
`Toplantı cuma saat 14.30, salon Mavi.` to the generated file without telling the
model. Before message 4, the workspace received two one-line fixtures:

```text
mavi.txt: Mavi ekip: cuma 14.30, salon Mavi. Sorumlu Ece.
yesil.txt: Yeşil ekip: pazartesi 10.15, salon Yeşil. Sorumlu Can.
```

## Observed behavior

| Situation | Observation |
| --- | --- |
| Create a small file | One write, no preliminary directory scan. The generated sentence correctly described Namzu as an agent kernel with a TypeScript SDK. |
| Refer to “its end” without the filename | Correct file and append; existing content preserved. The model nevertheless read its just-written, unchanged file again. |
| An unannounced external edit | A fresh read preceded the append. The manual meeting line remained byte-for-byte intact. This does not isolate hash-based context invalidation. |
| Two agents plus a steering question | Exactly two child runs, overlapping in time. Input was sent while both were active. The parent correctly answered “İyi çalışmalar.” and did not spawn replacements. |
| Delivering the original task's results | Both completed results were already in the parent's tool history, but its final answer covered only the steering question. A separate user question was needed for the meeting summary. |
| Asking for the agent results | The parent read both files again, then correctly reported both teams, times, rooms and responsible people. |
| Reopening the conversation | A second CLI process resumed the same conversation and answered Ece plus “İyi çalışmalar.” with no tool calls. Both CLI processes exited 0. |

The additional reads do not establish forgetting: refreshing current evidence
and verifying a delegated result can be deliberate. They do expose redundant
work in this small scenario. More consequentially, answering an intervening
question did not also close the outstanding request for the agent results.
The completed status rows were visible, but the requested summary still needed
another user turn. Neither behavior was fixed in this evidence-only change.

## Accounting and boundaries

All eight SDK runs ended with `end_turn`: six parent runs and two child runs.
There were no provider failures, duplicate child launches or unresolved request
counts. Parent usage was 145,942 tokens, child usage 15,958, total 161,900;
49,664 were reported cached tokens. These are cumulative request tokens,
including repeated context, not the conversation's final context size or a
verified monetary charge.

The five initial parent runs explicitly recorded low effort. Child metadata
omitted effort, and the resumed TUI displayed `default`; the resumed run also
omitted an explicit effort. Consequently this report does not call every run
a low-effort request or claim that resume preserved that setting.

Assertions checked the file prefixes and final suffix, both exact meeting
answers, absence of tools in the resumed answer, exactly two agent launches,
steering time within both children's lifetimes, all original run outcomes and
both process exit codes. The retained evidence can be inspected alongside its
source commit. No production package source changed, so workspace unit/build
gates were not rerun or claimed for this observation.

This short successful resume does not establish crash recovery, pending-tool
recovery, long-context recall or compaction quality. The earlier
[natural historical-source failures](natural-results.md) remain separate
experiments; this small visible-history case does not supersede them. The
recent [exploration-policy comparison](../resident/exploration-policy-terra.md)
also remains a separate, rejected learning proposal.
