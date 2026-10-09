import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as kernel from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	claimPalConversation,
	listPalConversations,
	palConversationBinding,
} from '../../../pals/conversations.js'
import { createPal, deletePal } from '../../../pals/store.js'
import {
	type CliSessions,
	closeSessions,
	loadConversation,
	openSessionScope,
	openSessions,
} from '../store.js'

vi.mock('node:fs/promises', { spy: true })
vi.mock('../../providers/credential-store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../providers/credential-store.js')>()
	// The fixture models Windows path APIs on a POSIX host; privacy still uses
	// this host's real owner-only permissions instead of launching Windows ACLs.
	const restrict = (path: string) => chmodSync(path, 0o700)
	return { ...actual, restrictToOwner: restrict, restrictToOwnerOnce: restrict }
})
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return { ...actual, ensureProject: vi.fn(actual.ensureProject) }
})

let root: string
const nativePlatform = process.platform
const opened: CliSessions[] = []
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-path-spelling-'))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	for (const state of opened.splice(0)) closeSessions(state)
	vi.restoreAllMocks()
	Object.defineProperty(process, 'platform', { value: nativePlatform })
	vi.unstubAllEnvs()
	removeTempDir(root)
})

/** Model native Windows spelling while keeping all project/profile/journal I/O real. */
async function nativeSpelling(
	workspace: string,
	canonical = workspace.replace('state-workspaces', 'STATE-workspaces'),
): Promise<string> {
	const { realpath, lstat } =
		await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
	Object.defineProperty(process, 'platform', { value: 'win32' })
	vi.spyOn(filesystem, 'realpath').mockImplementation(async (path, options) => {
		if (path === workspace || path === canonical) return canonical as never
		return realpath(path, options as never) as never
	})
	vi.spyOn(filesystem, 'lstat').mockImplementation(async (path, options) => {
		return lstat(path === canonical ? workspace : path, options as never) as never
	})
	return canonical
}

function deferred() {
	let resolve = () => {}
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

it('preserves approved Pal journal ownership while the physical project document uses native spelling', async () => {
	const pal = createPal({ name: 'Saved identity', model: null })
	const revisionFile = join(root, 'state', 'pals', pal.id, 'revisions', '1.json')
	const revision = readFileSync(revisionFile, 'utf8')
	const canonical = await nativeSpelling(pal.workspace)
	const id = kernel.generateSessionId()
	const claimed = await claimPalConversation(pal.workspace, pal.id, id)
	expect(claimed).toMatchObject({ palId: pal.id, revision: 1 })
	const state = await openSessions(pal.workspace)
	opened.push(state)
	expect(state.projectRoot).toBe(pal.workspace)
	expect(
		JSON.parse(readFileSync(join(root, 'state', 'projects', state.slug, 'project.json'), 'utf8')),
	).toMatchObject({
		cwd: canonical,
		projectId: state.projectId,
	})
	expect((await palConversationBinding(pal.workspace, id))?.pal).toEqual(pal)
	expect(await loadConversation(state, id)).toEqual([])
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
		expect.objectContaining({ id, count: 0, hasPrompted: false, palGreeting: claimed.palGreeting }),
	])
	const reopened = await openSessionScope(pal.workspace)
	expect(reopened).toMatchObject({
		projectRoot: pal.workspace,
		projectId: state.projectId,
		slug: state.slug,
	})
	expect(readFileSync(revisionFile, 'utf8')).toBe(revision)
})

it('refuses a non-case native alias even when it denotes the same physical Pal directory', async () => {
	const pal = createPal({ name: 'Exact control path' })
	await nativeSpelling(pal.workspace, `${pal.workspace}-short-alias`)
	await expect(openSessionScope(pal.workspace)).rejects.toThrow('workspace identity changed')
})

it.each(['deleted', 'replaced'] as const)(
	'refuses to publish a scope when the Pal is %s during native project preparation',
	async (change) => {
		const pal = createPal({ name: 'Current owner' })
		await nativeSpelling(pal.workspace)
		const entered = deferred()
		const released = deferred()
		const { ensureProject } = await vi.importActual<typeof import('@namzu/sdk')>('@namzu/sdk')
		vi.spyOn(kernel, 'ensureProject').mockImplementation(async (options) => {
			const prepared = await ensureProject(options)
			entered.resolve()
			await released.promise
			return prepared
		})
		const opening = openSessionScope(pal.workspace)
		const refusal = expect(opening).rejects.toThrow(
			/no matching definition|workspace identity changed/,
		)
		await Promise.race([entered.promise, opening])
		if (change === 'deleted') deletePal(pal.id, pal.revision)
		else {
			renameSync(pal.workspace, `${pal.workspace}-retired`)
			mkdirSync(pal.workspace)
		}
		released.resolve()
		await refusal
	},
)
