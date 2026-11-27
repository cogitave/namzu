/**
 * A plugin archive over https: downloaded to a file under staging, its sha256
 * checked when the catalog gave one. The zip itself is opened later by the
 * shared zip reader with the plugin limits, so a bomb or a path that climbs out
 * is refused there before anything is written.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { EXIT_DATAERR } from '../../../exit-codes.js'
import { FetchError, type FetchOptions } from './git.js'
import {
	ARCHIVE_DOWNLOAD_MAX_BYTES,
	ARCHIVE_DOWNLOAD_TIMEOUT_MS,
	download,
	isArchiveType,
} from './url.js'

export interface ArchiveDownload {
	readonly file: string
	/** The digest of what arrived, whether or not the catalog gave one. */
	readonly sha256: string
	readonly bytes: number
}

export async function downloadArchive(
	url: string,
	dest: string,
	expectedSha256: string | undefined,
	options: FetchOptions = {},
): Promise<ArchiveDownload> {
	const body = await download(
		{
			url,
			maxBytes: ARCHIVE_DOWNLOAD_MAX_BYTES,
			timeoutMs: ARCHIVE_DOWNLOAD_TIMEOUT_MS,
			acceptType: isArchiveType,
			subject: 'archive',
		},
		options,
	)
	const sha256 = createHash('sha256').update(body).digest('hex')
	if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase())
		throw new FetchError(
			EXIT_DATAERR,
			`The download does not match the digest the marketplace gave for it (expected ${expectedSha256.slice(0, 12)}, got ${sha256.slice(0, 12)}). Nothing was installed.`,
			'digest',
		)
	mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
	writeFileSync(dest, body, { mode: 0o600 })
	return { file: dest, sha256, bytes: body.length }
}
