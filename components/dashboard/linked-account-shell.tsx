"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CountryCombobox } from "@/components/country-combobox"
import useSWR from "swr"
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Building2,
  Copy,
  Check,
  Globe,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  ShieldCheck,
  Wallet,
  Zap,
} from "lucide-react"
import {
  getMyLinkedAccount,
  linkedPayout,
  resolveLinkedBeneficiary,
  type LinkedAccountView,
} from "@/app/actions/linked-account"
import { validateIban, lookupBankByIban, isGenericBankInfo, type BankInfo } from "@/lib/iban-swift"
import { resolveIbanExternal } from "@/app/actions/bank-resolve"

function money(n: number, currency: string) {
  return `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type Mode = null | "payout"

export function LinkedAccountShell({ displayName }: { displayName: string }) {
  const { data, isLoading, mutate } = useSWR("linked-account", async () => {
    const res = await getMyLinkedAccount()
    return res.ok ? res.data : null
  })

  const [mode, setMode] = useState<Mode>(null)

  return (
    <div className="min-h-[100dvh] bg-[#0b0b0d] text-neutral-100">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/15 text-amber-400">
            <Building2 className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold">NAFTAhub</p>
            <p className="text-[11px] text-neutral-400">Linked sub-account access</p>
          </div>
        </div>
        <form action="/api/logout" method="POST">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </form>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        <div className="mb-5">
          <h1 className="text-balance text-xl font-semibold sm:text-2xl">Welcome, {displayName}</h1>
          <p className="mt-1 text-sm text-neutral-400">
            You have delegated access to the sub-account below. You can view its balance and activity, and
            request outgoing payments from it &mdash; every payment is authorized by the administrator.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-6 text-sm text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your linked account&hellip;
          </div>
        ) : !data ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-sm text-neutral-400">
            Your linked sub-account is no longer available. It may have been closed or unlinked by the
            administrator. Please contact support if you believe this is an error.
          </div>
        ) : (
          <AccountCard
            view={data}
            onAction={(m) => setMode(m)}
            onRefresh={() => void mutate()}
          />
        )}
      </main>

      {mode && data && (
        <ActionSheet
          mode={mode}
          view={data}
          onClose={() => setMode(null)}
          onDone={() => {
            setMode(null)
            void mutate()
          }}
        />
      )}
    </div>
  )
}

function AccountCard({
  view,
  onAction,
  onRefresh,
}: {
  view: LinkedAccountView
  onAction: (m: Mode) => void
  onRefresh: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copyIban = useCallback(() => {
    if (!view.iban) return
    navigator.clipboard?.writeText(view.iban).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [view.iban])

  return (
    <div className="space-y-5">
      {/* Balance + identity */}
      <section className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{view.label}</h2>
            <p className="text-xs text-neutral-400">{view.currency} compartment</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" /> Active
          </span>
        </div>

        <div className="mt-5">
          <p className="text-xs text-neutral-400">Available balance</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
            {money(view.balance, view.currency)}
          </p>
        </div>

        {view.iban && (
          <div className="mt-5 rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-neutral-400">
                  <Building2 className="h-3 w-3" /> IBAN
                </p>
                <p className="mt-0.5 truncate font-mono text-sm">{view.iban}</p>
              </div>
              <button
                onClick={copyIban}
                className="shrink-0 rounded-md p-2 text-neutral-400 transition hover:bg-white/5 hover:text-white"
                title="Copy IBAN"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            {view.bic && <p className="mt-2 text-xs text-neutral-400">BIC {view.bic}</p>}
            {view.beneficiaryName && (
              <p className="mt-1 text-xs text-neutral-400">Beneficiary {view.beneficiaryName}</p>
            )}
          </div>
        )}

        {/* Actions — a linked visitor can only REQUEST an outgoing payment from
            this compartment's own balance. Funding the compartment is done by the
            account owner / administrator, not from here. */}
        <div className="mt-5">
          <button
            onClick={() => onAction("payout")}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-amber-400"
          >
            <Send className="h-4 w-4" /> New payment
          </button>
        </div>
      </section>

      {/* Pending payouts */}
      {view.payouts.length > 0 && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <Banknote className="h-4 w-4 text-amber-400" /> Payments
          </h3>
          <ul className="space-y-2">
            {view.payouts.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{p.beneficiary}</p>
                  <p className="text-[11px] text-neutral-400">
                    {p.reference || "No reference"} &middot; {new Date(p.submittedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium">{money(p.amount, p.currency)}</p>
                  <StatusChip status={p.status} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Activity */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Wallet className="h-4 w-4 text-amber-400" /> Recent activity
          </h3>
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        {view.activity.length === 0 ? (
          <p className="py-6 text-center text-sm text-neutral-500">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {view.activity.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      a.direction === "credit"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {a.direction === "credit" ? (
                      <ArrowDownLeft className="h-4 w-4" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm">{a.counterparty || a.category || "Transaction"}</p>
                    <p className="text-[11px] text-neutral-400">
                      {new Date(a.date).toLocaleDateString()} &middot; {a.category || "—"}
                    </p>
                  </div>
                </div>
                <p
                  className={`shrink-0 text-sm font-medium ${
                    a.direction === "credit" ? "text-emerald-400" : "text-neutral-200"
                  }`}
                >
                  {a.direction === "credit" ? "+" : "−"}
                  {money(a.amount, a.currency)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="pb-4 text-center text-[11px] text-neutral-500">
        Delegated access &middot; A 2% platform fee applies to outgoing payments.
      </p>
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const s = status.toLowerCase()
  const cls =
    s === "approved"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
      : s === "rejected" || s === "cancelled"
        ? "border-red-500/30 bg-red-500/10 text-red-400"
        : "border-amber-500/30 bg-amber-500/10 text-amber-400"
  const label = s === "pending" ? "Awaiting approval" : status.charAt(0).toUpperCase() + status.slice(1)
  return <span className={`mt-0.5 inline-block rounded-full border px-2 py-0.5 text-[10px] ${cls}`}>{label}</span>
}

function ActionSheet({
  mode,
  view,
  onClose,
  onDone,
}: {
  mode: Mode
  view: LinkedAccountView
  onClose: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<"instant" | "pending" | null>(null)

  // payout fields
  const [amount, setAmount] = useState("")
  const [beneficiary, setBeneficiary] = useState("")
  const [iban, setIban] = useState("")
  const [swiftCode, setSwiftCode] = useState("")
  const [country, setCountry] = useState("")
  const [reference, setReference] = useState("")

  // IBAN verification + auto-fill + rail (internal instant vs external approval)
  const [ibanStatus, setIbanStatus] = useState<"idle" | "checking" | "valid" | "invalid">("idle")
  const [ibanError, setIbanError] = useState<string | null>(null)
  const [bankInfo, setBankInfo] = useState<BankInfo | null>(null)
  const [rail, setRail] = useState<"internal" | "external" | null>(null)
  const ibanTicket = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Validate the beneficiary IBAN, resolve its bank (auto-filling SWIFT +
  // country), and determine whether it belongs to a NAFTAhub account so the
  // user knows the transfer will settle instantly vs. go through the desk.
  useEffect(() => {
    const trimmed = iban.trim()
    const ticket = ++ibanTicket.current
    if (!trimmed) {
      setIbanStatus("idle")
      setIbanError(null)
      setBankInfo(null)
      setRail(null)
      return
    }
    const result = validateIban(trimmed)
    if (!result.valid) {
      setIbanStatus("invalid")
      setIbanError(result.error ?? "Invalid IBAN")
      setBankInfo(null)
      setRail(null)
      return
    }
    setIbanStatus("checking")
    setIbanError(null)
    setRail(null)
    const timer = setTimeout(async () => {
      let info = await lookupBankByIban(trimmed)
      if (isGenericBankInfo(info)) {
        try {
          const ext = await resolveIbanExternal(trimmed)
          if (ext && (ext.name || ext.bic || ext.city)) {
            info = {
              name: ext.name ?? info?.name ?? "Registered institution",
              country: info?.country ?? "",
              countryCode: info?.countryCode ?? "",
              bic: ext.bic ?? info?.bic,
              city: ext.city ?? info?.city,
              postalCode: ext.postalCode ?? info?.postalCode,
              address: ext.address ?? info?.address,
            }
          }
        } catch {
          /* keep offline result */
        }
      }
      let internal = false
      try {
        const res = await resolveLinkedBeneficiary(trimmed, beneficiary)
        if (res.ok) internal = res.internal
      } catch {
        /* default to external */
      }
      if (ticket !== ibanTicket.current) return
      setBankInfo(info)
      setIbanStatus("valid")
      setRail(internal ? "internal" : "external")
      // Auto-fill SWIFT + country from the resolved bank when still empty.
      if (info?.bic) setSwiftCode((prev) => (prev.trim() ? prev : info!.bic!))
      if (info?.country) setCountry((prev) => (prev.trim() ? prev : info!.country))
    }, 350)
    return () => clearTimeout(timer)
    // Re-evaluate the rail when the beneficiary name changes too: the shared
    // default (house) IBAN is disambiguated to a recipient by name server-side.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iban, beneficiary])

  const amt = Number.parseFloat(amount)
  const feeRate = 0.02
  const fee = Number.isFinite(amt) && amt > 0 ? Math.round(amt * feeRate * 100) / 100 : 0

  const title = "Request a payment"

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await linkedPayout({
        beneficiary,
        beneficiaryCountry: country,
        iban,
        swiftCode,
        reference,
        amount: amt,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      // Show the outcome, then close + refresh so the balance/activity update.
      setDone(res.data.settlement)
      setTimeout(() => onDone(), 1600)
    } catch {
      setError("Something went wrong. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const disabled =
    busy ||
    !(amt > 0) ||
    beneficiary.trim().length === 0 ||
    iban.trim().length < 8 ||
    ibanStatus === "invalid" ||
    ibanStatus === "checking"

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-2xl border border-white/10 bg-[#141416] p-5 text-neutral-100 sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-neutral-400 hover:bg-white/5 hover:text-white">
            <span className="sr-only">Close</span>✕
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center py-8 text-center">
            <div
              className={`flex h-14 w-14 items-center justify-center rounded-full ${
                done === "instant" ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"
              }`}
            >
              {done === "instant" ? <Zap className="h-7 w-7" /> : <ShieldCheck className="h-7 w-7" />}
            </div>
            <h4 className="mt-4 text-base font-semibold text-neutral-100">
              {done === "instant" ? "Transfer settled" : "Payment submitted"}
            </h4>
            <p className="mt-1 max-w-xs text-sm text-neutral-400">
              {done === "instant"
                ? `${money(amt, view.currency)} was transferred instantly to ${beneficiary}.`
                : `Your ${money(amt, view.currency)} payment to ${beneficiary} is awaiting administrator authorization.`}
            </p>
          </div>
        ) : (
          <>
        <p className="mb-4 text-xs text-neutral-400">
          Paid out of &ldquo;{view.label}&rdquo;&apos;s own balance. Transfers to another NAFTAhub account
          settle instantly; payments to an outside bank are released after administrator authorization.
        </p>

        <div className="space-y-3">
          <Field label="Beneficiary name">
            <input
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
              placeholder="e.g. Apple Distribution Intl."
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SWIFT / BIC">
              <input value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)} placeholder="XXXXXXXX" className={inputCls} />
            </Field>
            <Field label="Country">
              <CountryCombobox
                valueMode="name"
                value={country}
                onChange={setCountry}
                placeholder="Select country"
                triggerClassName="rounded-lg border-white/15 bg-black/30 px-3 py-2.5 text-neutral-100 hover:bg-black/40 hover:text-neutral-100"
              />
            </Field>
          </div>
          <Field label="IBAN / Account number">
            <div className="relative">
              <input
                value={iban}
                onChange={(e) => setIban(e.target.value)}
                placeholder="XX00 0000 0000 0000"
                autoCapitalize="characters"
                spellCheck={false}
                className={`${inputCls} pr-9 font-mono uppercase ${
                  ibanStatus === "valid"
                    ? "border-emerald-500/60"
                    : ibanStatus === "invalid"
                      ? "border-red-500/60"
                      : ""
                }`}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                {ibanStatus === "checking" && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
                {ibanStatus === "valid" && <Check className="h-4 w-4 text-emerald-400" />}
                {ibanStatus === "invalid" && <AlertCircle className="h-4 w-4 text-red-400" />}
              </span>
            </div>
            {ibanStatus === "invalid" && ibanError && (
              <p className="mt-1 text-xs text-red-300">{ibanError}</p>
            )}
            {ibanStatus === "checking" && (
              <p className="mt-1 text-xs text-neutral-400">Verifying with the bank directory…</p>
            )}
            {ibanStatus === "valid" && bankInfo && (
              <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <Building2 className="h-4 w-4 text-amber-400" />
                  <span className="font-medium text-neutral-100">{bankInfo.name}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-400">
                  {bankInfo.country && (
                    <span className="inline-flex items-center gap-1">
                      <Globe className="h-3 w-3" />
                      {bankInfo.country}
                    </span>
                  )}
                  {bankInfo.bic && <span className="font-mono">BIC {bankInfo.bic}</span>}
                </div>
              </div>
            )}
            {ibanStatus === "valid" && rail === "internal" && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
                <Zap className="h-3.5 w-3.5" />
                NAFTAhub account — this transfer settles instantly.
              </p>
            )}
            {ibanStatus === "valid" && rail === "external" && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
                <ShieldCheck className="h-3.5 w-3.5" />
                External bank — released after administrator authorization.
              </p>
            )}
          </Field>
          <Field label="Reference (optional)">
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="INV-2024-XXX" className={inputCls} />
          </Field>

          <Field label={`Amount (${view.currency})`}>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className={inputCls}
            />
          </Field>

          {amt > 0 && (
            <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
              <Row label="Amount" value={money(amt, view.currency)} />
              <Row label="2% platform fee" value={money(fee, view.currency)} />
              <div className="mt-2 border-t border-white/10 pt-2">
                <Row label="Total" value={money(amt + fee, view.currency)} strong />
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium transition hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={disabled}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit request
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  )
}

const inputCls =
  "w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-amber-500/60"

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      {children}
    </label>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-400">{label}</span>
      <span className={strong ? "font-semibold" : "font-medium"}>{value}</span>
    </div>
  )
}
