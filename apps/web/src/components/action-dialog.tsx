"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Loader2Icon, XIcon } from "lucide-react";

import { FOCUS } from "@/components/form-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The roomier dialog shell: delete project, new session.
 *
 * The same `--fd-*` roles as `FormDialog`, at a larger scale -- a 40px icon
 * tile, a 17px title, 40px fields and 38px footer buttons -- for dialogs that
 * are one decision rather than a form to fill in. `tone="danger"` turns the
 * tile and the primary button red.
 */

type Tone = "accent" | "danger";

export const SECTION_LABEL = "text-[13px] font-semibold text-(--fd-text)";
export const FIELD_LABEL = "text-[13px] font-medium text-(--fd-text)";
export const HELPER_TEXT = "text-[12px] leading-normal text-(--fd-text-muted)";
export const INPUT = cn(
  "h-10 w-full rounded-[8px] border border-(--fd-border-field) bg-(--fd-field) px-3 text-[13.5px] text-(--fd-text) transition-[border-color,box-shadow] placeholder:text-(--fd-text-disabled) disabled:cursor-not-allowed disabled:opacity-70",
  FOCUS,
);
/** A selectable card: a radio in a group of them. Add the checked look per tone. */
export const CARD = cn(
  "flex min-w-0 items-start gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] disabled:cursor-not-allowed",
  FOCUS,
);
export const CARD_UNCHECKED = "border-(--fd-border) bg-(--fd-field-muted) enabled:hover:border-(--fd-border-hover)";
export const CARD_CHECKED_ACCENT = "border-(--fd-accent) bg-(--fd-accent-tint)";
export const CARD_CHECKED_DANGER = "border-(--fd-danger) bg-(--fd-danger-tint) focus-visible:border-(--fd-danger)";

export function ActionDialog({
  open,
  onOpenChange,
  busy,
  icon: Icon,
  tone = "accent",
  title,
  description,
  onSubmit,
  initialFocus,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** While true the dialog cannot be dismissed. */
  busy?: boolean;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;
  tone?: Tone;
  title: React.ReactNode;
  description: React.ReactNode;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  initialFocus?: React.RefObject<HTMLElement | null>;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        initialFocus={initialFocus}
        className="form-dialog flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-[14px] border border-(--fd-border) bg-(--fd-surface) p-0 text-(--fd-text) shadow-(--fd-shadow) ring-0 sm:max-w-[520px]"
      >
        <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
          <header className="flex items-start gap-3.5 border-b border-(--fd-border-subtle) px-5 pt-5 pb-[18px]">
            <div
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-[10px] border",
                tone === "danger"
                  ? "border-(--fd-danger-tint-border) bg-(--fd-danger-tint)"
                  : "border-(--fd-accent-tile-border) bg-(--fd-accent-tile)",
              )}
            >
              <Icon
                className={cn("size-5", tone === "danger" ? "text-(--fd-danger-icon)" : "text-(--fd-accent-soft)")}
                strokeWidth={1.8}
                aria-hidden
              />
            </div>
            <div className="flex min-w-0 grow flex-col gap-1">
              <DialogPrimitive.Title className="text-[17px] leading-snug font-semibold tracking-[-0.01em] text-(--fd-text)">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-[13.5px] leading-[1.45] break-words text-(--fd-text-muted)">
                {description}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              disabled={busy}
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-[8px] border border-transparent text-(--fd-text-muted) transition-colors hover:bg-(--fd-hover) disabled:opacity-40",
                FOCUS,
              )}
            >
              <XIcon className="size-4" aria-hidden />
            </DialogPrimitive.Close>
          </header>

          <div className="flex min-h-0 flex-col gap-[22px] overflow-y-auto p-5">{children}</div>

          {footer}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The footer band: a hint on the left, Cancel and the primary action on the right. */
export function ActionDialogFooter({
  hint,
  hintIcon: HintIcon,
  tone = "accent",
  busy,
  ready,
  children,
}: {
  hint?: React.ReactNode;
  hintIcon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  tone?: Tone;
  /** Working: a spinner, and the button stays at full strength. */
  busy?: boolean;
  /** Everything needed to submit is in place. */
  ready: boolean;
  /** The primary button's label. */
  children: React.ReactNode;
}) {
  const live = ready || busy;
  return (
    <footer className="flex items-center gap-2.5 border-t border-(--fd-border-subtle) bg-(--fd-surface-footer) px-5 py-3.5">
      <span className="flex min-w-0 grow items-center gap-1.5 text-[12.5px] text-(--fd-text-muted)">
        {HintIcon && <HintIcon className="size-3.5 shrink-0" aria-hidden />}
        {hint}
      </span>
      <DialogPrimitive.Close
        type="button"
        disabled={busy}
        className={cn(
          "h-[38px] shrink-0 rounded-[8px] border border-(--fd-border-hover) bg-transparent px-4 text-[13.5px] font-medium text-(--fd-text) transition-colors hover:bg-(--fd-cancel-hover) disabled:opacity-40",
          FOCUS,
        )}
      >
        Cancel
      </DialogPrimitive.Close>
      <button
        type="submit"
        disabled={!ready || busy}
        className={cn(
          "flex h-[38px] shrink-0 items-center gap-2 rounded-[8px] border px-4 text-[13.5px] transition-colors",
          FOCUS,
          tone === "danger"
            ? live
              ? "border-(--fd-danger-solid) bg-(--fd-danger-solid) font-semibold text-white enabled:hover:border-(--fd-danger-solid-hover) enabled:hover:bg-(--fd-danger-solid-hover)"
              : "cursor-not-allowed border-(--fd-danger-off-border) bg-(--fd-danger-off) font-medium text-(--fd-danger-off-text)"
            : cn(
                "border-(--fd-accent) bg-(--fd-accent) font-semibold text-(--fd-on-accent) enabled:hover:border-(--fd-accent-hover) enabled:hover:bg-(--fd-accent-hover)",
                !live && "cursor-not-allowed opacity-40",
              ),
        )}
      >
        {busy && <Loader2Icon className="size-3.5 animate-spin" aria-hidden />}
        {children}
      </button>
    </footer>
  );
}

/** A label, the field, and a line under it (or the error in its place). */
export function ActionField({
  label,
  htmlFor,
  labelId,
  helper,
  error,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  labelId?: string;
  helper?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} id={labelId} className={FIELD_LABEL}>
          {label}
        </label>
      ) : (
        <span id={labelId} className={FIELD_LABEL}>
          {label}
        </span>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-[12.5px] leading-normal break-words text-(--fd-danger-text)">
          {error}
        </p>
      ) : (
        helper && <p className={HELPER_TEXT}>{helper}</p>
      )}
    </div>
  );
}
