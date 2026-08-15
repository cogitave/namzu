// Deliberately-violating fixture for the process.std*.write allowlist rule
// (checkStreamWriteAllowlist). Same note as console-violation.ts: read
// directly by the test suite, never by the real gate's directory walk.
export function announce(message: string): void {
	process.stdout.write(`${message}\n`)
}
