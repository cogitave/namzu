import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * A reply of 130 KB ended the process because the bundle ran React's development build, which keeps
 * a copy of every drawn component's props for ever (memory grew with the square of the reply). The
 * bundle must carry the production build only. The test builds the renderer (Ink, with its React) with the bundle's own options
 * and looks at what is in the text: no clock, no process.
 */
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')

async function bundleReact(define: Record<string, string>): Promise<string> {
	// What the real bundle keeps outside (the optional development tools among it) is kept outside here too.
	const { external } = (await import(
		pathToFileURL(join(pkgDir, 'scripts/externals.mjs')).href
	)) as {
		external: string[]
	}
	const result = await build({
		stdin: {
			contents: "import { render } from 'ink'\nconsole.log(render)\n",
			resolveDir: pkgDir,
		},
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
		logLevel: 'silent',
		external,
		define,
	})
	return result.outputFiles[0]?.text ?? ''
}

// What only the development build holds: the record it keeps of the props of each component drawn.
const DEV_ONLY = 'logComponentRender'

describe('the bundle runs the production build of React', () => {
	it('the bundle options fix NODE_ENV to production', async () => {
		const options = (await import(
			pathToFileURL(join(pkgDir, 'scripts/bundle-options.mjs')).href
		)) as {
			productionDefine: Record<string, string>
		}
		expect(options.productionDefine).toEqual({ 'process.env.NODE_ENV': '"production"' })
	})

	it('has no development code of React in the text of the bundle', async () => {
		const options = (await import(
			pathToFileURL(join(pkgDir, 'scripts/bundle-options.mjs')).href
		)) as {
			productionDefine: Record<string, string>
		}
		expect(await bundleReact(options.productionDefine)).not.toContain(DEV_ONLY)
	})

	it('would have, without the option (the check can fail)', async () => {
		expect(await bundleReact({})).toContain(DEV_ONLY)
	})
})
