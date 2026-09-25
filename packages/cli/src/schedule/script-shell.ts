/** The same diagnostic at creation, confirmation and fire when a chosen interpreter is absent. */
export function scriptShellUnavailableReason(shell: 'bash' | 'sh'): string {
	return `the requested ${shell} shell is not executable on this host; install it or choose an installed shell before confirming this job`
}
