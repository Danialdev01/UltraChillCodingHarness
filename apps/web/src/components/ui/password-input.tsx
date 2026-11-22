"use client"

import * as React from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type PasswordInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  /** Names the value in the button's label: "Show password", "Hide key". */
  revealLabel?: string
  /** Classes for the wrapper. Layout classes (`flex-1`, `max-w-sm`) go here. */
  wrapperClassName?: string
  /**
   * Render a plain `<input>` styled only by `className`, for forms that use
   * their own field class instead of `<Input>`'s.
   */
  bare?: boolean
}

/**
 * A password, key or secret field with an eye button that shows what was
 * typed. It hides itself again whenever a controlled value is cleared (after
 * a save, or when a dialog resets), so a value is not left on screen.
 */
function PasswordInput({
  revealLabel = "password",
  wrapperClassName,
  bare = false,
  className,
  disabled,
  value,
  ...props
}: PasswordInputProps) {
  const [shown, setShown] = React.useState(false)
  React.useEffect(() => {
    if (value === "") setShown(false)
  }, [value])

  const action = `${shown ? "Hide" : "Show"} ${revealLabel}`
  const inputProps = {
    ...props,
    value,
    disabled,
    type: shown ? "text" : "password",
    className: cn(className, "pr-9"),
  }

  return (
    <div className={cn("relative w-full min-w-0", wrapperClassName)}>
      {bare ? <input {...inputProps} /> : <Input {...inputProps} />}
      {/* Plain <button>: it sits inside the field and needs no variant
          chrome. `type="button"` keeps it from submitting the form. */}
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        disabled={disabled}
        aria-label={action}
        aria-pressed={shown}
        title={action}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        {shown ? (
          <EyeOffIcon className="size-4" aria-hidden="true" />
        ) : (
          <EyeIcon className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}

export { PasswordInput }
