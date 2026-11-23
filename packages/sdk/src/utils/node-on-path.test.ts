import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSafeEnv } from '../sandbox/provider/local.js'
import { withNodeOnPath } from './node-on-path.js'

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-node-path-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function fakeNode(dir: string, file = 'node'): string {
	mkdirSync(dir, { recursive: true })
	const path = join(dir, file)
	writeFileSync(path, '#!/bin/sh\n')
	chmodSync(path, 0o755)
	return path
}

describe('withNodeOnPath', () => {
	it('appends the running binary directory to the end when no node resolves', () => {
		const runtime = fakeNode(join(root, 'runtime'))
		const user = join(root, 'user-bin')
		mkdirSync(user)
		const env = withNodeOnPath({ PATH: `${user}:/nowhere`, HOME: '/h' }, { execPath: runtime })
		expect(env.PATH).toBe(`${user}:/nowhere:${join(root, 'runtime')}`)
		expect(env.HOME).toBe('/h')
	})

	it('never overrides a node the user already has on PATH', () => {
		const runtime = fakeNode(join(root, 'runtime'))
		const mine = join(root, 'mine')
		fakeNode(mine)
		const before = `${mine}:/usr/bin`
		expect(withNodeOnPath({ PATH: before }, { execPath: runtime }).PATH).toBe(before)
	})

	it('leaves an environment without PATH and an embedded runtime alone', () => {
		const runtime = fakeNode(join(root, 'runtime'))
		expect(withNodeOnPath({ HOME: '/h' }, { execPath: runtime })).toEqual({ HOME: '/h' })
		const embedded = fakeNode(join(root, 'app'), 'electron')
		expect(withNodeOnPath({ PATH: '/usr/bin' }, { execPath: embedded }).PATH).toBe('/usr/bin')
	})

	it('resolves a link to the real directory and does not append twice', () => {
		const env = withNodeOnPath(
			{ PATH: '/usr/bin' },
			{
				execPath: '/opt/link/node',
				realpath: () => '/opt/real/bin/node',
				isExecutable: () => false,
			},
		)
		expect(env.PATH).toBe('/usr/bin:/opt/real/bin')
		expect(
			withNodeOnPath(env, {
				execPath: '/opt/link/node',
				realpath: () => '/opt/real/bin/node',
				isExecutable: () => false,
			}).PATH,
		).toBe('/usr/bin:/opt/real/bin')
	})

	it('keeps the user spelling of the key on Windows and uses its separator', () => {
		const env = withNodeOnPath(
			{ Path: 'C:\\Tools' },
			{
				platform: 'win32',
				execPath: 'C:\\runtime\\node.exe',
				realpath: (file) => file,
				isExecutable: () => false,
			},
		)
		expect(Object.keys(env)).toEqual(['Path'])
		expect(env.Path).toBe('C:\\Tools;C:\\runtime')
	})
})

describe('the sandbox environment', () => {
	it('can run node when the ambient PATH has none', () => {
		const before = process.env.PATH
		process.env.PATH = '/nonexistent-namzu-dir'
		try {
			const path = buildSafeEnv().PATH ?? ''
			const parts = path.split(':')
			expect(parts[0]).toBe('/nonexistent-namzu-dir')
			expect(parts.length).toBe(2)
		} finally {
			if (before !== undefined) process.env.PATH = before
		}
	})
})
