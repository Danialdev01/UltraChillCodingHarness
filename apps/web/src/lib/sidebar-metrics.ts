/**
 * Distance from the sidebar's left edge to a control inside the second
 * column, in pixels.
 *
 * The parts: the rail (`--sidebar-width-icon`, 3.375rem = 54px), its 1px
 * right border, and the 12px horizontal padding of the panel's header.
 */
export const RAIL_OFFSET_PX = 54 + 1 + 12;

/**
 * How far left to pull a sidebar dropdown so it covers the icon rail.
 *
 * Deliberately larger than RAIL_OFFSET_PX. Paired with `collisionPadding={0}`,
 * the positioner's shift keeps the menu inside the viewport, so the overshoot
 * is clamped to exactly the left edge -- the menu sits flush against it
 * whatever the trigger's precise offset turns out to be. Relying on the
 * arithmetic alone leaves a sliver of the rail showing if any padding
 * upstream changes by a pixel.
 */
export const RAIL_OVERLAP_PX = RAIL_OFFSET_PX + 24;
