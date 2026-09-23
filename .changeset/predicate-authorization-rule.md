---
'@namzu/sdk': minor
---

Add a `predicate` authorization rule, and export the command-line lexer the gate uses.

- `AuthorizationRule` gains `{ type: 'predicate', description, decide }`. `decide(call)` receives the tool name, input, definition and the `commandDialect` the line runs in (`sh` when the caller did not say) and returns `allow`, `deny`, `review` or `null`; it sits in its place in the rule list, after the dangerous-command floor. A `decide` that throws is read as `deny`. New types `AuthorizationPredicate` and `AuthorizationPredicateCall`.
- `lexShellCommandLine` is exported, with `ShellLexResult`, `ShellCommand`, `ShellWord`, `ShellRedirection` and `ShellLexOptions`, so a predicate reads a command line exactly as the gate does.
- A lexer result also reports `compoundWords` (a `for` or `select` loop's variable and list, a `case` statement's subject and patterns) and, on a here-document redirection, its `body`.

Nothing existing changes behaviour. `AuthorizationRule` is also the type of `GateEvaluationResult.matchedRule`: code that switches over `rule.type` with an exhaustive check (`const x: never = rule`) needs a `predicate` case or a `default:` branch to compile.
