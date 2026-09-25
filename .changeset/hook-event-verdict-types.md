---
'@namzu/sdk': major
---

`PluginHookDefinition` now checks each hook's returned action against its event. A TypeScript plugin whose handler is declared to return the full `PluginHookResult` union, or returns an action the runtime cannot use for that event, may stop compiling. Narrow the handler return type to `PluginHookResultFor<'event_name'>` or let TypeScript infer its specific result. For example, `retry` belongs to `post_tool_use`, `modify` to `pre_tool_use`, and `annotate` to `user_prompt_submit`. Session start/end and turn interrupt hooks can only declare `continue` as a result. JavaScript runtime behavior is unchanged.
