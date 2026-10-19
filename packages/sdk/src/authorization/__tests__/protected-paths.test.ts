import { describe, expect, it } from 'vitest'

import { PROTECTED_DIRECTORIES, PROTECTED_FILE_NAMES, isProtectedPath } from '../protected-paths.js'

describe('isProtectedPath', () => {
	it.each([
		'/repo/.git/hooks/pre-commit',
		'.git/config',
		'/repo/.vscode/tasks.json',
		'/repo/.idea/workspace.xml',
		'/repo/.husky/pre-push',
		'/repo/.cargo/config.toml',
		'/repo/.devcontainer/devcontainer.json',
		'/repo/.yarn/releases/yarn.cjs',
		'/repo/.mvn/wrapper/maven-wrapper.properties',
		'/repo/.namzu/agents/reviewer.md',
		'/home/u/.config/git/config',
	])('protects %s', (path) => {
		expect(isProtectedPath(path)).toBe(true)
	})

	it.each(PROTECTED_FILE_NAMES)('protects the file %s wherever it is', (name) => {
		expect(isProtectedPath(`/home/u/project/${name}`)).toBe(true)
	})

	it.each(PROTECTED_DIRECTORIES)('protects anything under %s', (name) => {
		expect(isProtectedPath(`/p/${name}/x/y.txt`)).toBe(true)
	})

	it('matches names case-folded, including the dotless i and the long s', () => {
		expect(isProtectedPath('/repo/.GIT/hooks/post-commit')).toBe(true)
		expect(isProtectedPath('/repo/.g\u0131t/hooks/post-commit')).toBe(true)
		expect(isProtectedPath('/home/u/.BashRC')).toBe(true)
		expect(isProtectedPath('/home/u/.Z\u017fhrc')).toBe(true)
		expect(isProtectedPath('/home/u/.\u017fhrc')).toBe(false)
	})

	it('reads backslash separators, so a Windows spelling is the same path', () => {
		expect(isProtectedPath('C:\\repo\\.git\\hooks\\pre-commit')).toBe(true)
		expect(isProtectedPath('C:\\Users\\u\\.bashrc')).toBe(true)
	})

	it('needs .config and git to be adjacent', () => {
		expect(isProtectedPath('/home/u/.config/gitui/theme.ron')).toBe(false)
		expect(isProtectedPath('/home/u/.config/other/git/x')).toBe(false)
	})

	it('leaves ordinary project files alone', () => {
		for (const path of [
			'/repo/src/index.ts',
			'/repo/README.md',
			'/repo/.github/workflows/ci.yml',
			'/repo/.gitignore',
			'/repo/.gitattributes',
			'/repo/package.json',
			'/repo/.env',
			'/repo/namzu.config.jsonc',
		]) {
			expect(isProtectedPath(path)).toBe(false)
		}
	})

	it('protects the project config file under its own name', () => {
		expect(isProtectedPath('/repo/namzu.config.json')).toBe(true)
		expect(isProtectedPath('/repo/namzu.config.local.json')).toBe(true)
	})
})
