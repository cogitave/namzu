import { expectTypeOf, it } from 'vitest'

import type { PluginHookDefinition } from '../../types/plugin/index.js'

it('correlates a hook event with actions the runtime accepts', () => {
	expectTypeOf<{
		event: 'user_prompt_submit'
		handler: () => Promise<{ action: 'annotate'; text: string }>
	}>().toMatchTypeOf<PluginHookDefinition>()
	expectTypeOf<{
		event: 'pre_tool_use'
		handler: () => Promise<{ action: 'modify'; input: unknown }>
	}>().toMatchTypeOf<PluginHookDefinition>()
	expectTypeOf<{
		event: 'post_tool_use'
		handler: () => Promise<{ action: 'retry' }>
	}>().toMatchTypeOf<PluginHookDefinition>()

	expectTypeOf<{
		event: 'pre_llm_call'
		handler: () => Promise<{ action: 'retry' }>
	}>().not.toMatchTypeOf<PluginHookDefinition>()
	expectTypeOf<{
		event: 'post_tool_use'
		handler: () => Promise<{ action: 'modify'; input: unknown }>
	}>().not.toMatchTypeOf<PluginHookDefinition>()
	expectTypeOf<{
		event: 'turn_interrupt'
		handler: () => Promise<{ action: 'skip'; reason: string }>
	}>().not.toMatchTypeOf<PluginHookDefinition>()
	expectTypeOf<{
		event: 'session_end'
		handler: () => Promise<{ action: 'error'; message: string }>
	}>().not.toMatchTypeOf<PluginHookDefinition>()
})
