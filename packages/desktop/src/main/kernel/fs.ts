import { createReadStream } from 'node:fs'
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'

/**
 * Every file operation the engine store makes goes through this, so a test can make any one
 * of them fail, or stop the world at a chosen operation to stand in for a power cut.
 */
export interface FileSink {
	write(chunk: Uint8Array): Promise<void>
	close(): Promise<void>
}

export interface KernelFs {
	readFile(path: string): Promise<Buffer>
	/** Creates or replaces the file and flushes it to disk. */
	writeFile(path: string, data: Uint8Array | string): Promise<void>
	appendFile(path: string, data: string): Promise<void>
	/** Creates a new file; refuses to open one that exists or a link. */
	openWrite(path: string): Promise<FileSink>
	rename(from: string, to: string): Promise<void>
	/** Removes a file or a whole folder; a missing path is not an error. */
	rm(path: string): Promise<void>
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
	readdir(path: string): Promise<string[]>
	/** Information about the path itself (a link is not followed). Undefined when absent. */
	stat(path: string): Promise<{ type: 'file' | 'directory' | 'other'; size: number } | undefined>
	openRead(path: string): AsyncIterable<Uint8Array>
}

export const nodeFs: KernelFs = {
	readFile: (path) => readFile(path),
	async writeFile(path, data) {
		const handle = await open(path, 'w', 0o644)
		try {
			await handle.writeFile(data)
			await handle.sync()
		} finally {
			await handle.close()
		}
	},
	appendFile: (path, data) => appendFile(path, data),
	async openWrite(path) {
		// 'wx': never open what is already there, and never go through a link.
		const handle = await open(path, 'wx', 0o644)
		return {
			async write(chunk) {
				let offset = 0
				while (offset < chunk.length) {
					const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
					offset += bytesWritten
				}
			},
			async close() {
				try {
					await handle.sync()
				} finally {
					await handle.close()
				}
			},
		}
	},
	rename: (from, to) => rename(from, to),
	rm: (path) => rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }),
	async mkdir(path, options) {
		await mkdir(path, options)
	},
	readdir: (path) => readdir(path),
	async stat(path) {
		try {
			const info = await lstat(path)
			return {
				type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
				size: info.size,
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
			throw error
		}
	},
	openRead: (path) => createReadStream(path),
}
