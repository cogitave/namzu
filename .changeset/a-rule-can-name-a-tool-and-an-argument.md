---
'@namzu/sdk': minor
---

A verification rule can name one tool and one argument.

Every pattern rule an operator could write was one of two wrong things.

`custom_pattern` carries no tool scope, so a rule written about `bash` decided
`edit` calls as well — `target: 'both'` prefixes the tool name to the subject
rather than requiring it, which is not a scope. And `target: 'args'` tests
`JSON.stringify(toolInput)`, so the subject is the JSON *text* of the whole
argument object: the natural, anchored thing to write, `^git push`, is tested
against `{"command":"git push origin main"}` and can never match. The rule then
decides nothing, silently. Pinning the tool cost the anchor; anchoring cost the
tool scope.

New `argument_pattern` rule — `toolNames`, `argument`, `pattern`, `decision` —
whose subject is the named argument's own value, so an anchored pattern means
what it looks like it means. The refusal names the argument as well as the
pattern, which is what tells a model whether a different value could get through.

It deliberately decides nothing in three cases: the tool was not called, the
argument is absent, or the argument holds an object or an array. No string a
pattern could match says anything true about a structured value, and serialising
one to try would put this rule back where `custom_pattern` already is. To refuse
a tool over the *shape* of its input, deny it by name. Numbers and booleans are
matched rather than skipped — they render unambiguously, and a rule about a
numeric argument is a reasonable thing to write.

`custom_pattern` is unchanged and not deprecated: matching anywhere in the
serialised input without caring where is a real use, and it is now documented as
being that rather than reading as something it never was. The trap was the name,
not the behaviour.
