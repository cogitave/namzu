---
'@namzu/sdk': minor
---

Nine new hook events, all additive: `pre_model_switch` and `post_model_switch`, `elicitation` and `elicitation_result`, `directory_added`, `instructions_loaded`, `user_prompt_expansion`, `task_created` and `task_completed`. A shell hook can attach to any of them (written `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `DirectoryAdded`, `InstructionsLoaded`, `UserPromptExpansion`, `TaskCreated`, `TaskCompleted`). The two task events are fired by the kernel in the tool step, before `task_create` and before a `task_update` that completes a task; a hook can refuse either and the model is told why. Existing events and hooks change in no way. Hooks that already exit `2` on a task tool through `pre_tool_use` keep working. Plugin hook authors who `switch` over every `PluginHookEvent` must add the new names. Documented in the hook events page.
