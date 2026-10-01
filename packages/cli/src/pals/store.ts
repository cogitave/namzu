import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
/** CLI storage adapter; reusable identity, revisions and admission live in the SDK. */
import { DiskPalStore, type PalCreate, type PalDefinition, type PalUpdate } from '@namzu/sdk'
import { restrictToOwner } from '../integrations/providers/credential-store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { trustDir } from '../integrations/trust/store.js'

export type Pal = PalDefinition
export type { PalCreate, PalModel, PalUpdate } from '@namzu/sdk'
export { PalConflictError } from '@namzu/sdk'

export function cliPalStore(home?: string): DiskPalStore {
	const root = resolve(home ?? resolveNamzuHome())
	return new DiskPalStore({
		root: join(root, 'pals'),
		workspaceRoot: join(dirname(root), `${basename(root)}-workspaces`, 'pals'),
		secureDirectory: restrictToOwner,
	})
}
export function getCliPalStore(): DiskPalStore {
	return cliPalStore()
}
export function getPal(id: string, home?: string): Pal | null {
	return cliPalStore(home).get(id)
}
export function getPalRevision(id: string, revision: number, home?: string): Pal {
	return cliPalStore(home).getRevision(id, revision)
}
export function listPals(home?: string): Pal[] {
	return cliPalStore(home).list()
}
export function createPal(input: PalCreate, home?: string): Pal {
	const pal = cliPalStore(home).create(input)
	// The create action authorizes only this newly allocated, empty control directory.
	trustDir(pal.workspace)
	return pal
}
export function updatePal(
	id: string,
	expectedRevision: number,
	changes: PalUpdate,
	home?: string,
): Pal {
	return cliPalStore(home).update(id, expectedRevision, changes)
}
function reserved(path: string, root: string): boolean {
	const rel = relative(root, path)
	return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
export function palAtWorkspace(cwd: string, home?: string): Pal | null {
	const root = resolve(home ?? resolveNamzuHome())
	const workspaceRoot = join(dirname(root), `${basename(root)}-workspaces`, 'pals')
	const lexical = resolve(cwd)
	const lexicalReserved = reserved(lexical, workspaceRoot)
	let canonical: string
	try {
		canonical = realpathSync(lexical)
	} catch (error) {
		if (!lexicalReserved && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
	if (!lexicalReserved && !reserved(canonical, workspaceRoot)) return null
	return cliPalStore(home).atWorkspace(cwd)
}
