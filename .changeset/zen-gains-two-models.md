---
'@namzu/zen': minor
---

The Zen catalogue gains two models. They arrive in the same release as a
generator fix that had to come first: the Zen page had started publishing a
route row this script refused to read, and while that row stood the catalogue
could not be checked against upstream at all.

**New on Zen**, both selectable once your key admits them: `qwen3.8-flash` on
the Messages wire at $0.15/$0.47 per million tokens, and `deepseek-v4.1-flash`
on Chat Completions at $0.30/$1.20. Both were already carried on the Go
service; upstream has since added them to the Zen route table as well, which is
what made this roster move. Nothing was removed, no price changed, and
`getZenModels`, `findZenModel`, `ZenModel` and `ZenProtocol` keep their
signatures and types, so the bump is `minor`.

**Two ids stay uncarried, and no longer stop the catalogue being checked.** The
Zen page routes `jev-1.13` and `jev-1.13-free` on an endpoint whose AI SDK
package column carries a dash rather than a package: the page names the model,
its id and its endpoint, and no source states a wire for it — models.dev holds
a name and limits for both and no package either. That row used to stop the
generator as a page that had changed shape, which is the defect this release
fixes: a row stating no wire is now read as exactly that, and both ids are
omitted by name in `src/models.review.json` instead. The service does serve
both, so if you call one of them the wire is yours to state — there is none to
carry them on, which is the whole reason they are omitted — and that needs a
real credential, because anonymous admission is only claimed for models the
catalogue carries. The page's free-model list names `jev-1.13-free`; that is a
statement upstream makes about it, not an anonymous access this driver grants.
