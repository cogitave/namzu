---
name: update-docs
description: Use this skill whenever a code change alters anything documented in `docs/` — public API, CLI behavior, wire schema, exported types, configuration, or user-facing workflow. Triggers include freezing a session whose decisions touched the public surface, merging a feature that adds or renames an exported symbol, changing CLI flag semantics, or user phrasing like "update the docs", "docs are stale", "sync documentation". Always use when the published surface changes — out-of-date docs are the most common and most costly drift in this repo.
---

# Update Docs

Keeps `docs/` (published to `docs.namzu.ai`) in sync with code. This skill finds the affected pages via frontmatter tags, updates content accurately, and bumps the `last_updated` field so reviewers can tell a page is current.

## When to trigger

<triggers>
- A session is freezing and its decisions changed any public surface (wire shape, CLI command, exported type, config key).
- A feature PR adds or renames an exported symbol.
- A CLI flag's semantics change.
- A configuration key is added, removed, or renamed.
- User asks to sync, refresh, or update documentation.
</triggers>

<not_triggers>
- Internal refactors with no public-surface change.
- Session-internal notes in `docs.local/` (that is working memory, not published docs).
- README snippets inside individual packages (unless they describe the public API).
</not_triggers>

## Frontmatter contract

<frontmatter>
Every page in `docs/` carries a YAML frontmatter block:

```yaml
---
title: <page title>
description: <one-line summary, used in indexes and search>
last_updated: YYYY-MM-DD
status: current
related_packages: ["@namzu/sdk", "@namzu/anthropic", ...]
---
```

Field semantics:

- `title` — short, human-readable; appears in nav.
- `description` — one sentence, ≤140 chars; used by index pages and any search snippet generator.
- `last_updated` — ISO date of the last *content-verified* edit. Bump only when the page was actually checked against current code.
- `status` — `current` for live pages. Use `superseded` (with a `superseded_by:` link) for pages kept as redirects; use `deprecated` for content describing removed surface that has not yet been deleted. Do not invent statuses.
- `related_packages` — array of fully-qualified package names with the `@namzu/` scope and quoted strings. This is the field agents grep against to find candidate pages for a code change. Use the actual package name as it appears in `package.json#name`.

Agents discover affected pages by matching `related_packages` against the code change. Example — a change to `@namzu/anthropic` triggers a search:

```bash
grep -rl '"@namzu/anthropic"' docs/
```

There is no `surface` field. Page topic is implied by directory placement (`docs/sdk/runtime/`, `docs/providers/anthropic.md`, etc.) and by `related_packages` scope.
</frontmatter>

## Steps

<procedure>
1. Identify the affected packages. Examples:

   <mapping>
     - New exported SDK type → `"@namzu/sdk"`.
     - CLI flag change → `"@namzu/cli"`.
     - Wire schema field added → `"@namzu/contracts"` (and consumers like `"@namzu/api"`).
     - Provider-specific config key → `"@namzu/<provider>"` and usually `"@namzu/sdk"` if it surfaces in SDK config too.
   </mapping>

2. Find candidate pages in `docs/` by grepping frontmatter:

   ```bash
   # find pages related to a package
   grep -rl '"@namzu/sdk"' docs/

   # combine with directory hint when scope is narrower
   grep -rl '"@namzu/anthropic"' docs/providers/
   ```

3. For each candidate page:

   <per_page>
     a. Read the page fully. Understand current claims.
     b. Compare against the actual code (types, schema, CLI help text). Use the code as the source of truth, not the old doc.
     c. Update the affected sections. Keep voice and structure consistent with the rest of `docs/`.
     d. If a claim is now wrong AND the replacement is not obvious from the diff, surface the ambiguity to the user rather than inventing text.
     e. Bump `last_updated` to today's date in the frontmatter.
     f. If the page is fully superseded, add a `superseded_by:` link in the frontmatter and a notice at the top.
   </per_page>

4. Add a new page if the surface change has no existing home. Use the established layout in its sibling directory. Fill the full frontmatter.

5. Cross-check navigation:
   - Index files (`docs/**/README.md`) — ensure new pages are listed.
   - Any landing page that enumerates capabilities — update the list.

6. If the session that triggered this skill is open, append to `progress.md`:

   ```md
   ### YYYY-MM-DD HH:MM — Docs updated
   - Pages updated: [list of docs/ paths]
   - Pages added: [list or "none"]
   - Pages deprecated: [list or "none"]
   - Next: [concrete step]
   ```
</procedure>

## Discipline

<discipline>
- Code is the source of truth. If the doc and the code disagree, the doc is wrong until proven otherwise.
- Never update `last_updated` without actually changing content. The field must mean "the content on this page was verified and current on this date".
- Never delete a public-surface doc without a redirect or a `superseded_by:` link. Readers following an external link should land somewhere useful.
- Do not edit `docs.local/` from this skill — that is working memory, separate from published docs.
</discipline>

## Output

- List of pages updated, added, and deprecated.
- For each updated page: one-line description of what changed.
- Progress log entry if inside a session.
