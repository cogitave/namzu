import { describe, expect, it } from 'vitest'

import { parseMarketplaceAddress } from '../marketplace.js'
import {
	gitUrlProblem,
	isBlockedSource,
	isCommitId,
	parseEntrySource,
	parseRemoteAddress,
	refProblem,
	repoPathProblem,
	sourceKey,
} from './source.js'

function source(input: string): unknown {
	const read = parseRemoteAddress(input)
	return read.ok ? read.source : read.message
}

describe('marketplace address parser', () => {
	it('reads the scp-like ssh form first, with a ref', () => {
		expect(source('git@github.com:acme/tools.git')).toEqual({
			source: 'git',
			url: 'git@github.com:acme/tools.git',
		})
		expect(source('deploy@git.example.com:team/tools#v2')).toEqual({
			source: 'git',
			url: 'deploy@git.example.com:team/tools',
			ref: 'v2',
		})
		expect(source('git@host:/srv/repos/tools.git')).toMatchObject({ source: 'git' })
	})

	it('reads https addresses: .git and _git are repositories, known hosts rewrite, others are a catalog file', () => {
		expect(source('https://example.com/team/tools.git')).toEqual({
			source: 'git',
			url: 'https://example.com/team/tools.git',
		})
		expect(source('https://dev.azure.com/org/proj/_git/tools')).toMatchObject({ source: 'git' })
		expect(source('https://github.com/acme/tools')).toEqual({
			source: 'github',
			repo: 'acme/tools',
		})
		expect(source('https://github.com/acme/tools.git#main')).toEqual({
			source: 'github',
			repo: 'acme/tools',
			ref: 'main',
		})
		expect(source('https://gitlab.com/acme/tools')).toEqual({
			source: 'git',
			url: 'https://gitlab.com/acme/tools.git',
		})
		expect(source('https://bitbucket.org/acme/tools/')).toEqual({
			source: 'git',
			url: 'https://bitbucket.org/acme/tools.git',
		})
		expect(source('https://example.com/catalog/marketplace.json')).toEqual({
			source: 'url',
			url: 'https://example.com/catalog/marketplace.json',
		})
	})

	it('reads owner/repo with #ref or @ref', () => {
		expect(source('acme/tools')).toEqual({ source: 'github', repo: 'acme/tools' })
		expect(source('acme/tools#release/1.2')).toEqual({
			source: 'github',
			repo: 'acme/tools',
			ref: 'release/1.2',
		})
		expect(source('acme/tools@v1.0.0')).toEqual({
			source: 'github',
			repo: 'acme/tools',
			ref: 'v1.0.0',
		})
		const sha = 'a'.repeat(40)
		expect(source(`acme/tools#${sha}`)).toMatchObject({ ref: sha })
		expect(source('acme/tools.git')).toEqual({ source: 'github', repo: 'acme/tools' })
	})

	it('refuses with the study’s texts', () => {
		expect(source('nonsense')).toBe(
			'Not a marketplace address. Use owner/repo, an https:// address, or a folder path.',
		)
		expect(source('a/b/c')).toContain('is not a valid GitHub owner/repo shorthand')
		expect(source('a/b/c')).toContain('full https:// address')
		expect(source('https://u:p@example.com/x.git')).toBe(
			'Remove the sign-in details from the address; Namzu uses your own Git setup.',
		)
		expect(source('https://example.com/x.git?token=1')).toContain('sign-in details')
		expect(source('https://github.com/acme/tools/tree/main/x')).toContain('not a page inside it')
		expect(source('https://example.com/m.json#main')).toContain('takes no #ref')
	})

	it('never lets a value pass as an option or a bad ref', () => {
		for (const bad of [
			'-oProxyCommand=x',
			'--upload-pack=x',
			'a b/c',
			'',
			'acme/tools#-x',
			'acme/tools#a..b',
			'acme/tools#x.lock',
			'git@-oProxy:x/y',
		]) {
			expect(typeof source(bad), bad).toBe('string')
		}
		expect(refProblem('main')).toBeUndefined()
		expect(refProblem('feature/x-1')).toBeUndefined()
		expect(refProblem('-x')).toContain('not a branch')
		expect(refProblem('a//b')).toBeDefined()
		expect(repoPathProblem('plugins/ledger')).toBeUndefined()
		for (const bad of [
			'',
			'/abs',
			'../up',
			'a/../b',
			'-x',
			'C:\\x',
			'a\\b',
			'a/./b',
			'~/x',
			'a\u0001b',
		]) {
			expect(repoPathProblem(bad), bad).toBeDefined()
		}
		expect(isCommitId('a'.repeat(40))).toBe(true)
		expect(isCommitId('a'.repeat(64))).toBe(true)
		expect(isCommitId('a'.repeat(39))).toBe(false)
		expect(isCommitId('A'.repeat(40))).toBe(false)
	})

	it('is the same order as the address function: paths first, then remote forms, no disk', () => {
		expect(parseMarketplaceAddress('acme/tools#main', '/w')).toMatchObject({
			kind: 'remote',
			form: 'github',
			source: { source: 'github', repo: 'acme/tools', ref: 'main' },
		})
		expect(parseMarketplaceAddress('./acme/tools', '/w')).toEqual({
			kind: 'path',
			path: '/w/acme/tools',
		})
		expect(parseMarketplaceAddress('~/m', '/w').kind).toBe('path')
		expect(parseMarketplaceAddress('http://a/b.git', '/w').kind).toBe('refused')
		expect(parseMarketplaceAddress('file:///x', '/w').kind).toBe('refused')
		expect(parseMarketplaceAddress('\\\\server\\share', '/w').kind).toBe('refused')
		expect(parseMarketplaceAddress('//server/share', '/w').kind).toBe('refused')
	})
})

describe('git addresses of a catalog', () => {
	it('accepts https, ssh and scp-like, refuses the rest', () => {
		expect(gitUrlProblem('https://example.com/x.git', false)).toBeUndefined()
		expect(gitUrlProblem('ssh://git@example.com/x.git', false)).toBeUndefined()
		expect(gitUrlProblem('git@example.com:x/y.git', false)).toBeUndefined()
		for (const bad of [
			'http://example.com/x.git',
			'ext::sh -c id',
			'file:///tmp/x',
			'/tmp/x',
			'--upload-pack=x',
			'https://u:p@h/x.git',
			'ssh://u:p@h/x',
			'git://h/x.git',
		]) {
			expect(gitUrlProblem(bad, false), bad).toBeDefined()
		}
		expect(gitUrlProblem('ssh://-oProxyCommand=x@h/x', false)).toBeDefined()
		expect(gitUrlProblem('ssh://%2DoProxyCommand=x@h/x', false)).toBeDefined()
		expect(gitUrlProblem('ssh://a%0Ab@h/x', false)).toBeDefined()
		expect(gitUrlProblem('ssh://git@h/x', false)).toBeUndefined()
		expect(gitUrlProblem('file:///tmp/x', true)).toBeUndefined()
		expect(gitUrlProblem('/tmp/x', true)).toBeUndefined()
	})
})

describe('plugin entry sources', () => {
	const read = (source: Record<string, unknown>, entry: Record<string, unknown> = {}) =>
		parseEntrySource('ledger', source, entry)
	const sha = 'b'.repeat(40)

	it('reads github, url, git-subdir and archive, with pins', () => {
		expect(read({ source: 'github', repo: 'acme/ledger', ref: 'v1', sha })).toEqual({
			ok: true,
			source: { kind: 'github', repo: 'acme/ledger', ref: 'v1', sha },
		})
		expect(read({ source: 'url', url: 'https://example.com/l.git' })).toEqual({
			ok: true,
			source: { kind: 'git', url: 'https://example.com/l.git' },
		})
		expect(
			read({
				source: 'git-subdir',
				url: 'git@h:acme/mono.git',
				path: 'plugins/ledger',
				ref: 'main',
			}),
		).toEqual({
			ok: true,
			source: {
				kind: 'git-subdir',
				url: 'git@h:acme/mono.git',
				path: 'plugins/ledger',
				ref: 'main',
			},
		})
		expect(
			read({ source: 'archive', url: 'https://example.com/l.zip', sha256: 'C'.repeat(64) }),
		).toEqual({
			ok: true,
			source: { kind: 'archive', url: 'https://example.com/l.zip', sha256: 'c'.repeat(64) },
		})
	})

	it('refuses npm and command sources and header helpers as not installable, with reasons', () => {
		for (const source of [
			{ source: 'npm', package: 'x' },
			{ source: 'command', command: 'echo' },
		]) {
			const result = read(source)
			expect(result).toMatchObject({ ok: false, unsupported: true })
			expect((result as { reason: string }).reason).toContain('does not install')
		}
		const headers = read(
			{ source: 'archive', url: 'https://example.com/l.zip' },
			{ headersHelper: 'x' },
		)
		expect(headers).toMatchObject({ ok: false, unsupported: true })
		expect((headers as { reason: string }).reason).toContain('helper program')
	})

	it('flags a malformed one as invalid, not unsupported', () => {
		for (const source of [
			{ source: 'github', repo: 'noslash' },
			{ source: 'github', repo: 'a/b', sha: 'short' },
			{ source: 'github', repo: 'a/b', ref: '-x' },
			{ source: 'url', url: 'http://example.com/l.git' },
			{ source: 'url' },
			{ source: 'git-subdir', url: 'https://e.com/m.git', path: '../x' },
			{ source: 'git-subdir', url: 'https://e.com/m.git' },
			{ source: 'archive', url: 'http://example.com/l.zip' },
			{ source: 'archive', url: 'https://example.com/l.zip', sha256: 'abc' },
			{ source: 'archive', url: 'https://u:p@example.com/l.zip' },
		]) {
			expect(read(source), JSON.stringify(source)).toMatchObject({ ok: false, unsupported: false })
		}
	})
})

describe('blocked marketplaces', () => {
	it('compares the normalised address', () => {
		expect(sourceKey({ source: 'github', repo: 'Acme/Tools' })).toBe('github.com/acme/tools')
		expect(sourceKey({ source: 'git', url: 'git@GitHub.com:acme/tools.git' })).toBe(
			'github.com/acme/tools',
		)
		expect(sourceKey({ source: 'git', url: 'https://example.com/a/b.git' })).toBe('example.com/a/b')
		expect(sourceKey({ source: 'directory', path: '/x' })).toBeUndefined()
		const github = { source: 'github', repo: 'acme/tools' }
		expect(isBlockedSource(github, ['acme/tools'])).toBe(true)
		expect(isBlockedSource(github, ['ACME/*'])).toBe(true)
		expect(isBlockedSource(github, ['github.com'])).toBe(true)
		expect(isBlockedSource(github, ['github.com/acme/*'])).toBe(true)
		expect(isBlockedSource(github, ['https://github.com/acme/tools.git'])).toBe(true)
		expect(isBlockedSource(github, ['other/tools', 'github.com/other/*'])).toBe(false)
		expect(isBlockedSource(github, [])).toBe(false)
		// The same repository under another spelling is the same repository.
		for (const url of [
			'ssh://git@github.com/acme/tools.git',
			'https://github.com:443/acme/tools.git',
			'https://www.github.com/acme/tools.git',
			'https://github.com//acme/tools.git',
			'https://GITHUB.com./acme/tools',
			'ssh://git@github.com:22/acme/tools',
			'git@github.com:acme/tools.git',
			'https://github.com/acme/tools.git/',
			'https://github.com/acme/%74ools',
		])
			for (const entry of [
				'acme/tools',
				'github.com/acme/*',
				'github.com',
				'www.github.com/acme/tools',
			])
				expect(isBlockedSource({ source: 'git', url }, [entry]), `${url} vs ${entry}`).toBe(true)
		expect(
			isBlockedSource({ source: 'git', url: 'https://github.com/acme/other' }, ['acme/tools']),
		).toBe(false)
		expect(
			isBlockedSource({ source: 'git', url: 'https://github.com/acme-x/tools' }, ['acme/*']),
		).toBe(false)
		expect(
			isBlockedSource({ source: 'git', url: 'https://notgithub.com/acme/tools' }, ['github.com']),
		).toBe(false)
		expect(sourceKey({ source: 'git', url: 'ssh://git@Example.com:2222//a//b.git/' })).toBe(
			'example.com/a/b',
		)
		expect(isBlockedSource(github, undefined)).toBe(false)
		expect(
			isBlockedSource({ source: 'git', url: 'https://example.com/a/b.git' }, ['example.com']),
		).toBe(true)
		expect(
			isBlockedSource({ source: 'git', url: 'git@git.example.com:a/b.git' }, ['git.example.com/*']),
		).toBe(true)
		// A folder on this computer is never a blocked address.
		expect(isBlockedSource({ source: 'directory', path: '/x' }, ['x'])).toBe(false)
	})
})
