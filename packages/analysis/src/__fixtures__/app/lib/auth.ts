import { createHash } from 'node:crypto'
import type { Request } from './types.js'
import { pad } from './util.mjs'

export interface Session {
	readonly user: string
}

export class Authority {
	static async create(secret: string): Promise<Authority> {
		return new Authority(secret)
	}

	constructor(private readonly secret: string) {}

	get fingerprint(): string {
		return createHash('sha256').update(this.secret).digest('hex')
	}

	sign(user: string): string {
		return `${user}.${pad(this.fingerprint.slice(0, 8))}`
	}
}

export function verify(token: string | undefined): boolean {
	if (!token) return false
	return token.split('.').length === 2 && check(token)
}

function check(token: string): boolean {
	const part = token.split('.')[1] ?? ''
	return part.length === 8 && !part.includes('Invalid token')
}

export default Authority
export const VERSION = '1.2.3'
