import sharp from "sharp";

/** Longest edge sent to Claude. At about 1000 px an image is roughly 1,300 tokens (PRD). */
export const MAX_EDGE = 1000;

export interface PreparedImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Decodes any supported image, applies EXIF rotation, and downsizes to MAX_EDGE as JPEG. */
export async function prepare(input: Buffer, maxEdge = MAX_EDGE): Promise<PreparedImage> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}

/**
 * Crops a normalized box out of an image with 8% padding, so edges and labels survive a
 * slightly loose box, and returns it at MAX_EDGE.
 */
export async function crop(
  image: PreparedImage,
  box: [number, number, number, number],
  pad = 0.08,
): Promise<PreparedImage> {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const left = Math.max(0, Math.floor((x0 - w * pad) * image.width));
  const top = Math.max(0, Math.floor((y0 - h * pad) * image.height));
  const right = Math.min(image.width, Math.ceil((x1 + w * pad) * image.width));
  const bottom = Math.min(image.height, Math.ceil((y1 + h * pad) * image.height));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const cropped = await sharp(image.jpeg).extract({ left, top, width, height }).toBuffer();
  return prepare(cropped);
}

/**
 * Sharpness as the variance of the Laplacian, the same measure the iOS app uses. Images are
 * scaled to fit 512 px first so a big photo and a small crop are compared fairly.
 */
export async function sharpness(image: PreparedImage): Promise<number> {
  const { channels } = await sharp(image.jpeg)
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
    .stats();
  const stdev = channels[0]?.stdev ?? 0;
  return stdev * stdev;
}

/**
 * Whether a new photo should replace the current hero image: it must be at least as large
 * and clearly sharper, so a lateral move never churns the thumbnail.
 */
export async function isBetterHero(candidate: PreparedImage, current: PreparedImage) {
  if (candidate.width * candidate.height < current.width * current.height) return false;
  const [a, b] = await Promise.all([sharpness(candidate), sharpness(current)]);
  return a > b * 1.1;
}

export type Box = [number, number, number, number];

/** Box area as a share of the frame. */
export const boxArea = ([x0, y0, x1, y1]: Box) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

/** Context crops pad the detector's box by at least this share of its size on every side... */
export const CONTEXT_PAD = 0.35;
/** ...and by at least this share of the frame, since Haiku's boxes can be off by 20%... */
export const CONTEXT_MIN_MARGIN = 0.2;
/** ...and cover at least this share of the frame's width and height. */
export const CONTEXT_MIN_SPAN = 0.3;

/** Frames are kept at up to this size for cutting crops; Claude still sees MAX_EDGE. */
export const SOURCE_EDGE = 2048;

/**
 * The region identification looks at: the detector's (coarse) box, padded generously and
 * widened to a minimum share of the frame, so the real object is inside it even when the
 * detector's box is off by a fifth of the frame. Shifted, not shrunk, at the frame's edges.
 */
export function contextRegion(
  box: Box,
  pad = CONTEXT_PAD,
  minMargin = CONTEXT_MIN_MARGIN,
  minSpan = CONTEXT_MIN_SPAN,
): Box {
  const axis = (lo: number, hi: number): [number, number] => {
    const size = Math.max(0, hi - lo);
    const margin = Math.max(size * pad, minMargin);
    const span = Math.min(1, Math.max(size + 2 * margin, minSpan));
    const center = (lo + hi) / 2;
    let start = center - span / 2;
    start = Math.min(Math.max(0, start), 1 - span);
    return [start, start + span];
  };
  const [x0, x1] = axis(box[0], box[2]);
  const [y0, y1] = axis(box[1], box[3]);
  return [x0, y0, x1, y1];
}

/** Maps a box normalized to a region back to the frame the region was cut from. */
export function fromRegion(inner: Box, region: Box): Box {
  const w = region[2] - region[0];
  const h = region[3] - region[1];
  return [
    region[0] + inner[0] * w,
    region[1] + inner[1] * h,
    region[0] + inner[2] * w,
    region[1] + inner[3] * h,
  ];
}

/**
 * Whether a box returned for a close-up is unusable: too thin, too small, or basically the
 * whole close-up (a context crop pads the object, so the object never fills it).
 */
export function isDegenerate(box: Box) {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return !(w >= 0.03 && h >= 0.03 && w * h >= 0.005 && w * h <= 0.9);
}

/** Cuts an exact normalized region (no padding) and returns it at MAX_EDGE. */
export async function cropRegion(image: PreparedImage, region: Box): Promise<PreparedImage> {
  const left = Math.max(0, Math.floor(region[0] * image.width));
  const top = Math.max(0, Math.floor(region[1] * image.height));
  const right = Math.min(image.width, Math.ceil(region[2] * image.width));
  const bottom = Math.min(image.height, Math.ceil(region[3] * image.height));
  const cropped = await sharp(image.jpeg)
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .toBuffer();
  return prepare(cropped);
}

/**
 * Seven-segment strokes for the grid's digits. Drawn as lines, not SVG text, because the
 * worker's slim container has no fonts and text would silently render as nothing.
 */
const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

function digitPath(digit: string, x: number, y: number, w: number, h: number) {
  const m = h / 2;
  const lines: Record<string, [number, number, number, number]> = {
    a: [x, y, x + w, y],
    b: [x + w, y, x + w, y + m],
    c: [x + w, y + m, x + w, y + h],
    d: [x, y + h, x + w, y + h],
    e: [x, y + m, x, y + h],
    f: [x, y, x, y + m],
    g: [x, y + m, x + w, y + m],
  };
  return [...(SEGMENTS[digit] ?? "")]
    .map((s) => {
      const [x1, y1, x2, y2] = lines[s] as [number, number, number, number];
      return `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
    })
    .join("");
}

/**
 * A light coordinate grid for detection only: a line every 0.1 of the frame, labeled with
 * the tenth (1 to 9) along the top and left edges. Models read positions better against a
 * ruler than against a bare image. Never used on crops or anything saved.
 */
export async function withGrid(image: PreparedImage): Promise<PreparedImage> {
  const { width: W, height: H } = image;
  const lines: string[] = [];
  const labels: string[] = [];
  const dh = Math.max(9, Math.round(Math.min(W, H) * 0.018));
  const dw = dh * 0.55;
  for (let i = 1; i < 10; i++) {
    const x = (W * i) / 10;
    const y = (H * i) / 10;
    lines.push(`M${x.toFixed(1)} 0V${H}`, `M0 ${y.toFixed(1)}H${W}`);
    labels.push(digitPath(String(i), x + 3, 3, dw, dh), digitPath(String(i), 3, y + 3, dw, dh));
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<path d="${lines.join("")}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1" fill="none"/>
<path d="${lines.join("")}" stroke="#000000" stroke-opacity="0.2" stroke-width="1" fill="none" transform="translate(1 1)"/>
<path d="${labels.join("")}" stroke="#000000" stroke-opacity="0.7" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="${labels.join("")}" stroke="#ffff00" stroke-width="1.5" fill="none" stroke-linecap="round"/>
</svg>`;
  const jpeg = await sharp(image.jpeg)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
  return { jpeg, width: W, height: H };
}
