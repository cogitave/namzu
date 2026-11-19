---
'@namzu/cli': patch
---

An extension manifest's `id` must now be a reverse DNS name: at least three parts separated by dots, each of lowercase letters, digits and inner hyphens (for example `com.example.activity`). A manifest whose id used a hyphen between parts, such as `com-example-activity`, is refused with a sentence that shows a correct id. This is a patch because the extension platform has not been released: no released Namzu ever accepted such a package, so no one has an extension to rename. `namzu extension validate <file.nzx>` also warns, without refusing, when the package file is not named `<id>-<version>-<platform>.nzx`.
