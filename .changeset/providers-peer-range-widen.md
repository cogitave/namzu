---
"@namzu/anthropic": patch
"@namzu/bedrock": patch
"@namzu/http": patch
"@namzu/lmstudio": patch
"@namzu/ollama": patch
"@namzu/openai": patch
"@namzu/openrouter": patch
---

Widen `@namzu/sdk` peer range to `>=0.1.6 <1.0.0`.

The previous peer range `^1 || ^0.1.6` resolved to `>=0.1.6 <0.2.0 || >=1.0.0`, which excluded the published `@namzu/sdk@0.2.0` and caused `npm install @namzu/sdk @namzu/<provider>` to fail with ERESOLVE on a clean machine. The new range covers every pre-1.0 SDK minor from 0.1.6 onward; the 1.0 pledge will be the next explicit widening.

This is the first release under the new Changesets-driven workflow and the wide-pre-1.0-peer convention. Consumers who followed the README's "getting started" install were previously blocked; after this release `npm install @namzu/sdk@latest @namzu/<provider>@latest` resolves cleanly.
