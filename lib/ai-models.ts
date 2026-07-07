import "server-only"
import { anthropic } from "@ai-sdk/anthropic"

/**
 * Single Anthropic backend for the whole platform.
 *
 * Every AI feature — the live NQAi console and all KYC document analysis —
 * runs on the proprietor's own Anthropic Claude account, configured via the
 * `ANTHROPIC_API_KEY` secret (forinoht@gmail.com). The `@ai-sdk/anthropic`
 * provider reads that key directly from the environment, so all interactions
 * are billed to and routed through that account and NEVER the shared Vercel AI
 * Gateway.
 *
 * We standardize on two tiers, chosen per workload:
 *   • CHAT  → Sonnet: fast, responsive, keeps the live NQAi console snappy.
 *   • DOCS  → Opus:   maximum reasoning for KYC document analysis & verdicts.
 *
 * NQAi is not a separate model — it is an identity/personalization layer
 * (system prompt, knowledge graph, tools, memory) composed on top of this same
 * Anthropic backend. Model IDs are overridable via env so tiers can be bumped
 * without a code change.
 */

/** Fast conversational tier — powers the live NQAi assistant. */
export const NQAI_CHAT_MODEL_ID = process.env.NQAI_MODEL || "claude-sonnet-4-6"

/** Highest-reasoning tier — powers KYC document analysis and verdicts. */
export const DOC_ANALYSIS_MODEL_ID = process.env.KYC_MODEL || "claude-opus-4-6"

/** The Anthropic chat model instance (Sonnet) used by NQAi. */
export function nqaiChatModel() {
  return anthropic(NQAI_CHAT_MODEL_ID)
}

/** The Anthropic document-analysis model instance (Opus) used for KYC. */
export function docAnalysisModel() {
  return anthropic(DOC_ANALYSIS_MODEL_ID)
}
