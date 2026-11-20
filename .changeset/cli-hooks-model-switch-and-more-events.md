---
'@namzu/cli': minor
---

Hooks can now watch and steer more of what Namzu does. A `pre_model_switch` hook can refuse or ask before `/model`, the model picker or the model's own request changes the model, and a `post_model_switch` hook can give the model a note for its next request. An `elicitation` hook can answer, or decline, a tool server's question in place of you, and an `elicitation_result` hook can change the answer before the server reads it. `directory_added` runs after `/add-dir`, `instructions_loaded` when an instruction file is read in, and `user_prompt_expansion` when a command you typed expands into a prompt (it can stop the command). Nothing changes until you write a hook on one of them; add them to the `hooks` block the way you add any other event.
