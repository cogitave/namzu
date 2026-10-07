/**
 * Link previews for links in assistant replies.
 *
 * Fetched only after a reader hovers or focuses a link, by the main process,
 * without cookies, from public HTTPS addresses only. The page's own head is
 * handed to the renderer, which parses it in an inert document: no script
 * runs and nothing it names is loaded except through `linkPreviewImage`.
 */

/** The start of a page, up to and including its `</head>`. */
export interface LinkPreviewPage {
	/** Final HTTPS address after validated redirects. */
	url: string
	/** Decoded document prefix, at most 512 KiB of source bytes. */
	head: string
}

/** `image` is a page's share picture; `icon` is its site icon. */
export type LinkPreviewImageKind = 'image' | 'icon'

/** Byte caps the main process enforces before an image reaches the renderer. */
export const LINK_PREVIEW_IMAGE_MAX_BYTES: Record<LinkPreviewImageKind, number> = {
	image: 2 * 1024 * 1024,
	icon: 256 * 1024,
}

export const LINK_PREVIEW_PAGE_MAX_BYTES = 512 * 1024
