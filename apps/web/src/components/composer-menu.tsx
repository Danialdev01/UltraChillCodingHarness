"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface MenuRow {
  key: string;
  icon: ReactNode;
  label: string;
  /** Dimmer text after the label: a folder, a description, a reason. */
  detail?: string;
  /** Cut the detail from the left -- for paths, whose end is the part that matters. */
  detailRtl?: boolean;
  /** Shown but not pickable; `detail` should say why. */
  disabled?: boolean;
  /** The current value, marked so you can see what you would be changing. */
  current?: boolean;
}

/**
 * The list the composer's `@` and `/` open above the box.
 *
 * Only a view. The textarea keeps focus and the keys -- arrows, Enter, Tab,
 * Escape -- stay with it; a row is picked on mouse-down rather than click so
 * the textarea never loses focus in between.
 */
export function ComposerMenu({
  id,
  rows,
  selected,
  empty,
  onHover,
  onPick,
}: {
  id: string;
  rows: readonly MenuRow[];
  selected: number;
  empty: string;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}) {
  const list = useRef<HTMLUListElement>(null);

  // Arrowing past the bottom of what fits scrolls with you.
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="border-border bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border shadow-lg">
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-xs">{empty}</p>
      ) : (
        <ul ref={list} id={id} role="listbox" className="max-h-64 overflow-y-auto p-1">
          {rows.map((row, index) => (
            <li
              key={row.key}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === selected}
              aria-disabled={row.disabled || undefined}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(index);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-disabled:cursor-default aria-disabled:opacity-50",
                index === selected && "bg-ucch-active-bg",
              )}
            >
              {row.icon}
              <span className={cn("text-foreground max-w-[60%] shrink-0 truncate", row.current && "font-medium")}>
                {row.label}
              </span>
              {row.detail &&
                (row.detailRtl ? (
                  <span dir="rtl" className="text-muted-foreground min-w-0 flex-1 truncate text-left text-xs">
                    {/* The isolate keeps `src/lib` reading left-to-right inside an rtl box. */}
                    <bdi>{row.detail}</bdi>
                  </span>
                ) : (
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{row.detail}</span>
                ))}
              {row.current && <span className="text-ucch-active shrink-0 text-xs">current</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
