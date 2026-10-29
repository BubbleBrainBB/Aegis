---
name: make-a-doc
title: Make a doc
description: Page-style documents, printable as they are
---
Make a document: a résumé, one-pager, memo, letter, report, guide or paper. First decide which of two shapes the user wants; they print completely differently.

## Flowing pages
Text that pours onto standard sheets (Letter or A4) and breaks wherever it needs to: reports, memos, letters, papers, guides.
- Write the document as normal flowing HTML inside one centered column the width of the sheet (Letter 8.5in, A4 210mm) on a quiet "desk" background on screen.
- Add one `@page { size: letter; margin: 0.75in }` rule (or `A4`), and under `@media print` drop the desk background, shadows and the column's screen padding, so printing gives clean sheets.
- Multi-column text uses CSS columns (`column-count`, `column-gap`, `column-span: all` for a heading that spans, `hyphens: auto` in narrow columns with `lang` set on the html element), never side-by-side flex or grid columns: only real columns flow and break across pages.
- `break-before: page` on anything that must start a new page (a chapter, an appendix). Keep headings with what follows (`break-after: avoid`), keep figures, code blocks and table rows whole (`break-inside: avoid`), and keep each kept-together block shorter than a page. Set `orphans: 3; widows: 3`.
- Long tables get a `<thead>` so the header repeats on every page.
- No `position: fixed` or `sticky` and no viewport units in the content: fixed elements stamp every printed page, and `100vh` mis-sizes in print.

## Fixed sheet
A design that fills exactly one page of fixed size: a poster, an infographic, a social graphic, a certificate. Build it at its true pixel size, with an explicit px `width` (and `height` when fixed) on the top-level element. No `@page` rule.

## Styling (both shapes)
Body type 14–16px with generous line-height (1.55–1.7); a clear heading hierarchy; a restrained palette. Tables get a header row and hairline borders; figures and code blocks each get a short caption. Open with the document's own h1 as the first element of the body; if the user pasted content whose first line is a heading, that line is the h1, not a separate masthead.
