/**
 * A tool server's request for structured input, put to the person through the
 * same question card the model's own questions use.
 *
 * The server sends a flat form (strings, numbers, yes/no, one or several
 * choices). Each field becomes one question; what the person answers is read
 * back against the field's own limits, and a value that does not fit is asked
 * again with the reason, so the server only ever receives what its schema
 * allows. Declining or closing the card answers the server with that choice,
 * never with partial values.
 */

import type { MCPElicitationRequest, MCPElicitationResult } from '@namzu/sdk'
import type { QuestionAnswer, QuestionFn, UserQuestion } from '../../tui/agent.js'

type Item = NonNullable<UserQuestion['questions']>[number]
type Value = string | number | boolean | readonly string[]

/** More fields than the card can sensibly show at once are declined, not truncated. */
export const MAX_ELICITATION_FIELDS = 8

type Choice = { readonly value: string; readonly label: string }

type Field = {
	readonly key: string
	readonly title: string
	readonly description: string | undefined
	readonly required: boolean
	readonly kind: 'text' | 'number' | 'choice' | 'multi' | 'boolean'
	readonly choices: readonly Choice[]
	readonly schema: Record<string, unknown>
}

function plain(text: string): string {
	let out = ''
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0
		out += code === 10 || (code >= 32 && code !== 127 && !(code >= 128 && code < 160)) ? ch : ' '
	}
	return out.trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

function choicesOf(schema: Record<string, unknown>): readonly Choice[] | undefined {
	const names = Array.isArray(schema.enumNames) ? schema.enumNames : undefined
	if (Array.isArray(schema.enum)) {
		if (!schema.enum.every((v) => typeof v === 'string')) return undefined
		return schema.enum.map((value: string, index) => ({
			value,
			label: plain(typeof names?.[index] === 'string' ? (names[index] as string) : value),
		}))
	}
	const list = Array.isArray(schema.oneOf)
		? schema.oneOf
		: Array.isArray(schema.anyOf)
			? schema.anyOf
			: undefined
	if (!list) return undefined
	const out: Choice[] = []
	for (const entry of list) {
		if (!isRecord(entry) || typeof entry.const !== 'string') return undefined
		out.push({
			value: entry.const,
			label: plain(typeof entry.title === 'string' ? entry.title : entry.const),
		})
	}
	return out
}

/** The fields of a form, or undefined when it holds a shape the card cannot ask. */
export function fieldsOf(request: MCPElicitationRequest): readonly Field[] | undefined {
	const properties = request.requestedSchema.properties
	if (!properties) return undefined
	const keys = Object.keys(properties)
	if (keys.length === 0 || keys.length > MAX_ELICITATION_FIELDS) return undefined
	const required = new Set(request.requestedSchema.required ?? [])
	const fields: Field[] = []
	for (const key of keys) {
		const schema = properties[key]
		if (!isRecord(schema)) return undefined
		const base = {
			key,
			title: plain(typeof schema.title === 'string' ? schema.title : key) || key,
			description: typeof schema.description === 'string' ? plain(schema.description) : undefined,
			required: required.has(key),
			schema,
		}
		if (schema.type === 'boolean') {
			fields.push({ ...base, kind: 'boolean', choices: [] })
		} else if (schema.type === 'number' || schema.type === 'integer') {
			fields.push({ ...base, kind: 'number', choices: [] })
		} else if (schema.type === 'string') {
			const choices = choicesOf(schema)
			if (choices) {
				if (choices.length === 0) return undefined
				fields.push({ ...base, kind: 'choice', choices })
			} else if (schema.enum !== undefined || schema.oneOf !== undefined) {
				return undefined
			} else {
				fields.push({ ...base, kind: 'text', choices: [] })
			}
		} else if (schema.type === 'array' && isRecord(schema.items)) {
			const choices = choicesOf(schema.items)
			if (!choices || choices.length === 0) return undefined
			fields.push({ ...base, kind: 'multi', choices })
		} else {
			return undefined
		}
	}
	return fields
}

function itemFor(field: Field, index: number, lead: string | undefined): Item {
	const detail = field.description ? `: ${field.description}` : ''
	const suffix = field.required ? '' : ' (optional)'
	const text = `${field.title}${detail}${suffix}`
	const options =
		field.kind === 'boolean'
			? [
					{ id: 'yes', label: 'Yes' },
					{ id: 'no', label: 'No' },
				]
			: field.choices.map((choice, position) => ({ id: String(position), label: choice.label }))
	return {
		id: `f${index}`,
		question: lead ? `${lead}\n\n${text}` : text,
		options,
		multiSelect: field.kind === 'multi',
		allowFreeText: field.kind === 'text' || field.kind === 'number',
	}
}

const FORMATS: Readonly<Record<string, RegExp>> = {
	email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	date: /^\d{4}-\d{2}-\d{2}$/,
	'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
}

function validUri(text: string): boolean {
	try {
		new URL(text)
		return true
	} catch {
		return false
	}
}

type Read =
	| { readonly ok: true; readonly value: Value | undefined }
	| { readonly ok: false; readonly reason: string }

function read(
	field: Field,
	index: number,
	answers: ReadonlyMap<string, { selected: readonly string[]; text: string }>,
): Read {
	const given = answers.get(`f${index}`)
	const selected = given?.selected ?? []
	const text = given?.text.trim() ?? ''
	const missing = (): Read =>
		field.required
			? { ok: false, reason: `"${field.title}" needs an answer.` }
			: { ok: true, value: undefined }
	switch (field.kind) {
		case 'boolean': {
			if (selected.length === 0) return missing()
			return { ok: true, value: selected[0] === 'yes' }
		}
		case 'choice': {
			const picked = field.choices[Number(selected[0])]
			return picked ? { ok: true, value: picked.value } : missing()
		}
		case 'multi': {
			const values = selected.flatMap((id) => {
				const picked = field.choices[Number(id)]
				return picked ? [picked.value] : []
			})
			if (values.length === 0) return missing()
			const min = typeof field.schema.minItems === 'number' ? field.schema.minItems : 0
			const max =
				typeof field.schema.maxItems === 'number' ? field.schema.maxItems : Number.POSITIVE_INFINITY
			if (values.length < min)
				return { ok: false, reason: `"${field.title}" needs at least ${min} choices.` }
			if (values.length > max)
				return { ok: false, reason: `"${field.title}" allows at most ${max} choices.` }
			return { ok: true, value: values }
		}
		case 'number': {
			if (text === '') return missing()
			const n = Number(text)
			if (!Number.isFinite(n)) return { ok: false, reason: `"${field.title}" must be a number.` }
			if (field.schema.type === 'integer' && !Number.isInteger(n)) {
				return { ok: false, reason: `"${field.title}" must be a whole number.` }
			}
			const { minimum, maximum } = field.schema
			if (typeof minimum === 'number' && n < minimum) {
				return { ok: false, reason: `"${field.title}" must be at least ${minimum}.` }
			}
			if (typeof maximum === 'number' && n > maximum) {
				return { ok: false, reason: `"${field.title}" must be at most ${maximum}.` }
			}
			return { ok: true, value: n }
		}
		default: {
			if (text === '') return missing()
			const { minLength, maxLength, format } = field.schema
			if (typeof minLength === 'number' && text.length < minLength) {
				return { ok: false, reason: `"${field.title}" must be at least ${minLength} characters.` }
			}
			if (typeof maxLength === 'number' && text.length > maxLength) {
				return { ok: false, reason: `"${field.title}" must be at most ${maxLength} characters.` }
			}
			if (typeof format === 'string') {
				const fits = format === 'uri' ? validUri(text) : (FORMATS[format]?.test(text) ?? true)
				if (!fits) return { ok: false, reason: `"${field.title}" must be a valid ${format}.` }
			}
			return { ok: true, value: text }
		}
	}
}

function collect(answer: Extract<QuestionAnswer, { kind: 'answer' }>) {
	const map = new Map<string, { selected: readonly string[]; text: string }>()
	for (const entry of answer.answers ?? []) {
		map.set(entry.questionId, { selected: entry.selectedOptionIds, text: entry.freeText ?? '' })
	}
	return map
}

/**
 * The handler a client takes as `onElicitation`. `ask` is read at the moment a
 * server asks, because who can answer changes from turn to turn; with nobody
 * to ask (a headless run, or between turns) the server is told "decline".
 */
export function elicitThroughQuestions(
	ask: () => QuestionFn | undefined,
): (
	request: MCPElicitationRequest,
	context: { readonly signal: AbortSignal },
) => Promise<MCPElicitationResult> {
	let counter = 0
	return async (request, { signal }) => {
		const fields = fieldsOf(request)
		const answerer = ask()
		if (!fields || !answerer) return { action: 'decline' }
		const lead = `${plain(request.serverName)} asks: ${plain(request.message)}`
		let problem: string | undefined
		for (;;) {
			if (signal.aborted) return { action: 'cancel' }
			const items = fields.map((field, index) =>
				itemFor(field, index, index === 0 ? (problem ? `${problem}\n\n${lead}` : lead) : undefined),
			)
			const first = items[0] as Item
			counter += 1
			const answer = await answerer(
				{
					questionId: `elicitation-${counter}`,
					question: first.question,
					options: first.options,
					multiSelect: first.multiSelect,
					allowFreeText: first.allowFreeText,
					questions: items,
				},
				signal,
			)
			if (signal.aborted) return { action: 'cancel' }
			if (answer.kind === 'abort') return { action: 'cancel' }
			if (answer.kind === 'skip') return { action: 'decline' }
			const given = collect(answer)
			const content: Record<string, Value> = {}
			problem = undefined
			for (const [index, field] of fields.entries()) {
				const result = read(field, index, given)
				if (!result.ok) {
					problem = result.reason
					break
				}
				if (result.value !== undefined) content[field.key] = result.value
			}
			if (problem === undefined) return { action: 'accept', content }
		}
	}
}
