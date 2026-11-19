import type {
	RegisterResult,
	SigninKind,
	SigninRegistrar,
	SigninSpec,
	SigninStatus,
} from './registrar.js'

/** In memory: what a test asks and what it was told, with nothing written anywhere. */
export class FakeRegistrar implements SigninRegistrar {
	entry: { launcher: string; kind: SigninKind } | undefined
	disabledByOs = false
	calls: string[] = []
	failRegister: string | undefined
	constructor(private readonly kind: SigninKind = 'xdg') {}
	async status(): Promise<SigninStatus> {
		this.calls.push('status')
		return this.entry
			? {
					registered: true,
					kind: this.entry.kind,
					...(this.disabledByOs ? { disabledByOs: true } : {}),
				}
			: { registered: false }
	}
	async register(spec: SigninSpec): Promise<RegisterResult> {
		this.calls.push('register')
		if (this.failRegister) return { ok: false, reason: this.failRegister }
		this.entry = { launcher: spec.launcher, kind: this.kind }
		return { ok: true, kind: this.kind }
	}
	async unregister(): Promise<void> {
		this.calls.push('unregister')
		this.entry = undefined
	}
}
