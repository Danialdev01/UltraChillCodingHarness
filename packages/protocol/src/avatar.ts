/**
 * What may be stored as a profile picture.
 *
 * A picture is held as a `data:` URL in `users.avatar_url`, beside the
 * GitHub URLs that column already holds. That keeps the column's meaning
 * intact -- something that can go straight in an `img src` -- and means an
 * uploaded avatar needs no storage directory, no serving route, and no
 * cache invalidation when it changes.
 *
 * The trade is that the bytes ride in every profile response, so the browser
 * shrinks the picture to a thumbnail before sending it and this puts a hard
 * ceiling under that. Both sides import these: the browser to know what to
 * produce, the server to refuse anything else. A validator that lived on one
 * side only would be a validator the other side could drift away from.
 */

/**
 * The square the picture is resized to before upload.
 *
 * Enough for the largest place it is drawn -- the account page -- at twice
 * the density, and nowhere near enough to be worth storing a photograph.
 */
export const AVATAR_SIZE = 256;

/**
 * The most an encoded avatar may weigh.
 *
 * A 256px WebP lands around 15 KB, so this is generous for a thumbnail and
 * still small enough that it can sit in a row that is read on every request.
 */
export const MAX_AVATAR_BYTES = 256 * 1024;

/** The formats accepted, and the one the browser encodes to when it can. */
export const AVATAR_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;

/**
 * Whether a stored value is an avatar this system produced.
 *
 * Deliberately strict, and matched against the whole string: this value ends
 * up in an `img src`, so anything that is not base64 image data -- an
 * `http:` URL that would leak a request, an SVG that can carry script -- is
 * refused rather than sanitised. GitHub's own URLs are set by the OAuth flow
 * and never travel through here.
 */
export function isAvatarDataUrl(value: string): boolean {
  const match = /^data:([a-z]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  if (!(AVATAR_TYPES as readonly string[]).includes(match[1]!)) return false;
  return decodedLength(match[2]!) <= MAX_AVATAR_BYTES;
}

/**
 * How many bytes a base64 payload decodes to, without decoding it.
 *
 * Checking the length before allocating is the point: the string itself has
 * already been received, but nothing should turn a megabyte of it into a
 * buffer just to find out it was too big.
 */
export function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
