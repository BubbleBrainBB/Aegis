/**
 * Design guidance the agent reads on demand through design_guide. The tool
 * descriptions say what the canvas allows; this is about making the work good.
 * Adapted from the Bubble desktop app's design skill.
 */
export const DESIGN_GUIDE_TOPICS = ['treatment', 'options', 'structure', 'components', 'decks', 'tokens', 'type', 'color', 'avoid', 'content', 'review'] as const;
export type DesignGuideTopic = (typeof DESIGN_GUIDE_TOPICS)[number];

const sections: Record<DesignGuideTopic, string> = {
  treatment: `## Read the request first
Decide the treatment before drawing anything. When the user names a direction, their words win over everything here.
- Product UI (settings, dashboards, flows, admin, most app screens): calm and precise. Real hierarchy, consistent spacing, a restrained palette. No hero, no decoration.
- Editorial (landing pages, launches, portfolios, campaign pages): a clear point of view, one bold idea, everything around it quiet.
- Consumer and brand products (fitness, music, food, travel, kids, lifestyle): commit to an aesthetic direction that fits the subject, light or dark. A dominant color with sharp accents beats a timid, evenly spread palette.
- Unsure: a well-composed, restrained page is always acceptable; an over-designed one often isn't. Restrained means few colors and calm type, not a grey page.
- Don't converge: when nothing sets the direction, vary light and dark, palette and type between designs instead of reaching for the same safe neutral every time.
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
- When a screen should read as a real device or app (a flow, a concept, a presentation), frame it with design_starter (ios-phone, android-phone, browser-window, macos-window) and design only what goes in its content layer. Never hand-draw bezels, status bars, browser toolbars or title bars; a half-right frame cheapens the whole board. A bare board at the device size is fine when the user just wants the screen.
- When <design_context> asks for several variations, make that many boards side by side, each a distinct direction, named "Home · A", "Home · B". That is for whole-page directions; a question about one part of a screen gets an option sheet (see Option sheets).
- Build one board at a time: add it, preview it, then do the next.
- For several pages, finish one representative board first and settle its type, spacing and components there; then build the others from it.
- When something is unclear but doesn't change the goal, make a sensible assumption, say it in one line, and keep going. Ask only when the answer would change what you build.`,
  options: `## Option sheets
When the user asks how one part of a screen should look or work ("how should the three pages switch", "how should the selected option show"), or a local decision has several good answers, don't settle it silently: lay the candidates out on one option sheet, so they can compare them and mix parts.
- One board per round, about 1200 wide, height following the content. Name it with the round number, the question and the options in brief, within 120 characters: "Round 1 · Settings page switching (1a title tabs · 1b More row · 1c cards)".
- Open with the question as a heading and a short paragraph: what is wrong now, what stays fixed in every option, and which one you would pick and why, if you have a view.
- Give every option a stable id, round number plus letter (1a, 1b, 1c…), as a small badge on its card. Ids never change and are never reused; use them in chat ("1b") and expect the user to.
- Three or more options, each an atomic variation: change one thing and hold everything else constant. Run from the by-the-book version to more novel ones. Lay them out in a two-column grid, or one row when there are only two or three narrow ones.
- Each card: badge and a short name, one or two sentences on what it does and what it trades off, then a mini mock of the real screen showing only that change. Build mocks from the product's real copy, type and colors (read the codebase or the existing boards first), not a generic stand-in.
- If you recommend one, mark it as recommended in the user's language and set it off lightly (a faint tint). A short details block for it after the grid helps whoever builds it: type and color values, states, keyboard, what it removes, narrow widths. Skip the recommendation when you have no real preference.
- End the board with one line of two or three next steps the user could say, using ids ("1a with the dot from 1b", "push 1c further", "new directions").
- A new round is a new board beside the last; leave earlier rounds as they are. A round built on a pick says so: "Round 2 · Riffs on 1a".`,
  structure: `## Structure that edits well
People edit these boards by hand: they reorder, resize, change spacing and text.
- Use semantic sections (header, nav, main, section, footer) and give meaningful layers a data-aegis-layer-name ("Hero", "Pricing card", "Primary CTA").
- Lay out sibling groups with flex or grid and gap. Avoid per-element margins between siblings; they collapse and fight the spacing handles.
- Avoid absolute positioning except for true overlays (badges, floating decorations, sticky bars). Never position a whole layout absolutely.
- Avoid fixed heights on text containers; let content set height.
- Use readable class names (.pricing-card, not .c3); the Code panel shows them.
- Text people will edit sits directly in its own element (an h1, a p, a span), not split across many inline fragments.

## Authored Tweaks
For useful board-level controls, put a data-aegis-tweaks JSON attribute on the body with version:1 and controls. Each control has a unique name, editor (text/color/int/float/range/boolean/enum), optional section, and target {nodeId,kind:"style",property} or {nodeId,kind:"text"}. nodeId must match a stable data-aegis-node-id. Text targets must be editable leaf nodes; styles use supported inline CSS properties. Numeric styles can set min/max/step and unit (for example px). Boolean styles require target.on and target.off values; enum controls require options [{label,value}]. No scripts or executable expressions. Set initial text or inline styles on the actual targets; these are the source of truth. Offer a few meaningful controls, not every CSS field. Example JSON: {"version":1,"controls":[{"name":"Accent","editor":"color","target":{"nodeId":"headline","kind":"style","property":"color"}},{"name":"Title","editor":"text","target":{"nodeId":"headline","kind":"text"}}]}. Only this attribute's JSON is escaped: write its double quotes as &quot; (or wrap the attribute in single quotes). The rest of the board is plain markup with literal < and >, never entities.

## Pages and canvas annotations
Pages group boards and annotations; screens remain individual boards. Preserve existing pages, marks and pageId membership when editing. New boards belong to the current pageId reported in design_context. A missing/invalid membership belongs to the first page. User notes and drawings are feedback: keep them unless asked to change them.

## Changing what exists
- Change only what the request needs. Leave other layers, colors, type and spacing as they are, and keep layer ids and names.
- A change to one element is not a change to the system: edit a shared token or class only when the request is meant to apply everywhere.
- Turning absolutely positioned layers into auto layout is a re-layout, not a conversion: decide direction, gap, padding, sizing and wrapping on purpose, then check reading order and the result.
- Prefer text that grows with its content; give a fixed height only to regions that are meant to clip, scroll or keep a ratio. Never hide an accidental overflow with overflow: hidden.`,
  components: `## Interactive boards (design components)
A board can respond in Play: switch tabs, open a menu, step through a flow, go to another board. Keep a board template-only unless that behaviour is what the user is judging; layout and visual work never needs logic.
A board has up to three parts, set with design_update (add/content take html, js and props together):
- Template: the board HTML, as for any board. Directives make it dynamic:
  - {{ expr }} in text or attribute values, e.g. <h1>{{ title }}</h1>, class="tab {{ tab === 'week' ? 'is-active' : '' }}".
  - data-aegis-if="expr", and data-aegis-else on the element right after it.
  - data-aegis-for="item in items" or "(item, i) in items" repeats the element (a number repeats it that many times); data-aegis-key="item.id" keeps items stable.
  - data-aegis-on-click="select('month')" (also input, change, submit, keydown, mouseenter, mouseleave…) runs a method or assigns state: data-aegis-on-click="open = !open".
  - data-aegis-bind-ATTR="expr" sets an attribute to a value (checked, disabled, style or class objects).
  - data-aegis-goto="Board name" makes the element go to that board in Play.
- Logic (js): one class, class Board extends AegisBoard { state = {…}; methods; values() { return {…} } }. this.props, this.state and this.setState({…}) work as in React; mounted(), updated() and unmounted() are lifecycle hooks; values() adds computed names for the template. Methods and state keys are names in the template.
- Props (props): {"items":{"type":"list","default":[…]},"title":{"type":"string","default":"…"}}; types string, number, boolean, color, enum (with options), image, list, object. "$preview" overrides values for the canvas. Props make sample data editable without touching markup.
Rules:
- Logic runs in a sandbox with no network, storage or host access: no fetch, timers only for animation or demo state. Put sample data in props, not in logic.
- Keep data-aegis-node-id on template elements as usual; repeated items share their template layer, so a hand edit applies to every item.
- On the canvas, logic runs but input goes to the editor; Play (and exported HTML) is where it responds. design_preview reports logic errors as warnings; fix them before you finish.
- Change logic with logic_patch for small edits, props with props, and the template with patch, as you would any board.`,
  decks: `## Decks (slides)
A deck is one board, sized as a slide (1920 × 1080 unless asked otherwise), whose deck element holds the slides:
<main data-aegis-deck style="width:100%;height:100%">
  <section data-aegis-slide data-aegis-notes="What to say on this slide">…</section>
  <section data-aegis-slide>…</section>
</main>
- Slides are the deck element's direct children; nothing else goes there (no loops or components as slides), so the canvas, thumbnails, notes and the presenter view line up with the source.
- Each slide fills the board (width and height 100%, its own padding); the canvas shows one at a time with ‹ › in the board's label, Play steps through them, and the presenter view shows the next slide and the notes.
- Projected text: 24px at the very least, body 28–36px, titles 56–96px. design_preview flags slide text under 24px.
- One idea per slide; put what the speaker says in data-aegis-notes rather than on the slide.
- design_preview takes a slide index to render any slide; design_verify looks at every slide. PDF and PowerPoint exports have a page or slide per deck slide, notes included.`,
  tokens: `## Tokens first
Before the first board, write a compact token set as CSS variables on :root and derive every color and type decision from it:
- Color: a handful of named tokens: background (a subtly toned white or black), text, muted text, line, and 0–2 accents; add a surface only where the page really layers, not as a darker page under white cards.
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
- Pick a tone (warm, cool or neutral) and carry it in subtly toned whites and blacks. A light page is a white with at most a hint of tint (oklch chroma 0.02 or less, lightness about 0.97 or more); a dark page is a near-black. Separate layers with hairlines, spacing and soft shadow, not by darkening the page: a light grey page under white cards reads dull. A grey page is a deliberate platform pattern (iOS grouped settings), never the default.
- Accents: 0–2, defined in oklch with the same lightness and chroma and different hues, so they sit together; use them with intent. Semantic colors (success, warning, error) are separate.
- With a brand, style guide or design system, use its colors; when they are too narrow, extend them in oklch to match rather than inventing unrelated ones.
- Use borders, fills, radius and shadow by role, to set off the one element that needs it. The same radius and shadow on every block flattens the page.
- Check contrast: body text at least 4.5:1 against its background.`,
  avoid: `## Avoid the generated look
Don't use these unless the user asks:
- Purple-to-blue gradient heroes, gradient text on headlines, glowing blurred blobs or floating spheres as filler.
- Warm cream with a serif display and a terracotta accent; near-black with a single neon accent; a light grey page under white cards as the default look.
- Everything centered; a giant hero filling the first screen with little content.
- Rounded cards with soft shadows everywhere; colored accent bars on the side of cards.
- Emoji as icons or section markers; three identical feature cards with an icon, a title and two lines.
- Numbered markers (01 / 02 / 03) on things that aren't a real sequence.
- Inter or Space Grotesk as the default face.
These are about pages and products; on an option sheet, matching cards and letter ids are its structure, not decoration.
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
Call design_verify once the request's boards are drawn and previewed: it runs the checks and a separate visual review. Fix what it reports and verify again (at most twice). Then say what you made, the decisions that matter, what you checked (previews, warnings fixed) and what you did not verify. Only call something checked if you actually checked it.`,
};

export const DESIGN_GUIDE_DESCRIPTION =
  `Read design guidance before creating or reworking boards with the design tools: treatment, board sizes, option sheets for comparing candidates, HTML structure that edits well, interactive boards (template directives, logic and props), decks (slides with speaker notes), tokens, type, color, patterns to avoid, content and review. Pass topics to read only some (${DESIGN_GUIDE_TOPICS.join(', ')}); omit them for all. Also returns the style guide the user picked for this design, if any.`;

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
