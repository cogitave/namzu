import { computeTotal } from './index.js'

export function report(values: readonly number[]): string {
	return `total is ${computeTotal(values)}`
}
