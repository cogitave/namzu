---
'@namzu/browser': patch
'@namzu/computer-use': patch
'@namzu/evals': patch
'@namzu/live': patch
'@namzu/lsp': patch
'@namzu/anthropic': patch
'@namzu/deepseek': patch
'@namzu/openai': patch
'@namzu/openrouter': patch
'@namzu/zen': patch
---

Updated package examples and evaluation fixtures for the SDK's `ToolRegistry`
removal. Browser, computer-use, live and LSP documentation now show toolsets;
the evals use `toolsets` when they call the kernel. Provider changes are test
fixture migrations only, with no provider runtime API change. Consumers that
pass tools to the SDK or `NamzuModel` should use `toolsets: readonly Toolset[]`
and wrap their definitions with `toolset(source, definitions)`.
