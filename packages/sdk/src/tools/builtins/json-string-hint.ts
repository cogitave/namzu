/**
 * The advice a tool whose arguments carry raw text gives a model whose call
 * was malformed.
 *
 * A file body, a replacement or a shell command is copied into a JSON string
 * as it stands, and the characters JSON does not allow there unescaped (a
 * newline, a tab, a double quote, a backslash) are what make such a call
 * unreadable. The tool's shape, which is all a validation hint gives, does
 * not say that.
 *
 * @param where - The arguments the text goes into, as the model sees them,
 * e.g. `"content"`.
 */
export function jsonStringEscapes(where: string): string {
	return `Every character of ${where} goes inside a JSON string: write a newline as \\n, a tab as \\t, a double quote as \\" and a backslash as \\\\.`
}
