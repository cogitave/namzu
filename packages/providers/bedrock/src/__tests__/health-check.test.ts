/**
 * The health check can pass, and says which failure it saw.
 *
 * The defect it is written against is not "the check returns false". It is that
 * the check could return NOTHING ELSE: it built its command directly around a
 * hardcoded `anthropic.claude-haiku-4-20250514`, the exact unversioned form
 * this driver's own `assertModelReachable` refuses, so the service rejected the
 * id and `catch { return false }` reported the rejection as an outage. Correct
 * credentials, correct region, service entirely up, answer `false`.
 *
 * A test asserting `healthCheck()` is `false` therefore passes against the
 * broken driver, which is why the first case here is that a HEALTHY fake makes
 * it `true`. The rest assert that the failures arrive apart from one another,
 * and that the probe is the request the driver actually makes.
 *
 * The harness is the one `cache-points.test.ts` uses: swap `provider.client`
 * and read what the AWS client was HANDED. Nothing here rests on a return value
 * alone, because the previous check's return value was honest about a request
 * nobody would have wanted made.
 */

import {
	AccessDeniedException,
	ResourceNotFoundException,
	ServiceUnavailableException,
	ThrottlingException,
	ValidationException,
} from '@aws-sdk/client-bedrock-runtime'
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime'
import { describe, expect, it } from 'vitest'

import { BedrockProvider } from '../client.js'
import type { BedrockHealthReason } from '../health.js'
import { assertModelReachable } from '../model-reachability.js'

/** An id this wire serves: ARN-versioned, behind an inference profile. */
const REACHABLE = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'

/** The exact id the broken check hardcoded. */
const HARDCODED = 'anthropic.claude-haiku-4-20250514'

interface Sent {
	readonly commandName: string
	readonly input: Record<string, unknown>
}

/**
 * A provider whose AWS client is replaced, plus the log of what it was handed.
 *
 * `sent` is the point of the harness. A green boolean cannot say which model
 * was probed or which operation carried the probe, and both were wrong.
 */
function providerWith(send: (command: unknown) => Promise<unknown>): {
	provider: BedrockProvider
	sent: Sent[]
} {
	const provider = new BedrockProvider({ region: 'us-east-1' })
	const sent: Sent[] = []
	;(provider as unknown as { client: unknown }).client = {
		send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
			sent.push({ commandName: command.constructor.name, input: command.input })
			return send(command)
		},
	}
	return { provider, sent }
}

/** A service that answers: 200, then a one-token stream that ends cleanly. */
function healthyProvider() {
	return providerWith(async () => ({
		$metadata: { httpStatusCode: 200, requestId: 'health-test' },
		stream: (async function* () {
			yield { contentBlockDelta: { delta: { text: 'h' }, contentBlockIndex: 0 } }
			yield { messageStop: { stopReason: 'max_tokens' } }
		})(),
	}))
}

/** A service that rejects the request with a real AWS exception class. */
function rejectingProvider(err: unknown) {
	return providerWith(() => Promise.reject(err))
}

/**
 * A service that hands back a 200 and then reports the failure as a member of
 * the output union — which is how Bedrock reports several of them.
 */
function midStreamFailureProvider(...events: ConverseStreamOutput[]) {
	return providerWith(async () => ({
		$metadata: { httpStatusCode: 200, requestId: 'health-test' },
		stream: (async function* () {
			yield* events
		})(),
	}))
}

describe('the check can pass', () => {
	it('returns true against a service that answers', async () => {
		const { provider } = healthyProvider()

		// The assertion the broken driver could not satisfy at any credential,
		// region or service state.
		expect(await provider.healthCheck(REACHABLE)).toBe(true)
	})

	it('reports pass with the reason and the model it probed', async () => {
		const { provider } = healthyProvider()

		const health = await provider.doctorCheck(REACHABLE)

		expect(health.status).toBe('pass')
		expect(health.reason).toBe('ok')
		expect(health.model).toBe(REACHABLE)
	})

	it('times the probe', async () => {
		const { provider } = healthyProvider()

		const health = await provider.doctorCheck(REACHABLE)

		expect(typeof health.durationMs).toBe('number')
	})
})

describe('the check probes what the caller asked for', () => {
	it('sends the model it was given, not a hardcoded one', async () => {
		const { provider, sent } = healthyProvider()

		await provider.healthCheck(REACHABLE)

		expect(sent).toHaveLength(1)
		expect(sent[0]?.input.modelId).toBe(REACHABLE)
		// Named rather than left to the equality above: the point is this id,
		// which the driver's own rule refuses and which shipped for months.
		expect(sent[0]?.input.modelId).not.toBe(HARDCODED)
	})

	it('probes with the operation the request path uses', async () => {
		const { provider, sent } = healthyProvider()

		await provider.healthCheck(REACHABLE)

		// `Converse` and `ConverseStream` are separate IAM actions. A probe on
		// the one `chatStream` does not send can pass under a policy that fails
		// every real call, which is a green check about a request nobody makes.
		expect(sent[0]?.commandName).toBe('ConverseStreamCommand')
	})

	it('asks for one token, so the probe is not a completion', async () => {
		const { provider, sent } = healthyProvider()

		await provider.healthCheck(REACHABLE)

		expect(sent[0]?.input.inferenceConfig).toMatchObject({ maxTokens: 1 })
	})
})

describe('the check refuses to invent a subject', () => {
	it('reports skipped, not unhealthy, when given no model', async () => {
		const { provider, sent } = healthyProvider()

		const health = await provider.doctorCheck()

		// `fail` here would be the original defect in a new spelling: a report
		// of an outage produced by the driver having nothing to ask about.
		expect(health.status).toBe('skipped')
		expect(health.reason).toBe('no-model')
		expect(sent).toHaveLength(0)
	})

	it('treats a blank model id the same as none', async () => {
		const { provider, sent } = healthyProvider()

		const health = await provider.doctorCheck('   ')

		expect(health.reason).toBe('no-model')
		expect(sent).toHaveLength(0)
	})

	it('returns false from healthCheck with no model, without calling AWS', async () => {
		const { provider, sent } = healthyProvider()

		expect(await provider.healthCheck()).toBe(false)
		expect(sent).toHaveLength(0)
	})
})

describe('an id this wire cannot serve is named as that, before any request', () => {
	it('fails on the unversioned form with the reachability reason', async () => {
		const { provider, sent } = healthyProvider()

		const health = await provider.doctorCheck('anthropic.claude-opus-5')

		expect(health.status).toBe('fail')
		expect(health.reason).toBe('unreachable-model')
		expect(sent).toHaveLength(0)
	})

	it('fails on the very id the broken check hardcoded', async () => {
		const { provider, sent } = healthyProvider()

		// The whole defect in one place: the driver classifies this id as
		// unreachable, and the old check sent it anyway — here, against a fake
		// that would have answered.
		expect(() => assertModelReachable(HARDCODED)).toThrow()

		const health = await provider.doctorCheck(HARDCODED)

		expect(health.reason).toBe('unreachable-model')
		expect(sent).toHaveLength(0)
	})

	it("carries the predicate's own explanation, not a summary of it", async () => {
		const { provider } = healthyProvider()

		const health = await provider.doctorCheck('anthropic.claude-opus-5')

		expect(health.message).toMatch(/cannot reach/)
		expect(health.message).toMatch(/Converse API/)
	})
})

describe('the failures arrive apart from one another', () => {
	const cases: ReadonlyArray<{
		readonly label: string
		readonly error: unknown
		readonly reason: BedrockHealthReason
		readonly status: string
	}> = [
		{
			label: 'a rejected credential',
			error: new AccessDeniedException({
				message: 'User is not authorized to perform bedrock:InvokeModelWithResponseStream',
				$metadata: { httpStatusCode: 403 },
			}),
			reason: 'credentials',
			status: 'fail',
		},
		{
			label: 'a model this region does not serve',
			error: new ResourceNotFoundException({
				message: 'Could not resolve the foundation model from the provided model identifier.',
				$metadata: { httpStatusCode: 404 },
			}),
			reason: 'unknown-model',
			status: 'fail',
		},
		{
			label: 'a request the service looked at and refused',
			error: new ValidationException({
				message: "Invocation of model ID with on-demand throughput isn't supported.",
				$metadata: { httpStatusCode: 400 },
			}),
			reason: 'refused',
			status: 'fail',
		},
		{
			label: 'a rate limit',
			error: new ThrottlingException({
				message: 'Too many requests, please wait before trying again.',
				$metadata: { httpStatusCode: 429 },
			}),
			reason: 'throttled',
			status: 'warn',
		},
		{
			label: 'a service that answered and could not serve',
			error: new ServiceUnavailableException({
				message: 'The service is unavailable. Please retry.',
				$metadata: { httpStatusCode: 503 },
			}),
			reason: 'service',
			status: 'fail',
		},
		{
			label: 'a machine with no resolvable credentials',
			error: Object.assign(new Error('Could not load credentials from any providers'), {
				name: 'CredentialsProviderError',
			}),
			reason: 'no-credentials',
			status: 'fail',
		},
		{
			label: 'a request that never got an answer',
			error: Object.assign(new Error('connect ECONNREFUSED'), { name: 'TimeoutError' }),
			reason: 'unreachable-service',
			status: 'inconclusive',
		},
	]

	for (const { label, error, reason, status } of cases) {
		it(`reports ${label} as ${reason}/${status}`, async () => {
			const { provider } = rejectingProvider(error)

			const health = await provider.doctorCheck(REACHABLE)

			expect(health.reason).toBe(reason)
			expect(health.status).toBe(status)
		})
	}

	it('gives every one of them a distinct reason', async () => {
		const reasons = new Set<string>()
		for (const { error } of cases) {
			const { provider } = rejectingProvider(error)
			reasons.add((await provider.doctorCheck(REACHABLE)).reason)
		}

		// The assertion `catch { return false }` fails: seven inputs an operator
		// acts on differently, seven answers. A mapping that collapsed any two
		// would still satisfy every per-case test above, because each of those
		// only names its own expectation.
		expect(reasons.size).toBe(cases.length)
	})

	it('tells the operator what to do about the ones they can act on', async () => {
		const actionable: readonly BedrockHealthReason[] = [
			'credentials',
			'unknown-model',
			'no-credentials',
		]
		for (const { error, reason } of cases) {
			if (!actionable.includes(reason)) continue
			const { provider } = rejectingProvider(error)
			const health = await provider.doctorCheck(REACHABLE)
			expect(health.remediation, `${reason} has no remediation`).toBeTruthy()
		}
	})

	it('keeps "nothing was learned" apart from "the service is down"', async () => {
		const { provider: unreachable } = rejectingProvider(
			Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }),
		)
		const { provider: down } = rejectingProvider(
			new ServiceUnavailableException({
				message: 'unavailable',
				$metadata: { httpStatusCode: 503 },
			}),
		)

		// Reporting a timeout as `fail` would send an operator on broken wifi to
		// rotate a credential that is fine.
		expect((await unreachable.doctorCheck(REACHABLE)).status).toBe('inconclusive')
		expect((await down.doctorCheck(REACHABLE)).status).toBe('fail')
	})

	it('reports every failure as not-healthy through the boolean', async () => {
		for (const { error, reason } of cases) {
			const { provider } = rejectingProvider(error)
			expect(await provider.healthCheck(REACHABLE), reason).toBe(false)
		}
	})
})

describe('a 200 handshake is not a pass on its own', () => {
	it('reads a mid-stream refusal that arrived after the 200', async () => {
		const { provider } = midStreamFailureProvider({
			validationException: new ValidationException({
				message: 'The provided model identifier is invalid.',
				$metadata: { httpStatusCode: 400 },
			}),
		} as unknown as ConverseStreamOutput)

		const health = await provider.doctorCheck(REACHABLE)

		// Bedrock reports several failures as members of the output union, after
		// a 200. A check that read only `$metadata.httpStatusCode` would call
		// this healthy.
		expect(health.status).toBe('fail')
		expect(health.reason).toBe('refused')
	})

	it('reads a mid-stream throttle the same way', async () => {
		const { provider } = midStreamFailureProvider({
			throttlingException: new ThrottlingException({
				message: 'slow down',
				$metadata: { httpStatusCode: 429 },
			}),
		} as unknown as ConverseStreamOutput)

		expect((await provider.doctorCheck(REACHABLE)).reason).toBe('throttled')
		expect(await provider.healthCheck(REACHABLE)).toBe(false)
	})

	it('fails a handshake that carried no stream body', async () => {
		const { provider } = providerWith(async () => ({
			$metadata: { httpStatusCode: 200, requestId: 'health-test' },
		}))

		const health = await provider.doctorCheck(REACHABLE)

		expect(health.status).toBe('fail')
		expect(health.reason).toBe('service')
	})
})

describe('the catalogue offers only ids this driver will send', () => {
	it("every advertised id survives the driver's own reachability rule", async () => {
		const provider = new BedrockProvider({ region: 'us-east-1' })

		const models = await provider.listModels()

		expect(models.length).toBeGreaterThan(0)
		for (const model of models) {
			// Two entries used to fail this: an operator picking either off the
			// menu got a throw before any request was built.
			expect(() => assertModelReachable(model.id), model.id).not.toThrow()
		}
	})

	it('advertises neither of the two ids that shipped and could not be invoked', async () => {
		const provider = new BedrockProvider({ region: 'us-east-1' })

		const ids = (await provider.listModels()).map((m) => m.id)

		expect(ids).not.toContain('anthropic.claude-sonnet-4-20250514')
		expect(ids).not.toContain(HARDCODED)
	})

	it('lets a menu entry be probed without changing it', async () => {
		const { provider, sent } = healthyProvider()
		const [first] = await provider.listModels()

		expect(await provider.healthCheck(first?.id)).toBe(true)
		expect(sent[0]?.input.modelId).toBe(first?.id)
	})
})

describe('a failure report says what it was about', () => {
	it('names the model it probed, on the failure paths too', async () => {
		const { provider } = rejectingProvider(
			new AccessDeniedException({ message: 'denied', $metadata: { httpStatusCode: 403 } }),
		)

		const health = await provider.doctorCheck(REACHABLE)

		// A report that names a failure and not its subject sends an operator
		// looking through every model they run.
		expect(health.model).toBe(REACHABLE)
	})

	it('reports the classified message rather than the raw AWS one', async () => {
		const { provider } = rejectingProvider(
			new AccessDeniedException({
				message: 'User AKIAIOSFODNN7EXAMPLE is not authorized to perform this action',
				$metadata: { httpStatusCode: 403 },
			}),
		)

		const health = await provider.doctorCheck(REACHABLE)

		// AWS builds its exception message from the response body, so a
		// credential the service echoed back is inside `err.message` before
		// this driver sees it. The message therefore comes from the SDK's
		// classifier, which is the one place that strips it — and a report is
		// exactly the value someone pastes into an issue.
		expect(health.message).not.toContain('AKIAIOSFODNN7EXAMPLE')
		expect(health.message).toContain('bedrock')
	})
})

describe('a machine that was never configured is not a service that is down', () => {
	it('reads a missing region as a local failure, not as an unreachable service', async () => {
		// The AWS SDK reports this as a plain `Error` with no exception class to
		// match on, so it is the one reason that has to come off the message.
		// Neither mutation round reached this branch; it is here because a table
		// where everything dies is a map of the lines the tests execute, and this
		// line was not on it.
		const { provider, sent } = rejectingProvider(new Error('Region is missing'))

		const health = await provider.doctorCheck(REACHABLE)

		expect(health.reason).toBe('no-credentials')
		expect(health.status).toBe('fail')
		// It did leave the driver — the request was built and handed over — which
		// is what separates this from the reachability refusal above.
		expect(sent).toHaveLength(1)
	})
})
