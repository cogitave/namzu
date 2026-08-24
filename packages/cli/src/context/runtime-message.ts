import type { RuntimeContextMessageKind } from '@namzu/sdk'

/** Human label for provider-user-role context authored by the runtime. */
export function runtimeContextLabel(kind: RuntimeContextMessageKind): string {
	switch (kind) {
		case 'advisory':
			return 'Advisor context'
		case 'answer-review':
			return 'Answer review feedback'
		case 'auto-continuation':
			return 'Automatic continuation'
		case 'limit-finalization':
			return 'Limit finalization request'
		case 'steering':
			return 'Runtime steering'
		case 'structured-output':
			return 'Structured-output retry'
		case 'task-completion':
			return 'Task completion context'
	}
}
