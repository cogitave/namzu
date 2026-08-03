/**
 * Sysexits-aligned exit codes for the @namzu/cli binary.
 *
 * Per ses_007 §9 D5 ratification:
 *   0   EXIT_OK             — all checks passed (or no failure produced)
 *   1   EXIT_FAIL           — one or more checks reported `fail`
 *   2   EXIT_NO_CONFIG      — Namzu is not configured in this environment
 *                             (no checks registered, no config file found)
 *   64  EXIT_USAGE          — sysexits EX_USAGE; the caller's arguments are
 *                             wrong. Distinct from 70 on purpose: 70 says the
 *                             CLI is broken and is worth a bug report, 64 says
 *                             the invocation is, and reporting one as the other
 *                             sends the reader looking in the wrong place.
 *   70  EXIT_INTERNAL_ERROR — sysexits EX_SOFTWARE; internal CLI error
 */
export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_NO_CONFIG = 2
export const EXIT_USAGE = 64
export const EXIT_INTERNAL_ERROR = 70

export type CliExitCode =
	| typeof EXIT_OK
	| typeof EXIT_FAIL
	| typeof EXIT_NO_CONFIG
	| typeof EXIT_USAGE
	| typeof EXIT_INTERNAL_ERROR
