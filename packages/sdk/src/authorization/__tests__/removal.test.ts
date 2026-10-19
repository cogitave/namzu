import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { dangerousRemoval } from '../removal.js'
import { readShellLine } from '../shell-paths.js'

const base = mkdtempSync(join(tmpdir(), 'namzu-removal-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const home = join(base, 'home', 'u')
const project = join(home, 'work', 'proj')
const added = join(base, 'elsewhere', 'extra')
mkdirSync(project, { recursive: true })
mkdirSync(added, { recursive: true })

function check(line: string, options: { cd?: boolean; env?: Record<string, string> } = {}) {
	return dangerousRemoval(readShellLine(line, 'bash'), options.cd ?? false, {
		cwd: project,
		additionalDirectories: [added],
		home,
		env: options.env ?? { HOME: home, PATH: '/usr/bin' },
	})
}

describe('a removal that is catastrophic whatever its flags', () => {
	it.each([
		'rm -rf /',
		'rm -fr /',
		'rm -r -f /',
		'rm --recursive --force /',
		'rm -Rf /',
		'rm /',
		'rm -rf -- /',
		'rm -rf /*',
		'rm -rf /usr',
		'rm -rf /etc/',
		'rm -rf /home',
		'rmdir /',
		'sudo rm -rf /',
		'env FOO=1 rm -rf /',
		'/bin/rm -rf /',
		'rm -rf ~',
		'rm -rf ~/',
		'rm -rf ~/*',
		'rm -rf $HOME',
		'rm -rf "${HOME}"',
		'rm -rf "$HOME/"',
		'rm -rf ..',
		'rm -rf ../..',
		'rm -rf .',
		'rm -rf ./',
		'rm -rf *',
		'rm -rf ./*/*',
		'rm -rf work/..',
		'find . -name x -exec rm -rf / ;',
		'echo go && rm -rf /',
		'bash -c "rm -rf /"',
	])('flags %s', (line) => {
		expect(check(line), line).toBeDefined()
	})

	it('flags the working directory by its absolute spelling and by a link to it', () => {
		expect(check(`rm -rf ${project}`)).toBeDefined()
		expect(check(`rm -rf ${join(home, 'work')}`)).toBeDefined()
		const link = join(base, 'link-to-project')
		symlinkSync(project, link)
		expect(check(`rm -rf ${link}`)).toBeDefined()
	})

	it('flags a glob across an added directory but not a plain path to one', () => {
		expect(check(`rm -rf ${added}/*`)).toBeDefined()
		expect(check(`rm -rf ${join(added, 'build')}`)).toBeUndefined()
	})

	it('flags a variable that may be empty in front of a path', () => {
		expect(check('rm -rf "$BUILD/"')).toBeDefined()
		expect(check('rm -rf $BUILD/*')).toBeDefined()
		expect(check('rm -rf "$BUILD"/$SUB')).toBeDefined()
		expect(check('rm -rf $PREFIX/usr')).toBeDefined()
	})

	it('lets a variable already set to something through when it only prefixes a top-level name', () => {
		expect(check('rm -rf $PREFIX/usr', { env: { PREFIX: '/opt/x' } })).toBeUndefined()
	})

	it('flags a recursive removal of the output of a substitution', () => {
		expect(check('rm -rf $(cat list)')).toBeDefined()
		expect(check('rm -rf /home/$(whoami)')).toBeDefined()
	})

	it('flags a relative glob after a cd, which cannot be resolved', () => {
		expect(check('cd build && rm -rf *', { cd: true })).toBeDefined()
	})

	it('flags a parent step after a name under a glob', () => {
		expect(check('rm -rf build/../*')).toBeDefined()
	})

	it('says what it found', () => {
		expect(check('rm -fr /')).toMatch(/^rm \/:/)
		expect(check('rm -rf "$BUILD/"')).toMatch(/\$BUILD is empty/)
	})
})

describe('a removal that is ordinary', () => {
	it.each([
		'rm -rf build',
		'rm -rf ./build',
		'rm -rf build/*',
		'rm -rf dist node_modules',
		'rm file.txt',
		'rm -rf /tmp/namzu-scratch',
		`rm -rf ${project}/out`,
		'rm -rf "$BUILD_DIR"',
		'rm -rf $BUILD_DIR/out',
		'rm -rf src/*/generated',
		'rmdir empty',
		'rm -rf ~/scratch',
		'git rm -rf build',
		'echo rm -rf /',
		'ls -la',
	])('does not flag %s', (line) => {
		expect(check(line), line).toBeUndefined()
	})

	it('does not read rm as an argument of another command', () => {
		expect(check('grep -r rm /')).toBeUndefined()
	})
})
