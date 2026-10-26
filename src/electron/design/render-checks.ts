/**
 * Checks run on a rendered board before it is captured, so design_preview can
 * tell the agent what the screenshot alone might not: text drawn over other
 * text, content cut off by a clipping container, a page that renders empty,
 * content wider or taller than the board, images that failed to load.
 *
 * Geometry finds only these kinds of defect; the agent still judges the
 * screenshot. Overflow that is clearly intended (ellipsis, line clamps,
 * scrolling regions) is not reported. Budgets keep big boards fast.
 */
export const MAX_FINDINGS_PER_KIND = 4;

/** A self-contained script for the board's page; resolves to warning strings. */
export function renderChecksScript(width: number, height: number): string {
  return `(async () => {
  await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => i.decode().catch(() => null)));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const W = ${Math.round(width)}, H = ${Math.round(height)}, MAX = ${MAX_FINDINGS_PER_KIND};
  const out = [];
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    const name = el.getAttribute("data-aegis-layer-name") || (el.classList[0] ? el.tagName.toLowerCase() + "." + el.classList[0] : el.tagName.toLowerCase());
    return text ? name + ' "' + text + '"' : name;
  };
  const root = document.body;
  const doc = document.documentElement;

  // A deck's slide: text below 24px is hard to read projected.
  if (document.querySelector("[data-aegis-deck]")) {
    const small = [...root.querySelectorAll("*")].filter((el) => visible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 24);
    if (small.length) out.push("Slide text under 24px (" + small.slice(0, MAX).map((el) => label(el) + " " + Math.round(parseFloat(getComputedStyle(el).fontSize)) + "px").join(", ") + "): too small to read projected.");
  }

  // Empty: nothing visible with text or size.
  const any = [...root.querySelectorAll("*")].some((el) => visible(el) && (el.textContent.trim() || ["IMG", "SVG", "svg"].includes(el.tagName)));
  if (!any) out.push("The board renders empty: nothing visible is drawn.");

  // Bigger than the board.
  if (doc.scrollWidth > W + 2) out.push("Content is wider than the board (" + doc.scrollWidth + " > " + W + "px): something overflows horizontally.");
  if (doc.scrollHeight > H + 2) out.push("Content is taller than the board (" + doc.scrollHeight + " > " + H + "px): grow the board's height or tighten the layout.");

  // Images that did not load.
  const broken = [...document.images].filter((i) => !i.naturalWidth);
  if (broken.length) out.push(broken.length + " image" + (broken.length === 1 ? "" : "s") + " could not be loaded.");

  // Text elements: those with their own non-blank text.
  const texts = [];
  for (const el of root.querySelectorAll("*")) {
    if (texts.length >= 400) break;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) texts.push({ el, r });
  }

  // Text drawn over other text (not nested in each other).
  let overlaps = 0;
  for (let i = 0; i < texts.length && overlaps < MAX; i++) {
    for (let j = i + 1; j < texts.length && overlaps < MAX; j++) {
      const a = texts[i], b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 4 && h > 4) {
        overlaps++;
        out.push("Text overlaps: " + label(a.el) + " and " + label(b.el) + ".");
      }
    }
  }

  // Clipped: a hidden-overflow container cutting off its own text.
  let clipped = 0;
  for (const el of root.querySelectorAll("*")) {
    if (clipped >= MAX) break;
    const s = getComputedStyle(el);
    const clips = (v) => v === "hidden" || v === "clip";
    if (!clips(s.overflowX) && !clips(s.overflowY)) continue;
    if (s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none")) continue;
    if (!visible(el) || !el.textContent.trim()) continue;
    const cutX = clips(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const cutY = clips(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (!cutX && !cutY) continue;
    const box = el.getBoundingClientRect();
    const lost = texts.some((t) => el.contains(t.el) && (t.r.right > box.right + 1 || t.r.bottom > box.bottom + 1 || t.r.left < box.left - 1 || t.r.top < box.top - 1));
    if (!lost) continue;
    clipped++;
    out.push("Text is cut off inside " + label(el) + " (overflow is hidden).");
  }
  return out;
})()`;
}
