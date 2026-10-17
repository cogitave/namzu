// The decision-model contract (the way of working).
export {
	type ChoiceDecision,
	DecisionError,
	type DecisionModel,
	type DecisionRequestOptions,
	type ScoreDecision,
	type YesNoDecision,
} from './contract.js'

// Driver selection + the drivers themselves.
export {
	type AzureDecisionProviderConfig,
	createDecisionModel,
	type DecisionProvider,
	type DecisionProviderConfig,
	type HttpDecisionProviderConfig,
} from './create.js'
export { type AzureFoundryConfig, AzureFoundryDecisionModel } from './drivers/azure-foundry.js'
export { type HttpDecisionConfig, HttpDecisionModel } from './drivers/http.js'

// The agent-facing behaviour.
export { createDecisionTool, DECIDE_TOOL_NAME, type DecisionToolOptions } from './tool.js'
