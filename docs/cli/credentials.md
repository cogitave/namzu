---
type: Reference
title: Provider credentials and private state
description: How Namzu discovers existing provider sessions, how the picker groups them into one row per vendor and offers each way to authenticate it, and how private credential and CLI state storage is verified on Windows and POSIX systems.
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

The provider picker draws **one row per vendor**, and the ways to authenticate
that vendor are offered inside it. Every vendor this build can construct and take
a typed credential for is on the list — not only the ones discovery found on the
machine. The rows it detected come first, each naming the source it came from
(`Claude session · this device`, `env · GEMINI_API_KEY`, `local ·
localhost:11434`). The rest follow under `Not detected — enter a credential to
use these:`, and each names the environment variable it needs (`needs
OPENROUTER_API_KEY`), because that variable is both what makes the vendor work
now and what keeps it working after a restart.

A vendor is a product, not a registry id. OpenAI is one row whether the machine
has the subscription signed in, the API key exported, or neither: the row's
third column says what is there (`Codex session · this device`) or what is
missing, and the row does not pick between them for you. Entering such a row
offers its ways in, the detected subscription first, then the API key, then — where
nothing works yet — a sign-in. Picking one leads where that way in has always
led: a detected session opens the vendor's models, a credential opens the paste
field, and a sign-in starts the same device-code or browser flow `l` starts.
The paste field feeds the session-credential path. A pasted Google API key is
saved privately after Google starts successfully, and both the key and selected
provider are available on the next launch. Other pasted credentials are held
in memory for that session and written nowhere.

**The choice follows the ways, not the ids.** What makes a row worth asking
about is that it has more than one way in — a machine that found a session *and*
can take an API key has two, whether or not they were declared on the same
registry entry. So an Anthropic row with a Claude session on the device offers
both: keep using that session, or enter a key of one's own. So does a vendor
whose free catalogue works without a credential, beside the key that catalogue
does not need. And a key discovery already hands over is ONE way: the row went
and found it, and entering another is that way twice, so that row goes straight
on.

Enter asks a question only where there is more than one answer. A row with one
way in keeps the keystroke it always had — an unconfigured row opens its paste
field, a detected one opens its models — and nothing stands between an operator
and their model list when there is nothing to choose. `k` opens the paste field
for whichever row the cursor is on. A row whose vendor takes no typed credential
leaves `k` addressing the saved provider the picker was opened for, which is the
provider whose key is missing, and `l` starts a Namzu-owned sign-in from any
screen in the picker.

Two vendors that look like one keep two rows, because they are two products
rather than two credentials for one. Zen and Zen Go have separate catalogues,
separate billing routes and keys that do not open each other, so a merged row
would ask which catalogue to run on under a heading about credentials; Ollama
and LM Studio are two different local servers. Nine vendors is the most this
list can draw — the seven that can be set up with a typed credential plus the
two local servers discovery can add — so the digit shortcut reaches every row
there can be, one keystroke each, and the arrows reach the rest of what fits.

On a terminal too short for the whole screen, the list is scrolled rather than
drawn past the bottom of it: the rows that do not fit are reached with the arrow
keys, and the window follows the cursor. What stays put is the notice at the top
— the sentence saying why this screen is open and what to do about it — then the
title, the heading above the not-detected block, and the keys at the foot. The
one line that gives way when there is still not enough room is the
`N detected · …` summary, which says nothing the rows below it do not. A row
whose source column is longer than the space beside its name wraps under it
rather than being cut, and the `← current` mark does the same when sharing the
line would leave the source too narrow to read.

The footer says what `esc` does on the screen it is on, because those are two
different things: with a session running behind the picker it returns to that
session (`esc cancel`), and on the startup screen, where there is nothing to
return to, it closes namzu (`esc exit namzu`).

Four providers are deliberately absent from that second block, each for a
reason the screen would otherwise have to explain after the fact. AWS Bedrock
needs a credential chain — an access key, a secret, a region, or a role the SDK
assumes — which one field cannot express. `http` is an endpoint whose base URL
is half the credential. LM Studio is not constructible in this build. Ollama is
never listed there either: what it needs is a running server, and a running
server is how discovery finds it.

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
Windows home. That home is `%USERPROFILE%` as `cmd.exe` reports it. Both
`cmd.exe` and the home are found under the drive mount root
(`[automount] root` in `/etc/wsl.conf`, `/mnt/` by default). Discovery records
the exact file it selected. Subsequent reads
and a rotating Claude refresh use that same file, preserving its other fields.
Namzu does not copy borrowed sessions into its own credential store.

## Private local storage

Namzu-owned sign-ins live in `credentials.json` under the application home
(`~/.namzu`, or `NAMZU_HOME`). Generated CLI state partitions use the same
privacy check before session startup. See [project and session state](project-state.md)
for the directory layout.

A Google API key pasted into the provider picker lives in the separate
`gemini-api-key.json` in that application home. It is created through the same
checked private write and atomic replacement as the subscription credential
store. An explicit `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable
takes priority over it; the saved key takes priority over the installed Google
session. Internal discovery callers can skip Namzu-owned stores with
`skipStored`. Run `/logout gemini` in the TUI or `namzu logout gemini` in a
shell to remove it. `/logout all` and `namzu logout all` remove it along with
Namzu-owned subscriptions. These commands remove the saved key for future
launches; an already-running Namzu session may continue using its in-memory
copy until it exits. Neither command changes environment variables or the
installed CLI's account session.

On POSIX systems, credentials must have no group or other access and generated
state directories are restricted to mode `0700`. On Windows, Namzu removes
inherited permissions, grants the current account access, and reads the
resulting protected discretionary ACL back from Windows. Before creating an
atomic credential file, Namzu also proves that its parent directory is private;
an account that opened a file under a broad inherited ACL could otherwise keep
that read handle after the file ACL was tightened.

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
