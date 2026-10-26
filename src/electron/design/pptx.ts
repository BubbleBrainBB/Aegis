import { strToU8, zipSync } from "fflate";

/**
 * A PowerPoint deck from slide images: one picture per slide filling it,
 * with the slide's speaker notes. The text is not editable (each slide is a
 * rendering, as designed); notes are. Minimal Office Open XML, written here.
 */
export interface PptxSlide {
  png: Uint8Array;
  /** The image's size in px; it is fitted into the slide, centred. */
  width: number;
  height: number;
  notes?: string;
}

const EMU_PER_PX = 9525;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const rels = (items: [string, string, string][]) =>
  `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`;
const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const THEME = `${head}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Aegis"><a:themeElements>
<a:clrScheme name="Aegis"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2328"/></a:dk2><a:lt2><a:srgbClr val="F6F8FA"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Aegis"><a:majorFont><a:latin typeface="Helvetica Neue"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Helvetica Neue"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Aegis"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

export function buildPptx(slides: PptxSlide[], size: { width: number; height: number }, title: string): Uint8Array {
  if (!slides.length) throw new Error("No slides to export.");
  // PowerPoint takes slide sides of 914400–51206400 EMU (1–56 in): scale into range, keeping the shape.
  const [MIN, MAX] = [914_400, 51_206_400];
  let cx = size.width * EMU_PER_PX;
  let cy = size.height * EMU_PER_PX;
  const grow = Math.max(1, MIN / Math.min(cx, cy));
  cx *= grow;
  cy *= grow;
  const shrink = Math.min(1, MAX / Math.max(cx, cy));
  cx = Math.round(Math.min(MAX, Math.max(MIN, cx * shrink)));
  cy = Math.round(Math.min(MAX, Math.max(MIN, cy * shrink)));
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => (files[path] = strToU8(xml));
  const n = slides.length;

  put(
    "[Content_Types].xml",
    `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("") +
      `</Types>`,
  );
  put("_rels/.rels", rels([
    ["rId1", `${REL}/officeDocument`, "ppt/presentation.xml"],
    ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
    ["rId3", `${REL}/extended-properties`, "docProps/app.xml"],
  ]));
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  put("docProps/core.xml", `${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Aegis</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  put("docProps/app.xml", `${head}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Aegis</Application><Slides>${n}</Slides><Notes>${slides.filter((s) => s.notes?.trim()).length}</Notes></Properties>`);

  // Presentation: rId1 master, rId2 notes master, rId3 theme, rId10+ slides.
  put(
    "ppt/presentation.xml",
    `${head}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`,
  );
  put("ppt/_rels/presentation.xml.rels", rels([
    ["rId1", `${REL}/slideMaster`, "slideMasters/slideMaster1.xml"],
    ["rId2", `${REL}/notesMaster`, "notesMasters/notesMaster1.xml"],
    ["rId3", `${REL}/theme`, "theme/theme1.xml"],
    ...slides.map((_, i): [string, string, string] => [`rId${10 + i}`, `${REL}/slide`, `slides/slide${i + 1}.xml`]),
  ]));
  put("ppt/theme/theme1.xml", THEME);
  put("ppt/theme/theme2.xml", THEME);
  put(
    "ppt/slideMasters/slideMaster1.xml",
    `${head}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${emptyTree}</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  put("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([
    ["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"],
    ["rId2", `${REL}/theme`, "../theme/theme1.xml"],
  ]));
  put("ppt/slideLayouts/slideLayout1.xml", `${head}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", `${REL}/slideMaster`, "../slideMasters/slideMaster1.xml"]]));
  put(
    "ppt/notesMasters/notesMaster1.xml",
    `${head}<p:notesMaster ${NS}><p:cSld><p:spTree>${emptyTree}</p:spTree></p:cSld>${CLR_MAP}<p:notesStyle/></p:notesMaster>`,
  );
  put("ppt/notesMasters/_rels/notesMaster1.xml.rels", rels([["rId1", `${REL}/theme`, "../theme/theme2.xml"]]));

  slides.forEach((slide, i) => {
    const k = i + 1;
    files[`ppt/media/slide${k}.png`] = slide.png;
    // Contained in the slide, centred: boards of another size are not stretched.
    const scale = Math.min(cx / (slide.width * EMU_PER_PX), cy / (slide.height * EMU_PER_PX));
    const fit = { cx: Math.round(slide.width * EMU_PER_PX * scale), cy: Math.round(slide.height * EMU_PER_PX * scale), x: 0, y: 0 };
    fit.x = Math.round((cx - fit.cx) / 2);
    fit.y = Math.round((cy - fit.cy) / 2);
    put(
      `ppt/slides/slide${k}.xml`,
      `${head}<p:sld ${NS}><p:cSld><p:spTree>${emptyTree}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide ${k}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${fit.x}" y="${fit.y}"/><a:ext cx="${fit.cx}" cy="${fit.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    );
    put(`ppt/slides/_rels/slide${k}.xml.rels`, rels([
      ["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"],
      ["rId2", `${REL}/image`, `../media/slide${k}.png`],
      ["rId3", `${REL}/notesSlide`, `../notesSlides/notesSlide${k}.xml`],
    ]));
    const paragraphs = (slide.notes ?? "").split("\n").map((line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>`).join("") || "<a:p><a:endParaRPr lang=\"en-US\"/></a:p>";
    put(
      `ppt/notesSlides/notesSlide${k}.xml`,
      `${head}<p:notes ${NS}><p:cSld><p:spTree>${emptyTree}` +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>` +
        `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
    );
    put(`ppt/notesSlides/_rels/notesSlide${k}.xml.rels`, rels([
      ["rId1", `${REL}/notesMaster`, "../notesMasters/notesMaster1.xml"],
      ["rId2", `${REL}/slide`, `../slides/slide${k}.xml`],
    ]));
  });
  return zipSync(files, { level: 6 });
}
