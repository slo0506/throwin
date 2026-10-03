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

/** Box area as a share of the frame. */
export const boxArea = ([x0, y0, x1, y1]: [number, number, number, number]) =>
  Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
