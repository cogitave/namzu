import type { RuntimeContextMessageKind } from '@namzu/sdk'

/** Human label for provider-user-role context authored by the runtime. */
export function runtimeContextLabel(kind: RuntimeContextMessageKind): string {
	switch (kind) {
		case 'step-context':
			return 'Context for the next step'
		case 'advisory':
			return 'Second opinion'
		case 'answer-review':
			return 'Reviewed the answer'
		case 'auto-continuation':
			return 'Continued automatically'
		case 'hook-feedback':
			return 'Hook feedback'
		case 'job-exit':
			return 'Background command ended'
		case 'limit-finalization':
			return 'Wrapped up at a limit'
		case 'peer-message':
			return 'Message from another Namzu window'
		case 'host-observation':
			return 'Pal activity'
		case 'channel-message':
			return 'Message from a connected channel'
		case 'peer-notice':
			return 'Notice from another Namzu window'
		case 'reminder':
			return 'Reminder'
		case 'repeat-call':
			return 'Repeated call warning'
		case 'steering':
			return 'Guidance from Namzu'
		case 'structured-output':
			return 'Asked again for the required format'
		case 'task-completion':
			return 'Task finished'
	}
}
