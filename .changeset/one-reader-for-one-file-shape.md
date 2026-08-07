---
'@namzu/cli': minor
---

A `SKILL.md` written on Windows now works.

The skill reader carried its own frontmatter regex, `/^---\n…\n---\n?/`, which
is LF-only. A file saved with CRLF line endings — the Windows default — matched
nothing, so the entire file was treated as body and the skill was listed under
its directory name with `(no description)`. It never failed; it described the
skill wrongly, which is why it survived this long.

It now reads through `parseFrontmatter` from `@namzu/sdk`, so LF, CRLF and a
lone CR all parse identically, a BOM is handled, and frontmatter keys can no
longer reach `Object.prototype`.

**One behaviour changed on purpose.** Frontmatter you *leave out* is still fine
and still documented: a file with no `---` fence is all body. Frontmatter you
*open and get wrong* is now refused instead of being treated as absent. The old
answer put the unreadable YAML into the body, where it reached the model
verbatim under a skill named after its own directory.

A refused skill does not take the roster with it. It stays in `/skills` marked
`⚠` with the parse error, so a file you can see on disk is accounted for, and
`/skill <name>` declines to activate it rather than injecting nothing.

If you have a `SKILL.md` whose frontmatter never parsed, you will now be told —
that is the change, and the skill was not working before either.
