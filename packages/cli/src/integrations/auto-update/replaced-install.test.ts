import { describe, expect, it } from 'vitest'

import { installWasReplaced, replacedInstallLine } from './replaced-install.js'

const root = '/opt/prefix/lib/node_modules/@namzu/cli'
const gone = (file: string) =>
	Object.assign(new Error(`Cannot find module '${file}'`), {
		code: 'ERR_MODULE_NOT_FOUND',
		url: `file://${file}`,
	})

describe('recognising an install that was replaced while this process ran', () => {
	it('is true for a missing file of this install when the version on disk differs', () => {
		expect(
			installWasReplaced({
				error: gone(`${root}/dist/chunks/dist-OLD.js`),
				running: '51.3.0',
				packageRoot: root,
				onDisk: '51.3.1',
			}),
		).toBe(true)
	})

	it('is false when the version on disk is the one running: the file is missing for another reason', () => {
		expect(
			installWasReplaced({
				error: gone(`${root}/dist/chunks/dist-OLD.js`),
				running: '51.3.0',
				packageRoot: root,
				onDisk: '51.3.0',
			}),
		).toBe(false)
	})

	it('is false when the manifest cannot be read, so that nothing is claimed it cannot show', () => {
		expect(
			installWasReplaced({
				error: gone(`${root}/dist/chunks/x.js`),
				running: '1.0.0',
				packageRoot: root,
				onDisk: null,
			}),
		).toBe(false)
	})

	it('is false for a file outside this install, however the versions compare', () => {
		expect(
			installWasReplaced({
				error: gone('/home/person/project/plugin.js'),
				running: '51.3.0',
				packageRoot: root,
				onDisk: '51.3.1',
			}),
		).toBe(false)
		expect(
			installWasReplaced({
				error: gone(`${root}-other/dist/x.js`),
				running: '51.3.0',
				packageRoot: root,
				onDisk: '51.3.1',
			}),
		).toBe(false)
	})

	it('is false for errors that are not a failed load of a file', () => {
		for (const error of [
			new Error('boom'),
			undefined,
			'text',
			{ code: 'EACCES', path: `${root}/x` },
		]) {
			expect(
				installWasReplaced({ error, running: '1.0.0', packageRoot: root, onDisk: '2.0.0' }),
			).toBe(false)
		}
	})

	it('reads the file from the message when the error carries no url, and from ENOENT', () => {
		expect(
			installWasReplaced({
				error: Object.assign(new Error(`Cannot find module '${root}/dist/a.js'`), {
					code: 'ERR_MODULE_NOT_FOUND',
				}),
				running: '1.0.0',
				packageRoot: root,
				onDisk: '2.0.0',
			}),
		).toBe(true)
		expect(
			installWasReplaced({
				error: Object.assign(new Error('x'), { code: 'ENOENT', path: `${root}/skills/a.md` }),
				running: '1.0.0',
				packageRoot: root,
				onDisk: '2.0.0',
			}),
		).toBe(true)
	})
})

describe('the line a person reads', () => {
	it('names both versions, says the conversation is saved and what to do, with no path and no stack', () => {
		const line = replacedInstallLine('51.3.0', '51.3.1')
		expect(line).toContain('51.3.1')
		expect(line).toContain('51.3.0')
		expect(line).toMatch(/saved/)
		expect(line).toMatch(/start Namzu again/i)
		expect(line).not.toMatch(/\/|ERR_|at /)
		expect(line.split('\n')).toHaveLength(1)
	})

	it('still reads when the version on disk cannot be read', () => {
		expect(replacedInstallLine('51.3.0', null)).toMatch(/updated/i)
	})
})
