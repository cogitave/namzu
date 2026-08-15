// Deliberately-violating fixture for rule 3 (checkConstantBody): a
// template literal with a hole, and a `+` concatenation, as the first
// argument to a confirmed Logger call. A constant body passes alongside
// them, proving the rule does not flag every call on this receiver.
import type { Logger } from '../../../packages/sdk/src/utils/logger.js'

export function demo(log: Logger, id: string) {
	log.info(`request ${id} accepted`, { 'namzu.request.id': id })
	log.warn('request ' + id + ' retried', { 'namzu.request.id': id })
	log.debug('constant body, passes', { 'namzu.request.id': id })
}
