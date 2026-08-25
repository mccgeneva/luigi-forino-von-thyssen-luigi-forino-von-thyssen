"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"

/**
 * Shared money-amount input used everywhere a currency amount is typed.
 *
 * WHY THIS EXISTS: a native `<input type="number">` can never show thousands
 * separators, so a value like `1500000000` reads as an unbroken wall of digits
 * that is impossible to sanity-check. This component renders the value WITH
 * grouping separators live as the user types (e.g. `1,500,000,000`) while
 * emitting the RAW, separator-free numeric string via `onValueChange`, so every
 * existing `parseFloat(amount)` / `Number(amount)` consumer keeps working with
 * zero other changes.
 *
 * DROP-IN USAGE — replace:
 *   <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
 * with:
 *   <MoneyInput value={amount} onValueChange={setAmount} />
 *
 * It is deliberately `type="text"` + `inputMode="decimal"` (not `number`): this
 * lets us format the display, avoids the browser's number spinners, and shows
 * the numeric keypad on mobile. `text-base` keeps the font ≥16px so iOS Safari
 * does not auto-zoom the field on focus.
 */

/** Strip everything except digits and a single decimal point. */
function sanitizeRaw(input: string): string {
  let s = input.replace(/[^\d.]/g, "")
  const firstDot = s.indexOf(".")
  if (firstDot !== -1) {
    // keep only the first dot; drop any further ones
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "")
  }
  return s
}

/** Format a raw numeric string with grouping separators for DISPLAY only. */
function formatDisplay(raw: string): string {
  if (!raw) return ""
  const [intPart, decPart] = raw.split(".")
  const grouped = (intPart || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  if (raw.includes(".")) {
    // preserve a trailing dot / decimals exactly as typed
    return `${grouped || "0"}.${decPart ?? ""}`
  }
  return grouped
}

export interface MoneyInputProps
  extends Omit<React.ComponentPropsWithoutRef<typeof Input>, "value" | "onChange" | "type" | "inputMode"> {
  /** RAW numeric string (no separators), e.g. "1500000000" or "1500000.50". */
  value: string
  /** Called with the RAW numeric string (no separators). */
  onValueChange: (rawValue: string) => void
}

export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onValueChange, placeholder = "0.00", className, ...rest },
  ref,
) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onValueChange(sanitizeRaw(e.target.value))
  }

  return (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      // iOS Safari otherwise treats an amount field as autofillable and pops the
      // "AutoFill" accessory INSTEAD of the numeric keypad (the keyboard appears
      // to be "missing"). These attributes disable every password-manager /
      // contact autofill heuristic so the numeric keyboard always shows.
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      enterKeyHint="done"
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      placeholder={placeholder}
      value={formatDisplay(value)}
      onChange={handleChange}
      className={className}
      {...rest}
    />
  )
})
