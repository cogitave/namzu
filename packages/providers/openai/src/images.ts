import { attributionHeaders } from '@namzu/sdk'

/** The image model the ChatGPT plan route serves; not selectable by the caller. */
export const CODEX_IMAGE_MODEL = 'gpt-image-2'

/** Where the ChatGPT plan route lives; the image paths hang off the same base as the Responses calls. */
export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const IMAGE_TURN_HEADER = 'x-codex-image-turn-id'
const ACTIVE_LIMIT_HEADER = 'x-codex-active-limit'
/** Generation takes minutes; this bounds one request, the caller's signal bounds it sooner. */
export const CODEX_IMAGE_TIMEOUT_MS = 10 * 60 * 1000
/** Largest decoded image the client accepts. */
export const CODEX_IMAGE_MAX_BYTES = 32 * 1024 * 1024
/** Limit ids the backend uses for the image quota. */
export const CODEX_IMAGE_LIMIT_IDS: readonly string[] = ['image_gen', 'imagegen_premium']

export interface CodexImagesConfig {
	readonly accessToken: string
	readonly accountId: string
	/** Defaults to the ChatGPT Codex backend. */
	readonly baseURL?: string
	/** Headers added after the standard ones, such as a host's own originator. */
	readonly headers?: Readonly<Record<string, string>>
	readonly fetch?: typeof fetch
	/** Per-request ceiling in milliseconds. */
	readonly timeoutMs?: number
}

export interface CodexImageRequest {
	readonly prompt: string
	readonly transparentBackground?: boolean
	/** `data:` URLs of the images to edit. Present means an edit, absent a new image. */
	readonly images?: readonly string[]
	/** The conversation turn the request belongs to, sent as the per-turn image header. */
	readonly turnId?: string
	readonly signal?: AbortSignal
}

export interface CodexImageResult {
	readonly bytes: Buffer
	readonly mediaType: 'image/png' | 'image/gif'
	readonly requestId?: string
}

export interface CodexImageUsageLimit {
	readonly limitId?: string
	/** Epoch milliseconds when the quota comes back, when the backend said. */
	readonly resetsAt?: number
}

/** A failed image request. `usageLimit` is set when the plan's image quota is spent. */
export class CodexImagesError extends Error {
	readonly status?: number
	readonly usageLimit?: CodexImageUsageLimit
	readonly requestId?: string
	constructor(
		message: string,
		details: { status?: number; usageLimit?: CodexImageUsageLimit; requestId?: string } = {},
	) {
		super(message)
		this.name = 'CodexImagesError'
		if (details.status !== undefined) this.status = details.status
		if (details.usageLimit !== undefined) this.usageLimit = details.usageLimit
		if (details.requestId !== undefined) this.requestId = details.requestId
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

/** The headers every ChatGPT-plan request carries, shared with the Responses client. */
export function codexRequestHeaders(accountId: string): Record<string, string> {
	return {
		...attributionHeaders(),
		'ChatGPT-Account-Id': accountId,
		originator: 'Codex Namzu',
		'User-Agent': 'Codex Namzu/1.0',
	}
}

/** GIF bytes start `GIF87a` or `GIF89a`; everything else the backend sends is a PNG. */
export function sniffImageType(bytes: Buffer): 'image/png' | 'image/gif' {
	const head = bytes.subarray(0, 6).toString('latin1')
	return head === 'GIF87a' || head === 'GIF89a' ? 'image/gif' : 'image/png'
}

function failureFrom(status: number, text: string, headers: Headers): CodexImagesError {
	const requestId = headers.get('x-codex-imagegen-request-id') ?? undefined
	let body: Record<string, unknown> | null = null
	try {
		body = asRecord(JSON.parse(text))
	} catch {
		body = null
	}
	const error = asRecord(body?.error)
	const type = typeof error?.type === 'string' ? error.type : undefined
	const message =
		(typeof error?.message === 'string' && error.message) || text.trim().slice(0, 300) || ''
	if (status === 429 && type === 'usage_limit_reached') {
		const limitId = headers.get(ACTIVE_LIMIT_HEADER) ?? undefined
		const seconds = typeof error?.resets_at === 'number' ? error.resets_at : undefined
		return new CodexImagesError('The image quota of this plan is used up.', {
			status,
			usageLimit: {
				...(limitId ? { limitId } : {}),
				...(seconds !== undefined ? { resetsAt: seconds * 1000 } : {}),
			},
			...(requestId ? { requestId } : {}),
		})
	}
	return new CodexImagesError(`HTTP ${status}${message ? `: ${message}` : ''}`, {
		status,
		...(requestId ? { requestId } : {}),
	})
}

/**
 * Generate or edit one image on the ChatGPT plan route. A request with `images`
 * goes to `images/edits`, one without to `images/generations`; both send the
 * same JSON body and read `data[0].b64_json`.
 */
export async function requestCodexImage(
	config: CodexImagesConfig,
	request: CodexImageRequest,
): Promise<CodexImageResult> {
	const base = (config.baseURL ?? CODEX_DEFAULT_BASE_URL).replace(/\/+$/, '')
	const editing = request.images !== undefined && request.images.length > 0
	const url = `${base}/images/${editing ? 'edits' : 'generations'}`
	const body = {
		prompt: request.prompt,
		model: CODEX_IMAGE_MODEL,
		quality: 'auto',
		size: 'auto',
		background: request.transparentBackground === true ? 'transparent' : 'opaque',
		...(editing ? { images: request.images?.map((image_url) => ({ image_url })) } : {}),
	}
	const timeout = AbortSignal.timeout(config.timeoutMs ?? CODEX_IMAGE_TIMEOUT_MS)
	const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
	const doFetch = config.fetch ?? fetch
	let response: Response
	try {
		response = await doFetch(url, {
			method: 'POST',
			signal,
			headers: {
				...codexRequestHeaders(config.accountId),
				...(config.headers ?? {}),
				Authorization: `Bearer ${config.accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
				...(request.turnId ? { [IMAGE_TURN_HEADER]: request.turnId } : {}),
			},
			body: JSON.stringify(body),
		})
	} catch (error) {
		if (request.signal?.aborted) throw request.signal.reason ?? error
		if (timeout.aborted) throw new CodexImagesError('The image request timed out.')
		throw new CodexImagesError(
			`The image request could not be sent: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const text = await response.text()
	if (!response.ok) throw failureFrom(response.status, text, response.headers)
	const requestId = response.headers.get('x-codex-imagegen-request-id') ?? undefined
	let parsed: Record<string, unknown> | null = null
	try {
		parsed = asRecord(JSON.parse(text))
	} catch {
		throw new CodexImagesError('The image response could not be read.', { requestId })
	}
	const first = Array.isArray(parsed?.data) ? asRecord(parsed.data[0]) : null
	const encoded = typeof first?.b64_json === 'string' ? first.b64_json : ''
	if (encoded === '') throw new CodexImagesError('The image service returned no image data.')
	// Base64 inflates by 4/3; refuse before decoding what could not fit.
	if (Math.ceil(encoded.length * 0.75) > CODEX_IMAGE_MAX_BYTES + 3)
		throw new CodexImagesError('The generated image is larger than 32 MiB and was not kept.')
	const bytes = Buffer.from(encoded, 'base64')
	if (bytes.length === 0) throw new CodexImagesError('The image service returned no image data.')
	if (bytes.length > CODEX_IMAGE_MAX_BYTES)
		throw new CodexImagesError('The generated image is larger than 32 MiB and was not kept.')
	return {
		bytes,
		mediaType: sniffImageType(bytes),
		...(requestId ? { requestId } : {}),
	}
}
