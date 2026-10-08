import { expect, it } from 'vitest'
import { readRuntimeVersions } from './runtime-versions.js'

const files = (entries: Record<string, string>) => (path: string) => {
	const normalized = path.replaceAll('\\', '/')
	const found = entries[normalized]
	if (found === undefined) throw new Error('ENOENT')
	return found
}

it('reads the CLI and the SDK it carries from beside the entry', () => {
	expect(
		readRuntimeVersions(
			'/app/resources/cli/dist/bin.js',
			files({
				'/app/resources/cli/package.json': '{"version":"25.3.0"}',
				'/app/resources/cli/node_modules/@namzu/sdk/package.json': '{"version":"25.2.1"}',
			}),
		),
	).toEqual({ cliVersion: '25.3.0', sdkVersion: '25.2.1' })
})

it('shows only what it can read, and nothing for an odd version string', () => {
	expect(
		readRuntimeVersions('/cli/dist/bin.js', files({ '/cli/package.json': '{"version":"1.0.0"}' })),
	).toEqual({ cliVersion: '1.0.0' })
	expect(
		readRuntimeVersions(
			'/cli/dist/bin.js',
			files({ '/cli/package.json': '{"version":"<script>"}' }),
		),
	).toEqual({})
	expect(readRuntimeVersions(undefined)).toEqual({})
	expect(readRuntimeVersions('/cli/dist/bin.js', () => 'not json')).toEqual({})
})
