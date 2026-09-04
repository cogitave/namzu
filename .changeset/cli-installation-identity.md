---
"@namzu/cli": major
---

The CLI has an identity. A tenant id is minted once per installation (`~/.namzu/identity.json`) and a topic id once per project (`projects/<id>/cli/topic.json`); every project, conversation and run is filed under them instead of the kernel's `tnt_unknown_legacy` placeholder and the constant `top_namzu-cli`. A conversation's id is chosen when the session opens and written under it at first use, so `session_start` hooks, logs and the screen all name the same id. The workspace-local legacy state backend (`<cwd>/.namzu/cli.json` pointing at a project stored inside the repository) is no longer read: state lives in the application home only, and `namzu state` reports what is there without minting anything. Conversations are matched to a project by project id alone.
