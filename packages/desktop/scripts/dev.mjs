import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const flags = new Set(process.argv.slice(2))
const portText = process.env.NAMZU_DESKTOP_DEV_PORT ?? '5173'
if (
	[...flags].some((flag) => !['--renderer-only', '--check'].includes(flag)) ||
	!/^\d{1,5}$/.test(portText) ||
	Number(portText) < 1 ||
	Number(portText) > 65535
) {
	console.error('Use --renderer-only or --check, and a NAMZU_DESKTOP_DEV_PORT from 1 to 65535.')
	process.exitCode = 1
} else {
	await run()
}

async function run() {
	const children = new Map()
	let server
	let stopping
	const stop = (code = 0) => {
		if (stopping) return stopping
		process.exitCode = code
		stopping = (async () => {
			const active = [...children.entries()]
			for (const [child] of active) child.kill()
			await Promise.allSettled([
				...active.map(([, exited]) => exited),
				server?.close(),
			])
		})()
		return stopping
	}
	const launch = (program, args, env = process.env) => {
		const child = spawn(program, args, { cwd: root, env, stdio: 'inherit' })
		const exited = new Promise((resolve, reject) => {
			child.once('error', reject)
			child.once('close', (code, signal) => resolve({ code, signal }))
		}).finally(() => children.delete(child))
		// A watcher or Electron can fail before its completion is awaited.
		void exited.catch(() => {})
		children.set(child, exited)
		return exited
	}
	process.once('SIGINT', () => void stop(130))
	process.once('SIGTERM', () => void stop(143))
	try {
		// Compile native main/preload once; renderer edits are served directly by
		// Vite. The watcher keeps native output ready for the next app restart.
		const compiler = require.resolve('typescript/bin/tsc')
		const built = await launch(process.execPath, [compiler, '--build'])
		if (built.code !== 0) throw new Error('Desktop native compilation failed.')
		if (!stopping) {
			server = await createServer({
				root,
				server: { host: '127.0.0.1', port: Number(portText), strictPort: true },
			})
			if (stopping) {
				await server.close()
				return
			}
			await server.listen()
			if (stopping) {
				await server.close()
				return
			}
			const url = `http://127.0.0.1:${portText}/`
			console.log(`Namzu renderer ready: ${url}`)
			console.log(`Visual browser preview: ${url}preview`)
			console.log(`Native renderer: NAMZU_DESKTOP_DEV_URL=${url}`)
			process.send?.({ type: 'namzu-desktop-dev-ready', url })
			if (flags.has('--check')) {
				const response = await fetch(url)
				const html = await response.text()
				if (!response.ok || !html.includes('/@vite/client'))
					throw new Error('The local renderer did not serve its development entry.')
				await stop()
			} else {
				void launch(process.execPath, [compiler, '--build', '--watch', '--preserveWatchOutput'])
					.then((result) => {
						if (!stopping) {
							console.error('Desktop native compiler watcher stopped.')
							return stop(result.code || 1)
						}
					})
					.catch((error) => {
						console.error(error.message)
						return stop(1)
					})
				if (!flags.has('--renderer-only')) {
					const env = { ...process.env, NAMZU_DESKTOP_DEV_URL: url }
					delete env.ELECTRON_RUN_AS_NODE
					void launch(electron, ['.'], env)
						.then((result) => stop(result.code ?? 1))
						.catch((error) => {
							console.error(error.message)
							return stop(1)
						})
				}
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		await stop(1)
	}
}
