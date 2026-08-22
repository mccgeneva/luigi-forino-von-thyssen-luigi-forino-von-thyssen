"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown, Landmark, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  PARTNER_BANKS,
  BANK_REGIONS,
  partnerBankByKey,
  type PartnerBank,
} from "@/lib/partner-banks"

type BankComboboxProps = {
  /** Selected partner-bank key (e.g. "hsbc"). */
  value?: string
  onChange: (key: string) => void
  placeholder?: string
  id?: string
  triggerClassName?: string
  contentClassName?: string
}

/**
 * Searchable, scrollable issuing-bank selector backed by the centralized
 * worldwide partner-bank catalogue (`PARTNER_BANKS`). Banks are grouped by
 * region and searchable by name, country or BIC.
 *
 * IMPORTANT: this renders its list INLINE (in normal document flow) rather than
 * in a portalled Radix Popover. These selectors always live inside a Dialog,
 * and on touch devices a nested Popover fought the dialog's focus trap — the
 * list floated over other fields and would not dismiss ("stuck open"). Rendering
 * inline makes the dialog grow/scroll predictably and lets the panel close
 * cleanly on select, outside tap, or Escape.
 */
export function BankCombobox({
  value,
  onChange,
  placeholder = "Select issuing bank",
  id,
  triggerClassName,
  contentClassName,
}: BankComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = value ? partnerBankByKey(value) : undefined

  // Close on outside tap/click and on Escape while the panel is open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  // Group the catalogue by region once, then filter by the live query.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byRegion = new Map<string, PartnerBank[]>()
    for (const bank of PARTNER_BANKS) {
      if (
        q &&
        !`${bank.name} ${bank.country} ${bank.bic} ${bank.key}`.toLowerCase().includes(q)
      ) {
        continue
      }
      const list = byRegion.get(bank.region) ?? []
      list.push(bank)
      byRegion.set(bank.region, list)
    }
    return BANK_REGIONS.map((region) => ({
      region,
      banks: (byRegion.get(region) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((g) => g.banks.length > 0)
  }, [query])

  const handleSelect = (key: string) => {
    onChange(key)
    setOpen(false)
    setQuery("")
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        id={id}
        type="button"
        variant="outline"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "w-full justify-between font-normal",
          !selected && "text-muted-foreground",
          triggerClassName,
        )}
      >
        {selected ? (
          <span className="flex items-center gap-2 truncate">
            <Landmark className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{selected.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{selected.country}</span>
          </span>
        ) : (
          placeholder
        )}
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>

      {open && (
        <div
          className={cn(
            "mt-2 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md",
            contentClassName,
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by bank, country or BIC..."
              className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="max-h-64 overflow-y-auto overscroll-contain py-1" role="listbox">
            {grouped.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No bank found.</p>
            ) : (
              grouped.map((group) => (
                <div key={group.region}>
                  <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    {group.region}
                  </p>
                  {group.banks.map((bank) => {
                    const isSelected = selected?.key === bank.key
                    return (
                      <button
                        key={bank.key}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => handleSelect(bank.key)}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                          isSelected && "bg-accent text-accent-foreground",
                        )}
                      >
                        <Landmark
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{bank.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {bank.country} · {bank.bic}
                          </span>
                        </span>
                        <Check
                          className={cn(
                            "ml-auto h-4 w-4 shrink-0",
                            isSelected ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
