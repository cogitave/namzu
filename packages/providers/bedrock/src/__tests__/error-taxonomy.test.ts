/**
 * Provider error taxonomy — Bedrock driver.
 *
 * `chatStream` awaits `this.client.send(command)` with no catch, so an AWS
 * `BedrockRuntimeServiceException` (`ThrottlingException`,
 * `ValidationException`, `ServiceUnavailableException`, …) escapes verbatim.
 * A caller cannot classify it without importing `@aws-sdk/client-bedrock-runtime`.
 *
 * Transport seam: `BedrockConfig` exposes no `requestHandler`/`endpoint`, so
 * unlike the fetch-based drivers there is nothing to inject at the HTTP
 * layer. The tests substitute the `BedrockRuntimeClient`'s `send` and reject
 * with the REAL AWS exception classes — which is exactly what the driver
 * sees from a live call, and the only surface the driver's (currently
 * absent) error mapping would act on.
 */

import {
	AccessDeniedException,
	ModelErrorException,
	ServiceQuotaExceededException,
	ServiceUnavailableException,
	ThrottlingException,
	ValidationException,
} from '@aws-sdk/client-bedrock-runtime'
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime'
import { describe, expect, it } from 'vitest'
import { BedrockProvider } from '../client.js'

/** Replace the AWS client's `send` so it rejects with `err`. */
function providerRejectingWith(err: unknown): BedrockProvider {
	const provider = new BedrockProvider({ region: 'eu-west-1' })
	;(provider as unknown as { client: { send: () => Promise<never> } }).client = {
		send: () => Promise.reject(err),
	}
	return provider
}

function providerStreaming(...events: ConverseStreamOutput[]): BedrockProvider {
	const provider = new BedrockProvider({ region: 'eu-west-1' })
	;(provider as unknown as { client: { send: () => Promise<unknown> } }).client = {
		send: async () => ({
			$metadata: { requestId: 'bedrock-test' },
			stream: (async function* () {
				yield* events
			})(),
		}),
	}
	return provider
}

async function captureChatStreamError(
	provider: BedrockProvider,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
			messages: [{ role: 'user', content: 'hi' }],
			signal,
		})) {
			// drain
		}
	} catch (err) {
		return err
	}
	throw new Error('expected chatStream to throw')
}

describe('@namzu/bedrock — provider error taxonomy', () => {
	it('(a) ThrottlingException with `retry-after: 2` becomes a throttle-classified error carrying retryAfterMs', async () => {
		const aws = new ThrottlingException({
			message: 'Too many requests, please wait before trying again.',
			$metadata: { httpStatusCode: 429 },
		})
		;(aws as unknown as { $response: unknown }).$response = {
			statusCode: 429,
			headers: { 'retry-after': '2' },
		}

		const err = await captureChatStreamError(providerRejectingWith(aws))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 429,
			retryAfterMs: 2000,
			providerId: 'bedrock',
		})
	})

	it("(c) a ValidationException reporting too many input tokens classifies as 'context_overflow'", async () => {
		const aws = new ValidationException({
			message:
				'Input is too long for requested model. The input token count exceeds the maximum for this model.',
			$metadata: { httpStatusCode: 400 },
		})

		const err = await captureChatStreamError(providerRejectingWith(aws))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'context_overflow',
			status: 400,
			providerId: 'bedrock',
		})
	})

	it("(c) a ValidationException that is not an overflow classifies as 'bad_request'", async () => {
		const aws = new ValidationException({
			message: 'The value at toolConfig.tools failed to satisfy constraint.',
			$metadata: { httpStatusCode: 400 },
		})

		const err = await captureChatStreamError(providerRejectingWith(aws))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'bad_request',
			status: 400,
			providerId: 'bedrock',
		})
	})

	it("an AccessDeniedException classifies as 'auth'", async () => {
		const aws = new AccessDeniedException({
			message: 'You do not have access to the model with the specified model ID.',
			$metadata: { httpStatusCode: 403 },
		})

		const err = await captureChatStreamError(providerRejectingWith(aws))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'auth',
			status: 403,
			providerId: 'bedrock',
		})
	})

	it("a ServiceUnavailableException classifies as 'server'", async () => {
		const aws = new ServiceUnavailableException({
			message: 'The service is unavailable, try again later.',
			$metadata: { httpStatusCode: 503 },
		})

		const err = await captureChatStreamError(providerRejectingWith(aws))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			status: 503,
			providerId: 'bedrock',
		})
	})

	it("a ModelErrorException with HTTP 424 still classifies as 'server'", async () => {
		const aws = new ModelErrorException({
			message: 'The model failed while processing the request.',
			originalStatusCode: 500,
			$metadata: { httpStatusCode: 424 },
		})

		const err = await captureChatStreamError(providerRejectingWith(aws))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			status: 424,
			providerId: 'bedrock',
		})
	})

	it("a ServiceQuotaExceededException classifies as 'throttle'", async () => {
		const aws = new ServiceQuotaExceededException({
			message: 'Account inference quota exceeded.',
			$metadata: { httpStatusCode: 400 },
		})

		const err = await captureChatStreamError(providerRejectingWith(aws))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 400,
			providerId: 'bedrock',
		})
	})

	it('classifies a throttling exception delivered as a stream union event', async () => {
		const aws = new ThrottlingException({
			message: 'stream quota exceeded',
			$metadata: { httpStatusCode: 429 },
		})

		const err = await captureChatStreamError(providerStreaming({ throttlingException: aws }))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 429,
			providerId: 'bedrock',
		})
	})

	it('drops a secret-bearing validation stream event without retaining cause', async () => {
		const secret = 'aws-secret-FAKE-DO-NOT-LOG'
		const aws = new ValidationException({
			message: `invalid request echoed ${secret}`,
			$metadata: { httpStatusCode: 400 },
		})

		const err = await captureChatStreamError(providerStreaming({ validationException: aws }))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'bad_request',
			providerId: 'bedrock',
		})
		expect((err as Error).message).not.toContain(secret)
		expect('cause' in (err as object)).toBe(false)
	})

	it('preserves the caller abort reason when the SDK replaces the error object', async () => {
		const controller = new AbortController()
		const reason = new Error('user stopped')
		const sdkAbort = Object.assign(new Error('request aborted'), {
			name: 'AbortError',
		})
		controller.abort(reason)

		const err = await captureChatStreamError(providerRejectingWith(sdkAbort), controller.signal)

		expect(sdkAbort).not.toBe(reason)
		expect(err).toBe(reason)
	})
})
