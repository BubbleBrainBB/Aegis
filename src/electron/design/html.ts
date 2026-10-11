import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

import { normalizeDesignLayers } from "../../shared/design-layers";

const tags = new Set(
  "html head body title style div main section article header footer nav aside span p h1 h2 h3 h4 h5 h6 a button input label textarea select option ul ol li dl dt dd table thead tbody tfoot tr td th caption col colgroup img picture figure figcaption br hr strong b em i u s small sub sup code pre blockquote details summary progress meter svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask use"
    .toLowerCase()
    .split(" "),
);
const attrs = new Set(
  "class id style title role type value placeholder disabled checked selected for name width height viewbox d fill stroke stroke-width stroke-linecap stroke-linejoin opacity x y x1 y1 x2 y2 cx cy r rx ry points transform offset stop-color stop-opacity preserveaspectratio clip-path colspan rowspan alt data-aegis-node-id data-aegis-layer-name data-aegis-hidden data-aegis-locked".split(
    " ",
  ),
);
export function sanitizeDesignHtml(html: string): string {
  if (typeof html !== "string" || Buffer.byteLength(html) > 1_000_000)
    throw new Error("HTML must be text of at most 1 MB.");
  const doc = parse(html);
  function clean(parent: DefaultTreeAdapterMap["parentNode"]): void {
    parent.childNodes = parent.childNodes.filter((node) => {
      if (node.nodeName === "#text") return true;
      if (!("tagName" in node) || !tags.has(node.tagName.toLowerCase()))
        return false;
      node.attrs = node.attrs.filter((attr) => {
        const name = attr.name.toLowerCase();
        if (attr.namespace || attr.prefix) return false;
        if (name === "src")
          return (
            node.tagName === "img" &&
            /^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(
              attr.value,
            )
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

export { designFrameHtml } from "../../shared/design-frame";
