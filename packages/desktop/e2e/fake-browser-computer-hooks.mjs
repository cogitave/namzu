// Module-loader hooks for e2e only: `@namzu/computer-use` keeps everything it exports except the host,
// which is fake-browser-computer.mjs. See cli-entry.mjs.
import { fileURLToPath, pathToFileURL } from "node:url";
const fake = pathToFileURL(
	fileURLToPath(new URL("./fake-browser-computer.mjs", import.meta.url)),
).href;
export async function resolve(specifier, context, next) {
	const resolved = await next(specifier, context);
	if (specifier !== "@namzu/computer-use") return resolved;
	const source = `export * from ${JSON.stringify(resolved.url)};\nexport { SubprocessComputerUseHost } from ${JSON.stringify(fake)};\n`;
	return {
		url: `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
		shortCircuit: true,
	};
}
