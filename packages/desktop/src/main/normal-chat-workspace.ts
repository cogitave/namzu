import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MARKER = '{"version":1,"kind":"namzu-desktop-chat"}\n'
const samePath = (a: string, b: string) =>
	process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

async function checked(directory: string): Promise<void> {
	const entry = await lstat(directory)
	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		!samePath(await realpath(directory), directory)
	)
		throw new Error('The normal chat workspace was redirected. Choose a project instead.')
	const marker = join(directory, '.desktop-chat.json')
	const file = await lstat(marker)
	if (
		!file.isFile() ||
		file.isSymbolicLink() ||
		file.nlink !== 1 ||
		file.size !== Buffer.byteLength(MARKER)
	)
		throw new Error('The normal chat workspace does not belong to this app.')
	if ((await readFile(marker, 'utf8')) !== MARKER)
		throw new Error('The normal chat workspace does not belong to this app.')
}

/** Only this app-created scratch directory can acquire implicit folder trust. */
export async function normalChatWorkspace(userData: string): Promise<string> {
	await mkdir(userData, { recursive: true, mode: 0o700 })
	const directory = join(await realpath(userData), 'chats')
	let created = false
	try {
		await mkdir(directory, { mode: 0o700 })
		created = true
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
			throw error
	}
	if (created)
		await writeFile(join(directory, '.desktop-chat.json'), MARKER, {
			flag: 'wx',
			mode: 0o600,
		})
	await checked(directory)
	return directory
}

/** Restoring a saved path never grants trust to an arbitrary folder or Pal. */
export async function isNormalChatWorkspace(path: string, userData?: string): Promise<boolean> {
	if (!userData) return false
	try {
		const directory = join(await realpath(userData), 'chats')
		if (!samePath(path, directory)) return false
		await checked(directory)
		return true
	} catch {
		return false
	}
}
