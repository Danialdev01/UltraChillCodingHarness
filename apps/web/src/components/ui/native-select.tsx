"use client";

import * as React from "react";
import { ChevronsUpDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A short list of choices. A native `<select>` rather than the combobox the
 * pickers use: a handful of options needs no search, and the platform's own
 * menu is the most usable one on a phone.
 */
export function NativeSelect({
  id,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "border-input bg-background h-8 w-full appearance-none rounded-lg border pr-8 pl-2.5 text-sm outline-none",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50",
          "dark:bg-input/30",
        )}
      >
        {children}
      </select>
      <ChevronsUpDownIcon className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2" />
    </div>
  );
}
