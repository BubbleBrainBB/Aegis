---
name: hi-fi-design
title: Hi-fi design
description: Polished, production-quality mockups
---
Make a high-fidelity, polished design.

Follow this process, and put it on your todo list:
1. Ask questions.
2. Find the existing UI kits and collect design context. Copy every relevant component and read every relevant example; ask the user when you can't find them.
3. Start the file with your assumptions, the context you found and your design reasoning, written as a junior designer would report to their manager, with placeholders where the designs will go. Show it to the user early (`design_show`).
4. Build the designs out and show the user again as soon as you can, with a few next steps.
5. Check, verify and iterate (`design_ready`).

Good hi-fi designs don't start from scratch: they grow out of existing design context. Ask the user to point you at their codebase, to share screenshots of the existing product, or to name a UI kit or design resources. In a code project, look yourself: components, styles, tokens, theme and Tailwind config, brand assets, existing pages. You must spend real effort acquiring this context, components included; when you can't find it, ask. Mocking up an entire product from nothing is the last resort and leads to poor design. When stuck, list the project's files and look for design assets, and be proactive about it. Some designs need several design systems; gather all of them. Use the starter components (`design_starter_copy`) for device frames, window chrome and the comparison canvas.

When you present several options side by side, use the `design_canvas.jsx` starter so each option is a labeled artboard on a neutral, pannable canvas. If the user has to pick one before work can continue, ask them which (see "Asking") rather than treating the canvas itself as the answer.

Asking many good questions is essential.

Give options: aim for three or more variations across several dimensions. Mix by-the-book designs that follow existing patterns with new and novel interactions: interesting layouts, metaphors and visual styles. Make some options use color or advanced CSS; some with iconography and some without. Start basic and get more advanced and creative as you go. Remix the brand's assets and visual DNA in interesting ways: play with scale, fills, texture, visual rhythm, layering, novel layouts and type treatments. The goal isn't the one perfect option; it is atomic variations the user can mix and match. Every option should differ from the others along an axis you can name: five shades of one idea are not a choice.

CSS, HTML, JavaScript and SVG can do remarkable things, and users often don't know what is possible. Surprise them.

When you don't have an icon, asset or component, draw a placeholder: in hi-fi work a clean placeholder beats a bad attempt at the real thing. Photography always goes in an image placeholder the user can replace, never a CSS background picked at random.
