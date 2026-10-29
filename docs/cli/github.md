---
type: Reference
title: GitHub workflows and pull request links
description: namzu github install writes Actions workflows that answer @namzu mentions and review new pull requests, a conversation that opens a pull request is linked to it, and --from-pr lists the linked conversations.
resource: packages/cli/src/commands/github.ts
tags: [cli, github, ci, sessions]
status: stable
---

# GitHub workflows and pull request links

Two things connect a repository on GitHub to Namzu: workflow files that run
`namzu exec` on a runner, and a link between a conversation and the pull
request it opened or changed.

## Installing the workflows

```sh
namzu github install
namzu github install --workflow review --provider openai --budget 2
```

`install` writes into `.github/workflows/` of the repository you are in (the
nearest folder with a `.git` entry above the current one). It reads nothing
from GitHub, saves no key and runs nothing; the files are plain text you can
read before you commit them.

| Workflow | File | Runs when | What it posts |
| --- | --- | --- | --- |
| `mention` | `namzu.yml` | someone writes `@namzu` in an issue, a pull request or a review comment | the answer, as a comment on that issue or pull request |
| `review` | `namzu-review.yml` | a pull request from this repository is opened or marked ready for review | a review, as a comment on the pull request |

Without `--workflow` both are written; `--workflow` can be repeated.

| Option | Meaning | Default |
| --- | --- | --- |
| `--provider <id>` | the provider whose key the runner uses; it must be one that takes an API key | `anthropic` |
| `--model <id>` | a model for that provider | the provider's default |
| `--secret <name>` | the repository secret that holds the key | the provider's usual variable, such as `ANTHROPIC_API_KEY` |
| `--budget <dollars>` | the spend limit of one run (`--max-budget-usd`) | `1` |
| `--force` | replace a file that is already there | keep it and say so |
| `--dry-run` | list what would be written and write nothing | |

When it has written something, `install` ends with the two steps left to you:
save the key with `gh secret set <name>` and commit the files.

### What the runner does

Each workflow checks out the repository, installs `@namzu/cli` at the release
line of the CLI that wrote the file (`@namzu/cli@42` from a 42.x CLI; the pin
does not follow later majors), and runs `namzu exec --trust` with the options
above and `--disallowed-tools "edit write"`. The run can read the repository
and cannot push to it: the edit and write tools are off and the token only reads
contents. The shell tool stays on, so a command can still write files on the
runner and use the comment token (issues and pull requests, write) and the
provider key. A run that fails or stops at the spend limit
posts nothing.

Two limits keep a stranger from spending your key:

- The `mention` workflow answers only comments written by an owner, a member
  or a collaborator of the repository.
- The `review` workflow skips pull requests from forks (GitHub does not share
  the secret with them) and drafts.

The text of a comment or an issue reaches the run through an environment
variable and standard input, never inside the script itself.

## Linking a conversation to a pull request

When a shell command that changes a pull request succeeds and prints the
request's address, the conversation is linked to it. The commands are
`gh pr create`, `edit`, `merge`, `comment`, `close`, `reopen` and `ready`, and
`glab mr create`, `update`, `merge`, `note`, `close` and `reopen`; a command
with `--dry-run`, and one that only reads (`gh pr view`, `gh pr checkout`),
links nothing. The link is written to the conversation's own log when the turn
ends, so it survives moving the conversation to another machine. The last
request a conversation touched is the one it shows.

`/resume` shows the link on the row (`acme/widgets#42`) and the search finds
a conversation by it (`pr #42`).

## Finding the conversations of a pull request

```sh
namzu --from-pr          # every conversation linked to a pull request
namzu --from-pr 42       # the ones linked to #42
namzu --from-pr https://github.com/acme/widgets/pull/42
```

`--from-pr` opens the `/resume` picker with only the linked conversations. A
number, `#42` or a pull request address narrows it to that request. It says
so in one line when nothing matches. It cannot be combined with `--continue`
or `--resume`, and it applies to the interactive session only.

## What this does not do

Namzu has no hosted GitHub app: there is no installer that stores a key for
you, no command that follows a pull request's checks for you, and a headless
`namzu exec` run does not link its conversation to a pull request.
