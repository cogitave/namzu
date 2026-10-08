#!/usr/bin/env bash
# WSL-side runner for the Windows Sandbox clean-machine test.
#   run.sh <v1-installer.exe> <v2-installer.exe> [timeout-minutes]
# Copies the inputs to C:\namzu-sbx, opens the sandbox, waits for out\done.json (real time is fine
# here: this is a script, not a test), copies the receipts to ./results, then closes the sandbox.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
v1="$1"; v2="$2"; limit="${3:-40}"
win="/mnt/c/namzu-sbx"
winpath() { wslpath -w "$1"; }
if tasklist.exe | grep -qi 'WindowsSandbox'; then echo "a sandbox is already running; refusing to start another" >&2; exit 2; fi
rm -rf "$win"; mkdir -p "$win/in/v1" "$win/in/feed" "$win/out"
cp "$v1" "$win/in/v1/"
node.exe "$(winpath "$here/make-feed.mjs")" "$(winpath "$v2")" 0.1.1 'C:\namzu-sbx\in\feed'
mkdir -p "$win/in/probe-main"; cp "$here/probe-main/"* "$win/in/probe-main/"
cp "$here/driver.cjs" "$here/run.ps1" "$here/shot.ps1" "$here/click-dialog.ps1" "$win/in/"
cp "$here/sandbox.wsb" "$win/run.wsb"
close() { taskkill.exe /F /IM WindowsSandbox.exe /IM WindowsSandboxClient.exe /IM WindowsSandboxRemoteSession.exe >/dev/null 2>&1 || true; }
trap close EXIT
echo "opening sandbox at $(date +%T)"
WindowsSandbox.exe 'C:\namzu-sbx\run.wsb' &
start=$(date +%s)
while [ ! -f "$win/out/done.json" ]; do
	[ $(( $(date +%s) - start )) -gt $(( limit * 60 )) ] && { echo "timed out after $limit min" >&2; break; }
	sleep 10
done
mkdir -p "$here/results"; rm -rf "$here/results/last"; cp -r "$win/out" "$here/results/last"
ls "$here/results/last"
