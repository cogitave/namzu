---
name: document
description: Write a document or report as one Markdown file. Use when the person wants a write-up to read or send. Not for Word, PDF, slides or sheets.
invocation: both
---

# Writing a document

A document here is one Markdown file. Desktop shows it beside the conversation
as a page, with an outline, and the person can copy it or open it in their own
program. Write the file, then say in one reply what you made.

## What is not available yet

Word (`.docx`), PDF, slides and spreadsheet files cannot be made yet. If the
person asks for one, say so in one plain sentence, write the Markdown file
instead, and tell them they can paste or open it in the program they use. Do
not write a script that needs a library the machine may not have, and do not
pretend a Markdown file is a Word file.

## Steps

1. **Settle the few things that change the document.** Who reads it, what they
   should do after reading it, and how long it should be. If the request
   already says, do not ask. If one answer would change the whole document,
   ask one short question; otherwise pick a sensible default, write the
   document, and list the guesses at the end of the reply.
2. **Choose the title and the file name.** The title is plain and specific
   ("Project kickoff: Billing rewrite", not "Document"). The file name is the
   title in words: `Project kickoff - Billing rewrite.md`. Keep letters,
   numbers, spaces, hyphens and underscores; no slashes or colons. If a file
   of that name exists and the person did not ask to change it, add a number
   (`... 2.md`) rather than replacing it.
3. **Choose the folder.** Put it in the project folder, beside the work. If
   the project already has a folder for documents (`docs`, `documents`),
   use it. With no project, use the folder this conversation works in. Never
   write outside those folders.
4. **Write the whole file with one `write` call.** Use this shape:
   - First line: `# Title`.
   - Second line, in italics: the date and, when known, who it is for or from
     (`*18 November 2026 · For the product team*`). Use today's date from the
     conversation; never invent one.
   - A short opening paragraph: what this is and what the reader needs to
     decide or do.
   - Sections with `##` headings, in the order the reader needs them. Two to
     four short paragraphs or one list under each. Use `###` only when a
     section truly has parts.
   - Lists for steps, options and owners. Numbered lists when order matters.
   - A table when you compare things or list owners, dates or amounts: a
     header row, the same number of cells in every row, short cells.
   - Task lists (`- [ ] item`) for actions someone must do.
   - Images only if the person gave you the file: a relative link to it.
5. **Read it back once.** Use `read` on the file. Check that heading levels do
   not skip, no heading is empty, every table row has the same number of
   cells, and nothing says "TBD" without a reason. Fix what you find with
   `edit` and say nothing about the fixes.

## Writing well

- Lead with the point. The first paragraph says what the reader most needs.
- Short sentences, plain words, the reader's words rather than the project's
  internal names. Explain a short form the first time it appears.
- Specific beats general: a date, a number, a name, a next step.
- Do not pad. A section with nothing to say is left out, not filled.
- Do not invent facts, figures, names or dates. When you do not know, write
  what is needed in the document as an open question, in brackets, for example
  `[Owner to confirm: launch date]`, and list it in the reply.
- Keep one voice from top to bottom.

## The reply

Keep it short, and in this order:

1. One sentence that names the document by its title as a link to the file, for
   example: `I wrote [Project kickoff - Billing rewrite](Project kickoff - Billing rewrite.md).`
   Write the link once, in the first sentence. Do not paste the document into
   the reply.
2. **Assumptions** — a short list of what you took as given.
3. **Open questions** — a short list of what the person should settle, if any.

Leave out a list that would be empty. Offer one next step at most ("I can shorten
it to one page"). Do not describe how you worked.

## When asked to change a document

Read the file first, change only what was asked with `edit`, and keep its
title, headings and wording elsewhere. Say what changed in one sentence.
Update the date line only if the person asks.

## Never

- Write a document into a folder the project does not own.
- Replace an existing file the person did not ask to change.
- Claim a Word, PDF, slide or spreadsheet file exists when you wrote Markdown.
