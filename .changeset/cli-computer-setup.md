---
"@namzu/cli": minor
---

Add `namzu computer status`, `namzu computer setup` and `namzu computer stop-idle`
for Pal computers on Windows. `status` says in one sentence whether this PC is
ready; `setup` shows what it will install, the download size, the time, and
whether Windows will ask permission or a restart may follow, asks `Continue?
[y/N]`, then runs; `stop-idle` shuts down the idle Linux machine. `--json`
prints versioned JSON lines for Namzu Desktop (`setup --json` needs `--plan
<id>` as the consent). `setup` without a terminal and without `--yes` or `--plan`
exits with the new code 75 after printing the plan. `--bundle <dir>` or
`NAMZU_PAL_COMPUTER_BUNDLE` names the folder with the bundled image; with
`NAMZU_PAL_COMPUTER_ENGINE=wslc` and no `NAMZU_PAL_COMPUTER_IMAGE`, the Pal
runtime uses the manifest's `imageRef`. On Windows a Pal computer that is not
set up now says "Run namzu computer setup to set this up.", and the model is told
that the computer is not set up. Nothing changes for existing commands; the agent
runtime still never installs anything.
