"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import type { Cell, ColumnInfo, TableDetail } from "@ucch/protocol";

import { Flag } from "@/components/database/column-form";
import { errorText } from "@/components/database/db-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { editText, isEditable, parseCellInput } from "@/lib/db-cells";

/**
 * How one field of the form is filled: as text, as NULL, or left to the
 * engine's default -- which for an inserted row means the column is left
 * out of the statement, and for an edited row means it is left alone.
 */
interface FieldState {
  mode: "value" | "null" | "default";
  text: string;
}

function initialField(column: ColumnInfo, cell: Cell | undefined): FieldState {
  if (cell === undefined) {
    // Inserting: anything the engine can fill in is left to it.
    if (column.autoincrement || column.generated || column.default !== null)
      return { mode: "default", text: "" };
    if (column.nullable) return { mode: "null", text: "" };
    return { mode: "value", text: "" };
  }
  if (cell === null) return { mode: "null", text: "" };
  return { mode: "value", text: editText(cell) };
}

/**
 * A row as a form: one field per column. Inserts and edits alike -- given
 * `row`, the fields start from it and only the ones changed are sent.
 * `onDone` is called once a submit has gone through, or when nothing had
 * changed; `resetKey` starts the form over (a new row, a reopened dialog).
 */
export function RowForm({
  detail,
  row,
  onSubmit,
  onDone,
  submitLabel,
  resetKey,
  footer,
}: {
  detail: TableDetail;
  /** The row being edited, by column order; absent when inserting. */
  row?: Cell[];
  onSubmit: (values: Record<string, Cell>) => Promise<void>;
  onDone: () => void;
  submitLabel: string;
  resetKey?: unknown;
  /** Rendered beside the submit button: a Cancel, or nothing. */
  footer?: (pending: boolean) => React.ReactNode;
}) {
  const [fields, setFields] = React.useState<FieldState[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setFields(
      detail.columns.map((column, i) => initialField(column, row?.[i])),
    );
    setPending(false);
    setError(null);
  }, [detail, row, resetKey]);

  function update(index: number, next: Partial<FieldState>) {
    setFields((all) =>
      all.map((f, i) => (i === index ? { ...f, ...next } : f)),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const values: Record<string, Cell> = {};
    detail.columns.forEach((column, i) => {
      const field = fields[i]!;
      if (field.mode === "default") return;
      const next: Cell =
        field.mode === "null"
          ? null
          : parseCellInput(field.text, { ...column, nullable: false });
      // Editing: only what changed goes over, so an untouched blob or a
      // value the grid could not show exactly is not written back.
      if (row && (!isEditable(row[i]!) || sameCell(row[i]!, next))) return;
      values[column.name] = next;
    });
    if (row && Object.keys(values).length === 0) return onDone();
    setPending(true);
    setError(null);
    try {
      await onSubmit(values);
      onDone();
    } catch (caught) {
      setError(errorText(caught));
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {detail.columns.map((column, i) => {
          const field = fields[i];
          if (!field) return null;
          const canDefault =
            !row &&
            (column.autoincrement ||
              column.generated ||
              column.default !== null);
          const locked =
            column.generated || (row !== undefined && !isEditable(row[i]!));
          const long = column.kind === "text" || column.kind === "json";
          const id = `row-${column.name}`;
          return (
            <div
              key={column.name}
              className="grid grid-cols-[minmax(0,10rem)_1fr] items-start gap-3"
            >
              <label htmlFor={id} className="flex min-w-0 flex-col pt-1.5">
                <span
                  className="truncate font-mono text-xs font-medium"
                  title={column.name}
                >
                  {column.name}
                </span>
                <span
                  className="text-muted-foreground truncate text-[11px]"
                  title={column.type}
                >
                  {column.type}
                </span>
              </label>
              <div className="flex flex-col gap-1.5">
                {long ? (
                  <Textarea
                    id={id}
                    value={field.text}
                    onChange={(e) =>
                      update(i, { text: e.target.value, mode: "value" })
                    }
                    disabled={pending || locked || field.mode !== "value"}
                    rows={2}
                    className="min-h-9 font-mono text-xs"
                    spellCheck={false}
                  />
                ) : (
                  <Input
                    id={id}
                    value={field.text}
                    onChange={(e) =>
                      update(i, { text: e.target.value, mode: "value" })
                    }
                    disabled={pending || locked || field.mode !== "value"}
                    className="h-8 font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                <div className="text-muted-foreground flex gap-3 text-xs">
                  {column.nullable && (
                    <Flag
                      id={`${id}-null`}
                      label="NULL"
                      checked={field.mode === "null"}
                      disabled={pending || locked}
                      onChange={(on) =>
                        update(i, { mode: on ? "null" : "value" })
                      }
                    />
                  )}
                  {canDefault && (
                    <Flag
                      id={`${id}-default`}
                      label={
                        column.autoincrement
                          ? "Auto"
                          : column.generated
                            ? "Generated"
                            : `Default (${column.default})`
                      }
                      checked={field.mode === "default"}
                      disabled={pending || locked}
                      onChange={(on) =>
                        update(i, {
                          mode: on
                            ? "default"
                            : column.nullable
                              ? "null"
                              : "value",
                        })
                      }
                    />
                  )}
                  {locked && !column.generated && (
                    <span>Binary values cannot be edited here.</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        {footer?.(pending)}
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The form in a dialog, for inserting from the grid and editing a row of it. */
export function RowFormDialog({
  open,
  onOpenChange,
  detail,
  row,
  onSubmit,
  title,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: TableDetail;
  row?: Cell[];
  onSubmit: (values: Record<string, Cell>) => Promise<void>;
  title: string;
  submitLabel: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader className="mb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {row
              ? "Only the fields you change are written."
              : "Fields left at their default are filled in by the engine."}
          </DialogDescription>
        </DialogHeader>
        <RowForm
          detail={detail}
          row={row}
          onSubmit={onSubmit}
          onDone={() => onOpenChange(false)}
          submitLabel={submitLabel}
          resetKey={open}
          footer={(pending) => (
            <DialogClose
              render={
                <Button type="button" variant="outline" disabled={pending} />
              }
            >
              Cancel
            </DialogClose>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}

function sameCell(a: Cell, b: Cell): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a) === String(b);
}
