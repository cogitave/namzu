import type { HttpDialect } from '../types.js'

/**
 * A response body that ends the way a finished answer does on each dialect:
 * the OpenAI wire with a finish reason, the Anthropic wire with `message_stop`.
 * A stream that closes without that marker is a cut connection, so a test that
 * only looks at the request still has to hand the driver a whole response.
 */
export function finishedStream(dialect: HttpDialect): string {
	return dialect === 'anthropic'
		? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
		: `data: ${JSON.stringify({ id: 'r', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
}
