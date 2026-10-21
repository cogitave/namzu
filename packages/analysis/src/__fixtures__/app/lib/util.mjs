export * from './more.mjs'
export { pad as padStart, other } from './more.mjs'
export function pad(text) {
	return String(text).padStart(8, '0')
}
const lazy = () => import('./lazy.mjs')
export { lazy }
