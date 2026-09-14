import { createHash } from 'node:crypto'
import {
	constants,
	closeSync,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ResidentLearningSource, ResidentLearningState } from '@namzu/sdk'

const PREFIX = 'workspace-file:'
const MAX_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024

/** Resolve only declared local file dependencies; no credentials, network or model calls. */
export function residentLearningSources(
	cwd: string,
	learning?: ResidentLearningState,
): () => readonly ResidentLearningSource[] {
	const keys = [
		...new Set(
			learning?.skills.flatMap((skill) => skill.sources?.map((source) => source.key) ?? []) ?? [],
		),
	]
	return () => {
		const observations: ResidentLearningSource[] = []
		let remaining = MAX_TOTAL_BYTES
		const root = realpathSync(cwd)
		for (const key of keys) {
			if (!key.startsWith(PREFIX)) continue
			const path = key.slice(PREFIX.length)
			// Keys are portable, canonical, workspace-relative paths. No traversal or Windows ADS.
			if (
				!path ||
				path.includes('\\') ||
				path.includes(':') ||
				path.includes('\0') ||
				isAbsolute(path) ||
				path.split('/').some((part) => !part || part === '.' || part === '..')
			)
				continue
			let fd: number | undefined
			try {
				const target = resolve(root, path)
				const actual = realpathSync(target)
				const fromRoot = relative(root, actual)
				if (
					!fromRoot ||
					isAbsolute(fromRoot) ||
					fromRoot === '..' ||
					fromRoot.startsWith(`..${sep}`) ||
					actual !== target
				)
					continue
				fd = openSync(
					target,
					constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
				)
				const before = fstatSync(fd, { bigint: true })
				if (!before.isFile() || before.size > BigInt(MAX_BYTES) || before.size > BigInt(remaining))
					continue
				const size = Number(before.size)
				remaining -= size
				const bytes = Buffer.alloc(size + 1)
				let length = 0
				while (length < bytes.length) {
					const count = readSync(fd, bytes, length, bytes.length - length, length)
					if (!count) break
					length += count
				}
				const after = fstatSync(fd, { bigint: true })
				const current = statSync(target, { bigint: true })
				if (
					length !== size ||
					current.dev !== after.dev ||
					current.ino !== after.ino ||
					after.size !== before.size ||
					after.mtimeNs !== before.mtimeNs ||
					after.ctimeNs !== before.ctimeNs ||
					realpathSync(target) !== actual
				)
					continue
				observations.push({
					key,
					revision: createHash('sha256').update(bytes.subarray(0, size)).digest('hex'),
				})
			} catch {
				/* Missing, changed or unreadable sources remain unverified. */
			} finally {
				if (fd !== undefined) closeSync(fd)
			}
		}
		return observations
	}
}
