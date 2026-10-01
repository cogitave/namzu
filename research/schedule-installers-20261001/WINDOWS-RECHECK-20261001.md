# Native Windows recheck — 2026-10-01

Tested source: `632b896562ea8af3877d67063b83cff83f19c520` in
`namzu-wt-schedule-ownership`. No production source was changed during this
recheck. Historical receipts were retained.

## Environment

Read-only discovery ran inside native Windows PowerShell, from `C:\`:

```json
{
  "platform": "Windows",
  "powerShellVersion": "5.1.19041.7725",
  "executionPolicy": "Restricted",
  "cwd": "C:\\",
  "nodeVersion": "v22.20.0",
  "npmCommandPromptVersion": "11.6.1",
  "npmCommandPromptExitCode": 0,
  "bareNpmResolvedName": "npm.ps1"
}
```

The npm version was read through native `cmd.exe /d /c npm.cmd --version`.
PowerShell returned informational module-initialization progress on stderr;
the discovery process exited successfully. No execution policy, persisted
configuration, account or credential was changed.

## Executed checks

| Check | Result | Boundary exercised |
|---|---|---|
| `node --test scripts/__tests__/install-powershell.test.mjs` | 5 passed, 0 failed, 0 skipped | Native PowerShell 5.1 with Restricted policy; installer source executes against process-local command mocks. |
| `node --import tsx research/schedule-installers-20261001/native-resume-proof.mjs` | Exit 0 | Generated PowerShell Resume command; literal arguments and failed-directory-change guard. |
| Native CMD `npm.cmd --version` | Exit 0, version 11.6.1 | The installed npm batch shim is callable from Command Prompt. |

Both existing proof wrappers select `/mnt/c` as the native process working
directory when launched from WSL. The Linux-only repository directory therefore
does not become an inherited Windows working directory.

### Installer output

```text
PASS PowerShell installer uses .cmd shims under Restricted policy
PASS PowerShell installer rejects a Node 22 release below the CLI minimum
PASS PowerShell installer still reports a failed native npm command
PASS PowerShell installer refuses failed version verification even with stdout
PASS PowerShell installer refuses an empty successful version answer
tests 5; pass 5; fail 0; cancelled 0; skipped 0; todo 0
```

The successful-install scenario suppresses successful npm stderr chatter. The
failure scenario preserves the mocked native npm failure message and exit 42.
Failed or empty `namzu.cmd --version` answers do not produce an installed claim.

### Native Resume output

```json
{
  "platform": "Windows PowerShell 5.1",
  "installedNamzuInvoked": false,
  "literalArguments": true,
  "guardedDirectoryChange": true,
  "status": 0
}
```

The argument proof includes spaces, an apostrophe, brackets and literal `$()`
text. An unsuccessful `Set-Location -LiteralPath` does not invoke Resume.

## Reviewed shim cases

Reviewed `packages/cli/src/resume-invocation.ts` and its direct test source.
Recognition requires the fixed npm Node batch-wrapper structure and a canonical
target matching the running CLI. Existing tests cover prefixes with spaces,
linked targets, conflicting earlier installations, unreadable or inaccessible
earlier shims, missing targets, target-looking comments, extra batch commands,
expanded or drive-dependent targets, relative PATH entries and source-loader
fallback. These direct tests use filesystem fixtures; they were reviewed, not
rerun as native Windows tests in this recheck.

No new production blocker was identified within these checks.

## Native Windows scheduler and real batch forwarding

The additional [proof entry](native-schedule-proof.mjs) imports the actual
production scheduler builder, policy compiler, job store, SDK schedule tool and
Resume formatters. The [preparation script](prepare-native-schedule-proof.mjs)
bundles those modules using dependencies already installed in this worktree;
it does not install a package. Native Windows Node executes the bundle and
asserts `process.platform === 'win32'` before it creates fixtures.

The [receipt](native-schedule-receipt.json) records exit 0 with Node v22.20.0.
The private fixture root is
`C:\Users\Arda\AppData\Local\Temp\namzu-native-schedule-Lk4NiX`.

| Check | Result |
|---|---|
| New agent job defaults | Token budget `0`, 50 iterations, 30-minute run timeout, 10-minute provider wait. |
| Explicit limits | Configured 75,000 and explicit 25,000 remain finite; explicit `0` overrides a configured finite budget. |
| Invalid budgets | Negative, fractional, non-finite and unsafe integer values are refused. |
| Windows filesystem storage | Create/read/update round trip retains the budget; changing it invalidates confirmation and reconfirming restores validity. |
| Confirmation preview | Reports no token limit and no daily token limit without a zero allowance or low-budget warning. |
| SDK schedule tool | Schema accepts `0` and execution forwards it to the fake schedule host unchanged. |
| npm shim recognition | The fixed npm-shaped batch wrapper targets the same private fixture installation. |
| Real CMD batch invocation | `cmd.exe` invokes the private `.cmd` wrapper and preserves a path containing spaces and brackets. |
| Real PowerShell-to-batch invocation | The production Resume formatter runs under Restricted policy, reaches the private `.cmd` and preserves its working directory, spaces, apostrophes, brackets and literal `$()` text. |

The `.cmd` fixture forwards to a harmless Node program that reports its actual
arguments and working directory. It does not intercept the batch command with
a PowerShell function. This complements the earlier failed-directory-change
guard proof. No installed Namzu command, provider or service is invoked.

Reproduce with existing worktree dependencies:

```sh
node research/schedule-installers-20261001/prepare-native-schedule-proof.mjs /mnt/c/Users/Arda/AppData/Local/Temp/namzu-native-schedule-20261001/proof.mjs
```

Then in native Windows PowerShell:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\Arda\AppData\Local\Temp\namzu-native-schedule-20261001\proof.mjs'
```

The preparation and native run both returned exit 0. Earlier probe failures
came from an incorrect policy-compiler call and Node's default C-runtime
quoting of a CMD command string in the proof harness. Those harness calls were
corrected before recording the passing receipt; production code did not change.

## Direct worktree CLI attempt

Native Windows Node was also asked to execute the already-built
`packages/cli/dist/bin.js --version` through
`\\wsl.localhost\archlinux\home\arda\workspaces\@cogitave\cogitave\namzu-wt-schedule-ownership`.
It failed with exit 1 and `ERR_MODULE_NOT_FOUND` for `commander` before entering
the CLI. Dependencies in that checkout are Linux pnpm symlinks; this attempt did
not provide a Windows dependency installation. No package was installed to
work around it. This is neither a passing complete CLI test nor evidence that a
normal npm consumer installation has the same failure. Its private process
`NAMZU_HOME` was under the Windows temporary directory.

## Limits of this evidence

The installer calls mocked `npm.cmd` and `namzu.cmd`; no real installation was
performed. The Resume proof intercepts a process-local PowerShell function named
`namzu.cmd`, so it verifies PowerShell quoting and directory guarding, rather
than an installed Namzu batch shim's argument forwarding. The additional proof
exercises a real batch fixture using selected bundled production modules; it is
not a complete packaged CLI. These checks do not establish a native Windows
TUI/live-model run, Task Scheduler service execution, browser/Pal environment
isolation, credential discovery on another computer, or a published npm version.
