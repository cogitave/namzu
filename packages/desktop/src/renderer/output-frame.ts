/**
 * How a web page a turn wrote is shown without trusting it. The page is data, not part of the app:
 * it runs in a frame with no permissions at all (no scripts, no same-origin access, no top
 * navigation, no forms, no popups), and carries its own policy that lets it fetch nothing from
 * the network. Only what is written in the file itself can be drawn: inline styles and images
 * and fonts embedded as data.
 */

/** The `sandbox` attribute of the frame: empty, which switches every permission off. */
export const OUTPUT_FRAME_SANDBOX = ''

/** What the page may load: nothing, except what its own file embeds. */
export const OUTPUT_FRAME_POLICY =
	"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; base-uri 'none'; form-action 'none'"

const META = `<meta http-equiv="Content-Security-Policy" content="${OUTPUT_FRAME_POLICY}">`

/** The page with the policy placed first in its head, so nothing in the file can run before it. */
export function outputFrameDocument(html: string): string {
	const head = /<head(?:\s[^>]*)?>/i.exec(html)
	if (head)
		return `${html.slice(0, head.index + head[0].length)}${META}${html.slice(head.index + head[0].length)}`
	const root = /<html(?:\s[^>]*)?>/i.exec(html)
	if (root)
		return `${html.slice(0, root.index + root[0].length)}<head>${META}</head>${html.slice(root.index + root[0].length)}`
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
	if (doctype)
		return `${html.slice(0, doctype[0].length)}<head>${META}</head>${html.slice(doctype[0].length)}`
	return `<head>${META}</head>${html}`
}
