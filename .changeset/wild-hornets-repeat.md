---
'@namzu/sdk': major
---

A delegated agent's output is now framed as untrusted material, and the
framing itself can no longer be forged.

**Why the child→parent return.** A delegated worker is the component most
likely to have consumed something nobody in the run authored: it was handed a
task like "read these files and report", it ran `read`, `grep`, possibly a
connector fetch over material the user did not write, and its final text
landed directly in the parent's context — where the parent typically holds a
broader tool grant than the child that produced the text. An unlabelled block
there reads as the parent's own reasoning. Connector-supplied prompts already
got this treatment; the delegation surface had none.

`create_task` and the `Agent` tool now wrap their `output` in a
`<namzu-untrusted kind="agent-result">` frame naming the agent and task, with
one line saying the content is material rather than direction. The worker's
text is unaltered inside it, and `data.result` carries it verbatim, so a host
reading the result programmatically is unaffected — only the model-facing
string changed.

**The framing was forgeable, and that is fixed.** The existing envelope around
connector prompts built its tag by hand and interpolated remote text straight
into the body. A prompt whose content contained `</mcp-prompt>` closed the
block early, and everything the server wrote after that read as unlabelled —
which is to say, as this agent's own instructions. The label was the entire
mitigation and the labelled party could remove it. `wrapUntrusted` now defangs
the delimiter case-insensitively (a model reads `</NAMZU-UNTRUSTED>` as the
same tag) and escapes attribute values, so a source name carrying a quote
cannot rewrite the tag it appears in.

Two decisions worth stating because the obvious alternatives are wrong:

- **No length threshold.** Skipping short payloads to save tokens leaves the
  cheapest carrier unframed; an instruction fits in a tweet.
- **No "already wrapped, skip it" fast path.** That check is forgeable —
  content merely beginning with the opening tag would pass through with no
  framing at all. Wrapping twice is harmless; not wrapping once is not.

`wrapUntrusted`, `neutralizeEnvelopeDelimiter` and `UntrustedEnvelope` are
exported, so a host surfacing its own untrusted content to a model can use the
same framing rather than inventing one.

**Migration.** If you assert on `create_task` or `Agent` output text, read
`data.result` instead — it is the worker's text with nothing added. If you
call `renderPromptMessages` directly, its output opens with
`<namzu-untrusted kind="mcp-prompt" …>` rather than `<mcp-prompt …>`.
