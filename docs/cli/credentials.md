---
type: Reference
title: Provider credentials and private state
description: How Namzu discovers existing provider sessions, which providers the picker offers to set up with a credential, and how private credential and CLI state storage is verified on Windows and POSIX systems.
resource: packages/cli/src/integrations/providers/credential-store.ts
tags: [cli, providers, credentials, windows, storage]
status: stable
---

# Provider credentials and private state

Namzu discovers usable sessions independently of whether the corresponding
external CLI executable is installed. `/setup` reports installation and
credential availability separately. `namzu doctor --category providers`
reports discovered source kinds and paths without printing credential values.

## Choosing a provider, and entering a credential

The provider picker lists every provider this build can construct that takes a
credential you can type — not only the ones discovery found on the machine. The
rows it detected come first, each naming the source it came from (`Claude
session · this device`, `env · GEMINI_API_KEY`, `local · localhost:11434`). The
rest follow under `Not detected — enter a credential to use these:`, and each
names the environment variable it needs (`needs OPENROUTER_API_KEY`), because
that variable is both what makes the provider work now and what keeps it
working after a restart.

Enter on one of those rows opens the paste field for that provider, and `k`
does the same for whichever row the cursor is on. A provider that takes no typed
credential — a local server, or one whose credential arrives by sign-in —
leaves `k` addressing the provider the picker was opened for, which is the saved
provider whose key is missing. `l` starts a Namzu-owned subscription sign-in
instead. A typed credential is held in memory for that session: nothing is
written to disk, and the variable named on the row is how it becomes durable.
Rows past the ninth are reachable with the arrow keys; the digit shortcut is one
keystroke per row and the screen says so when the list grows past nine.

Four providers are deliberately absent from that second block, each for a
reason the screen would otherwise have to explain after the fact. AWS Bedrock
needs a credential chain — an access key, a secret, a region, or a role the SDK
assumes — which one field cannot express. `http` is an endpoint whose base URL
is half the credential. LM Studio is not constructible in this build. Codex is
offered instead as a device-code sign-in under `l`, so that one provider is not
set up two different ways. Ollama is never listed there either: what it needs is
a running server, and a running server is how discovery finds it.

## Existing Claude sessions

The default Claude session file is `~/.claude/.credentials.json` on Linux and
`%USERPROFILE%\.claude\.credentials.json` on native Windows, including when
Namzu is launched from PowerShell or Git Bash. The default macOS session is
read from Claude's Keychain entry. These storage locations follow
[Claude's credential documentation](https://code.claude.com/docs/en/authentication#credential-management).

`CLAUDE_CONFIG_DIR` selects the directory containing `.credentials.json`.
Relative values are resolved against Namzu's working directory; paths with
spaces are read directly without a shell. When this variable selects a
profile, a missing or unusable file does not cause Namzu to read the default
Claude profile, a paired Windows home from WSL, or the default macOS Keychain
entry. Custom macOS Keychain entries are not currently discovered.

Without a directory override, WSL may also reuse a session from its paired
Windows home. Discovery records the exact file it selected. Subsequent reads
and a rotating Claude refresh use that same file, preserving its other fields.
Namzu does not copy borrowed sessions into its own credential store.

## Private local storage

Namzu-owned sign-ins live in `credentials.json` under the application home
(`~/.namzu`, or `NAMZU_HOME`). Generated CLI state partitions use the same
privacy check before session startup. See [project and session state](project-state.md)
for the directory layout.

On POSIX systems, credentials must have no group or other access and generated
state directories are restricted to mode `0700`. On Windows, Namzu removes
inherited permissions, grants the current account access, and reads the
resulting protected discretionary ACL back from Windows.

Directory grants include inheritance for child files and directories. Otherwise,
a new partition below a protected parent can receive the creator's default ACL
instead, including an explicit Administrators grant. Securing a named private
directory removes that group grant and installs inheritable current-user access;
the group is not accepted as private. This also permits startup after the older
non-inheritable directory grant caused a failed launch. This is not a recursive
migration of old files: explicit permissions on existing descendants are not
removed by repairing their parent alone.

An existing grant to Windows LocalSystem is accepted alongside access for the
current account. Windows may serialize this account as `SY` or `S-1-5-18`;
`SY` denotes the operating system, as documented in Microsoft's
[SDDL SID reference](https://learn.microsoft.com/en-us/windows/win32/secauthz/sid-strings).
SYSTEM-only access does not establish access for the current user. Grants to
Everyone, Users, Authenticated Users, or another user remain refused. A remaining
Administrators grant also fails validation, including on credential files.
Unsupported or malformed ACL entries cause refusal.

A startup error naming `state/` or `cli/` and a Windows account is a
local state-permission failure. It can occur after a provider credential has
already been found. Earlier versions incorrectly rejected an explicit `SY`
grant as another user's access; signing in to Claude again does not repair
that local ACL interpretation.

The fixes must be installed before retrying startup. On native Windows, CLI
23.0.0's own `namzu upgrade` can fail with `spawn EINVAL` because it tries to
launch npm's command shim directly. Install the update once from PowerShell
or Git Bash with `npm.cmd install --global @namzu/cli@latest`, using the same
Node installation and adding `--prefix "<existing-prefix>"` for a custom
global installation. Restart Namzu after installation; another provider login
is not needed to fix this updater failure.
