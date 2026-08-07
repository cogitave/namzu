---
'@namzu/sdk': major
---

`parseFrontmatter` refuses a block-sequence list instead of silently dropping it.

```yaml
---
allowed-tools:
  - Read
  - Bash
---
```

Those lines carry no `:`, so they were skipped, and the key came back **absent**
— not empty, absent. Meanwhile the flow form `[Read, Bash]` threw. One spelling
of a list was a hard error and the other was silence, and the silent one is the
spelling people actually write, because the block form is the natural YAML for
a list.

**What breaks.** A file whose frontmatter uses a `- ` list now throws where it
previously parsed. If you load skills or commands from files you did not write,
one of them may start being refused.

**What to do.** Write the value on one line:

```yaml
allowed-tools: Read, Bash
```

The error names the key and the file.

**Why this is worth a major rather than left alone.** The file that now throws
was never working. `allowed-tools` is a capability list: a skill that asked for
`Bash`, had the request silently discarded, and ran without it is
indistinguishable — from the author's side and from the log's — from a skill
that never asked. That is a capability quietly not granted, which is worse than
a file that will not load, because the second one tells you.

In `@namzu/cli` this surfaces as it should: the skill is listed with `⚠` and the
parse error rather than disappearing, and the rest of the roster keeps working.

Not affected: an ordinary indented mapping still parses, and a hyphen inside a
value — `description: a - b` — is prose, not a list, and is left alone.
