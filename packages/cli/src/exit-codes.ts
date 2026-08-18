/**
 * Sysexits-aligned exit codes for the @namzu/cli binary.
 *
 * Per ses_007 §9 D5 ratification:
 *   0   EXIT_OK             — all checks passed (or no failure produced)
 *   1   EXIT_FAIL           — one or more checks reported `fail`
 *   2   EXIT_NO_CONFIG      — Namzu is not configured in this environment
 *                             (no checks registered, no config file found)
 *   69  EXIT_UNAVAILABLE    — sysexits EX_UNAVAILABLE; something the command
 *                             needed was not there, so it could not ESTABLISH
 *                             what it was asked to report. Distinct from 0 for
 *                             the reason 2 is distinct from 1: a report that
 *                             could not look tells you nothing about the part
 *                             it did look at, and collapsing the two lets
 *                             "healthy" and "did not check" share a number.
 *                             Distinct from 70 because a check that timed out
 *                             on a loaded machine is not a bug in this CLI.
 *
 *                             `namzu eval` spells the same idea `2`
 *                             (`EVAL_EXIT.inconclusive`) and that is not an
 *                             oversight: `doctor` had already spent 2 on "no
 *                             checks registered", and giving one number two
 *                             meanings inside one command is worse than giving
 *                             one meaning two numbers across two.
 *   64  EXIT_USAGE          — sysexits EX_USAGE; the caller's arguments are
 *                             wrong. Distinct from 70 on purpose: 70 says the
 *                             CLI is broken and is worth a bug report, 64 says
 *                             the invocation is, and reporting one as the other
 *                             sends the reader looking in the wrong place.
 *   70  EXIT_INTERNAL_ERROR — sysexits EX_SOFTWARE; internal CLI error
 *   77  EXIT_UNTRUSTED      — sysexits EX_NOPERM; the working directory has
 *                             not been trusted, so a headless run refused to
 *                             start. Its own code because a caller has to be
 *                             able to tell it from 64 (your arguments are
 *                             wrong) and from 1 (the run failed): this one is
 *                             fixed by a human decision about a folder, and
 *                             nothing else is. A caller who cannot tell them
 *                             apart matches on the message string, and then
 *                             the message can never be reworded.
 *   78  EXIT_BAD_CONFIG     — sysexits EX_CONFIG; a config source is present
 *                             and cannot be read or contains a known setting
 *                             with an invalid value, so the run refuses rather
 *                             than silently substituting another setting.
 *                             Distinct from 2 for
 *                             the reason 2 is distinct from 0: "namzu is not
 *                             configured here" and "your configuration is
 *                             unreadable" are fixed by opposite actions, and a
 *                             caller that cannot tell them apart treats a
 *                             broken file as an absent one — which is the
 *                             fail-open this code exists to make visible.
 *                             Distinct from 70 on the same grounds as 64: 70
 *                             says this CLI is broken, 78 says the file is.
 */
export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_NO_CONFIG = 2
export const EXIT_USAGE = 64
export const EXIT_UNAVAILABLE = 69
export const EXIT_INTERNAL_ERROR = 70
export const EXIT_UNTRUSTED = 77
export const EXIT_BAD_CONFIG = 78

export type CliExitCode =
	| typeof EXIT_OK
	| typeof EXIT_FAIL
	| typeof EXIT_NO_CONFIG
	| typeof EXIT_USAGE
	| typeof EXIT_UNAVAILABLE
	| typeof EXIT_INTERNAL_ERROR
	| typeof EXIT_UNTRUSTED
	| typeof EXIT_BAD_CONFIG
