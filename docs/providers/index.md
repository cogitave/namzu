# Providers

One driver package per model service, and how each is configured.

* [The Anthropic driver — authentication, configuration and strict tool inputs](anthropic.md) - Reference for @namzu/anthropic — authentication, configuration, route-bound signed-thinking replay, reasoning effort mapping, and strict tool-input generation.
* [The AWS Bedrock driver — model ids, credentials and prompt caching](bedrock.md) - Reference for @namzu/bedrock: how a Bedrock model id differs from a vendor id, where credentials and region come from, what prompt caching buys and costs, and the health and error surfaces the kernel reads.
* [The DeepSeek driver — image input, thinking mode and reasoning replay](deepseek.md) - Reference for @namzu/deepseek — model-scoped inline image input, why thinking mode makes this a separate driver, how reasoning_content maps onto kernel reasoning blocks, and what the wire refuses.
* [The generic HTTP driver — two dialects and one configuration](http.md) - Reference for @namzu/http: the two wire dialects it speaks and how a mismatch is refused rather than guessed, every configuration field, and the model-listing and health surfaces a gateway has to provide.
* [The LM Studio driver — the local server, configuration and cost](lmstudio.md) - Reference for @namzu/lmstudio: what the local server has to be running, every configuration field, why a locally served model reports zero cost, and the error surface when the server is absent.
* [The Ollama driver — configuration, refusals and cancellation](ollama.md) - Reference for @namzu/ollama: every configuration field, what the driver refuses rather than silently approximating, how cancellation reaches a running generation, and how to use it without carrying the vendor client.
* [The OpenAI package — API-key and ChatGPT subscription transports](openai.md) - Reference for @namzu/openai: the Chat Completions API-key driver, the account-routed ChatGPT subscription transport, their capabilities, refusals, health checks and model-listing surfaces.
* [The OpenRouter driver — models, the window, credentials and attribution](openrouter.md) - Reference for @namzu/openrouter: how a model id maps to a context window, where credentials and the attribution headers come from, every configuration field, and the health and error surfaces.
