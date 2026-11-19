---
'@namzu/cli': minor
---

Three new settings. `outputStyle` (your own words on how replies read) and `attribution` (text the agent ends commit messages and pull request descriptions with) each add one short note to the working rules of new conversations; both are empty by default, the prompt is byte for byte unchanged while they are, a project's `namzu.config.json` cannot set them, and the model follows them without anything enforcing it. `promptSuggestions` is on by default: after a reply the terminal app asks the small model for one short next message and shows it in the empty composer, and Tab uses it. That is one small model request per reply, which was not spent before; set `promptSuggestions: false` (Settings > Agent > Prompt suggestions) to keep today's behaviour, and a failed request, no small model or a long reply shows nothing. Desktop does not show suggestions yet.
