/**
 * Turning a picked photograph into something small enough to store.
 *
 * An avatar is held as a `data:` URL on the user row, so the bytes travel in
 * every profile response -- which makes shrinking the picture before upload
 * the difference between a 15 KB thumbnail and a 4 MB phone camera image
 * riding along on every page load.
 *
 * The crop is centred and square, which is the one crop that is right often
 * enough not to need a UI: a face in a portrait photograph is near the
 * middle, and the alternative is squashing it.
 */

import { AVATAR_SIZE, AVATAR_TYPES, MAX_AVATAR_BYTES } from "@ucch/protocol/plain";

/**
 * The area of the source to draw, as a centred square.
 *
 * Pure, and separated from the canvas work, because it is the part with an
 * off-by-one worth testing: the square is the shorter side, offset by half
 * the difference on the longer one.
 */
export function centreCrop(
  width: number,
  height: number,
): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

/**
 * The size to draw at.
 *
 * Never larger than the source: upscaling a 64px icon to 256 stores four
 * times the bytes for a blurrier picture than the file already was.
 */
export function targetSize(sourceSize: number): number {
  return Math.max(1, Math.min(AVATAR_SIZE, Math.round(sourceSize)));
}

/**
 * Reads an image file and returns a square thumbnail as a `data:` URL.
 *
 * WebP where the browser will encode it, JPEG otherwise -- both are a third
 * the size of the PNG a canvas produces by default. Transparency is lost
 * either way, which is why the canvas is filled first: an avatar with an
 * alpha channel would otherwise come out with a black square behind it.
 */
export async function fileToAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const crop = centreCrop(bitmap.width, bitmap.height);
    const size = targetSize(crop.size);

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("this browser cannot resize images");

    // White rather than transparent, because the formats below have no alpha
    // channel to preserve it in.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);

    for (const type of AVATAR_TYPES) {
      const encoded = canvas.toDataURL(type, 0.85);
      // A canvas asked for a format it cannot encode silently returns a PNG,
      // so the answer is checked rather than trusted.
      if (!encoded.startsWith(`data:${type};base64,`)) continue;
      if (encoded.length <= MAX_AVATAR_BYTES) return encoded;
    }

    throw new Error("that image is too detailed to store -- try a smaller one");
  } finally {
    // Frees the decoded frame rather than waiting for a collection that may
    // be a whole camera image away.
    bitmap.close();
  }
}
