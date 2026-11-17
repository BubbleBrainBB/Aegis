import type { ThemeBackdrop } from './theme-types';

/**
 * The dot-matrix backdrop: a slow picture drawn in dots on a fixed grid.
 *
 * The dots never move; what changes over time is each dot's size and
 * brightness. `DotFieldModel` works out the picture for a moment in time and
 * has no DOM in it. `createDotField` paints a model into canvases and only
 * redraws the cells whose look changed since the last frame, which is a small
 * share of them: the picture drifts slowly.
 */

/** Distance between dot centres, in CSS pixels. */
export const DOT_PITCH = 6;

/** A cell that shows nothing. */
const EMPTY = 0;
/** Keys from here on are stars; below are dots of the picture itself. */
const STAR = 1000;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => n / 16 + 1 / 32);

const AURORA_INKS = (() => {
  const stops = [[98, 246, 208], [72, 190, 255], [96, 128, 255], [150, 104, 255], [196, 108, 244]];
  const inks: number[][] = [];
  for (let i = 0; i < 16; i += 1) {
    const f = (i / 15) * 4;
    const k = Math.min(3, Math.floor(f));
    const m = f - k;
    inks.push(stops[k].map((c, j) => Math.round(c + (stops[k + 1][j] - c) * m)));
  }
  return inks;
})();
const STAR_INK = [214, 224, 255];
/** The terrain under the contour lines is refreshed one row in this many per frame. */
const TERRAIN_TURNS = 8;
/** Contour lines by height: low ground, middle, high ground. */
const CONTOUR_INKS = [[48, 176, 190], [58, 96, 224], [124, 92, 230]];

/** Lower edge of each aurora curtain across the window: [across, down], both 0..1. */
const CURTAINS = [
  {
    points: [[-0.2, 0.62], [0.0, 0.6], [0.1, 0.54], [0.21, 0.4], [0.34, 0.27], [0.5, 0.21], [0.66, 0.225], [0.8, 0.19], [0.92, 0.15], [1.2, 0.17]],
    seed: 11, streak: 46, slant: 0.14, length: 0.19, weight: 1,
  },
  {
    points: [[-0.2, 0.3], [0.0, 0.28], [0.2, 0.18], [0.42, 0.09], [0.62, 0.1], [0.8, 0.22], [0.92, 0.31], [1.2, 0.33]],
    seed: 29, streak: 58, slant: 0.22, length: 0.1, weight: 0.55,
  },
];

interface Star {
  cell: number;
  /** 0..3, which of four sizes. */
  size: number;
  alpha: number;
  phase: number;
  speed: number;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function curveAt(points: number[][], u: number): number {
  let i = 0;
  while (i < points.length - 2 && u > points[i + 1][0]) i += 1;
  const p = points[i];
  const q = points[i + 1];
  let f = Math.min(1, Math.max(0, (u - p[0]) / (q[0] - p[0])));
  f = f * f * (3 - 2 * f);
  return p[1] + (q[1] - p[1]) * f;
}

export class DotFieldModel {
  readonly cols: number;
  readonly rows: number;
  /** How strongly each cell is lit or inked, 0..1. */
  readonly level: Float32Array;
  /** Which ink a cell takes: 0..1 along the aurora's ramp; for contour lines, 0 low ground, 1 middle, 2 high. */
  readonly tone: Float32Array;
  private readonly table = new Float32Array(4096);
  private readonly gain = [1, 1];
  private readonly stars: Star[] = [];
  private readonly starAt: Int32Array;
  private readonly edges: Float32Array[];
  private readonly glows: Float32Array[];
  /** Contour only: the terrain's height at each cell, and the moment each row of it shows. */
  private readonly ground: Float32Array;
  private readonly shown: Float64Array;

  /** Window width over height: positions are measured in units of the height. */
  private readonly aspect: number;

  constructor(readonly kind: ThemeBackdrop, width: number, height: number) {
    this.aspect = width / Math.max(1, height);
    this.cols = Math.max(1, Math.ceil(width / DOT_PITCH));
    this.rows = Math.max(1, Math.ceil(height / DOT_PITCH));
    const cells = this.cols * this.rows;
    this.level = new Float32Array(cells);
    this.tone = new Float32Array(cells);
    this.starAt = new Int32Array(cells).fill(-1);
    this.edges = [new Float32Array(this.cols), new Float32Array(this.cols)];
    this.glows = [new Float32Array(this.cols), new Float32Array(this.cols)];
    const random = seededRandom(20261116);
    for (let i = 0; i < this.table.length; i += 1) this.table[i] = random();
    this.ground = new Float32Array(kind === 'contour' ? cells : 0);
    this.shown = new Float64Array(kind === 'contour' ? this.rows : 0).fill(Number.NaN);
    if (kind !== 'aurora') return;
    this.gain[0] = this.brightest(0);
    this.gain[1] = this.brightest(1);
    const place = (cell: number, star: Omit<Star, 'cell'>) => {
      if (cell < 0 || cell >= cells || this.starAt[cell] >= 0) return;
      this.starAt[cell] = this.stars.length;
      this.stars.push({ cell, ...star });
    };
    for (let r = 0; r < this.rows; r += 1) {
      for (let c = 0; c < this.cols; c += 1) {
        if (random() > 0.0095) continue;
        const b = random();
        const star = { size: Math.min(3, Math.floor(b * 4)), alpha: 0.26 + 0.66 * b * b, phase: random() * 6.283, speed: 0.4 + random() * 0.9 };
        place(r * this.cols + c, star);
        // The brightest few get four dim neighbours on the grid.
        if (b <= 0.92) continue;
        const dim = { size: 0, alpha: 0.25, phase: star.phase, speed: star.speed };
        if (c > 0) place(r * this.cols + c - 1, dim);
        if (c < this.cols - 1) place(r * this.cols + c + 1, dim);
        place((r - 1) * this.cols + c, dim);
        place((r + 1) * this.cols + c, dim);
      }
    }
  }

  /** Smooth noise over two dimensions; the second is usually time. */
  private noise(x: number, y: number, seed: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const t = this.table;
    const a = t[(xi * 73 + yi * 157 + seed * 31) & 4095];
    const b = t[((xi + 1) * 73 + yi * 157 + seed * 31) & 4095];
    const c = t[(xi * 73 + (yi + 1) * 157 + seed * 31) & 4095];
    const d = t[((xi + 1) * 73 + (yi + 1) * 157 + seed * 31) & 4095];
    return a + (b - a) * fx + (c - a + (a - b + d - c) * fx) * fy;
  }

  private fbm(x: number, y: number, seed: number): number {
    return (this.noise(x, y, seed) + 0.5 * this.noise(x * 2, y * 2, seed + 17)) / 1.5;
  }

  /** Where a curtain's lower edge is in each column, and how bright that stretch of it is. */
  private hang(which: number, t: number): void {
    const { points, seed } = CURTAINS[which];
    const edge = this.edges[which];
    const glow = this.glows[which];
    for (let c = 0; c < this.cols; c += 1) {
      const u = (c + 0.5) / this.cols;
      const sway = 0.016 * Math.sin(6.283 * (u * 1.4 - t * 0.03 + seed)) + 0.03 * (this.noise(u * 4, t * 0.05, seed) - 0.5);
      edge[c] = curveAt(points, u) + sway;
      glow[c] = 0.35 + 0.65 * this.fbm(u * 2.1 + 2, t * 0.045, seed + 21);
    }
  }

  private lit = 0;
  private height = 0;
  /** One curtain at one cell: sets `lit` (0 when dark) and `height` along the ray. Call hang() first. */
  private curtain(which: number, c: number, u: number, v: number, t: number): void {
    const d = this.edges[which][c] - v; // positive above the edge
    if (d < -0.06) {
      this.lit = 0;
      return;
    }
    const { seed, streak, slant, length } = CURTAINS[which];
    const along = u + slant * d + t * 0.0035;
    let ray = (this.fbm(along * streak, t * 0.11, seed + 9) - 0.16) / 0.66;
    ray = ray <= 0 ? 0 : ray >= 1 ? 1 : Math.pow(ray, 1.15);
    const reach = length * (0.3 + 1.4 * this.fbm(along * streak * 0.6 + 3, t * 0.07, seed + 3));
    const body = 0.24 + 0.76 * ray;
    const light = d >= 0 ? Math.exp(-d / reach) * body * (0.72 + 0.28 * Math.exp(-d / 0.022)) : Math.exp(d / 0.01) * body;
    this.lit = light * this.glows[which][c];
    this.height = Math.min(1, Math.max(0, d / (reach * 1.7)));
  }

  /** What the brightest hundredth of a curtain reaches, so both curtains use the full range. */
  private brightest(which: number): number {
    this.hang(which, 0);
    const values: number[] = [];
    for (let r = 0; r < this.rows; r += 2) {
      for (let c = 0; c < this.cols; c += 2) {
        this.curtain(which, c, (c + 0.5) / this.cols, (r + 0.5) / this.rows, 0);
        values.push(this.lit);
      }
    }
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length * 0.99)] || 1;
  }

  private aurora(t: number): void {
    const { cols, rows, level, tone } = this;
    this.hang(0, t);
    this.hang(1, t);
    for (let r = 0; r < rows; r += 1) {
      const v = (r + 0.5) / rows;
      for (let c = 0; c < cols; c += 1) {
        const u = (c + 0.5) / cols;
        const i = r * cols + c;
        this.curtain(0, c, u, v, t);
        const front = this.lit > 0 ? Math.pow(Math.min(1, this.lit / this.gain[0]), 0.85) : 0;
        const frontHeight = this.height;
        this.curtain(1, c, u, v, t);
        const back = this.lit > 0 ? CURTAINS[1].weight * Math.pow(Math.min(1, this.lit / this.gain[1]), 0.85) : 0;
        if (front >= back) {
          level[i] = front;
          tone[i] = front > 0 ? frontHeight : 0;
        } else {
          level[i] = back;
          tone[i] = 0.45 + 0.55 * this.height;
        }
      }
    }
  }

  /** Three octaves of noise, for the terrain the contour lines follow. */
  private terrain(x: number, y: number): number {
    return (this.noise(x, y, 5) + 0.5 * this.noise(x * 2 + 11.3, y * 2 + 4.7, 5) + 0.25 * this.noise(x * 4 + 2.1, y * 4 + 9.9, 5)) / 1.75;
  }

  /**
   * Contour lines of a slowly shifting terrain, like a map: teal on low
   * ground, blue in the middle, violet on the heights.
   *
   * The lines travel every frame, which is cheap; the terrain under them
   * shifts far more slowly and is the costly part, so each row of it is
   * refreshed only every few frames, rows taking turns. Which moment a row
   * shows depends on the time alone, so the same time gives the same picture.
   */
  private contour(t: number): void {
    const { cols, rows, level, tone, aspect, ground, shown } = this;
    const frame = Math.floor(t * 12);
    for (let r = 0; r < rows; r += 1) {
      const turn = r % TERRAIN_TURNS;
      const moment = (Math.floor((frame - turn) / TERRAIN_TURNS) * TERRAIN_TURNS + turn) / 12;
      const at = r * cols;
      if (shown[r] !== moment) {
        shown[r] = moment;
        const y = (r + 0.5) / rows;
        for (let c = 0; c < cols; c += 1) {
          const x = ((c + 0.5) / cols) * aspect;
          ground[at + c] = this.terrain(x * 1.5 + moment * 0.012, y * 1.5 - moment * 0.009);
        }
      }
      for (let c = 0; c < cols; c += 1) {
        const i = at + c;
        const height = ground[i];
        const band = 0.5 + 0.5 * Math.cos(6.283 * height * 11 + t * 0.22);
        level[i] = band * band * band * (0.3 + 0.9 * height);
        tone[i] = height > 0.6 ? 2 : height < 0.36 ? 0 : 1;
      }
    }
  }

  /** Works out the picture at time `t` (seconds). */
  compute(t: number): void {
    if (this.kind === 'aurora') this.aurora(t);
    else this.contour(t);
  }

  /**
   * The look of one cell after compute(): equal keys draw the same dot, so a
   * cell whose key did not change needs no repaint.
   */
  key(cell: number, t: number): number {
    const value = this.level[cell];
    if (this.kind === 'contour') {
      // Print: every dot is there and its size carries the tone.
      const step = Math.round(Math.min(1, Math.max(0, value)) * 10);
      return step ? this.tone[cell] * 16 + step : EMPTY;
    }
    // LED: five sizes, with an ordered dither between neighbouring ones.
    const r = Math.floor(cell / this.cols);
    const c = cell - r * this.cols;
    const step = Math.min(5, Math.floor(value * 5 + BAYER[(r % 4) * 4 + (c % 4)]));
    if (step) return Math.round(this.tone[cell] * 15) * 8 + step;
    const index = value > 0.03 ? -1 : this.starAt[cell];
    if (index < 0) return EMPTY;
    const star = this.stars[index];
    const twinkle = 0.72 + 0.28 * Math.sin(t * star.speed + star.phase);
    return STAR + star.size * 16 + Math.round(star.alpha * twinkle * 10);
  }

  /** The halo colour of a cell after compute(), written as RGBA into `out` at `at`. Aurora only. */
  halo(cell: number, out: Uint8ClampedArray, at: number): void {
    const ink = AURORA_INKS[Math.round(this.tone[cell] * 15)];
    out[at] = ink[0];
    out[at + 1] = ink[1];
    out[at + 2] = ink[2];
    out[at + 3] = Math.round(255 * 0.46 * Math.pow(Math.min(1, this.level[cell]), 1.2));
  }
}

/** How a key is drawn: the dot's radius in CSS pixels and its fill. */
export function dotStyle(kind: ThemeBackdrop, key: number): { radius: number; fill: string } {
  if (key >= STAR) {
    const size = Math.floor((key - STAR) / 16);
    const alpha = ((key - STAR) % 16) / 10;
    return { radius: 0.6 + 0.22 * size, fill: `rgba(${STAR_INK.join(',')},${alpha.toFixed(2)})` };
  }
  if (kind === 'contour') {
    const q = (key % 16) / 10;
    const ink = CONTOUR_INKS[Math.floor(key / 16)] ?? CONTOUR_INKS[0];
    return { radius: DOT_PITCH * 0.42 * (0.14 + 0.86 * Math.pow(q, 0.9)), fill: `rgba(${ink.join(',')},${(0.55 + 0.35 * q).toFixed(3)})` };
  }
  const q = (key % 8) / 5;
  const ink = AURORA_INKS[Math.floor(key / 8)] ?? AURORA_INKS[0];
  return { radius: DOT_PITCH * 0.38 * (0.36 + 0.64 * q), fill: `rgba(${ink.join(',')},${(0.3 + 0.7 * Math.pow(q, 0.8)).toFixed(3)})` };
}

export interface DotField {
  /** Fits the picture to the host's current size; the next paint redraws everything. */
  resize(): void;
  /** Paints the picture at time `t` (seconds). */
  paint(t: number): void;
  destroy(): void;
}

/** Paints a dot field into `host`, which it fills with its own canvases. */
export function createDotField(host: HTMLElement, kind: ThemeBackdrop): DotField {
  const dots = document.createElement('canvas');
  // Lit dots bleed a soft halo: the same picture at one pixel per dot, stretched by the compositor.
  const halo = kind === 'aurora' ? document.createElement('canvas') : null;
  if (halo) host.appendChild(halo);
  host.appendChild(dots);
  const pen = dots.getContext('2d');
  const haloPen = halo?.getContext('2d') ?? null;
  const styles = new Map<number, { radius: number; fill: string }>();
  let model: DotFieldModel | null = null;
  let seen = new Int32Array(0);
  let glow: ImageData | null = null;
  const groups = new Map<number, number[]>();

  const resize = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!pen || width <= 0 || height <= 0) {
      model = null;
      return;
    }
    model = new DotFieldModel(kind, width, height);
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const wide = model.cols * DOT_PITCH;
    const tall = model.rows * DOT_PITCH;
    dots.width = Math.round(wide * scale);
    dots.height = Math.round(tall * scale);
    dots.style.width = `${wide}px`;
    dots.style.height = `${tall}px`;
    pen.setTransform(scale, 0, 0, scale, 0, 0);
    seen = new Int32Array(model.cols * model.rows).fill(-1);
    if (halo && haloPen) {
      halo.width = model.cols;
      halo.height = model.rows;
      halo.style.width = `${wide}px`;
      halo.style.height = `${tall}px`;
      glow = haloPen.createImageData(model.cols, model.rows);
    }
  };

  const paint = (t: number) => {
    if (!model || !pen) return;
    model.compute(t);
    const { cols } = model;
    const cells = seen.length;
    groups.clear();
    for (let cell = 0; cell < cells; cell += 1) {
      if (glow) model.halo(cell, glow.data, cell * 4);
      const key = model.key(cell, t);
      if (key === seen[cell]) continue;
      // A dot never reaches the edge of its cell, so clearing the cell clears the dot.
      if (seen[cell] > EMPTY) {
        const r = Math.floor(cell / cols);
        pen.clearRect((cell - r * cols) * DOT_PITCH, r * DOT_PITCH, DOT_PITCH, DOT_PITCH);
      }
      seen[cell] = key;
      if (key === EMPTY) continue;
      const group = groups.get(key);
      if (group) group.push(cell);
      else groups.set(key, [cell]);
    }
    if (glow && haloPen) haloPen.putImageData(glow, 0, 0);
    for (const [key, group] of groups) {
      let style = styles.get(key);
      if (!style) {
        style = dotStyle(kind, key);
        styles.set(key, style);
      }
      const { radius } = style;
      pen.fillStyle = style.fill;
      pen.beginPath();
      for (const cell of group) {
        const r = Math.floor(cell / cols);
        const x = (cell - r * cols + 0.5) * DOT_PITCH;
        const y = (r + 0.5) * DOT_PITCH;
        pen.moveTo(x + radius, y);
        pen.arc(x, y, radius, 0, 6.2832);
      }
      pen.fill();
    }
  };

  resize();
  return {
    resize,
    paint,
    destroy() {
      dots.remove();
      halo?.remove();
      model = null;
    },
  };
}
