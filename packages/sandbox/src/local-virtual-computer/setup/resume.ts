import type { ClearResumeAtSignIn, RegisterResumeAtSignIn } from './contract.js'
import { notImplemented } from './not-implemented.js'

export const registerResumeAtSignIn: RegisterResumeAtSignIn = async () => {
	throw notImplemented('registerResumeAtSignIn')
}
export const clearResumeAtSignIn: ClearResumeAtSignIn = async () => {
	throw notImplemented('clearResumeAtSignIn')
}
