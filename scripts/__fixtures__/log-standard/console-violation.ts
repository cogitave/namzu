// Deliberately-violating fixture for the console.* allowlist rule
// (checkConsoleAllowlist in scripts/check-log-standard.mjs). This directory
// is excluded from the real gate's own walk — packages/*/src is the only
// scope it ever scans — so this file is only ever read by
// scripts/__tests__/check-log-standard.test.ts, which loads its text
// directly and feeds it to the check function as a synthetic file entry
// against an allowlist that does not mention it.
export function reportStartupFailure(err: unknown): void {
	console.error('startup failed', err)
}
