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

/**
 * The page with the policy as its first element, before anything the file holds, so no markup in the
 * file (a comment that spells a head tag, an image before the head) can come ahead of it. The parser
 * puts a leading meta into the head it opens for the page. A doctype at the very start stays first so
 * the page keeps its standards mode.
 */
export function outputFrameDocument(html: string): string {
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
	if (doctype) return `${doctype[0]}${META}${html.slice(doctype[0].length)}`
	return `${META}${html}`
}
