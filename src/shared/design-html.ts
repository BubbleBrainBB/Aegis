import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

import { normalizeDesignLayers } from "./design-layers";
import { DESIGN_LOGIC_TYPE, DESIGN_PROPS_TYPE } from "./design-component";

const tags = new Set(
  "html head body title style script div main section article header footer nav aside span p h1 h2 h3 h4 h5 h6 a button input label textarea select option ul ol li dl dt dd table thead tbody tfoot tr td th caption col colgroup img picture figure figcaption br hr strong b em i u s small sub sup code pre blockquote details summary progress meter svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask use aegis-use aegis-slot"
    .toLowerCase()
    .split(" "),
);
/** Scripts survive only as the board's inert logic and props data. */
const dataScripts = new Set([DESIGN_LOGIC_TYPE, DESIGN_PROPS_TYPE]);
/** Template directives the board runtime reads (never event-handler attributes). */
const directive = /^data-aegis-(?:if|else|for|key|on-[a-z]+|bind-[a-z][a-z0-9-]*|goto|deck|slide|notes|asset)$/;
const attrs = new Set(
  "class id style title role type value placeholder disabled checked selected for name width height viewbox d fill stroke stroke-width stroke-linecap stroke-linejoin opacity x y x1 y1 x2 y2 cx cy r rx ry points transform offset stop-color stop-opacity preserveaspectratio clip-path colspan rowspan alt data-aegis-node-id data-aegis-layer-name data-aegis-hidden data-aegis-locked data-aegis-tweaks data-aegis-starter".split(
    " ",
  ),
);
export function looksEscapedMarkup(html: string): boolean {
  const escaped = (html.match(/&lt;\/?[a-z][a-z0-9-]*(?:\s|&gt;|\/)/gi) ?? []).length;
  if (escaped < 3) return false;
  const real = (html.match(/<\/?[a-z][a-z0-9-]*(?:\s|>|\/)/gi) ?? []).length;
  return real === 0 || (/^\s*&lt;[a-z!]/i.test(html) && escaped > real);
}

export function sanitizeDesignHtml(html: string): string {
  if (typeof html !== "string" || new TextEncoder().encode(html).length > 1_000_000)
    throw new Error("HTML must be text of at most 1 MB.");
  const doc = parse(html);
  function clean(parent: DefaultTreeAdapterMap["parentNode"]): void {
    parent.childNodes = parent.childNodes.filter((node) => {
      if (node.nodeName === "#text") return true;
      if (!("tagName" in node) || !tags.has(node.tagName.toLowerCase()))
        return false;
      if (node.tagName === "script") {
        const type = node.attrs.find((a) => a.name === "type")?.value.trim().toLowerCase();
        if (!type || !dataScripts.has(type)) return false;
        node.attrs = [{ name: "type", value: type }];
        node.childNodes = node.childNodes.filter((n) => n.nodeName === "#text");
        return true;
      }
      // The document's own <html> and <head> carry nothing: the frame puts its
      // security policy right after <html><head>, and an attribute there could
      // smuggle a fake "<head>" ahead of the real one.
      if (node.tagName === "html" || node.tagName === "head") {
        node.attrs = [];
        clean(node);
        return true;
      }
      // A component instance's attributes are its props.
      const instance = node.tagName === "aegis-use";
      node.attrs = node.attrs.filter((attr) => {
        const name = attr.name.toLowerCase();
        if (attr.namespace || attr.prefix) return false;
        if (/^on/.test(name)) return false;
        if (directive.test(name)) return true;
        if (instance && /^[a-z][a-z0-9-]{0,63}$/.test(name)) return true;
        if (name === "src")
          return (
            node.tagName === "img" &&
            // SVG in <img> never runs script.
            (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[a-z\d+/=\s]+$/i.test(attr.value) ||
              // A design system asset, resolved to its data URL when the board renders.
              /^aegis-asset:[\w.-]{1,80}$/.test(attr.value))
          );
        if (name === "href") return /^#[a-z\d_-]+$/i.test(attr.value);
        return attrs.has(name) || /^aria-[a-z-]+$/.test(name);
      });
      clean(node);
      return true;
    });
  }
  clean(doc);
  return normalizeDesignLayers(serialize(doc));
}
