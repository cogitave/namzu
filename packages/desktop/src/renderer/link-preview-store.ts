/**
 * Loads and remembers link cards. A card stays closed until a reader asks for
 * it, and appears once, complete: page details, share image and site icon are
 * awaited together so nothing shifts after the reveal.
 */
import { useEffect, useState } from 'react'
import { type LinkPreviewDetails, parseLinkPreview } from './link-preview-parse.js'

export type LinkPreviewResult =
	| { status: 'ready'; details: LinkPreviewDetails; image?: string; icon?: string }
	| { status: 'unavailable' }

type LinkPreviewApi = Pick<NonNullable<Window['namzu']>, 'linkPreview' | 'linkPreviewImage'>
type Parse = (head: string, pageUrl: string) => LinkPreviewDetails

export const LINK_PREVIEW_CACHE_LIMIT = 200
const unavailable: LinkPreviewResult = { status: 'unavailable' }
const cache = new Map<string, Promise<LinkPreviewResult>>()
// Settled results, readable during render: a card reopened for a known link
// shows its details at once instead of flashing the placeholder.
const settled = new Map<string, LinkPreviewResult>()

export function clearLinkPreviewCache(): void {
	cache.clear()
	settled.clear()
}

export function settledLinkPreview(url: string): LinkPreviewResult | undefined {
	return cache.has(url) ? settled.get(url) : undefined
}

async function load(
	url: string,
	api: LinkPreviewApi | undefined,
	parse: Parse,
): Promise<LinkPreviewResult> {
	if (!api?.linkPreview) return unavailable
	const page = await api.linkPreview(url).catch(() => null)
	if (!page) return unavailable
	const details = parse(page.head, page.url)
	const fetchImage = async (target: string | undefined, kind: 'image' | 'icon') => {
		if (!target || !api.linkPreviewImage) return undefined
		try {
			return (await api.linkPreviewImage(target, kind)) ?? undefined
		} catch {
			return undefined
		}
	}
	const [image, icon] = await Promise.all([
		fetchImage(details.imageUrl, 'image'),
		fetchImage(details.iconUrl, 'icon'),
	])
	const result: LinkPreviewResult = { status: 'ready', details }
	if (image) result.image = image
	if (icon) result.icon = icon
	return result
}

export function loadLinkPreview(
	url: string,
	api: LinkPreviewApi | undefined = typeof window === 'undefined' ? undefined : window.namzu,
	parse: Parse = parseLinkPreview,
): Promise<LinkPreviewResult> {
	const cached = cache.get(url)
	if (cached) {
		// Re-insert so the least recently used entry is the one evicted.
		cache.delete(url)
		cache.set(url, cached)
		return cached
	}
	const pending = load(url, api, parse)
	cache.set(url, pending)
	pending.then(
		(result) => {
			if (cache.get(url) === pending) settled.set(url, result)
		},
		// A failed load must not stay remembered.
		() => {
			if (cache.get(url) === pending) cache.delete(url)
		},
	)
	while (cache.size > LINK_PREVIEW_CACHE_LIMIT) {
		const oldest = cache.keys().next().value
		if (oldest === undefined) break
		cache.delete(oldest)
		settled.delete(oldest)
	}
	return pending
}

export interface LinkPreviewState {
	phase: 'idle' | 'loading' | 'ready' | 'unavailable'
	result?: LinkPreviewResult
}

export function useLinkPreview(url: string | undefined): LinkPreviewState {
	const [loaded, setLoaded] = useState<{ url: string; result: LinkPreviewResult } | null>(null)
	useEffect(() => {
		if (!url) return
		let current = true
		loadLinkPreview(url).then(
			(result) => {
				if (current) setLoaded({ url, result })
			},
			() => {
				if (current) setLoaded({ url, result: unavailable })
			},
		)
		return () => {
			current = false
		}
	}, [url])
	if (!url) return { phase: 'idle' }
	const result = loaded?.url === url ? loaded.result : settledLinkPreview(url)
	if (!result) return { phase: 'loading' }
	return { phase: result.status, result }
}
