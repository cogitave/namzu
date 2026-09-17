/**
 * Textual checks on `../Dockerfile` — NOT a build.
 *
 * Building it (a Debian base pull, `docker build`) is out of reach of this
 * package's normal `pnpm --filter @namzu/sandbox test` tier for the reason
 * `k8s/__tests__/dockerfile.test.ts` gives for the guest image: there is no
 * container runtime in the test environment. `.github/workflows/sandbox-smoke.yml`
 * builds this image on a runner that has one; this file checks the parts a
 * build would NOT catch, because they fail at container START rather than at
 * build time.
 *
 * What it exists for, concretely. `server.mjs` resolves the compiled boundary
 * relative to itself (`DEFAULT_PROXY_MODULE`), which is the image's layout and
 * nothing else. If this Dockerfile copies `dist/egress` somewhere else, the
 * image still builds — `COPY` only cares that the source exists — and the
 * failure arrives when the proxy container starts, inside a sandbox whose only
 * route out is that container. That is the shape of bug worth a test that
 * costs nothing to run.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCKERFILE = readFileSync(join(HERE, '../Dockerfile'), 'utf8')
const ENTRYPOINT = readFileSync(join(HERE, '../server.mjs'), 'utf8')

/** Where the image puts everything, read off the Dockerfile rather than
 * repeated here — a constant that agreed with itself and not with the file
 * would pass this suite and fail in a container. */
const INSTALL_ROOT = '/opt/namzu-egress'

/** The relative module path the entrypoint resolves against its own URL. */
function relativeProxyModule(): string {
	const match = ENTRYPOINT.match(/new URL\('(\.[^']+)',\s*import\.meta\.url\)/)
	expect(match).not.toBeNull()
	return (match as RegExpMatchArray)[1] as string
}

describe('egress-proxy/Dockerfile', () => {
	it('lays the compiled module out where the entrypoint resolves it', () => {
		// `./egress/index.js` beside `server.mjs` — so the image must have the
		// module directory and the entrypoint as siblings under INSTALL_ROOT.
		expect(relativeProxyModule()).toBe('./egress/index.js')
		expect(DOCKERFILE).toContain(`COPY dist/egress ${INSTALL_ROOT}/egress`)
		expect(DOCKERFILE).toContain(`COPY egress-proxy/server.mjs ${INSTALL_ROOT}/server.mjs`)
	})

	it('does not copy the module directory into a nested egress/egress', () => {
		// The failure mode the check above cannot see on its own: copying the
		// PARENT directory would also produce an `egress` entry, one level off.
		expect(DOCKERFILE).not.toMatch(new RegExp(`COPY dist ${INSTALL_ROOT}\\b`))
	})

	it('marks the copied files as ESM, after copying them', () => {
		// `dist/egress/*.js` are ESM, and a `.js` file with no package.json above
		// it is CommonJS to Node — the first `import` in `egress/index.js` would
		// throw "Cannot use import statement outside a module" inside the
		// container. The marker has to be written after the COPY, or the COPY
		// would simply overwrite nothing and the file would not be there yet.
		const markerIndex = DOCKERFILE.indexOf(`${INSTALL_ROOT}/package.json`)
		expect(markerIndex).toBeGreaterThan(-1)
		expect(DOCKERFILE).toContain('printf \'{"type":"module"}\\n\'')
		expect(DOCKERFILE.indexOf('COPY dist/egress')).toBeLessThan(markerIndex)
	})

	it('runs the entrypoint as a non-root user', () => {
		expect(DOCKERFILE).toMatch(/^USER namzu$/m)
		// And the files belong to that user, so a read-only root filesystem does
		// not have to be worked around at run time.
		expect(DOCKERFILE).toContain('chown -R namzu:namzu')
	})

	it('starts the entrypoint the backend expects, on the port it names', () => {
		// `CMD` rather than `ENTRYPOINT` so an operator can replace the command
		// for a diagnostic run without rebuilding. The path and the port are the
		// two values the backend's argv and the sandbox's `HTTP_PROXY` depend on.
		expect(DOCKERFILE).toContain(`CMD ["node", "${INSTALL_ROOT}/server.mjs"]`)
		expect(DOCKERFILE).toContain('EXPOSE 2025')
	})
})
