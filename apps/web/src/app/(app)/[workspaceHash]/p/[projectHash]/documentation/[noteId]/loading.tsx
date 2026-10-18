/**
 * Nothing to draw: the note on screen belongs to the layout, which switches
 * to the new one itself. The boundary is what lets it: without one, a click
 * from one note to another waited on the server before the address -- and
 * so the layout -- moved at all.
 */
export default function Loading() {
  return null;
}
