"use client";

import * as React from "react";
import { ArrowRightIcon, ChevronsUpDownIcon, InfoIcon, Loader2Icon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The quick-action dialogs' shared look: new project, new todo, new database.
 *
 * One shell -- an icon tile and a title above, a scrolling body, a footer band
 * with a hint and the two buttons -- and the fields that go in it. Colours are
 * the `--fd-*` roles in globals.css, each mapped onto the app's theme, so these
 * follow light/dark and any custom theme without knowing about either.
 */

// -- Field styles ------------------------------------------------------------

export const LABEL = "text-[11.5px] font-medium text-(--fd-text-label)";
export const HELPER = "text-[11.5px] leading-normal text-(--fd-text-faint)";
/** Every field's focus: an accent border and a soft ring, in place of the global outline. */
export const FOCUS =
  "outline-none focus-visible:outline-none focus-visible:border-(--fd-accent) focus-visible:ring-[3px] focus-visible:ring-(--fd-ring)";
export const FIELD = cn(
  "flex h-[34px] w-full items-center gap-2 rounded-[8px] border border-(--fd-border-field) bg-(--fd-field) px-2.5 text-left text-[12.5px] text-(--fd-text) transition-[border-color,box-shadow] placeholder:text-(--fd-text-disabled) disabled:cursor-not-allowed disabled:text-(--fd-text-disabled)",
  FOCUS,
);
export const TEXTAREA = cn(FIELD, "h-auto min-h-24 resize-y items-start py-2 leading-normal");
/** A small secondary action inside the body: add, attach, pick. */
export const SECONDARY_BUTTON = cn(
  "flex h-[30px] shrink-0 items-center gap-1.5 rounded-[7px] border border-(--fd-border-field) bg-(--fd-field) px-2.5 text-[12px] font-medium text-(--fd-text-label) transition-colors enabled:hover:border-(--fd-border-hover) disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:text-(--fd-text-muted)",
  FOCUS,
);

// -- The shell ---------------------------------------------------------------

export function FormDialog({
  open,
  onOpenChange,
  busy,
  icon: Icon,
  title,
  description,
  onSubmit,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** While true the dialog cannot be dismissed. */
  busy?: boolean;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: React.ReactNode;
  description: React.ReactNode;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        className="form-dialog flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-[13px] border border-(--fd-border) bg-(--fd-surface) p-0 text-(--fd-text) shadow-(--fd-shadow) ring-0 sm:max-w-[480px]"
      >
        <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
          <header className="flex items-start gap-3 border-b border-(--fd-border-subtle) px-5 pt-[18px] pb-4">
            <div className="grid size-8 shrink-0 place-items-center rounded-[8px] border border-(--fd-accent-tile-border) bg-(--fd-accent-tile)">
              <Icon className="size-4 text-(--fd-accent-soft)" strokeWidth={1.8} />
            </div>
            <div className="flex min-w-0 grow flex-col gap-1">
              <DialogPrimitive.Title className="text-[14.5px] leading-snug font-semibold tracking-[-0.01em] text-(--fd-text)">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-[12px] leading-normal text-(--fd-text-muted)">
                {description}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              disabled={busy}
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-lg border border-transparent text-(--fd-text-muted) transition-colors hover:bg-(--fd-hover)",
                FOCUS,
              )}
            >
              <XIcon className="size-3.5" />
            </DialogPrimitive.Close>
          </header>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pt-[18px] pb-5">
            {children}
          </div>

          {footer}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The footer band: a quiet hint on the left, Cancel and the primary action on the right. */
export function FormDialogFooter({
  hint,
  hintIcon: HintIcon,
  busy,
  disabled,
  children,
}: {
  hint?: React.ReactNode;
  hintIcon?: React.ComponentType<{ className?: string }>;
  /** Working: a spinner, and the button stays at full strength. */
  busy?: boolean;
  /** Not ready to submit. */
  disabled?: boolean;
  /** The primary button's label. */
  children: React.ReactNode;
}) {
  return (
    <footer className="flex items-center gap-2.5 border-t border-(--fd-border-subtle) bg-(--fd-surface-footer) px-5 py-3">
      <span className="flex min-w-0 grow items-center gap-1.5 text-[11px] text-(--fd-text-faint)">
        {HintIcon && <HintIcon className="size-3 shrink-0" />}
        {hint}
      </span>
      <DialogPrimitive.Close
        type="button"
        disabled={busy}
        className={cn(
          "h-8 shrink-0 rounded-[7px] border border-(--fd-border-field) px-3.5 text-[12.5px] font-medium text-(--fd-text-label) transition-colors hover:bg-(--fd-cancel-hover) disabled:opacity-40",
          FOCUS,
        )}
      >
        Cancel
      </DialogPrimitive.Close>
      <button
        type="submit"
        disabled={disabled || busy}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] border border-(--fd-accent) bg-(--fd-accent) px-4 text-[12.5px] font-semibold text-(--fd-on-accent) transition-colors enabled:hover:border-(--fd-accent-hover) enabled:hover:bg-(--fd-accent-hover)",
          FOCUS,
          // Disabled for want of input reads as unavailable; disabled
          // because it is working should not.
          !busy && "disabled:opacity-40",
        )}
      >
        {busy && <Loader2Icon className="size-3.5 animate-spin" />}
        {children}
        {!busy && <ArrowRightIcon className="size-3.5" />}
      </button>
    </footer>
  );
}

// -- Fields ------------------------------------------------------------------

/**
 * A label, the field, and a line under it.
 *
 * `htmlFor` labels a native control; `labelId` names a custom one, which
 * points back with `aria-labelledby`. `aside` sits opposite the label.
 */
export function FormField({
  label,
  htmlFor,
  labelId,
  aside,
  helper,
  error,
  dimLabel,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  labelId?: string;
  aside?: React.ReactNode;
  helper?: React.ReactNode;
  /** Shown in place of the helper, as an alert. */
  error?: React.ReactNode;
  /** The field cannot be used yet. */
  dimLabel?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const labelClass = cn(LABEL, dimLabel && "text-(--fd-text-faint)");
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        {htmlFor ? (
          <label htmlFor={htmlFor} id={labelId} className={labelClass}>
            {label}
          </label>
        ) : (
          <span id={labelId} className={labelClass}>
            {label}
          </span>
        )}
        {aside}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-destructive text-[11.5px] leading-normal break-words">
          {error}
        </p>
      ) : (
        helper && <p className={HELPER}>{helper}</p>
      )}
    </div>
  );
}

/** "(optional)" after a label. */
export function Optional() {
  return <span className="font-normal text-(--fd-text-faint)"> (optional)</span>;
}

/**
 * A segmented control: a radio group whose options sit side by side.
 *
 * Arrow keys move the choice and the focus together, with only the checked
 * segment in the tab order, as a native radio group does.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  options: readonly { value: T; label: string; ariaLabel?: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  labelledBy: string;
}) {
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    buttons.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="flex gap-[3px] rounded-[8px] border border-(--fd-border) bg-(--fd-field) p-[3px]"
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "h-[27px] min-w-0 flex-auto truncate rounded-[6px] border px-2 text-[12px] font-medium transition-colors disabled:opacity-60",
              FOCUS,
              checked
                ? "border-(--fd-border) bg-(--fd-field-raised) text-(--fd-text) shadow-xs"
                : "border-transparent text-(--fd-text-muted) enabled:hover:border-(--fd-border-hover)",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Cards that switch what is shown below them: a title and a hint each.
 *
 * Tabs underneath -- `OptionPanel`s hold what each one shows -- so arrow keys
 * move between the cards and the panel follows.
 */
export function OptionTabs<T extends string>({
  value,
  onChange,
  label,
  aside,
  options,
  disabled,
  children,
}: {
  value: T;
  onChange: (value: T) => void;
  label: string;
  aside?: React.ReactNode;
  options: readonly { value: T; title: string; hint: string }[];
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const labelId = React.useId();
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(next) => !disabled && onChange(String(next) as T)}
      className="flex flex-col gap-2.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span id={labelId} className={LABEL}>
          {label}
        </span>
        {aside && <span className="text-right text-[11px] text-(--fd-text-faint)">{aside}</span>}
      </div>

      <TabsPrimitive.List
        activateOnFocus
        aria-labelledby={labelId}
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <TabsPrimitive.Tab
            key={option.value}
            value={option.value}
            disabled={disabled}
            className={cn(
              "flex min-w-0 flex-col items-start gap-[3px] rounded-[8px] border border-(--fd-border) bg-(--fd-field) px-2.5 py-2 text-left transition-[border-color,box-shadow,background-color]",
              FOCUS,
              "[&:not([data-active]):hover]:border-(--fd-border-hover)",
              "data-active:border-(--fd-accent) data-active:bg-(--fd-accent-tint) data-active:ring-[3px] data-active:ring-(--fd-ring-soft)",
            )}
          >
            <span className="text-[12px] font-medium text-(--fd-text)">{option.title}</span>
            <span className="max-w-full truncate text-[11px] text-(--fd-text-muted)">{option.hint}</span>
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>

      {children}
    </TabsPrimitive.Root>
  );
}

export function OptionPanel({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TabsPrimitive.Panel value={value} className={cn("flex flex-col gap-3 rounded-md pt-1 outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
      {children}
    </TabsPrimitive.Panel>
  );
}

/**
 * A choice from a list, in the same popover the chat's model and effort
 * pickers use, so a choice looks and behaves the same wherever it is made.
 * `searchable` adds a filter box for lists too long to scan.
 */
export function PopoverSelect<T extends string>({
  value,
  options,
  onChange,
  heading,
  icon: Icon,
  placeholder,
  disabled,
  labelledBy,
  searchable,
  emptyText = "Nothing matches that.",
  popoverClassName,
}: {
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  heading?: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  labelledBy: string;
  searchable?: boolean;
  emptyText?: string;
  popoverClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={labelledBy}
            disabled={disabled}
            className={FIELD}
          />
        }
      >
        {Icon && <Icon className="size-3.5 shrink-0 text-(--fd-text-muted)" />}
        <span className={cn("min-w-0 grow truncate", !selected && "text-(--fd-text-faint)")}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-(--fd-icon-dim)" />
      </PopoverTrigger>

      <PopoverContent className={cn("w-(--anchor-width) min-w-56 p-0", popoverClassName)}>
        <Command>
          {searchable && <CommandInput placeholder="Search…" />}
          <CommandList className="max-h-64">
            {searchable && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup heading={heading}>
              {options.map((option) => (
                <CommandItem
                  key={option.value || "none"}
                  // cmdk matches on this when searching, so it is the label
                  // and the id together.
                  value={`${option.label} ${option.value}`}
                  data-checked={option.value === value}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && (
                    <span className="text-muted-foreground shrink-0 text-[10px]">{option.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// -- Notes -------------------------------------------------------------------

/** A quiet note: an icon and a sentence, on a muted ground. */
export function Callout({
  icon: Icon = InfoIcon,
  accent,
  className,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  /** The icon in the accent colour, for a note that is the point rather than an aside. */
  accent?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-[8px] border border-(--fd-border-subtle) bg-(--fd-field-muted) px-2.5 py-2",
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-px size-3.5 shrink-0",
          accent ? "text-(--fd-accent-soft)" : "text-(--fd-icon-dim)",
        )}
      />
      <div className="min-w-0 text-[11.5px] leading-[1.55] break-words text-(--fd-text-muted)">
        {children}
      </div>
    </div>
  );
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="fd-mono rounded-[4px] bg-(--fd-code-bg) px-[5px] py-px text-[11px] text-(--fd-text-label)">
      {children}
    </code>
  );
}
