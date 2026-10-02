# Native Windows Pal parked review proof — 2026-10-02

The production CLI Pal session and SDK checkpoint resume path passed in three
fresh native Windows Node v22.20.0 processes. The caller inherited a WSL UNC
working directory. Each process used the existing explicitly selected local
Podman machine and `namzu-local-computer:1` image, a private application home,
an owned Pal, its own persistent guest volume, and the original conversation.
No dependency, engine or image installation was performed.

## Verified behavior

- The first process records a real checkpoint and `decision_requested` while
  the requested guest file change remains absent.
- Updating the Pal profile to revision 2 leaves this conversation pinned to
  its original model and purpose in revision 1.
- The second process resumes the same original turn and reviewed batch through
  the production SDK under actual guest admission. The first counter becomes
  exactly `x`; a later counter remains absent behind a distinct checkpoint even
  with this private host and agent configured in current `auto` mode.
- The third process retains the guest volume. Repeating the first action
  returns the actual original resolution pointer without inference or another
  write. Changed answers, forged request pointers and revoked current consent
  refuse before a subsequent model request or guest change. This fresh process
  uses current `accept-edits` host mode; the later decision is applied only by
  its separate approval.
- Separately approving the later batch produces exactly `y`, completes the
  same turn, and records each original tool ID once. The original token,
  iteration and timeout limits remain `0`, `6`, and `0` respectively.
- A real guest desktop PNG is captured in the private Windows fixture, outside
  Git. Every phase confirms `agent.close()` and `closeCliPalRuntime()` before
  writing its receipt; the parent process exits with code 0.

## Evidence

The executable fixture is
`research/runtime-desktop-20260930/windows-pal-review-proof.mjs`.
The sanitized receipt is
[pal-native-review-20261002.json](artifacts/pal-native-review-20261002.json); it contains
the exact entry and checkpoint/action hashes plus complete copied SDK, CLI and
sandbox runtime tree hashes. It contains no private profile/session identifiers,
raw action bodies, credentials or fixture paths.

Exact final command logs are
`/var/tmp/namzu-pal-parked-review-ceiling-tests-20261002.log` (29 tests, exit 0)
and `/var/tmp/namzu-pal-native-review-ceiling-20261002.json` (native parent exit 0).
The action runtime hash is
`a71a93d8a0ee52be05c13067aa463060b33284f8c5f56486daa68fee9dd4a8ee`.

The focused CLI Pal suite passes 29 tests, including current plan mode refusing
a restored approval and a later rule-allowed batch, missing trusted current
mode refusal for an actually reopened plan session, captured host-port mutation,
writer cleanup retry, durable competing-action refusal, and static and live
switches into `auto`/`accept-edits` preserving the action's one-batch ceiling.
CLI typecheck and
the scoped style, documentation, external-name and log-standard checks pass.

## Scope

Only model inference and authenticated host consent are scripted. Pal metadata,
ownership, original disk journal/checkpoint, durable action reservation,
production native resume and guest shell/files/screenshot are real. The required
current permission callback is supplied by the private host: initial parking in
`prompt`, checkpoint resume in `auto`, and restart verification in `accept-edits`.
Only the authenticated action applies its `prompt` ceiling; no real user mode
or ordinary operator default is changed. This does not claim an external
channel account verification.

An action receipt proves application of the answer, not arbitrary tool success.
The Podman guest is a Linux container with a shared kernel, not a full VM.
Chromium's internal browser sandbox and Podman cgroup quotas remain disabled as
documented in the local computer deployment notes. Unrelated user processes,
containers and the machine's default connection were preserved.
