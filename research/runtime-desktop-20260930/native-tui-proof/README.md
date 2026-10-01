# Actual native Windows Pal TUI proof

The receipt in `../artifacts/native-pal-tui-receipt.json` was obtained on Windows
Node 22.20.0 with a **real new Windows console**, not redirected stdin/stdout or
an Ink testing harness. `Start-Process` created the owned console;
`AttachConsole` and `WriteConsoleInputW` delivered keyboard events to its recorded
Node PID. `ReadConsoleOutputCharacterW` captured the console buffer.

The production CLI, Ink renderer, Pal admission and existing local Podman guest
were used. `preload.mjs` only taps console writes/TTY metadata and serves a small
local Ollama HTTP fixture. The actual Ollama driver calls that fixture through
a loopback address rewrite. Other network requests are rejected. The fixture
also observes the CLI's same-process runtime during its provider request and
takes a real guest screenshot. The existing Ollama driver has no tool/vision
support; its displayed capability warning is expected. This proves interactive
startup, admission, text completion, durable resume and exit cleanup. It does
not prove a real model operating the computer.

## Reproduce with the existing native consumer fixture

Run these scripts on native Windows. No packages, engines, images or machines
are installed or started by this harness. The existing Podman machine must
already be running, with image `namzu-local-computer:1`. The concrete consumer
fixture used for this receipt was
`C:\Users\Arda\AppData\Local\Temp\namzu-native-consumer-20261002-pal`.

```powershell
$proofRoot = Join-Path $env:TEMP ('ntui-' + [Guid]::NewGuid().ToString('N'))
.\launch.ps1 -ConsumerRoot 'C:\Users\Arda\AppData\Local\Temp\namzu-native-consumer-20261002-pal' -ProofRoot $proofRoot
```

Wait until `startup-console-ready.json` exists and the owned console displays
the composer. It records the actual Node PID and all three TTY flags. Deliver
text and Enter separately; sending text and CR in one batch is interpreted by
Ink as a paste.

```powershell
$ownedPid = (Get-Content (Join-Path $proofRoot 'startup-console-ready.json') | ConvertFrom-Json).pid
[IO.File]::WriteAllText((Join-Path $proofRoot 'input.txt'), 'LOCAL_NATIVE_TUI_MESSAGE')
.\console-control.ps1 -OwnedPid $ownedPid -InputPath (Join-Path $proofRoot 'input.txt') -ResultPath (Join-Path $proofRoot 'startup-screen.json')
[IO.File]::WriteAllText((Join-Path $proofRoot 'enter.txt'), "`r")
.\console-control.ps1 -OwnedPid $ownedPid -InputPath (Join-Path $proofRoot 'enter.txt') -ResultPath (Join-Path $proofRoot 'startup-enter-screen.json')
```

After the reply appears, send `/exit` and Enter as separate calls. The final
`startup-receipt.json` must have `exitCode: 0`. Resume executes the **exact
printed PowerShell command**, with fixture instrumentation injected through
`NODE_OPTIONS`; the command itself is unchanged.

```powershell
.\launch.ps1 -ConsumerRoot 'C:\Users\Arda\AppData\Local\Temp\namzu-native-consumer-20261002-pal' -ProofRoot $proofRoot -Mode resume
```

Use the PID from `resume-console-ready.json`, confirm the prior conversation
is displayed, and send `LOCAL_NATIVE_TUI_RESUMED_MESSAGE`. The provider request
must contain the Pal purpose and both user messages. The receipt's `computer`
must report a live Pal runtime admission and actual guest PNG. Exit again.

Observe only this fixture's owner-labelled resources: SHA-256 of the fixture
Pal ID is `org.namzu.pal.owner`; `podman ps -a --filter label=org.namzu.pal.owner=<hash>`
must be empty after exit. `namzu-pal-data-<hash>` remains as durable Pal data.
The harness leaves that private Pal/volume for inspection. It does not close
other consoles, remove other containers, stop the machine or modify an account.

The first development attempt used an overly strict fixture fetch guard that
blocked the owned guest's loopback health check. Production timed out, returned
69 and cleaned up that allocation. Allowing loopback corrected the harness;
that attempt is not attributed to a production defect or counted as a pass.
