# Windows background jobs

## Root cause

On Windows `findCommandShell` has no shell path (Node's platform shell, cmd). The foreground `bash` tool handled that with `spawn(command, {shell: true})`; the background job registry spawned `shell.file ?? '/bin/sh'` with `-c`, which is ENOENT on Windows. The `error` handler only set a flag and `close` finalised the job as `exited` with no exit code and no message, so every background job ended a few ms after "Started background job" with no output.

## Fix

- One spawn, `spawnHostShell` (`packages/sdk/src/tools/command-shell.ts`), used by the foreground tool, the job registry and plugin hooks.
- A job that cannot start records `error`, writes it to stderr, and `bash` answers "Could not start the command: ..." instead of "Started".
- Windows output is decoded as UTF-8 first, then the console's OEM code page.
- Trial finding (case 7): cmd converts its command line to the OEM page before running it, so `ğ`/`ş` became `g`/`s` before any byte was written, and `chcp` inside the same line is too late. The command now travels in an environment variable to an inner cmd started after `chcp 65001` (delayed expansion `!VAR!` in the outer cmd keeps quotes and `&|>` inert there).
- Trial finding (case 6b): a missing working directory was reported as `spawn ...cmd.exe ENOENT`; it now says "the working directory does not exist: <dir>".
- POSIX paths are unchanged.

## Before / after (Windows node v22.20.0, fresh directory per case)

| Case | Before (installed SDK) | After (scratch build of this change) |
|---|---|---|
| 1 `ping -n 6` | exits in 5 ms, no output | 5.1 s, exit 0, output streamed |
| 2 cmd `for /l` loop | exits in 2 ms, no output | 10.2 s, exit 0, 5 lines streamed |
| 3 redirect to `bg-demo.txt` | exits in 2 ms, file never created | 3.1 s, exit 0, file has 3 lines |
| 4 PowerShell `Start-Sleep` | exits in 5 ms, no output | 3.2 s, exit 0, `tick 1..3` |
| 5 `ping -n 60` then kill | already exited, never ran | running at 3 s, 1 `ping.exe`; after kill `killed`, 0 `ping.exe` |
| 6a nonexistent exe | exits, no message | exit 1 with cmd's "not recognized" text |
| 6b bad working directory | exits, no message | `error`: "the working directory does not exist: <dir>" (earlier build said `spawn ...cmd.exe ENOENT`) |
| 7 `echo çğıöşü` | exits, no output | `çğıöşü` (earlier build: `çgıösü`) |
| 8 quoting `"a & b"`, `%%`, `!x!`, `^&` | no output | identical to plain `spawn(shell:true)` |
| 9 `exit /b 7` | no output | exit code 7, identical to plain spawn |
| 10 pipe, `findstr`, redirect | no output | identical to plain spawn |
| 11 `%COMSPEC% %NOPE% %CD%` | no output | identical to plain spawn |

Cases 8-11 are differential: the trial runs the same line through `spawnSync(command, {shell: true})` and records `sameAsDirect`.

## Rerun

Build the SDK to a scratch directory and run with Windows node from a fresh temp directory (never the installed app):

```
tsc -p packages/sdk --outDir <scratch>/sdk-dist --composite false --incremental false
node trial.mjs <label> <path-to-sdk-dist>/index.js <fresh-output-dir>
```

The SDK's runtime dependencies must be resolvable from the dist (copy a `node_modules` with symlinks resolved; Windows node cannot follow WSL symlinks). `receipt-<label>.json` is written to the output directory. `receipt-before.json` was taken against the installed SDK, `receipt-after.json` against the build described here.

## Delayed-expansion parity (main session, Windows node)

`bang-parity.cjs` runs eight lines through plain `spawn(line, { shell: true })` and through the UTF-8 wrapper and compares output and exit code: `echo hello!`, `echo a!b!c`, `echo caret^^ and ^& amp`, `echo %ComSpec:~0,3%`, `echo "quoted!" & echo second`, `echo 100%% done!`, `git --version 2>nul & echo bang! done`, `echo !PATH:~0,3!`. All eight are identical: the outer cmd's delayed expansion only reads the variable, and the inner cmd parses the command exactly as before.
