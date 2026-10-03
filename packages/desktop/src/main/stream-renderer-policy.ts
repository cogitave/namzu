import type { Protocol } from 'electron'

const QUERY = 'namzuStreamPort'
function checkedPort(port: number): number {
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
		throw new Error('Invalid local screen stream port.')
	return port
}

/** The native page query conveys a local port, never a stream credential. */
export function withStreamRendererPort(page: string, port: number): string {
	checkedPort(port)
	const url = new URL(page)
	if (url.protocol === 'file:') return page
	if (
		url.protocol !== 'http:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	)
		throw new Error('The stream renderer must use the selected local root page.')
	url.searchParams.set(QUERY, String(port))
	return url.href
}

/** Invalid or repeated query values cannot widen development CSP. */
export function readStreamRendererPort(requestUrl?: string): number | undefined {
	if (!requestUrl) return undefined
	try {
		const url = new URL(requestUrl, 'http://127.0.0.1/')
		if (
			url.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
			url.username ||
			url.password
		)
			return undefined
		const values = url.searchParams.getAll(QUERY)
		if (values.length !== 1 || !/^[1-9][0-9]{0,4}$/.test(values[0] ?? '')) return undefined
		return checkedPort(Number(values[0]))
	} catch {
		return undefined
	}
}

function streamDocument(html: string, port: number): string {
	const meta =
		/(<meta\b[^>]*\bhttp-equiv="Content-Security-Policy"[^>]*\bcontent=")([^"]*)("[^>]*>)/giu
	const entries = [...html.matchAll(meta)]
	if (entries.length !== 1) throw new Error('The bundled renderer must have one document policy.')
	return html.replace(meta, (_match, before: string, policy: string, after: string) => {
		const connections = policy
			.split(';')
			.map((directive) => directive.trim())
			.filter((directive) => /^connect-src(?:\s|$)/u.test(directive))
		if (connections.length !== 1 || !/^connect-src\s+'none'$/u.test(connections[0] ?? ''))
			throw new Error('The bundled renderer connection policy must deny connections by default.')
		const updated = policy.replace(
			/(^|;)(\s*)connect-src\s+'none'(?=\s*(?:;|$))/u,
			`$1$2connect-src ws://127.0.0.1:${port}`,
		)
		return `${before}${updated}${after}`
	})
}

/** Install after app ready on the renderer's session; forward other assets to built-in file handling. */
export function installStreamRendererPolicy(options: {
	readonly protocol: Pick<Protocol, 'handle' | 'unhandle'>
	readonly fetch: (
		request: Request,
		init: { readonly bypassCustomProtocolHandlers: true },
	) => Promise<Response>
	readonly productionPage: string
	readonly port: number
}): () => void {
	const port = checkedPort(options.port)
	const page = new URL(options.productionPage)
	if (
		page.protocol !== 'file:' ||
		page.username ||
		page.password ||
		page.search ||
		page.hash ||
		!page.pathname.endsWith('/index.html')
	)
		throw new Error('The stream policy requires the exact bundled renderer file.')
	options.protocol.handle('file', async (request) => {
		// Explicit bypass is required to avoid recursively calling this interceptor.
		// https://www.electronjs.org/docs/latest/api/net#netfetchinput-init
		const response = await options.fetch(request, { bypassCustomProtocolHandlers: true })
		if (request.url !== page.href || request.method !== 'GET' || !response.ok) return response
		const html = streamDocument(await response.text(), port)
		const headers = new Headers(response.headers)
		headers.set('content-type', 'text/html; charset=utf-8')
		headers.delete('content-length')
		headers.delete('content-encoding')
		return new Response(html, { status: response.status, statusText: response.statusText, headers })
	})
	let installed = true
	return () => {
		if (!installed) return
		options.protocol.unhandle('file')
		installed = false
	}
}
