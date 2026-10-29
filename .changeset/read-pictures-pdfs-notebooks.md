---
'@namzu/sdk': major
---

The built-in `read` tool now reads pictures, PDFs and notebooks instead of refusing them. A PNG, JPEG or WebP comes back as the picture (checked and fitted as `view_image` does); a PDF comes back as page images through the new optional `pages` argument (`"3"` or `"1-5"`, at most 20 pages per request; a PDF of more than 10 pages needs it) using poppler's `pdftoppm` and `pdfinfo`, and says to install poppler-utils when they are missing; a `.ipynb` comes back as its cells with their printed output. A text file that only has a picture name is still read as text. This changes the default result for those paths: image/PDF refusals become media results, and notebook JSON becomes rendered cells. Callers that require raw notebook JSON should read it through their own text-file tool; callers matching the old media refusal must accept and render the returned content blocks.
