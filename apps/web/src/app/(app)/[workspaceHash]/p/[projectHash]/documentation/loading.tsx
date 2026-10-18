/**
 * Nothing to draw: the pages under `notes` render nothing, and the skeleton
 * is the layout's own Suspense fallback. The file still matters -- the
 * router prefetches a dynamic route only as far down as its first loading
 * boundary, and without one here a click on Notes would fetch the whole
 * segment on demand rather than have it ready.
 */
export default function Loading() {
  return null;
}
