/**
 * An allow rule that allows any program is found and named; a rule that names
 * what it runs is left alone. Nothing here changes what a rule matches.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PermissionLayer } from '../../config/load.js'
import { broadAllowRules, broadBashPattern, warnBroadAllowRules } from '../broad-allow.js'

describe('which bash allow patterns allow any program', () => {
	it.each([
		undefined,
		'*',
		' * ',
		':*',
		'python *',
		'python:*',
		'python3*',
		'python',
		'python -c *',
		'python3 -m *',
		'node *',
		'node --eval *',
		'deno *',
		'tsx *',
		'ruby *',
		'perl *',
		'php *',
		'npx *',
		'bunx *',
		'npm run *',
		'pnpm run:*',
		'yarn run *',
		'bash *',
		'bash -c *',
		'sh -c *',
		'zsh:*',
		'env *',
		'env FOO=1 *',
		'env python *',
		'xargs *',
		'sudo *',
		'sudo -n *',
		'timeout *',
		'timeout 30 *',
		'nohup *',
		'/usr/bin/env *',
		'eval *',
		'exec *',
		'ssh *',
		'ssh -o StrictHostKeyChecking=no *',
		'curl *',
		'curl -s *',
		'wget *',
		'kubectl *',
		'kubectl exec *',
		'kubectl delete *',
		'aws *',
		'gcloud *',
		'gsutil *',
		'curl -d $BODY *',
		'DOCKER=1 bash *',
		'curl -X POST *',
		'curl -H x *',
		'curl -o out.txt *',
		'wget -O f *',
		'kubectl -n ns exec *',
		'kubectl --context prod delete *',
	])('flags %s', (pattern) => {
		const found = broadBashPattern(pattern)
		expect(found, String(pattern)).toBeDefined()
		expect(found?.why.length).toBeGreaterThan(0)
		expect(found?.instead.length).toBeGreaterThan(0)
	})

	it.each([
		'git status',
		'git status *',
		'git:*',
		'pnpm test *',
		'pnpm test:*',
		'npm run build',
		'npm run build:*',
		'python scripts/build.py *',
		'python3 -m pytest *',
		'python -m pytest.mark *',
		'node scripts/check.mjs',
		'npx prettier *',
		'bash scripts/deploy.sh *',
		'timeout 30 git status *',
		'timeout -k 5 30 git status *',
		'nice -n 5 git log *',
		'kubectl -n ns get pods *',
		'env FOO=1 git log *',
		'sudo systemctl status *',
		'ssh deploy@host.example.com uptime',
		'ssh deploy@host.example.com *',
		'curl https://api.example.com/*',
		'curl -s https://api.example.com/v1/*',
		'kubectl get *',
		'kubectl -n prod get pods',
		'aws s3 ls *',
		'gcloud compute instances list *',
		'cargo build *',
		'ls *',
		'rm -rf build',
		'sed -i s/a/b/ *',
	])('leaves %s alone', (pattern) => {
		expect(broadBashPattern(pattern), pattern).toBeUndefined()
	})

	it('names a narrower rule that is itself not flagged', () => {
		for (const pattern of ['python *', 'node *', 'npm run *', 'bash -c *', 'curl *', 'kubectl *']) {
			const found = broadBashPattern(pattern)
			const written = /Bash\(([^)]*)\)/.exec(found?.instead ?? '')?.[1]
			if (written !== undefined) expect(broadBashPattern(written), written).toBeUndefined()
		}
	})
})

const layer = (
	source: PermissionLayer['source'],
	path: string,
	permissions: PermissionLayer['permissions'],
): PermissionLayer => ({ source, path, permissions })

describe('reading the permission files', () => {
	it('names the rule, its file and a rule to write instead', () => {
		const found = broadAllowRules([
			layer('project-file', '/work/app/namzu.config.json', {
				bash: { 'python *': 'allow', 'git status *': 'allow', 'node *': 'ask', 'sudo *': 'deny' },
			}),
			layer('local-file', '/work/app/namzu.config.local.json', { bash: 'allow' }),
			layer('managed', '/etc/namzu/managed.json', {
				read: 'allow',
				Bash: { 'bash -c *': 'allow' },
			}),
		])
		expect(found.map((f) => [f.rule, f.source])).toEqual([
			['Bash(python *)', '/work/app/namzu.config.json'],
			['Bash', '/work/app/namzu.config.local.json'],
			['Bash(bash -c *)', '/etc/namzu/managed.json'],
		])
		expect(found[0]?.instead).toContain('scripts/build.py')
	})

	it('finds nothing in a table that names what it runs, or only asks and denies', () => {
		expect(
			broadAllowRules([
				layer('user-file', '/home/u/.namzu/config.yaml', {
					bash: { 'git *': 'allow', '*': 'ask', 'python *': 'deny' },
					web_fetch: 'allow',
				}),
			]),
		).toEqual([])
		expect(broadAllowRules([layer('user-file', '/x', { bash: 'ask' })])).toEqual([])
	})

	it('says each wide rule once and never throws on an unreadable file', () => {
		const warn = vi.fn()
		const read = () => [
			layer('project-file', '/work/once/namzu.config.json', { bash: { 'env *': 'allow' } }),
		]
		warnBroadAllowRules(undefined, { warn }, read)
		warnBroadAllowRules(undefined, { warn }, read)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toContain('Bash(env *)')
		expect(warn.mock.calls[0]?.[0]).toContain('/work/once/namzu.config.json')
		expect(() =>
			warnBroadAllowRules(undefined, { warn }, () => {
				throw new Error('bad yaml')
			}),
		).not.toThrow()
	})
})
