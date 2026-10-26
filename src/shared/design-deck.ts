import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

/**
 * A deck is a board whose deck element (data-aegis-deck) holds slides as
 * its direct children (data-aegis-slide), each with optional speaker notes
 * (data-aegis-notes). The board's size is the slide size. One slide shows at
 * a time: the host picks it with a frame-owned stylesheet, never by editing
 * the board, so source slides and shown slides always match one to one.
 */

type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export interface DesignSlide {
  /** The slide's layer id. */
  id: string;
  index: number;
  /** Its first heading (or first text), for lists and thumbnails. */
  title: string;
  notes: string;
}

const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;
const isElement = (n: DefaultTreeAdapterMap["node"]): n is Element => "tagName" in n;

export function isDesignDeck(html: string): boolean {
  return /\sdata-aegis-deck(?:[\s=>])/i.test(html);
}

function findDeck(parent: ParentNode): Element | undefined {
  for (const n of parent.childNodes) {
    if (!isElement(n)) continue;
    if (n.attrs.some((a) => a.name === "data-aegis-deck")) return n;
    const hit = findDeck(n);
    if (hit) return hit;
  }
  return undefined;
}

function textOf(e: Element): string {
  return e.childNodes.map((n) => ("value" in n && n.nodeName === "#text" ? n.value : isElement(n) ? textOf(n) : "")).join(" ");
}
function firstHeading(e: Element): Element | undefined {
  for (const n of e.childNodes) {
    if (!isElement(n)) continue;
    if (/^h[1-6]$/.test(n.tagName)) return n;
    const hit = firstHeading(n);
    if (hit) return hit;
  }
  return undefined;
}

const slidesOf = (deck: Element) => deck.childNodes.filter(isElement).filter((n) => n.attrs.some((a) => a.name === "data-aegis-slide"));

const slideCache = new Map<string, DesignSlide[]>();
/** A deck's slides, in order (cached by HTML: the canvas asks on every render). */
export function designSlides(html: string): DesignSlide[] {
  const hit = slideCache.get(html);
  if (hit) return hit;
  const slides = readSlides(html);
  slideCache.set(html, slides);
  if (slideCache.size > 64) slideCache.delete(slideCache.keys().next().value as string);
  return slides;
}
function readSlides(html: string): DesignSlide[] {
  const deck = findDeck(parse(html));
  if (!deck) return [];
  return slidesOf(deck).map((s, index) => {
    const heading = firstHeading(s);
    const title = (heading ? textOf(heading) : textOf(s)).replace(/\s+/g, " ").trim().slice(0, 80);
    return { id: attr(s, "data-aegis-node-id") ?? "", index, title: title || `Slide ${index + 1}`, notes: attr(s, "data-aegis-notes") ?? "" };
  });
}

/** Replaces one slide's speaker notes (empty removes them). */
export function setDesignSlideNotes(html: string, slideId: string, notes: string): string {
  const doc = parse(html);
  const deck = findDeck(doc);
  const slide = deck && slidesOf(deck).find((s) => attr(s, "data-aegis-node-id") === slideId);
  if (!slide) throw new Error("That slide no longer exists.");
  slide.attrs = slide.attrs.filter((a) => a.name !== "data-aegis-notes");
  const text = notes.replace(/\r\n/g, "\n").slice(0, 10_000);
  if (text.trim()) slide.attrs.push({ name: "data-aegis-notes", value: text });
  return serialize(doc);
}

/** The frame stylesheet that shows slide `index` (0-based) and hides the rest. */
export function deckSlideCss(index: number): string {
  const n = Math.max(0, Math.floor(index)) + 1;
  return `[data-aegis-deck]>[data-aegis-slide]:not(:nth-child(${n} of [data-aegis-slide])){display:none!important}`;
}
