// Compare selected public wire fields with an excerpt of the pinned official schema.
// This is research evidence, not a complete A2A conformance validator.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import {
	buildAgentCard,
	messageToA2A,
	turnStatusToA2AState,
} from '../../packages/sdk/dist/index.js'

const standard = JSON.parse(
	await readFile(new URL('./artifacts/a2a-0.3-contract-excerpt.json', import.meta.url), 'utf8'),
)
const card = buildAgentCard(
	{
		id: 'research-pal',
		name: 'Research Pal',
		version: '1.0.0',
		category: 'research',
		description: 'Local wire comparison; no server is started',
		tools: [],
		defaults: {},
	},
	{ baseUrl: 'https://example.invalid', transport: 'jsonrpc' },
)
const message = messageToA2A({ role: 'user', content: 'Observe the contract' })
const missing = (required, actual) => required.filter((name) => !Object.hasOwn(actual, name))
const mappedStates = ['queued', 'running'].map((state) => ({
	turnState: state,
	emitted: turnStatusToA2AState(state),
	acceptedByPinnedEnum: standard.taskStates.includes(turnStatusToA2AState(state)),
}))
const observation = {
	scope: standard.scope,
	networkCalls: 0,
	modelCalls: 0,
	source: standard.source,
	declaredVersion: card.protocolVersion,
	message: { missingRequired: missing(standard.messageRequired, message) },
	card: {
		missingRequired: missing(standard.cardRequired, card),
		propertiesAbsentFromPinnedSchema: Object.keys(card).filter(
			(name) => !standard.cardPropertyNames.includes(name),
		),
	},
	mappedStates,
}
assert.equal(observation.declaredVersion, standard.version)
assert.deepEqual(observation.message.missingRequired, ['kind', 'messageId'])
assert.deepEqual(observation.card.missingRequired, ['url'])
assert.ok(mappedStates.every((state) => !state.acceptedByPinnedEnum))
await writeFile(
	new URL('./artifacts/a2a-contract-boundary.json', import.meta.url),
	`${JSON.stringify(observation, null, 2)}\n`,
)
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`)
