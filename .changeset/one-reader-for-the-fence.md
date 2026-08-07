---
'@namzu/sdk': minor
---

Added `parseFrontmatter`, the one reader for a markdown file's `---` block, and
its `ParsedFrontmatter` result type.

```ts
import { parseFrontmatter } from '@namzu/sdk'

const { data, blocks, body } = parseFrontmatter(raw, `command at "${path}"`)
// data:   { description: 'Open a pull request', 'argument-hint': '<branch>' }
// blocks: { metadata: { author: 'someone' } }   ← one level of nesting
// body:   everything after the closing fence, trimmed
```

**Why you would want it.** If you read your own markdown — command files,
prompt templates, anything with frontmatter — you were writing a second reader.
There were three in this project and two of them disagreed on the same input:
one **threw** on malformed frontmatter and another **silently returned no
metadata**, so one file was a hard error on one path and, on the other, a skill
named after its own directory described as "(no description)". This is the one
that stays.

**It refuses rather than degrades.** Absent frontmatter, an unclosed fence, or
YAML this reader does not implement — a block scalar (`>`/`|`), a flow sequence
(`[a, b]`), a flow mapping (`{a: b}`) — all throw, and the message names your
`source` label and the offending key. It never returns an empty or partial
result to stand in for a file it could not read. Pass whatever `source` string
makes your errors read correctly; it is used verbatim.

**It parses CRLF.** A file authored on Windows is the ordinary case. Be aware of
what this does and does not claim: `loadSkill` already handled CRLF correctly,
so this is not a repair on the SDK side — the defect was in a separate
first-party copy whose regex required LF and which therefore dropped the
frontmatter of every Windows-authored file without failing. CRLF is now covered
by tests that fail if it regresses, on a property that was true and untested.

**Frontmatter keys cannot reach the prototype chain.** Keys come from a file,
which is untrusted input, so `__proto__`, `constructor` and `toString` are
stored as ordinary data and cannot write to `Object.prototype`. Worth stating
because the first cut of this export got it wrong: a `__proto__:` block wrote
straight through to `Object.prototype`, and the poison then surfaced in the
metadata of an unrelated skill loaded later in the same process. Caught before
release; covered by tests.

**It does not know what your fields mean.** It returns the parsed map and
validates no field names — a skill's vocabulary and a command's are different,
and widening one to cover the other is how a skill-shaped API comes to mean
something it does not. `data` holds top-level scalars, `blocks` holds one level
of indented keys grouped under the key above them. Your own validation stays
yours.

**Nothing about `loadSkill`, `discoverSkills`, `SkillRegistry` or
`resolveSkillChain` changes**, with one disclosed exception below. They are now
built on this reader, and that was checked rather than assumed: the pre-refactor
loader and the refactored one were run side by side over 26 frontmatter shapes
× both line endings — including a key carrying both a scalar and indented
children, `metadata:` with a value *and* children, children under a
non-`metadata` key, duplicate keys, and indented lines before any key — and
compared on returned metadata, body, token estimate, and thrown message. 52
cases, no structural difference.

**A second exception, and it is a fix.** A file using lone-`CR` line endings
(classic Mac, pre-2001) used to be read as one single line, which collapsed the
whole frontmatter into the first key — `name` came back as
`"a-skill\rdescription: d"`. `loadSkill` then refused the file with
`missing required field: description`, because the collapse leaves no
`description` key at all. Such files now parse correctly. Nothing that worked
before stops working: the only files whose outcome changes could not load at
all. It mattered enough to fix because a caller doing its own validation —
which is the whole point of this export — would have accepted the mangled name
silently.

**The one exception that is only prose.** The refusal message for unsupported
YAML used to end *"Refusing rather than registering a skill whose `x` would read
as …"*. It now ends *"Refusing rather than accepting a `x` that would read
as …"*, because the reader is no longer only about skills and a command file
refused with the word "skill" in the message is a worse error than the one it
replaces. The prefix, the named key, the named construct, and the advice are all
unchanged; only that clause differs. If you match on the full text of that
message, adjust; matching on `/block scalar/`, `/flow sequence/` or
`/flow mapping/` is unaffected.

`discoverSkills` still finds only directories containing a `SKILL.md`; serving
single-file layouts is a caller's job, and this export is what makes writing that
caller reasonable.
