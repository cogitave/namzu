/** Keep the privileged preload restricted to one host-selected renderer page. */
export function selectRendererPage(options: {
	isPackaged: boolean
	productionPage: string
	developmentUrl?: string
}): string {
	if (options.isPackaged || options.developmentUrl === undefined) return options.productionPage
	let candidate: URL
	try {
		candidate = new URL(options.developmentUrl)
	} catch {
		throw new Error('The desktop development URL must be an HTTP loopback root page.')
	}
	const port = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/?$/.exec(
		options.developmentUrl,
	)?.[1]
	if (
		candidate.protocol !== 'http:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname) ||
		!port ||
		Number(port) < 1 ||
		candidate.username ||
		candidate.password ||
		candidate.pathname !== '/' ||
		candidate.search ||
		candidate.hash
	)
		throw new Error('The desktop development URL must be an HTTP loopback root page.')
	return candidate.href
}
