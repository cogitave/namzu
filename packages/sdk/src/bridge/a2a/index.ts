export { buildAgentCard } from './agent-card.js'

export {
	mapTurnToA2ATask,
	isTerminalState,
	turnStatusToA2AState,
	a2aMessageToCreateTurn,
	type CreateTurnFromA2A,
	type MapTurnToA2ATaskOptions,
} from './task.js'

export { resolveA2AContext, type A2AContextResolution } from './context.js'

export {
	messageToA2A,
	extractTextFromA2AMessage,
	a2aMessageToInput,
} from './message.js'

export { mapTurnToA2AEvent, mapSessionToA2AEvent } from './mapper.js'

// A host's JSON-RPC server maps a turn refused because another is active to
// the A2A error of its choice, naming the active task (`activeTurnId`).
export { isTurnInProgressError } from '../../types/session/turn.js'
