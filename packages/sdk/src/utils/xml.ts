/**
 * Escaping for the XML-ish frames the runtime builds around untrusted content
 * (sub-agent output, advisor output, plugin/MCP tool names and descriptions).
 *
 * These frames are template literals pushed into the model's conversation, so a
 * payload containing a literal closing tag would otherwise splice a forged frame
 * into the transcript. Escaping is applied at render time only — never to values
 * that are also used as lookup keys.
 */

/**
 * Escape a value for use as an XML text node: `&`, `<`, `>`.
 *
 * The ampersand is replaced first, otherwise the `&` introduced by a later
 * replacement would be double-escaped.
 */
export function escapeXmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Escape a value for use inside an XML attribute value: text escaping plus both
 * quote characters, so the value cannot break out of the attribute.
 */
export function escapeXmlAttr(value: string): string {
	return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
