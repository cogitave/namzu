/**
 * A connector's tool in the words a person reads: `slack · post`, not the name
 * the model calls it by. Anything that is not a connector tool is returned as
 * it came.
 */
export function connectorToolLabel(name: string): string {
	if (!name.startsWith('mcp__')) return name
	const rest = name.slice('mcp__'.length)
	const split = rest.indexOf('__')
	if (split <= 0 || split + 2 >= rest.length) return name
	return `${rest.slice(0, split)} · ${rest.slice(split + 2)}`
}
