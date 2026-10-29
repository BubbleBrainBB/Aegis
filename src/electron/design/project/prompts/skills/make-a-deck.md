---
name: make-a-deck
title: Make a deck
description: Slide presentations in HTML
---
Make a slide deck as one HTML file.

## The stage
- Every slide is a fixed 1920×1080 canvas (16:9) unless the user asks for another size, as a direct child `<section data-screen-label="01 Title">` of one stage element. Label each slide with its two-digit number and a short name; "slide 5" means label 05, never index 4.
- A small script scales the stage to fit the viewport: compute `Math.min(innerWidth/1920, innerHeight/1080)`, apply it with `transform: scale()` on the slide wrapper, recompute on resize, and letterbox on a dark background.
- Show one slide at a time. Arrow keys, Page Up/Down and space move between slides, and clicks on the left and right thirds too. Previous/next buttons and a "3 / 12" counter sit outside the scaled element, so they stay usable on small screens, and fade out after a moment without mouse movement.
- Keep the current slide in the URL hash (`#5`), so a refresh keeps the place.
- Print: under `@media print`, show every slide, one per page, at full size (`@page { size: 1920px 1080px; margin: 0 }`, `break-after: page`, no transform), with any entrance animation at its end state.
- Speaker notes only when the user asks for them.

## Writing slides
- One idea per slide. Titles say the point, not the topic ("Churn halved after onboarding v2", not "Churn").
- Projected text: never below 24px; body usually 32–40px, titles 64–96px, a single big number 160px or more.
- Decide the deck's system before writing slides, and say it: a layout for each kind of slide (cover, section opener, title and body, big number, quote, image and caption, comparison, closing), one or two background colors at most, one type pairing. Vary layouts with rhythm (a full-bleed image or color slide every few slides) instead of the same title-and-bullets frame throughout.
- Text-heavy slides get imagery: the user's images, a diagram built in HTML and CSS, or a placeholder that says what belongs there.
- Prefer real diagrams (HTML and CSS boxes and arrows, or SVG charts drawn from the actual numbers) to bullet lists for structure, process and data.
- Animations are optional. When you add entrance builds, make the visible end state the base style and gate the animation on the active slide and `prefers-reduced-motion: no-preference`; no endless decorative loops.

## Planning
1. Agree on audience, length, tone and the story with the user (ask unless the request already says).
2. Write the outline as slide titles first, and check it reads as a story on its own.
3. Build the stage, then the slides in order.
4. Check: no text overflows its slide, nothing below 24px, every slide has a label, keyboard navigation works.
