---
'@namzu/deepseek': minor
'@namzu/sdk': minor
'@namzu/cli': minor
---

Add `@namzu/deepseek`, and stop dropping reasoning when a stream is collected.

**A new driver, and a separate package on purpose.** DeepSeek's endpoint is OpenAI's Chat Completions shape, so pointing `@namzu/openai` at it with a `baseURL` looks like it should work. It does not, and the reason is thinking mode: it is **on by default**, the chain of thought comes back in a `reasoning_content` field that wire has no concept of, and the vendor requires that field replayed on every later turn once tool calls are in play. A driver that does not know about it drops the model's reasoning on every call.

`@namzu/deepseek` maps `ThinkingConfig` one-to-one onto the vendor's own `adaptive | enabled | disabled`, streams reasoning through `delta.reasoning` — the same channel `@namzu/anthropic` uses, so a host that renders one renders the other — and replays it automatically. Callers pass the assistant message back and the field goes with it.

It **refuses** two things the vendor accepts and applies to nothing: `effort` (this wire validates `thinking.type` and ignores any effort beside it) and the sampling parameters while thinking is on. Both were measured against the live API rather than read off the documentation. `samplingInThinkingMode: 'ignore'` opts out of the second.

It carries no price rows, deliberately: the vendor charges twice as much during peak UTC hours, and a static table has no hour in it.

**`collectChatCompletion` dropped reasoning blocks** (`@namzu/sdk`). `delta.reasoning` existed, `AssistantMessage.reasoning` is documented as replayed verbatim, and the run loop assembled it correctly — but this helper, which every non-streaming caller goes through, threw it away. So the same stream produced a message with reasoning through one route and without it through the other, and a vendor that needs the blocks back was sent a message that had lost them. It now buckets them by index exactly as the run loop does. This affects `@namzu/anthropic` users too.

**The CLI ships the driver** (`@namzu/cli`), so `namzu --provider deepseek` works on a fresh install with `DEEPSEEK_API_KEY` set. That is a fifth bundled driver and a slightly larger install.

Models are `deepseek-v4-flash` and `deepseek-v4-pro`. `deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24 and resolve to nothing.
