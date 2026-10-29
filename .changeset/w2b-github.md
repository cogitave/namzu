---
'@namzu/cli': minor
---

New `namzu github install` writes two GitHub Actions workflows into `.github/workflows/`: one that answers `@namzu` mentions from repository owners, members and collaborators, and one that reviews each new pull request from the same repository. Each runs `namzu exec` on the runner with the repository read-only and a dollar limit (`--budget`, default 1), and posts the reply as a comment. Save the provider key as a repository secret (`gh secret set ANTHROPIC_API_KEY`) and commit the files; `--provider`, `--model`, `--secret`, `--workflow`, `--force` and `--dry-run` choose the rest.

A conversation whose shell command opens or changes a pull request (`gh pr create`, `gh pr merge`, `glab mr create` and the like) is now linked to it in its own log. `/resume` shows the request on the row and finds it by search, and the new `--from-pr [number|address]` opens the picker with only the linked conversations. Nothing to change to keep working; conversations already on disk simply have no link.
