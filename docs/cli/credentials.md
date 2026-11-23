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
When it finds no Anthropic credential, it also names the Claude Code file paths
it checked, even if another provider such as Codex is available.

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
The paste field feeds the session-credential path. A pasted API key, for any
provider that takes one, is saved privately after that provider starts
successfully, and both the key and the selected provider are available on the
next launch without asking again: the Google key goes to `gemini-api-key.json`, every
other provider's to `api-keys.json` (below). The one exception is a pasted
subscription token, which lapses in hours with nothing to renew it; it stays in
memory for that session and the screen says so. The Desktop's **Settings ▸ Models** saves a
pasted key for any provider that takes one in `api-keys.json` beside the other credential files
(`{ "version": 1, "keys": { "<provider id>": "<key>" } }`, created `0600` in a `0700` directory and
read back and verified like them, refused rather than stored unprotected); discovery reads it after
the environment, names it `saved API key · this device`, and every Namzu surface then uses it.
Removing the last key deletes the file. The terminal picker writes the same file, so a key
entered in one surface is found by the others.

A key added with `/auth` lives in `accounts.json` with its label, and only there: startup reads it
from the account when `api-keys.json` (Google: `gemini-api-key.json`) names no key for the provider, so
the key is stored once. An account aimed at a custom endpoint is not used for startup. Removing an
account removes its key with it, including a key you typed in the picker that is identical to it, since
that copy is retired. `/logout <provider>` removes the saved key and only the plain `/auth` accounts
that hold that same key; accounts with other keys stay (the oldest then becomes the startup key). Their
last-use records go with them. If an account cannot be removed, the saved key is kept and the error is
shown. A key file in `accounts.json` that others can read or write is not trusted for startup. An earlier build also copied an account's key into
`api-keys.json`; at the first start of a build with this behaviour a copy that is byte for byte the
account's key is removed, after the account file is read and the removal re-checks the value under the
store lock, with a one-line notice. If the account is removed by another process
meanwhile, the copy is written back. This runs at the start of the terminal app; Desktop and the
non-interactive commands already read the account, so the retired copy only disappears at the next
terminal start. A key that differs from the account's, or any file that cannot be read, is left alone.
An older build started afterwards does not find a retired key in `api-keys.json` and shows the provider
as not detected; the key is still in the account.

**The choice follows the ways, not the ids.** What makes a row worth asking
about is that it has more than one way in — a machine that found a session *and*
can take an API key has two, whether or not they were declared on the same
registry entry. So an Anthropic row with a Claude session on the device offers
both: keep using that session, or enter a key of one's own. So does a vendor
with experimental free Zen models beside its credentialed path; listing a free
model does not verify inference access. A key discovery already
hands over ONE way: the row went
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

### What a first run starts with

With nothing saved, the terminal app and Desktop do not stop at the picker when something usable
is on the computer. They start on the best thing found, in this order: a sign-in Namzu already
reuses (Claude Code, Codex), an API key in the environment, a local server (Ollama, LM Studio; each
probe waits at most 300 ms and all run together), then the keyless Zen free models (experimental; Zen may refuse them, see below). `discoverProviders`
returns the list already in that order, so the first entry is the default for `exec`, the ACP host
and Desktop too. The terminal app says what it picked in one line ("Using your Claude sign-in, found
on this computer."), saves nothing, and `/model` changes it; the picker still opens first when nothing
at all is available, or when the automatic start cannot run.

### Experimental Zen free models

With no Zen API key, the picker and headless `--provider zen --model <id>` can
select the free models in Namzu's bundled Zen catalogue. The selected model
must resolve against the active catalogue or its bundled fallback at zero price;
an unknown model, a paid Zen model, or any Zen Go model needs its own API key.
This is an experimental path. Zen may refuse a direct request even
when its catalogue lists the model as free. Space Bunny Free has been verified
for direct anonymous access; the other free models have not. The
`supportsAnonymousAccess` flag continues to mean verified direct access, not
experimental eligibility.

The chooser and `/setup` recommend installing OpenCode for its own client.
Namzu sends Zen requests directly and does not invoke that binary, so installing
OpenCode does not change a Namzu session's request or guarantee that Zen
will accept it. Set `OPENCODE_API_KEY` for credentialed Zen access if a free
request is refused. `OPENCODE_GO_API_KEY` is separate and does not authorize
Zen requests.

When Zen declines a free-model request that carried no key (HTTP 403, the free tier is not available
to this client), the terminal app says "Zen didn’t accept the free model right now. Try again in a
while, or choose another provider with /model. A Zen API key also works." and keeps the service's own
words for `--debug`; the structured text of `exec` and scheduled runs says the same. The generic
`provider.permission` catalogue entry no longer claims a key authenticated: a 403 only says the
request was refused.

When Zen rate limits a free model (the allowance is per model), the terminal app says "The free
allowance for this model is used up for now. It should reset in about 15h 00m. Pick another model
with /model, or choose another provider. A Zen API key also works." The reset time appears only when
the service named one, and the service's own words stay behind `--debug`. A paused reply leads with
the same ways on instead of "wait". A paid model, or another provider, keeps the ordinary "is limiting
requests right now" wording. The `provider.rate_limit` catalogue hint no longer advises lowering
concurrency; it says to wait for the retry delay or the quota window, or to continue on another model
or provider.

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
Namzu is launched from Command Prompt, PowerShell or Git Bash. The default
macOS session is read from Claude's Keychain entry. These storage locations follow
[Claude's credential documentation](https://code.claude.com/docs/en/authentication#credential-management).

Installing or signing in to Claude Desktop does not guarantee a Claude Code
CLI session for Namzu to reuse. The Desktop app includes a Code tab, and
[Anthropic documents the terminal CLI as a separate installation](https://code.claude.com/docs/en/desktop-quickstart).
If `namzu doctor --category providers` reports no Claude Code session, sign in
from Namzu with `namzu auth login claude` (see [Signing in from a shell that cannot paste](#signing-in-from-a-shell-that-cannot-paste)), or install the standalone `claude` CLI
and use its `/login` command. A detected Codex session says nothing about
Claude Code's separate credential file. Namzu does not inspect the Desktop
app's own OAuth storage.

`CLAUDE_CONFIG_DIR` selects the directory containing `.credentials.json`.
Relative values are resolved against Namzu's working directory; paths with
spaces are read directly without a shell. When this variable selects a
profile, a missing or unusable file does not cause Namzu to read the default
Claude profile, a paired Windows home from WSL, or the default macOS Keychain
entry. Custom macOS Keychain entries are not currently discovered.

Without a directory override, WSL may also reuse a session from its paired
Windows home. That home is `%USERPROFILE%` as `cmd.exe` reports it. Both
`cmd.exe` and the home are found under the drive mount root
(`[automount] root` in `/etc/wsl.conf`, `/mnt/` by default). The home is asked
for once per process, not once per sign-in family: each ask is a blocking round
trip into Windows (about 35 ms), and discovery used to pay it four times at
every start. Only an answer is kept; a probe that timed out or failed is asked
again at the next discovery, so a long-lived engine recovers. Discovery records
the exact file it selected. Subsequent reads and a rotating Claude refresh use
that same file, preserving its other fields.
Namzu does not copy borrowed sessions into its own credential store.

## A sign-in made in Namzu Desktop on Windows

Namzu Desktop on Windows and a terminal inside WSL are two Namzu homes on one
machine: `%USERPROFILE%\.namzu` and `/home/<you>/.namzu`. A Claude or Codex
sign-in Namzu itself made (`credentials.json`) used to stay in the home where it
was made, so the other side did not see it.

Inside WSL, the terminal now reads Desktop's `credentials.json` in place through
the mounted drive when its own home has no sign-in for that provider. Nothing is
copied. A subscription's refresh token rotates, so a copy would die the first
time either side refreshed; instead there is one record, and a refresh the
terminal makes is written back to that file under the same lock the Windows side
uses (`credentials.json.lock`, then an atomic rename). A rotation Desktop made
meanwhile is taken as it stands and never overwritten.

- **Own first.** A sign-in in the terminal's own home always wins, per provider.
  Two different accounts on the two sides are never mixed: the terminal uses its
  own and the sources line names it.
- **Where it comes from.** The provider list and `/model` say "Signed in with
  Namzu Desktop on Windows" for a shared sign-in. The Windows home is found the
  documented way (`cmd.exe /c echo %USERPROFILE%` under the drive mount root),
  never guessed from a user name. A failed lookup is retried after a minute and
  means no shared sign-in.
- **Only the default home.** `NAMZU_HOME`, an explicit home, or a Windows
  `credentials.json` that is a link or not a regular file, or a `.namzu` folder that
  is a link or junction (or resolves outside the Windows home), turns it off for
  that lookup.
- **Permissions.** The mounted drive reports every file as mode 0777, so the
  owner-only proof used for the terminal's own file cannot be made there; the
  file is protected by the Windows profile's access list, which Desktop set.
- **Locked or unreadable.** An unreadable or corrupt file reads as no sign-in.
  A lock the Windows side holds refuses the refresh with a sentence naming
  Desktop; the current access token keeps working until it expires.
- **Signing out.** `namzu auth logout` in the terminal never removes Desktop's
  sign-in (that would sign Desktop out); it says so, including when the terminal's
  own sign-in was hiding Desktop's and Desktop's is now the one in use. Signing out in Desktop
  removes the file, and the terminal then sees none. Signing in on the terminal
  makes a separate sign-in of its own that is used from then on.
- **Turn it off.** `shareDesktopSignIn: false` in your own config file, or
  `NAMZU_SHARE_DESKTOP_SIGNIN=0` (the variable wins), keeps the terminal to its
  own sign-ins. Project files cannot set it.

Not covered: the reverse direction (Desktop reading the WSL home) and a Windows
`NAMZU_HOME` that differs from `%USERPROFILE%\.namzu`.

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
`skipStored`. Run `/logout gemini` in the TUI or `namzu auth logout gemini` in a
shell to remove it; `/logout <provider>` (for example `/logout deepseek`, or
`/logout anthropic-key` for an Anthropic API key, since `/logout anthropic`
removes the subscription) and `namzu auth logout <provider>` remove another
provider's key from `api-keys.json`. `/logout all` and `namzu auth logout all` remove
every saved key along with Namzu-owned subscriptions, including keys the Desktop's Settings > Models saved in the same file (remove single providers instead to keep them). Removing an `/auth` account leaves a key already kept for startup; use `/logout <provider>` for that. `/auth` accounts are not
touched by any of them. These commands remove the saved key for future
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

A directory is proved private once per process and per directory. The proof costs three Windows
processes (`whoami`, `icacls`, `icacls /save`), and opening a Pal or a conversation meets the same
state folders several times, so a folder this process already proved is not proved again while
it keeps the same device, file id and creation time. A folder deleted and created again under the
same path has a different identity and is proved afresh. The account's security identifier is
also read once per process. Only a successful proof is remembered, never a refusal. The trade is
stated: an access-list edit made to that same folder while Namzu runs is noticed at the next start,
not at the next open. Credential files, and the directories that hold them, are proved at every read and write.
A credential file that does not exist is answered without a proof: looking its name up opens no
handle to any data, and provider discovery asks about several such files at every start. Discovery
also reads the saved API keys once for all providers instead of once per provider, so on Windows a
start with no saved keys runs no `icacls` at all for them.

Windows ACL mutation and verification pass extended absolute paths to `icacls`.
This permits private state under long project paths without changing its stored
directory names or weakening the read-back check. A native 291-character state
path reproduced ordinary-path failure and passed with the extended form.

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
23.0.0's own `namzu update` can fail with `spawn EINVAL` because it tries to
launch npm's command shim directly. Install the update once from PowerShell
or Git Bash with `npm.cmd install --global @namzu/cli@latest`, using the same
Node installation and adding `--prefix "<existing-prefix>"` for a custom
global installation. Restart Namzu after installation; another provider login
is not needed to fix this updater failure.

## Signing in from a shell that cannot paste

`namzu auth login claude` in a terminal prints the address and waits for you to paste the code the browser shows. A shell whose standard input closes at once (a chat tool's shell prefix, a script) cannot take that paste, and the one-time verifier would die with the process. Namzu therefore keeps the waiting sign-in (verifier, state, redirect address, start time) in `login-pending/anthropic.json` under the Namzu home, a file readable only by your account in an owner-only folder. It is never printed or logged. The command prints the address and one line, and exits 0 meaning "waiting for the code":

```text
Finish with `namzu auth login claude --code <code>` within 10 minutes.
```

Open the address, sign in, then run `namzu auth login claude --code <value>`, where the value is the bare code, `code#state`, or the finished address. Namzu refuses a sign-in that is missing, older than 10 minutes, or whose state does not match, says so in a sentence, and stores nothing. After the exchange has been tried, whether it worked or not, the waiting file is deleted, so a second `--code` says no sign-in is waiting. Exit codes: 0 signed in or waiting, 1 the sign-in failed, 2 the command was used wrongly. A terminal that can paste keeps the interactive flow, and the Codex sign-in is unchanged.
