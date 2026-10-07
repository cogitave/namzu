export const COPY_CODE_PROPERTY = 'data-namzu-copy-code'

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object'
		? (value as Record<string, unknown>)
		: undefined
}

/** Preserve the established Markdown parser's code value before HAST appends LF. */
export function remarkCodeCopy({ source }: { source: string }) {
	return (tree: unknown): void => {
		const remaining: unknown[] = [tree]
		while (remaining.length) {
			const node = record(remaining.pop())
			if (!node) continue
			if (Array.isArray(node.children)) for (const child of node.children) remaining.push(child)
			if (node.type !== 'code' || typeof node.value !== 'string') continue
			const position = record(node.position)
			const start = record(position?.start)?.offset
			const end = record(position?.end)?.offset
			if (
				typeof start !== 'number' ||
				typeof end !== 'number' ||
				!Number.isInteger(start) ||
				!Number.isInteger(end) ||
				start < 0 ||
				end < start ||
				end > source.length
			)
				continue
			const data = record(node.data) ?? {}
			const properties = record(data.hProperties) ?? {}
			node.data = {
				...data,
				hProperties: { ...properties, [COPY_CODE_PROPERTY]: node.value },
			}
		}
	}
}

/** Internal processor metadata only; the code component removes it from DOM props. */
export function markdownCodeCopy(node: unknown): { text: string; language: string } | undefined {
	const children = record(node)?.children
	if (!Array.isArray(children)) return undefined
	const code = children
		.map(record)
		.find((child) => child?.type === 'element' && child.tagName === 'code')
	const properties = record(code?.properties)
	const text = properties?.[COPY_CODE_PROPERTY]
	if (typeof text !== 'string') return undefined
	const classes = properties?.className
	const language =
		(Array.isArray(classes) ? classes : typeof classes === 'string' ? classes.split(/\s+/) : [])
			.find((name): name is string => typeof name === 'string' && name.startsWith('language-'))
			?.slice(9, 73) ?? ''
	return { text, language }
}
