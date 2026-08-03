---
'@namzu/sdk': patch
---

Clearing a tool result no longer destroys the way back to it, and skill
frontmatter fails loudly instead of quietly.

**A cleared tool result kept its recovery pointer.** When a result exceeds
the output budget its full text is written to disk and a line pointing at
the file is embedded *in* the result. Compaction then replaced the whole
content with a placeholder — deleting that line for exactly the largest
outputs, and advising the model to "call the tool again", which is advice to
re-run something that returned megabytes. The spill line now survives, along
with the `read`/`grep` instruction that goes with it.

A head and tail survive too. Clearing was total, so a result just over the
1,000-character minimum lost 100% of itself — including the few lines the
agent was actively reasoning from — to reclaim a few hundred characters. A
result shorter than the head and tail together is kept whole, since eliding
it would drop content while saving nothing.

**The skill frontmatter fence is anchored to a line.** An unanchored search
for `---` cut the frontmatter at the first occurrence anywhere — inside a
quoted value, inside a URL — which both truncated the metadata and spilled
the remainder into the body, where it reaches the system prompt verbatim.

**YAML this reader does not implement is refused rather than mangled.** The
reader is a flat key/value splitter and the documented contract says "YAML
frontmatter" with no restriction, so an author has every reason to write a
block scalar or a flow sequence. `description: >-` produced the literal
string `">-"`, which passed validation and registered with no warning — the
skill existed and was never selected, because its description said nothing.
`[Read, Grep]` became that literal text and was interpolated into the
prompt. Both now name the file and the field.

That is worse for exactly one skill — the one already silently broken — and
better for everyone looking for it.
