/**
 * Whether a permission rule carries a secret in its text.
 *
 * A remembered answer can be the exact command line that was run, and that
 * line can hold a password or a token: `curl -u admin:hunter2 …`,
 * `mysql -uroot -psecret`, an `Authorization: Bearer …` header. A rule is
 * written to a file on disk in plain text, so a rule that looks like it holds
 * one is not written; the answer holds for the conversation only.
 *
 * Two kinds of test. The credential shapes the kernel already redacts from its
 * logs (vendor keys, bearer headers, JWTs), and the places a command line puts
 * a password or a token by its arguments. Both err toward not writing: a false
 * match costs one answer that has to be given again next session.
 */

import { LOG_SECRET_PATTERNS } from '@namzu/sdk'

/** The places on a command line that hold a password or a token. */
const ARGUMENT_SHAPES: readonly RegExp[] = [
	// curl -u user:pass, --user=user:pass, wget --http-user/--http-password pairs.
	/(?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=)?["']?[^\s:"'@]+:[^\s"']+/i,
	// mysql -psecret (no space), mysqldump/mysqladmin too.
	/\bmysql(?:dump|admin|sh)?\b.*\s-p[^\s-]\S*/i,
	// sshpass -p secret
	/\bsshpass\b.*\s-p\s*\S+/i,
	// A flag whose name says it carries one: --password x, --api-key=x, --token x, --secret=x.
	/(?:^|\s)--?[\w-]*(?:password|passwd|passphrase|token|secret|api[-_]?key|access[-_]?key|auth[-_]?key)[\w-]*(?:=|\s+)["']?[^\s"'-]\S*/i,
	// key=value forms: password=x, PGPASSWORD=x, token: x.
	/\b[\w-]*(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key)\s*[=:]\s*["']?[^\s"'*]\S*/i,
	// Authorization: Bearer x / Basic x / token x
	/\bauthorization\s*:\s*(?:bearer|basic|token|digest)\s+\S+/i,
	// scheme://user:pass@host
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
]

/** The redaction table without the `g` flag, so `test` keeps no state between calls. */
const CREDENTIAL_SHAPES: readonly RegExp[] = LOG_SECRET_PATTERNS.map(
	([, pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', '')),
)

/**
 * Whether `<tool> <pattern>` looks like it holds a secret. A test that throws
 * counts as a match: the rule is then not written, which is the safe side.
 */
export function ruleLooksSecret(tool: string, pattern: string | undefined): boolean {
	const text = pattern === undefined ? tool : `${tool} ${pattern}`
	try {
		return (
			CREDENTIAL_SHAPES.some((shape) => shape.test(text)) ||
			ARGUMENT_SHAPES.some((shape) => shape.test(text))
		)
	} catch {
		return true
	}
}
