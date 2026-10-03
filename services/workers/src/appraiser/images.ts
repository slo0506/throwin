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

/** Box area as a share of the frame. */
export const boxArea = ([x0, y0, x1, y1]: [number, number, number, number]) =>
  Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
