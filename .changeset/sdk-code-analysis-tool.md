---
"@namzu/sdk": minor
---

Add the `code_analysis` tool and the `CodeAnalysisProvider` interface it calls. Nothing changes for a host that does not opt in: the tool is not part of `getBuiltinTools()` and is registered only when a host passes a provider (`getCodeAnalysisTools(provider)`, with `QueryParams.codeAnalysis` / `ToolContext.codeAnalysis` carrying it into the turn). The tool answers cited, paged lookups over a JavaScript/TypeScript index: `index`, `find_literal`, `enclosing_function`, `function_source`, `callers_of` and `imports`. Every result says what was observed, what was inferred (a callee matched by text, not by scope) and whether coverage is complete. Paths go through the same resolver and review route as `read`, and a sandboxed turn is refused because the index reads the host file system. To use it, construct a provider (`@namzu/analysis` ships one) and pass it as `codeAnalysis` to `query()`.
