import type {
	SessionEvidenceScope,
	SessionTextEvidenceReadResult,
	SessionTextEvidenceSearchResult,
} from '@namzu/sdk'

const integer = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optionalInteger = (value: unknown) => value === undefined || integer(value)
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean'
const boundedString = (value: unknown, max: number): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max

/** Validate the source contract before its data becomes model input or a cached address.
 * Matching scope fields do not authenticate arbitrary text from a custom host source.
 */
export function assertEvidenceOwner(
	scope: SessionEvidenceScope,
	owner: SessionEvidenceScope,
): void {
	if (
		!scope ||
		Object.entries(owner).some(
			([key, value]) => value !== undefined && scope[key as keyof SessionEvidenceScope] !== value,
		)
	)
		throw new Error('Evidence page or source has a different owner.')
}

function assertPage(
	page: { scope: SessionEvidenceScope; scannedBytes: number },
	owner: SessionEvidenceScope,
	remainingBytes: number,
	signal?: AbortSignal,
): void {
	signal?.throwIfAborted()
	if (!page) throw new Error('Evidence page is unavailable.')
	assertEvidenceOwner(page.scope, owner)
	if (!integer(page.scannedBytes) || page.scannedBytes > remainingBytes)
		throw new Error('Evidence page exceeded its retrieval bounds.')
}

function validTextMetadata(page: {
	seq: number
	part: number
	source: string
	retained: string
	byteOffset: number
	characterOffset?: number
	toolName?: string
	isError?: boolean
}): boolean {
	return (
		integer(page.seq) &&
		page.seq > 0 &&
		integer(page.part) &&
		boundedString(page.source, 128) &&
		(page.retained === 'full' || page.retained === 'preview') &&
		integer(page.byteOffset) &&
		optionalInteger(page.characterOffset) &&
		(page.toolName === undefined || typeof page.toolName === 'string') &&
		optionalBoolean(page.isError)
	)
}

export function assertEvidenceSearchPage(
	page: SessionTextEvidenceSearchResult,
	owner: SessionEvidenceScope,
	remainingBytes: number,
	maxMatches: number,
	signal?: AbortSignal,
): void {
	assertPage(page, owner, remainingBytes, signal)
	if (
		!Array.isArray(page.matches) ||
		page.matches.length > maxMatches ||
		!Array.isArray(page.unavailable) ||
		typeof page.incomplete !== 'boolean' ||
		(page.unavailable.length > 0 && !page.incomplete) ||
		!(page.nextCursor === null || boundedString(page.nextCursor, 4096)) ||
		!optionalInteger(page.excludedToolResults) ||
		!optionalInteger(page.excludedSummaries) ||
		page.matches.some(
			(match) =>
				!match ||
				!validTextMetadata(match) ||
				!boundedString(match.address, 8192) ||
				typeof match.excerpt !== 'string' ||
				match.excerpt.length > 512 ||
				!optionalBoolean(match.excerptComplete) ||
				(match.excerptComplete === true && (match.retained !== 'full' || match.byteOffset !== 0)),
		)
	)
		throw new Error('Evidence search page exceeded its retrieval bounds or has invalid metadata.')
}

export function assertEvidenceReadPage(
	page: SessionTextEvidenceReadResult,
	owner: SessionEvidenceScope,
	remainingBytes: number,
	byteOffset: number,
	signal?: AbortSignal,
): void {
	assertPage(page, owner, remainingBytes, signal)
	if (
		!validTextMetadata(page) ||
		typeof page.text !== 'string' ||
		page.text.length > 6000 ||
		page.byteOffset !== byteOffset ||
		!integer(page.totalBytes) ||
		!optionalInteger(page.totalChars)
	)
		throw new Error('Invalid retained evidence read page.')
	const end = byteOffset + Buffer.byteLength(page.text)
	if (
		!integer(end) ||
		end > page.totalBytes ||
		(page.nextByteOffset === null
			? end !== page.totalBytes
			: !integer(page.nextByteOffset) ||
				page.nextByteOffset !== end ||
				end <= byteOffset ||
				end >= page.totalBytes) ||
		(page.totalChars !== undefined &&
			page.characterOffset !== undefined &&
			page.characterOffset + page.text.length > page.totalChars)
	)
		throw new Error('Retained evidence read positions are inconsistent.')
}
