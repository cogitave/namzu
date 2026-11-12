import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type NetIncoming, type NetLike, type NetRequest, netCall } from './engine-net.js'

class FakeRequest extends EventEmitter {
	headers: Record<string, string> = {}
	aborted = false
	options: Parameters<NetLike['request']>[0] | undefined
	setHeader(name: string, value: string) {
		this.headers[name] = value
	}
	end() {
		this.emit('started')
	}
	abort() {
		this.aborted = true
	}
}

function fake() {
	const request = new FakeRequest()
	const net: NetLike = {
		request: (options) => {
			request.options = options
			return request as unknown as NetRequest
		},
	}
	return { net, request }
}

function incoming(status: number, body: string, headers = {}): NetIncoming {
	return Object.assign(Readable.from([Buffer.from(body)]), {
		statusCode: status,
		headers,
	}) as unknown as NetIncoming
}

describe('the feed request on the platform network stack', () => {
	it('asks without cookies, never follows a redirect itself, and sends the headers given', async () => {
		const { net, request } = fake()
		const pending = netCall(net, { 'Accept-Language': '*' })('http://127.0.0.1/a', {
			headers: { 'User-Agent': 'namzu-desktop' },
			signal: new AbortController().signal,
		})
		request.emit('response', incoming(200, 'hello', { 'content-type': 'text/plain' }))
		const response = await pending
		expect(request.options).toMatchObject({ redirect: 'manual', useSessionCookies: false })
		expect(request.headers).toEqual({ 'Accept-Language': '*', 'User-Agent': 'namzu-desktop' })
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('hello')
	})

	it('turns a redirect into a 3xx response with its address, without reading further', async () => {
		const { net, request } = fake()
		const pending = netCall(net)('http://127.0.0.1/a', {
			headers: {},
			signal: new AbortController().signal,
		})
		request.emit('redirect', 302, 'GET', 'http://evil.example/b')
		const response = await pending
		expect(request.aborted).toBe(true)
		expect(response).toMatchObject({ status: 302 })
		expect(response.headers.get('location')).toBe('http://evil.example/b')
		expect(response.body).toBeNull()
	})

	it('fails when the request is cancelled or the network fails', async () => {
		const first = fake()
		const controller = new AbortController()
		const cancelled = netCall(first.net)('http://127.0.0.1/a', {
			headers: {},
			signal: controller.signal,
		})
		controller.abort()
		await expect(cancelled).rejects.toThrow(/cancelled/u)
		expect(first.request.aborted).toBe(true)
		const second = fake()
		const failed = netCall(second.net)('http://127.0.0.1/a', {
			headers: {},
			signal: new AbortController().signal,
		})
		second.request.emit('error', new Error('net::ERR_CONNECTION_REFUSED'))
		await expect(failed).rejects.toThrow(/ERR_CONNECTION_REFUSED/u)
	})
})
