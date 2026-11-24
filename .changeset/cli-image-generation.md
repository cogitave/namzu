---
"@namzu/cli": minor
---

Add `generate_image`: create and edit images with the person's subscription plan, whichever model leads the conversation (DeepSeek, OpenRouter, Anthropic or a local one, not only OpenAI models). It is offered while a subscription sign-in is connected and the plan is not Free; an OpenAI API key alone does not enable it. Images are saved to `<Namzu home>/generated_images/<session>/<call>.png`, shown in the terminal as "Generated image", the prompt and "Saved to <path>" after the answer, and readable by that session's file tools. The new `imageGeneration.enabled` setting (default `true`, a project file can only turn it off) switches it, with an "Image generation" row in Settings. To keep the old behaviour of having no image tool, set `imageGeneration.enabled` to `false`.
