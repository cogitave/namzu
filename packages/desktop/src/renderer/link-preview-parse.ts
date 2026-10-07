/**
 * Turns the head of a linked page into the few details a link card shows.
 * `selectLinkPreview` is pure; `parseLinkPreview` feeds it from an inert
 * document, so no script runs and nothing the page names is loaded.
 */

export interface LinkPreviewTag {
	tag: 'meta' | 'link' | 'title' | 'base'
	/** Attribute names are lower-cased. */
	attrs: Readonly<Record<string, string>>
	text?: string
}

export interface LinkPreviewDetails {
	title?: string
	description?: string
	siteName?: string
	imageUrl?: string
	iconUrl?: string
}

const MAX_TAGS = 400
const MAX_URL = 2048

export function collectHeadTags(doc: Document): LinkPreviewTag[] {
	const tags: LinkPreviewTag[] = []
	const elements = doc.querySelectorAll('meta, link, title, base')
	for (let index = 0; index < elements.length && index < MAX_TAGS; index++) {
		const element = elements[index]
		if (!element) continue
		const attrs: Record<string, string> = {}
		for (const attribute of Array.from(element.attributes))
			attrs[attribute.name.toLowerCase()] = attribute.value
		const tag = element.tagName.toLowerCase() as LinkPreviewTag['tag']
		tags.push(tag === 'title' ? { tag, attrs, text: element.textContent ?? '' } : { tag, attrs })
	}
	return tags
}

function text(value: string | undefined, max: number): string | undefined {
	if (value === undefined) return undefined
	const clean = value.replace(/\s+/g, ' ').trim()
	if (!clean) return undefined
	const chars = Array.from(clean)
	return chars.length > max
		? `${chars
				.slice(0, max - 1)
				.join('')
				.trimEnd()}…`
		: clean
}

function httpsUrl(value: string | undefined, base: string): string | undefined {
	const raw = value?.trim()
	if (!raw) return undefined
	try {
		const url = new URL(raw, base)
		if (url.protocol !== 'https:' || url.username || url.password) return undefined
		return url.href.length > MAX_URL ? undefined : url.href
	} catch {
		return undefined
	}
}

function iconSizeScore(sizes: string | undefined): number {
	// Closest to 32 wins; larger is preferred over smaller by a small margin.
	if (!sizes) return 1000
	let best = 1000
	for (const token of sizes.toLowerCase().split(/\s+/)) {
		// `any` almost always marks a vector icon, which previews never load.
		if (token === 'any') {
			best = Math.min(best, 500)
			continue
		}
		const match = /^(\d+)x(\d+)$/.exec(token)
		if (!match) continue
		const size = Number(match[1])
		best = Math.min(best, size >= 32 ? size - 32 : (32 - size) * 2 + 1)
	}
	return best
}

export function selectLinkPreview(
	tags: readonly LinkPreviewTag[],
	pageUrl: string,
): LinkPreviewDetails {
	const meta = new Map<string, string>()
	for (const tag of tags) {
		if (tag.tag !== 'meta') continue
		const content = tag.attrs.content
		if (content === undefined) continue
		for (const key of [tag.attrs.property, tag.attrs.name]) {
			const name = key?.trim().toLowerCase()
			if (name && !meta.has(name)) meta.set(name, content)
		}
	}
	const first = (...names: string[]): string | undefined => {
		for (const name of names) {
			const value = meta.get(name)
			if (value?.trim()) return value
		}
		return undefined
	}

	const baseHref = tags.find((tag) => tag.tag === 'base' && tag.attrs.href !== undefined)?.attrs
		.href
	const base = httpsUrl(baseHref, pageUrl) ?? pageUrl
	const resolve = (value: string | undefined) => httpsUrl(value, base)

	const titleTag = tags.find((tag) => tag.tag === 'title')
	const links = tags.filter((tag) => tag.tag === 'link')
	const withRel = (rel: string, exclude?: string) =>
		links.filter((tag) => {
			const tokens = (tag.attrs.rel ?? '').toLowerCase().split(/\s+/)
			return tokens.includes(rel) && !(exclude && tokens.includes(exclude))
		})
	const icons = withRel('icon', 'mask-icon').filter((tag) => resolve(tag.attrs.href))
	// Only raster icons can be shown, so a vector icon is the last resort.
	const vector = (tag: LinkPreviewTag) =>
		(tag.attrs.type ?? '').toLowerCase() === 'image/svg+xml' ||
		/\.svgz?(?:[?#]|$)/i.test(tag.attrs.href ?? '')
	const rank = (tag: LinkPreviewTag) => [
		vector(tag) ? 1 : 0,
		iconSizeScore(tag.attrs.sizes),
		(tag.attrs.type ?? '').toLowerCase() === 'image/png' ? 0 : 1,
	]
	const bestIcon = [...icons].sort((a, b) => {
		const ra = rank(a)
		const rb = rank(b)
		return ra.reduce((order, value, index) => order || value - (rb[index] ?? 0), 0)
	})[0]
	const touch = withRel('apple-touch-icon').find((tag) => resolve(tag.attrs.href))
	let iconUrl = resolve(
		(bestIcon && !vector(bestIcon) ? bestIcon : (touch ?? bestIcon))?.attrs.href,
	)
	if (!iconUrl) {
		try {
			iconUrl = httpsUrl('/favicon.ico', new URL(pageUrl).origin)
		} catch {
			iconUrl = undefined
		}
	}

	const details: LinkPreviewDetails = {}
	const title = text(first('og:title', 'twitter:title') ?? titleTag?.text, 200)
	const description = text(first('og:description', 'twitter:description', 'description'), 300)
	const siteName = text(first('og:site_name', 'application-name'), 80)
	const imageUrl = resolve(
		first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
	)
	if (title) details.title = title
	if (description) details.description = description
	if (siteName) details.siteName = siteName
	if (imageUrl) details.imageUrl = imageUrl
	if (iconUrl) details.iconUrl = iconUrl
	return details
}

export function parseLinkPreview(head: string, pageUrl: string): LinkPreviewDetails {
	// DOMParser documents are inert: scripts do not run and resources do not load.
	const doc = new DOMParser().parseFromString(head, 'text/html')
	return selectLinkPreview(collectHeadTags(doc), pageUrl)
}
