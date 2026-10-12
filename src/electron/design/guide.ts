/**
 * Design guidance the agent reads on demand through design_guide. The tool
 * descriptions say what the canvas allows; this is about making the work good.
 * Adapted from the Bubble desktop app's design skill.
 */
export const DESIGN_GUIDE_TOPICS = ['treatment', 'structure', 'tokens', 'type', 'color', 'avoid', 'content', 'review'] as const;
export type DesignGuideTopic = (typeof DESIGN_GUIDE_TOPICS)[number];

const sections: Record<DesignGuideTopic, string> = {
  treatment: `## Read the request first
Decide the treatment before drawing anything. When the user names a direction, their words win over everything here.
- Product UI (settings, dashboards, flows, admin, most app screens): calm and precise. Real hierarchy, consistent spacing, a restrained palette. No hero, no decoration.
- Editorial (landing pages, launches, portfolios, campaign pages): a clear point of view, one bold idea, everything around it quiet.
- Unsure: a well-composed, restrained page is always acceptable; an over-designed one often isn't.
Settle three things in one line each before the first board: the subject, who it is for, and the single job of the page.

## Start from what already exists
Precedence: the user's words, then the style guide in <design_context>, then the project's own design system (design_resources lists its components and templates), then your choices.
- When the project has a template that fits, start from it (design_resources), not from a blank page; keep its structure and components and replace its sample copy.
- In a code project, look for its system first: Tailwind config, CSS variables or theme files, a tokens file, component styles, brand assets. Reuse its colors, type, radii and spacing so the design can be built with what the codebase already has.
- If the design already has boards, match them: same tokens, type scale, spacing rhythm and component shapes.
- Keep layer names and structure stable when revising, so comments and selections still point at the right things.

## Boards
- One board per page or screen. Name boards by what people call them: "Home", "Pricing", "Checkout · Mobile".
- Default sizes: desktop 1440 wide, laptop 1280, tablet 768, phone 390 (844 tall for one screen). Let height follow the content for scrolling pages.
- Responsive variants are separate boards with the same content, not a squeezed copy.
- When <design_context> asks for several variations, make that many boards side by side, each a distinct direction, named "Home · A", "Home · B".
- Build one board at a time: add it, preview it, then do the next.
- For several pages, finish one representative board first and settle its type, spacing and components there; then build the others from it.
- When something is unclear but doesn't change the goal, make a sensible assumption, say it in one line, and keep going. Ask only when the answer would change what you build.`,
  structure: `## Structure that edits well
People edit these boards by hand: they reorder, resize, change spacing and text.
- Use semantic sections (header, nav, main, section, footer) and give meaningful layers a data-aegis-layer-name ("Hero", "Pricing card", "Primary CTA").
- Lay out sibling groups with flex or grid and gap. Avoid per-element margins between siblings; they collapse and fight the spacing handles.
- Avoid absolute positioning except for true overlays (badges, floating decorations, sticky bars). Never position a whole layout absolutely.
- Avoid fixed heights on text containers; let content set height.
- Use readable class names (.pricing-card, not .c3); the Code panel shows them.
- Text people will edit sits directly in its own element (an h1, a p, a span), not split across many inline fragments.

## Authored Tweaks
For useful board-level controls, put a data-aegis-tweaks JSON attribute on the body with version:1 and controls. Each control has a unique name, editor (text/color/int/float/range/boolean/enum), optional section, and target {nodeId,kind:"style",property} or {nodeId,kind:"text"}. nodeId must match a stable data-aegis-node-id. Text targets must be editable leaf nodes; styles use supported inline CSS properties. Numeric styles can set min/max/step and unit (for example px). Boolean styles require target.on and target.off values; enum controls require options [{label,value}]. No scripts or executable expressions. Set initial text or inline styles on the actual targets; these are the source of truth. Offer a few meaningful controls, not every CSS field. Example JSON: {"version":1,"controls":[{"name":"Accent","editor":"color","target":{"nodeId":"headline","kind":"style","property":"color"}},{"name":"Title","editor":"text","target":{"nodeId":"headline","kind":"text"}}]}. HTML-escape this JSON when putting it in an attribute.

## Pages and canvas annotations
Pages group boards and annotations; screens remain individual boards. Preserve existing pages, marks and pageId membership when editing. New boards belong to the current pageId reported in design_context. A missing/invalid membership belongs to the first page. User notes and drawings are feedback: keep them unless asked to change them.

## Changing what exists
- Change only what the request needs. Leave other layers, colors, type and spacing as they are, and keep layer ids and names.
- A change to one element is not a change to the system: edit a shared token or class only when the request is meant to apply everywhere.
- Turning absolutely positioned layers into auto layout is a re-layout, not a conversion: decide direction, gap, padding, sizing and wrapping on purpose, then check reading order and the result.
- Prefer text that grows with its content; give a fixed height only to regions that are meant to clip, scroll or keep a ratio. Never hide an accidental overflow with overflow: hidden.`,
  tokens: `## Tokens first
Before the first board, write a compact token set as CSS variables on :root and derive every color and type decision from it:
- Color: 4–6 named tokens (background, surface, text, muted text, accent, and a line color if needed).
- Type: font tokens for each role (display, body, and a utility face for numbers or captions if useful) and a type scale you keep to.
- A one-line comment above them naming the layout idea.
Reuse the same tokens on every board in the design.`,
  type: `## Typography
- Remote fonts don't load on the canvas. Use system stacks, or inline a font as a data-URL @font-face only when the brand truly needs it.
  - Sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif
  - Serif: "New York", Georgia, "Songti SC", "Noto Serif SC", serif
  - Mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace
- For Chinese text, keep body line-height around 1.6–1.8 and avoid letter-spacing on CJK; reserve tight negative tracking for Latin display type.
- Running text near 65 Latin characters (about 30–40 CJK characters) per line.
- A real scale with few steps; headings with text-wrap: balance; uppercase labels with a little letter-spacing; font-variant-numeric: tabular-nums where digits line up.`,
  color: `## Color and surfaces
- Choose neutrals deliberately. A grey with a slight bias toward the accent looks intentional; pure mid-grey looks unconsidered.
- One accent, used with intent. Semantic colors (success, warning, error) are separate from it.
- Use borders, fills, radius and shadow by role, to set off the one element that needs it. The same radius and shadow on every block flattens the page.
- Check contrast: body text at least 4.5:1 against its background.`,
  avoid: `## Avoid the generated look
Don't use these unless the user asks:
- Purple-to-blue gradient heroes, gradient text on headlines, glowing blurred blobs or floating spheres as filler.
- Warm cream with a serif display and a terracotta accent; near-black with a single neon accent.
- Everything centered; a giant hero filling the first screen with little content.
- Rounded cards with soft shadows everywhere; colored accent bars on the side of cards.
- Emoji as icons or section markers; three identical feature cards with an icon, a title and two lines.
- Numbered markers (01 / 02 / 03) on things that aren't a real sequence.
- Inter or Space Grotesk as the default face.
Instead, ground the design in the subject: its real content, units, terms and conventions. Include at least one detail only this subject would have.`,
  content: `## Content and images
- Real content only, never lorem ipsum. Use plausible names, numbers and copy from the subject's world.
- Try realistic lengths: a long name, mixed Chinese and English, a big number, a long link. Show the states the page needs (an empty list, a loading area, an error in a form), not every state of everything.
- Images: inline SVG illustrations or icons, CSS shapes, or small data-URL images. No remote images.
- Draw icons as simple inline SVG with one stroke width, sized to the text they sit beside.

## Writing the copy
- Write from the user's side of the screen: name things by what people recognize.
- Buttons say exactly what happens ("Start free trial", "Save changes").
- Short, plain sentences. Avoid em-dash asides, "not X but Y" framing and stock phrases.
- Match the language the user writes in.`,
  review: `## Check once with a preview
After each board, preview it once. The preview lists what it measured (text over other text, text cut off by a clipping box, an empty page, content wider or taller than the board, images that failed): treat these as leads, then look at the screenshot yourself for what geometry can't see: misaligned edges in repeated items, low contrast, an empty or stretched area, weak hierarchy, and anything from "Avoid the generated look". Fix the cause in one pass (not by shrinking text or hiding content), then move on. Don't loop on previews; the user reviews and comments on the canvas.

## When you finish
Say what you made, the decisions that matter, what you checked (previews, warnings fixed) and what you did not verify. Only call something checked if you actually checked it.`,
};

export const DESIGN_GUIDE_DESCRIPTION =
  `Read design guidance before creating or reworking boards with the design tools: treatment, board sizes, HTML structure that edits well, tokens, type, color, patterns to avoid, content and review. Pass topics to read only some (${DESIGN_GUIDE_TOPICS.join(', ')}); omit them for all. Also returns the style guide the user picked for this design, if any.`;

export function designGuideText(topics?: readonly string[], styleGuide?: { name: string; text: string } | null): string {
  const wanted = topics?.length
    ? DESIGN_GUIDE_TOPICS.filter((topic) => topics.includes(topic))
    : DESIGN_GUIDE_TOPICS;
  const parts = (wanted.length ? wanted : DESIGN_GUIDE_TOPICS).map((topic) => sections[topic]);
  if (styleGuide) {
    parts.unshift(
      `## Style guide: ${styleGuide.name}\nThe user picked this style for the design. It wins over the general guidance below; their own words still win over it.\n\n${styleGuide.text.trim()}`,
    );
  }
  return `# Designing on the Aegis canvas\n\n${parts.join('\n\n')}`;
}
