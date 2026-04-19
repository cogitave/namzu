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
related_packages: [sdk, contracts, cli, api, agents, computer-use]
surface: [api | cli | wire | types | config | workflow]
status: stable | beta | deprecated
last_updated: YYYY-MM-DD
---
```

Agents discover affected pages by matching `related_packages` and `surface` against the code change.
</frontmatter>

## Steps

<procedure>
1. Identify the change's surface and affected packages. Examples:

   <mapping>
     - New exported SDK type → `related_packages: [sdk]`, `surface: [types]`.
     - CLI flag change → `related_packages: [cli]`, `surface: [cli]`.
     - Wire schema field added → `related_packages: [contracts, api]`, `surface: [wire]`.
     - Config key renamed → `related_packages: [sdk]`, `surface: [config]`.
   </mapping>

2. Find candidate pages in `docs/` by grepping frontmatter:

   ```bash
   # find pages related to a package
   grep -rl "related_packages:.*sdk" docs/

   # narrow by surface
   grep -rl "surface:.*wire" docs/
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
