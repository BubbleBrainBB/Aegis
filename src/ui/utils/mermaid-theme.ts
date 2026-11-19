/** An opaque color as red, green and blue, each 0–255. */
export type Rgb = readonly [number, number, number];

/** The app theme tokens a diagram is drawn from, already resolved to colors. */
export interface MermaidPalette {
  dark: boolean;
  /** The message surface (`--bg-primary`). */
  surface: Rgb;
  /** `--text-primary` */
  ink: Rgb;
  /** `--text-secondary` */
  subdued: Rgb;
  accent: Rgb;
  success: Rgb;
  warning: Rgb;
  error: Rgb;
  fontFamily: string;
}

const hex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

/** `amount` of `color` over `base`, as an opaque color. */
export function mixRgb(color: Rgb, base: Rgb, amount: number): Rgb {
  return [0, 1, 2].map((index) => base[index] + (color[index] - base[index]) * amount) as unknown as Rgb;
}

/**
 * Mermaid's `base` theme variables for the app theme. Mermaid computes shades
 * from these with a color library that reads no CSS variables and no
 * `color-mix()`, so every value here is a plain hex color.
 *
 * Shapes are the message surface on the code slab, with ink mixed in for
 * borders and lines: the diagram reads as part of the answer in any theme.
 */
export function mermaidThemeVariables(palette: MermaidPalette): Record<string, string | boolean> {
  const { surface, ink, subdued, accent, success, warning, error } = palette;
  const tint = (amount: number) => hex(mixRgb(ink, surface, amount));
  const wash = (color: Rgb, amount: number) => hex(mixRgb(color, surface, amount));

  const slab = tint(0.05);
  const node = hex(surface);
  const nodeBorder = tint(0.28);
  const group = tint(0.09);
  const groupBorder = tint(0.17);
  const line = hex(mixRgb(subdued, surface, 0.85));
  const text = hex(ink);
  const series = [accent, success, warning, error, subdued].flatMap((color) => [wash(color, 0.55), wash(color, 0.28)]);

  return {
    darkMode: palette.dark,
    fontFamily: palette.fontFamily,
    fontSize: '14px',
    background: slab,

    primaryColor: node,
    primaryTextColor: text,
    primaryBorderColor: nodeBorder,
    secondaryColor: wash(accent, 0.14),
    secondaryTextColor: text,
    secondaryBorderColor: wash(accent, 0.4),
    tertiaryColor: group,
    tertiaryTextColor: text,
    tertiaryBorderColor: groupBorder,

    textColor: text,
    titleColor: text,
    lineColor: line,
    arrowheadColor: line,
    mainBkg: node,
    nodeBorder,
    clusterBkg: group,
    clusterBorder: groupBorder,
    edgeLabelBackground: slab,

    noteBkgColor: wash(warning, 0.16),
    noteTextColor: text,
    noteBorderColor: wash(warning, 0.45),
    activationBkgColor: tint(0.09),
    activationBorderColor: nodeBorder,
    sequenceNumberColor: node,

    // Gantt, where the defaults are named web colors that ignore the theme.
    sectionBkgColor: tint(0.07),
    altSectionBkgColor: node,
    sectionBkgColor2: tint(0.04),
    gridColor: groupBorder,
    excludeBkgColor: tint(0.06),
    taskBkgColor: wash(accent, 0.22),
    taskBorderColor: wash(accent, 0.5),
    activeTaskBkgColor: wash(accent, 0.38),
    activeTaskBorderColor: wash(accent, 0.7),
    doneTaskBkgColor: tint(0.14),
    doneTaskBorderColor: tint(0.3),
    critBkgColor: wash(error, 0.3),
    critBorderColor: wash(error, 0.6),
    todayLineColor: hex(error),
    vertLineColor: hex(accent),
    taskTextColor: text,
    taskTextDarkColor: text,
    taskTextLightColor: text,
    taskTextOutsideColor: text,
    taskTextClickableColor: hex(accent),

    // Tables in entity and class diagrams.
    rowOdd: node,
    rowEven: tint(0.04),
    attributeBackgroundColorOdd: node,
    attributeBackgroundColorEven: tint(0.04),

    errorBkgColor: wash(error, 0.16),
    errorTextColor: text,

    ...Object.fromEntries(series.map((color, index) => [`pie${index + 1}`, color])),
    pieTitleTextColor: text,
    pieSectionTextColor: text,
    pieLegendTextColor: text,
    pieStrokeColor: slab,
    pieOuterStrokeColor: groupBorder,
  };
}
