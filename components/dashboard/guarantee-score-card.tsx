"use client"

import useSWR from "swr"
import { ShieldCheck, ShieldAlert, TrendingUp, Info, CircleDollarSign } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { GuaranteeScore } from "@/lib/guarantees-accumulator"
import type { OverdraftStatus } from "@/lib/overdraft"

type Payload = {
  ok: boolean
  enforce: boolean
  highRiskThreshold: number
  score: GuaranteeScore
  overdraft?: OverdraftStatus
}

const eur = (n: number) =>
  `EUR ${(Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fetcher = (url: string) => fetch(url, { credentials: "include", cache: "no-store" }).then((r) => r.json())

/**
 * Client-facing Guarantees Accumulator trust-score card. Reads the member's
 * OWN score from the non-proxied `/api/guarantees` GET (a Server Action would
 * be 401'd by the dashboard proxy on a stale cookie). Purely informational —
 * the authoritative High-Risk block lives server-side in `submitApproval`.
 */
export function GuaranteeScoreCard() {
  const { data } = useSWR<Payload>("/api/guarantees", fetcher, { refreshInterval: 60_000 })

  if (!data?.ok || !data.score) return null

  const { score, enforce } = data
  // Defensive: never trust the payload shape blindly — a missing/invalid
  // threshold must not crash the whole dashboard section (it did once).
  const highRiskThreshold =
    typeof data.highRiskThreshold === "number" && Number.isFinite(data.highRiskThreshold)
      ? data.highRiskThreshold
      : 10
  const finalScore = Number.isFinite(score.finalScore) ? score.finalScore : 0
  const ageCredit = Number.isFinite(score.ageCredit) ? score.ageCredit : 0
  const high = Boolean(score.highRisk)

  // Map the risk score onto a 0-100 bar relative to 2x the threshold so the
  // High-Risk line sits at the mid-point and is easy to read at a glance.
  const barMax = Math.max(highRiskThreshold * 2, 1)
  const pct = Math.min(100, Math.max(0, (finalScore / barMax) * 100))

  return (
    <Card className={cn("border-border bg-card", high && "border-destructive/40")}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {high ? (
              <ShieldAlert className="h-4 w-4 text-destructive" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-primary" />
            )}
            Guarantees Accumulator — Trust Score
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              "text-[11px]",
              high
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-500",
            )}
          >
            {high ? "High risk" : "Good standing"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Risk score</p>
              <p
                className={cn(
                  "text-2xl font-bold tabular-nums",
                  high ? "text-destructive" : "text-foreground",
                )}
              >
                {finalScore.toFixed(2)}
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              High-risk above {highRiskThreshold.toFixed(0)}
            </p>
          </div>
          <Progress value={pct} className="mt-2 h-2" />
        </div>

        {/* Factor breakdown */}
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
          <Factor label="Security deposit coefficient" value={score.factors?.securityDeposit} good />
          <Factor label="Leverage load" value={score.factors?.leverageLoad} />
          <Factor label="Exposure factor" value={score.factors?.exposure} />
          <Factor label="Payment penalty" value={score.factors?.paymentPenalty} />
          <Factor label="Track record (new account)" value={score.factors?.trackRecord} />
          <Factor label="Overdraft" value={score.factors?.overdraft} />
        </div>

        {data.overdraft?.available ? (
          <OverdraftPanel overdraft={data.overdraft} />
        ) : null}

        <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5 text-primary" />
            Account history credit
          </span>
          <span className="text-sm font-semibold text-foreground">−{ageCredit.toFixed(2)}</span>
        </div>

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground text-pretty">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          {high
            ? enforce
              ? "Your account is high risk, so new leverage, monetization, project funding and treasury financing are paused. Paid-in security deposits and unencumbered balance lower the score — borrowed/financed collateral does not, since it nets against the loan behind it. Reduce leverage or exposure and clear any overdue charges to lower your score."
              : "Your account is high risk. Add paid-in guarantees or balance (borrowed collateral does not count), reduce leverage/exposure or clear overdue charges to improve it."
            : "This independent score reflects your guarantees, leverage, exposure and payment history. Real paid-in capital and a longer clean history lower it over time."}
        </p>
      </CardContent>
    </Card>
  )
}

function OverdraftPanel({ overdraft }: { overdraft: OverdraftStatus }) {
  const usedPct = Math.min(100, Math.max(0, (overdraft.usageRatio || 0) * 100))
  const negative = overdraft.inOverdraft
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        negative ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-secondary/30",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <CircleDollarSign className={cn("h-3.5 w-3.5", negative ? "text-amber-600" : "text-primary")} />
          Controlled overdraft
        </span>
        <Badge
          variant="outline"
          className={cn(
            "text-[11px]",
            negative
              ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-500"
              : "border-border text-muted-foreground",
          )}
        >
          {negative ? "In overdraft" : "Not used"}
        </Badge>
      </div>
      <Progress value={usedPct} className="mt-2 h-1.5" />
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <p className="text-muted-foreground">Used</p>
          <p className="font-semibold tabular-nums text-foreground">{eur(overdraft.negativeEur)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Available</p>
          <p className="font-semibold tabular-nums text-foreground">{eur(overdraft.remainingEur)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Ceiling (8%)</p>
          <p className="font-semibold tabular-nums text-foreground">{eur(overdraft.limitEur)}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground text-pretty">
        {negative
          ? "Your Master Account is in a controlled overdraft to settle platform charges. New leverage, monetization and treasury financing are paused until you return to a positive balance."
          : "Platform charges may draw your Master Account up to 8% of your secured treasury security deposit when positive funds run out. Outgoing payments still require positive funds."}
      </p>
    </div>
  )
}

function Factor({ label, value, good }: { label: string; value?: number; good?: boolean }) {
  const safe = typeof value === "number" && Number.isFinite(value) ? value : 0
  return (
    <div className="bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-sm font-semibold tabular-nums",
          good ? "text-green-600 dark:text-green-500" : "text-foreground",
        )}
      >
        {safe.toFixed(2)}
      </p>
    </div>
  )
}
