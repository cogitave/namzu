---
"@namzu/sdk": minor
"@namzu/cli": minor
"@namzu/sandbox": minor
---

Add optional host-only `PalComputerScreenStream`, `PalEnvironmentLease.screenStream`
and `PalRuntime.computerScreenStream(palId, generation)` for observing an exact
current Pal computer over read-only RFB. Existing providers remain compatible;
providers without the optional capability explicitly refuse live observation.
Keep allocation authorization private in the embedding host and enforce read-only
observation server-side; the stream does not grant operator input authority.

The CLI exposes the owning desktop ACP stream method with geometry and generation
rechecks, and reuses initialized registry roots to avoid repeated Windows ACL
subprocesses while retaining fresh Pal definitions and directory identity checks.
The local computer image adds x11vnc and authenticated binary WebSocket transport.
Rebuild the installed image explicitly and restart the owning computer to enable
live observation; older images retain screenshot/input behavior and advertise no
stream capability. Persistent workspace and browser profile volumes survive.

The guest desktop includes a themed wallpaper, a real dock, Files, terminal and
browser launchers, plus a local browser home page. Normal browser-window closure
keeps the desktop alive; owned profile shutdown retains browser flush ordering.
