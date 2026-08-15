---
'@namzu/cli': minor
---

Extract the tri-state optional-package probe, and probe all four optional capabilities in `namzu doctor`

`doctor/checks/telemetry.ts`'s resolve-then-import probe — the one that tells a genuinely absent `@namzu/telemetry` apart from one that is installed and throws on load — only ever covered telemetry. `@namzu/sandbox`, `@namzu/files` and `@namzu/computer-use` had no equivalent check, so a sandbox whose native binding failed to load in a container image was invisible to `namzu doctor`: nothing probed it, so nothing could report `fail`.

New in `@namzu/cli`:

- `probeOptionalPackage(specifier): Promise<CapabilityProbe>` — the extracted probe, at `context/capabilities.ts`. Never throws; every resolve/import failure becomes a `CapabilityProbe` value.
- `CapabilityProbe` — `{ state: 'present', specifier, version }` (version read from the nearest `package.json` above the resolved entry file, not through a possibly-restrictive `exports` map), `{ state: 'absent', specifier }`, or `{ state: 'broken', specifier, error }`.
- `NAMZU_OPTIONAL_CAPABILITIES` — the four optional packages namzu runs without: `@namzu/sandbox`, `@namzu/files`, `@namzu/computer-use`, `@namzu/telemetry`.
- `probeCapabilities(): Promise<readonly CapabilityProbe[]>` — probes all four in parallel; never rejects.
- Three new doctor checks — `sandboxInstalledCheck`, `filesInstalledCheck`, `computerUseInstalledCheck` — registered in `builtInDoctorChecks` alongside the existing `telemetryInstalledCheck`, all now built over the same probe.

`describeInstalledPackage` and `telemetryInstalledCheck` keep their exact exported signatures and status mapping; every existing test in `doctor/checks/__tests__/telemetry.test.ts` passes unmodified. A broken optional package still reports doctor status `fail`; an absent one still reports `skipped` and leaves the doctor's exit code at `0` — `builtInDoctorChecks` gaining three checks changes no existing row and cannot move a healthy machine off exit `0`.

One wording change, needed because `describeInstalledPackage` now backs four packages instead of one: a `broken` package's remediation text used to read "...or remove it if you are not using **telemetry**...", regardless of which specifier was actually broken. It now reads "...or remove it if you are not using **it**...". No test asserted the old literal string; a caller matching on it should switch to matching the surrounding sentence instead.

No boot-path emission yet — the boot narrative's `capability` line consumes this probe in a follow-up change.
