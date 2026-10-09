// Module-loader hooks for e2e only: `@namzu/sandbox` resolves to a provider whose computer is a
// recorder (no container engine, no display). See cli-entry.mjs.
const fake = (real) => `
export * from ${JSON.stringify(real)};
export function createLocalVirtualComputerProvider() {
	let generation = 0;
	return {
		probe: async () => ({ ready: true }),
		acquire: async (request) => {
			generation += 1;
			const sandbox = {
				id: 'e2e-guest-' + generation,
				status: 'ready',
				rootDir: '/home/namzu/workspace',
				environment: 'linux-namespace',
				readFile: async () => Buffer.from(''),
				writeFile: async () => {},
				listFiles: async () => [],
				exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 }),
				destroy: async () => {},
			};
			return {
				palId: request.pal.id,
				environmentId: 'e2e-guest',
				generation,
				sandbox,
				computerUseHost: {
					id: 'e2e-guest-display',
					getDisplayGeometry: async () => ({ width: 1280, height: 800, scaleFactor: 1 }),
					capabilities: { displayServer: 'x11', screenshot: true, mouse: true, keyboard: true, cursorPosition: false, clipboard: false },
					execute: async () => { throw new Error('The e2e guest has no display.'); },
				},
				release: async () => {},
			};
		},
	};
}
`;
export async function resolve(specifier, context, next) {
	const resolved = await next(specifier, context);
	if (specifier !== "@namzu/sandbox") return resolved;
	// Everything the real package exports stays; only the computer provider is replaced.
	return {
		url: `data:text/javascript;base64,${Buffer.from(fake(resolved.url)).toString("base64")}`,
		shortCircuit: true,
	};
}
