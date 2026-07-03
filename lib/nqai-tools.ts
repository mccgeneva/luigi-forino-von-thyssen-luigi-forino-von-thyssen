import "server-only"

// ---------------------------------------------------------------------------
// NQAi tool belt — live vessel intelligence & smart oil-deal discovery.
//
// These AI SDK tools let NQAi reach beyond static knowledge and query the
// platform's real data in-flight while answering a client:
//   • verifyVessel        — IMO verification + master data + OFAC compliance
//   • searchVessels       — free-text / type search over the vessel catalogue
//   • listSpotDeals       — the live limited-time spot-deal board
//   • discoverOilDeals    — port → vessel → oil matching (the smart matcher)
//   • vesselDataProvider  — which AIS provider (if any) is linked, for context
//
// All tools run SERVER-SIDE (the /api/nqai route is nodejs runtime). Provider
// API tokens are read from the environment via lib/vessel-providers.ts and are
// NEVER exposed to the client. Vessel lookups are cached briefly to avoid
// hammering upstream providers on rapid consecutive prompts.
// ---------------------------------------------------------------------------

import { tool } from "ai"
import { z } from "zod"
import { listVessels, getVessel } from "@/lib/spot-deals-db"
import { fetchVesselByImo, providerStatus, screenVesselImo } from "@/lib/vessel-providers"
import { listLiveSpotDeals } from "@/app/actions/spot-deals"
import { searchResearch, lookupInstitution, exploreConcept } from "@/lib/nqai-knowledge"
import { sendOutboundEmail, sendOutboundSms } from "@/lib/nqai-messaging"
import {
  queryTerminals,
  findTerminal,
  projectTerminal,
  STORAGE_DATA_NOTE,
  STORAGE_CLASS_LABELS,
} from "@/lib/tank-terminals"
import {
  isValidImo,
  dealCountdown,
  VESSEL_TYPE_LABELS,
  VESSEL_STATUS_LABELS,
  type Vessel,
  type VesselType,
  type SpotDeal,
} from "@/lib/spot-deals-shared"
import { PETROLEUM_PRODUCTS } from "@/lib/petroleum-products"

// --- helpers ----------------------------------------------------------------

function norm(s: string | undefined | null): string {
  return (s ?? "").toLowerCase().trim()
}

/** Loose token match: does `haystack` contain `needle` (or vice-versa)? */
function fuzzy(haystack: string | undefined, needle: string | undefined): boolean {
  const h = norm(haystack)
  const n = norm(needle)
  if (!n) return true
  if (!h) return false
  return h.includes(n) || n.includes(h)
}

/**
 * Infer which tanker family can carry a given oil/product description.
 * Resolves against the petroleum catalogue first (by id or name), then falls
 * back to keyword heuristics. Returns null when it can't decide.
 */
function inferVesselType(product: string | undefined): VesselType | null {
  const p = norm(product)
  if (!p) return null

  const match = PETROLEUM_PRODUCTS.find((c) => norm(c.id) === p || fuzzy(c.name, p))
  if (match) {
    if (match.category === "Crude Oil") return "crude"
    if (match.category === "LPG & LNG") return "gas"
    return "product"
  }

  if (/\b(crude|brent|wti|dubai|urals|espo|bonny|murban|maya|basrah|arab (light|heavy)|condensate)\b/.test(p)) {
    return "crude"
  }
  if (/\b(lng|lpg|propane|butane|natural gas|liquefied (natural|petroleum) gas|gas)\b/.test(p)) {
    return "gas"
  }
  if (
    /\b(diesel|gasoil|gas oil|en590|ulsd|jet|kerosene|gasoline|naphtha|fuel oil|mgo|mazut|vgo|bitumen|base oil|petrochemical)\b/.test(
      p,
    )
  ) {
    return "product"
  }
  return null
}

/** A compact, client-safe projection of a vessel for tool output. */
function projectVessel(v: Vessel) {
  return {
    imo: v.imo,
    name: v.name,
    type: VESSEL_TYPE_LABELS[v.type],
    vesselClass: v.vesselClass ?? null,
    capacity: v.capacity ? `${v.capacity.toLocaleString("en-US")} ${v.capacityUnit}` : "n/a",
    status: VESSEL_STATUS_LABELS[v.status],
    location: v.location || "Unknown",
    flag: v.flag ?? null,
    builtYear: v.builtYear ?? null,
    cargo: v.cargo ?? null,
    compliance: v.compliance
      ? {
          status: v.compliance.status,
          imoValid: v.compliance.imoValid,
          note: v.compliance.note ?? null,
          sources: v.compliance.sources,
        }
      : null,
    source: v.source,
  }
}

/** A compact projection of a live spot deal for tool output. */
function projectDeal(d: SpotDeal) {
  const cd = dealCountdown(d.expiresAt)
  return {
    id: d.id,
    product: d.product,
    quantity: `${d.quantity.toLocaleString("en-US")} ${d.unit}`,
    spotPrice: `${d.spotPrice} ${d.currency}/${d.unit}`,
    totalValue: `${d.currency} ${d.totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    incoterm: d.incoterm,
    loadPort: d.loadPort || null,
    dischargePort: d.dischargePort || null,
    vessel: `${d.vesselName} (IMO ${d.vesselImo})`,
    vesselType: VESSEL_TYPE_LABELS[d.vesselType],
    expiresIn: cd.expired ? "expired" : cd.label,
    expiresAt: d.expiresAt,
  }
}

// --- lightweight vessel-lookup cache ---------------------------------------
// Caches verifyVessel results per-IMO for a short window so repeated prompts
// about the same ship don't re-hit the upstream provider every time.
type CacheEntry = { at: number; value: unknown }
const lookupCache = new Map<string, CacheEntry>()
const LOOKUP_TTL_MS = 5 * 60_000

function cacheGet(key: string): unknown | null {
  const hit = lookupCache.get(key)
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.value
  if (hit) lookupCache.delete(key)
  return null
}
function cacheSet(key: string, value: unknown): void {
  lookupCache.set(key, { at: Date.now(), value })
  // Bound the cache so it can't grow unbounded across many distinct IMOs.
  if (lookupCache.size > 200) {
    const oldest = lookupCache.keys().next().value
    if (oldest) lookupCache.delete(oldest)
  }
}

// --- tools ------------------------------------------------------------------

/** Per-request context injected into the tools at request scope. */
export interface NqaiToolContext {
  /** Display name for the email footer, e.g. "Jane Doe — Acme Ltd". */
  senderName?: string
}

// Hard ceiling for any single tool round-trip. The knowledge APIs already
// self-limit to ~12s and messaging to ~9s; this is the backstop for the
// otherwise-unbounded ones (platform DB reads, external vessel providers) so a
// slow or hung upstream can never stall the whole turn toward the route's
// maxDuration — which the client would otherwise see as the generic
// "the request may have taken too long" transient fault.
const TOOL_TIMEOUT_MS = 22_000
const TOOL_TIMEOUT_MARKER = "__nqai_tool_timeout__"

/**
 * Harden every tool so a misbehaving round-trip can never break the chat:
 *   1. TIMEOUT — execute is raced against TOOL_TIMEOUT_MS so a hung upstream is
 *      abandoned instead of blocking the stream until the platform kills it.
 *   2. NEVER THROW — a thrown tool error aborts the ENTIRE streamed response
 *      (surfacing as the transient-fault banner). We catch everything and
 *      resolve to a graceful { ok:false, error } result, which the model
 *      already knows how to recover from (answer without the tool, or suggest a
 *      retry). Mutates execute in place and returns the same object so the
 *      caller keeps its precise tool types.
 */
function guardTools<T extends Record<string, unknown>>(tools: T): T {
  for (const name of Object.keys(tools)) {
    const entry = tools[name] as { execute?: (...args: unknown[]) => Promise<unknown> }
    const original = entry?.execute
    if (typeof original !== "function") continue
    entry.execute = async (...args: unknown[]) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          original(...args),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(TOOL_TIMEOUT_MARKER)), TOOL_TIMEOUT_MS)
          }),
        ])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const timedOut = message.includes(TOOL_TIMEOUT_MARKER)
        console.log(`[v0] NQAi tool "${name}" ${timedOut ? "timed out" : "failed"}:`, timedOut ? `${TOOL_TIMEOUT_MS}ms` : message)
        return {
          ok: false,
          error: timedOut
            ? `The ${name} lookup took too long and was skipped. Answer with what you already have, or suggest the client try again.`
            : `The ${name} tool could not complete. Proceed without it, or suggest the client try again.`,
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  }
  return tools
}

/**
 * Build the NQAi tool belt for a single request. Any data that must be read in
 * the request scope (e.g. the signed-in client's identity via cookies) is
 * resolved by the caller and passed in via `ctx` — tools NEVER call cookies()
 * themselves, because their `execute` runs during the streamed response (outside
 * the request scope) where cookies() would throw and abort the whole stream.
 */
export function createNqaiTools(ctx: NqaiToolContext = {}) {
  const tools = {
  /**
   * Verify a vessel by IMO. Runs the official IMO check-digit validation, the
   * free OFAC sanctions screen, and (if an AIS provider is linked) live master
   * data. Falls back to free public-registry enrichment when no key is set.
   */
  verifyVessel: tool({
    description:
      "Verify and look up a marine vessel by its 7-digit IMO number. Returns name, tanker type/class, deadweight or gas capacity, flag, build year, last known location/status, and an OFAC sanctions + IMO-validity compliance verdict. Use whenever a user gives an IMO or asks to verify/identify a specific ship.",
    inputSchema: z.object({
      imo: z.string().describe("The vessel's 7-digit IMO number, e.g. '9782522'."),
    }),
    execute: async ({ imo }) => {
      const clean = (imo ?? "").trim()
      if (!/^\d{7}$/.test(clean)) {
        return { ok: false, error: "An IMO number must be exactly 7 digits." }
      }
      if (!isValidImo(clean)) {
        const compliance = await screenVesselImo(clean)
        return {
          ok: false,
          error: "That IMO fails the official check-digit algorithm — it is not a structurally valid IMO number.",
          compliance: { status: compliance.status, imoValid: false, note: compliance.note ?? null },
        }
      }

      const cached = cacheGet(`vessel:${clean}`)
      if (cached) return cached as object

      // Already in the catalogue? Return the stored, compliance-stamped record.
      const existing = await getVessel(clean)
      if (existing) {
        const out = {
          ok: true,
          source: "platform catalogue",
          vessel: projectVessel(existing),
        }
        cacheSet(`vessel:${clean}`, out)
        return out
      }

      const result = await fetchVesselByImo(clean)
      if ("error" in result) {
        return {
          ok: false,
          error: result.error,
          compliance: {
            status: result.compliance.status,
            imoValid: result.compliance.imoValid,
            note: result.compliance.note ?? null,
          },
        }
      }
      const out = {
        ok: true,
        source: result.providerLabel,
        vessel: projectVessel(result.vessel),
      }
      cacheSet(`vessel:${clean}`, out)
      return out
    },
  }),

  /**
   * Search the platform's vessel catalogue by free text and/or tanker type.
   */
  searchVessels: tool({
    description:
      "Search the platform's marine vessel catalogue by name, IMO, cargo, or tanker type. Use to find vessels matching a description (e.g. 'VLCC crude tankers', 'LNG carriers near Qatar', 'diesel product tankers'). Returns up to 12 matching vessels with capacity, status and location.",
    inputSchema: z.object({
      query: z
        .string()
        .nullable()
        .describe("Free-text search over vessel name, IMO, location, class or cargo. Pass null for no text filter."),
      type: z
        .enum(["crude", "product", "gas"])
        .nullable()
        .describe("Restrict to a tanker family: crude (crude oil), product (refined products), or gas (LNG/LPG)."),
    }),
    execute: async ({ query, type }) => {
      const all = await listVessels(query ?? undefined)
      const filtered = all.filter((v) => {
        if (type && v.type !== type) return false
        if (query) {
          return (
            fuzzy(v.name, query) ||
            fuzzy(v.imo, query) ||
            fuzzy(v.location, query) ||
            fuzzy(v.vesselClass, query) ||
            fuzzy(v.cargo, query) ||
            fuzzy(v.flag, query)
          )
        }
        return true
      })
      return {
        ok: true,
        count: filtered.length,
        vessels: filtered.slice(0, 12).map(projectVessel),
        note:
          filtered.length === 0
            ? "No vessels in the catalogue match that query. Try a broader term or verify a specific IMO."
            : undefined,
      }
    },
  }),

  /**
   * The live, limited-time spot-deal board, with optional filters.
   */
  listSpotDeals: tool({
    description:
      "List the live, limited-time spot-deal board (published, unexpired cargoes). Optionally filter by product, port, or vessel type. Use when a user asks what oil/cargo deals are currently available, or about a specific product or port.",
    inputSchema: z.object({
      product: z.string().nullable().describe("Filter by product/grade, e.g. 'crude', 'diesel', 'LNG'. Null = any."),
      port: z.string().nullable().describe("Filter by load or discharge port, e.g. 'Rotterdam'. Null = any."),
      vesselType: z
        .enum(["crude", "product", "gas"])
        .nullable()
        .describe("Filter by tanker family. Null = any."),
    }),
    execute: async ({ product, port, vesselType }) => {
      const deals = await listLiveSpotDeals()
      const filtered = deals.filter((d) => {
        if (product && !fuzzy(d.product, product)) return false
        if (vesselType && d.vesselType !== vesselType) return false
        if (port && !(fuzzy(d.loadPort, port) || fuzzy(d.dischargePort, port))) return false
        return true
      })
      return {
        ok: true,
        count: filtered.length,
        deals: filtered.slice(0, 12).map(projectDeal),
        note:
          filtered.length === 0
            ? "No live spot deals match those criteria right now. Clients can register interest; nothing executes automatically — confirm with the desk."
            : "Indicative limited-time offers. Clients accept/negotiate via Commodity Trading → Spot Deals; nothing executes automatically.",
      }
    },
  }),

  /**
   * Smart oil-deal discovery: match a target delivery port + desired oil type
   * to (a) live spot deals routing there and (b) candidate vessels in the
   * catalogue whose cargo capability and position make them routable.
   */
  discoverOilDeals: tool({
    description:
      "Smart oil-deal discovery. Given a target delivery (discharge) port and an optional oil/product type, finds: (1) live spot deals routing to or loading for that port that match the product, and (2) candidate vessels in the catalogue whose cargo capability matches and that could be routed there for a new deal. Use for requests like 'Find vessels approaching Rotterdam with crude oil capacity' or 'What crude can I get delivered to Singapore?'.",
    inputSchema: z.object({
      targetPort: z
        .string()
        .describe("The desired delivery / discharge port (or load port if the user specifies loading)."),
      product: z
        .string()
        .nullable()
        .describe("Desired oil/product type, e.g. 'crude oil', 'EN590 diesel', 'LNG'. Null = any."),
      minQuantity: z
        .number()
        .nullable()
        .describe("Optional minimum cargo capacity (in DWT for oil, CBM for gas) a candidate vessel must have."),
    }),
    execute: async ({ targetPort, product, minQuantity }) => {
      const desiredType = inferVesselType(product ?? undefined)

      // (1) Live spot deals routing to/from the target port matching the product.
      const liveDeals = await listLiveSpotDeals()
      const matchingDeals = liveDeals
        .filter((d) => {
          const portHit = fuzzy(d.dischargePort, targetPort) || fuzzy(d.loadPort, targetPort)
          if (!portHit) return false
          if (product && !fuzzy(d.product, product)) return false
          if (desiredType && d.vesselType !== desiredType) return false
          return true
        })
        .slice(0, 8)
        .map(projectDeal)

      // (2) Candidate vessels: right cargo family, adequate capacity, and
      // plausibly routable (near the port, or underway/anchored and available).
      const catalogue = await listVessels()
      const candidates = catalogue
        .filter((v) => {
          if (desiredType && v.type !== desiredType) return false
          if (minQuantity && v.capacity > 0 && v.capacity < minQuantity) return false
          // Only suggest vessels that are clear (or unverified) on sanctions.
          if (v.compliance?.status === "flagged") return false
          return true
        })
        .map((v) => {
          const nearPort = fuzzy(v.location, targetPort)
          const available = v.status === "underway" || v.status === "anchored" || v.status === "idle"
          // Score: nearest gets the most weight, then availability, then capacity.
          const score = (nearPort ? 100 : 0) + (available ? 20 : 0) + Math.min(v.capacity / 100000, 10)
          return { v, nearPort, available, score }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(({ v, nearPort, available }) => ({
          ...projectVessel(v),
          nearTargetPort: nearPort,
          availableForRouting: available,
          routingNote: nearPort
            ? `Currently at/near ${v.location} — well positioned for ${targetPort}.`
            : `Last known ${VESSEL_STATUS_LABELS[v.status].toLowerCase()} at ${v.location || "unknown"}; routable to ${targetPort} subject to laycan.`,
        }))

      const provider = providerStatus()
      return {
        ok: true,
        targetPort,
        desiredProduct: product ?? "any",
        inferredVesselType: desiredType ? VESSEL_TYPE_LABELS[desiredType] : "any",
        matchingDeals,
        candidateVessels: candidates,
        liveTrackingEnabled: provider.connected,
        notes: [
          matchingDeals.length === 0
            ? "No live spot deals currently route to that port for the requested product."
            : `${matchingDeals.length} live spot deal(s) match.`,
          candidates.length === 0
            ? "No catalogue vessels match the cargo/capacity criteria."
            : `${candidates.length} candidate vessel(s) could carry this cargo.`,
          provider.connected
            ? `Live AIS positions via ${provider.active?.label}.`
            : "Real-time ETA/position requires a connected AIS provider (MarineTraffic/Datalastic/VesselFinder); positions shown are last-known catalogue values. Exact ETA and firm terms must be confirmed with the desk.",
        ],
      }
    },
  }),

  /**
   * Report which live AIS / vessel-data provider is connected (token-free
   * status only — never exposes the key itself).
   */
  vesselDataProviderStatus: tool({
    description:
      "Check which live vessel-data (AIS) provider is linked to the platform and whether real-time tracking is available. Use when a user asks about data sources, live tracking, or why ETA/position data may be limited.",
    inputSchema: z.object({}),
    execute: async () => {
      const status = providerStatus()
      return {
        ok: true,
        liveTrackingEnabled: status.connected,
        activeProvider: status.active?.label ?? null,
        complianceScreeningEnabled: status.complianceEnabled,
        availableProviders: status.providers.map((p) => ({ label: p.label, configured: p.configured })),
        note: status.connected
          ? `Live vessel intelligence is active via ${status.active?.label}. Free OFAC sanctions + IMO-validity screening always runs.`
          : "No paid AIS provider is linked. Free OFAC sanctions screening, IMO validation, and public-registry lookups are always available; live real-time positions/ETA require connecting a provider API key.",
      }
    },
  }),

  // =========================================================================
  // TANK TERMINALS & WORLDWIDE STORAGE — query the reference catalogue of real
  // tank-terminal operators at global hubs (Rotterdam, Houston, Singapore,
  // Fujairah, Ras Tanura, Cushing, …). Nameplate capacities are reference
  // figures; live open/booked space needs a commercial feed or desk
  // confirmation (STORAGE_DATA_NOTE is always surfaced, never fabricated).
  // =========================================================================

  /**
   * Find tank terminals / storage facilities matching a port, region, product
   * and/or minimum capacity. Powers natural-language storage queries.
   */
  findTankStorage: tool({
    description:
      "Find oil/gas/chemical tank terminals and storage facilities worldwide. Filter by port (e.g. 'Rotterdam', 'Houston', 'Singapore', 'Fujairah', 'Ras Tanura'), region (e.g. 'Middle East', 'US Gulf Coast', 'ARA'), the product to be stored (e.g. 'diesel', 'crude', 'LNG', 'fuel oil', 'chemicals'), and/or a minimum nameplate capacity. Use for requests like 'Show tank storage in Rotterdam for diesel', 'List major crude storage terminals in the Middle East', or 'Where can I store LPG in Asia?'. Returns matching terminals with operator, port, product slate, nameplate capacity (m³), connectivity and services.",
    inputSchema: z.object({
      port: z.string().nullable().describe("Port/hub name to filter by, e.g. 'Rotterdam'. Null = any port."),
      region: z
        .string()
        .nullable()
        .describe("Region to filter by, e.g. 'Middle East', 'US Gulf Coast', 'ARA', 'Singapore'. Null = any region."),
      product: z
        .string()
        .nullable()
        .describe("Product/grade to be stored, e.g. 'diesel', 'crude oil', 'LNG', 'fuel oil', 'chemicals'. Null = any."),
      minCapacityCbm: z
        .number()
        .nullable()
        .describe("Optional minimum nameplate capacity in cubic metres (m³) a terminal must have."),
    }),
    execute: async ({ port, region, product, minCapacityCbm }) => {
      const { terminals, resolvedRegion, resolvedClass } = queryTerminals({
        port,
        region,
        product,
        minCapacityCbm,
      })
      return {
        ok: true,
        query: {
          port: port ?? "any",
          region: resolvedRegion ?? region ?? "any",
          product: product ?? "any",
          resolvedProductClass: resolvedClass ? STORAGE_CLASS_LABELS[resolvedClass] : "any",
          minCapacityCbm: minCapacityCbm ?? null,
        },
        count: terminals.length,
        terminals: terminals.slice(0, 12).map(projectTerminal),
        dataNote: STORAGE_DATA_NOTE,
        note:
          terminals.length === 0
            ? "No terminals in the reference catalogue match those criteria. Try a broader region, a different product family, or drop the capacity filter."
            : `${terminals.length} terminal(s) match, sorted by nameplate capacity. Present the top ones as a table (operator, port, products, capacity). Always state that capacities are reference figures and live space must be confirmed with the terminal/desk.`,
      }
    },
  }),

  /**
   * Detail on a single named terminal / operator.
   */
  getTerminalDetails: tool({
    description:
      "Get full details on a single tank terminal by its name or operator, e.g. 'Vopak Europoort', 'Universal Terminal Jurong', 'VTTI Fujairah', 'Cushing Enbridge'. Returns operator, port/country/region, full product slate, nameplate capacity, tank count, marine/inland connectivity and value-added services. Use after findTankStorage when the user wants to drill into one facility.",
    inputSchema: z.object({
      query: z.string().describe("The terminal name or operator to look up, e.g. 'Vopak Europoort'."),
    }),
    execute: async ({ query }) => {
      const q = (query ?? "").trim()
      if (!q) return { ok: false, error: "Provide a terminal name or operator to look up." }
      const terminal = findTerminal(q)
      if (!terminal) {
        return {
          ok: false,
          error: `No terminal matching "${q}" is in the reference catalogue. Try findTankStorage to browse by port/region/product.`,
        }
      }
      return {
        ok: true,
        terminal: projectTerminal(terminal),
        dataNote: STORAGE_DATA_NOTE,
        note: "Reference facility profile. Confirm live available capacity with the terminal or the MCC desk before committing cargo.",
      }
    },
  }),

  // =========================================================================
  // KNOWLEDGE LAYER — read-only research intelligence from open, key-free
  // scholarly APIs (OpenAlex, arXiv, Crossref). This is the "Universities →
  // Knowledge APIs → AI" pipeline: NQAi ingests peer-reviewed and preprint
  // research on demand, then reasons over it with full source attribution.
  // All calls are cached + rate-limited server-side in lib/nqai-knowledge.ts.
  // =========================================================================

  /**
   * Search global scholarly literature (OpenAlex + arXiv + Crossref) for
   * peer-reviewed papers and preprints relevant to a topic.
   */
  searchResearch: tool({
    description:
      "Search global academic research — peer-reviewed papers and preprints — across OpenAlex, arXiv and Crossref. Use for any question about science, technology, engineering, energy, markets methodology, climate, materials, or 'what does the latest research say about X'. Returns ranked works with titles, authors, year, venue, citation counts, open-access status and source links for attribution. Always cite the works you use.",
    inputSchema: z.object({
      query: z.string().describe("The research topic or question, e.g. 'carbon capture cost per tonne' or 'lithium iron phosphate degradation'."),
      fromYear: z.number().int().nullable().describe("Optional earliest publication year to include (e.g. 2022). Null for no lower bound."),
      openAccessOnly: z.boolean().nullable().describe("If true, only return open-access works the user can read in full. Null/false returns all."),
    }),
    execute: async ({ query, fromYear, openAccessOnly }) => {
      const q = (query ?? "").trim()
      if (!q) return { ok: false, error: "Provide a research topic or question to search." }
      const result = await searchResearch({
        query: q,
        sources: ["openalex", "arxiv", "crossref"],
        fromYear: fromYear ?? undefined,
        openAccessOnly: openAccessOnly ?? undefined,
      })
      return {
        ok: true,
        query: q,
        sourcesQueried: result.sources,
        sourceErrors: result.errors,
        works: result.works,
        note:
          result.works.length === 0
            ? "No matching research found. Try broadening the query or removing the year/open-access filters."
            : `Top ${result.works.length} works across ${result.sources.join(", ")}. Cite titles + links; label preprints (arXiv) as not yet peer-reviewed.`,
      }
    },
  }),

  /**
   * Resolve a university / research institution to its open scholarly profile
   * (OpenAlex): output, top fields, and identifiers.
   */
  lookupInstitution: tool({
    description:
      "Look up a university or research institution's scholarly profile (via OpenAlex): total works, citation impact, top research fields, country and homepage. Use when a user references a university, research lab, or asks 'who is doing research on X' at an institutional level.",
    inputSchema: z.object({
      name: z.string().describe("Institution name, e.g. 'ETH Zurich' or 'MIT'."),
    }),
    execute: async ({ name }) => {
      const n = (name ?? "").trim()
      if (!n) return { ok: false, error: "Provide an institution name." }
      const matches = await lookupInstitution(n)
      return {
        ok: true,
        query: n,
        institutions: matches,
        note:
          matches.length === 0
            ? "No matching institution found in the OpenAlex knowledge graph."
            : `Found ${matches.length} institution match(es). Figures are open scholarly metadata (OpenAlex).`,
      }
    },
  }),

  /**
   * Explore a research concept/field: its scale, related concepts, and the
   * most-cited recent works — a knowledge-graph view of a subject.
   */
  exploreConcept: tool({
    description:
      "Explore a research concept or field as a knowledge graph (via OpenAlex): how large the field is, related/adjacent concepts, and the most influential recent works. Use to map an unfamiliar technical domain, find adjacent areas, or surface seminal papers before going deeper with searchResearch.",
    inputSchema: z.object({
      concept: z.string().describe("A field or concept, e.g. 'green hydrogen', 'maritime decarbonization', 'perovskite solar cells'."),
    }),
    execute: async ({ concept }) => {
      const c = (concept ?? "").trim()
      if (!c) return { ok: false, error: "Provide a concept or field to explore." }
      const node = await exploreConcept(c)
      if (!node) {
        return { ok: false, error: `No concept matching "${c}" was found in the knowledge graph.` }
      }
      return {
        ok: true,
        concept: node,
        note: "Concept map from the OpenAlex knowledge graph. Use searchResearch on the concept or a related one to pull specific papers.",
      }
    },
  }),

  // =========================================================================
  // OUTBOUND MESSAGING — NQAi sends email (Resend) and SMS (Twilio) on the
  // client's behalf when asked. Sends are server-side, validated, and execute
  // immediately. NQAi composes the content unless the user dictates it.
  // =========================================================================

  /**
   * Send an email to a specified address, immediately, via Resend.
   */
  sendEmail: tool({
    description:
      "Send an email immediately to a specific address on the client's behalf. Use this whenever the user asks you to email someone (e.g. 'email john@acme.com the quote'). You compose a clear, professional subject and body unless the user dictates exact wording. The email is sent right away from the MCC Capital domain; report success (with the recipient) or the exact error.",
    inputSchema: z.object({
      to: z.string().describe("The recipient's email address, e.g. 'jane@example.com'."),
      subject: z.string().describe("A concise, professional subject line."),
      body: z
        .string()
        .describe("The full email body in plain text. Use line breaks for paragraphs. Sign off as NQAi / MCC Capital."),
    }),
    execute: async ({ to, subject, body }) => {
      // senderName is resolved once in the request scope (see createNqaiTools);
      // we must NOT call cookies()/resolveCurrentSession() here because tool
      // execute runs during the streamed response, outside the request scope.
      const result = await sendOutboundEmail({ to, subject, body, senderName: ctx.senderName })
      if (!result.ok) {
        return { ok: false, channel: "email", error: result.error }
      }
      return {
        ok: true,
        channel: "email",
        to: result.to,
        messageId: result.id,
        note: `Email delivered to ${result.to}. Confirm to the client that it was sent.`,
      }
    },
  }),

  /**
   * Send an SMS text message to a specified mobile number, immediately, via Twilio.
   */
  sendSms: tool({
    description:
      "Send an SMS text message immediately to a specific mobile number on the client's behalf via Twilio. Use this whenever the user asks you to text or SMS a number (e.g. 'text +41791234567 that the cargo is confirmed'). Keep the message concise. The number must be in international format (E.164, e.g. +41791234567); you may normalise obvious formats. Report success (with the recipient) or the exact error.",
    inputSchema: z.object({
      to: z.string().describe("The recipient's mobile number in international format, e.g. '+41791234567'."),
      body: z.string().describe("The SMS message text. Keep it concise and clear."),
    }),
    execute: async ({ to, body }) => {
      const result = await sendOutboundSms({ to, body })
      if (!result.ok) {
        return { ok: false, channel: "sms", error: result.error }
      }
      return {
        ok: true,
        channel: "sms",
        to: result.to,
        messageId: result.id,
        note: `SMS delivered to ${result.to}. Confirm to the client that it was sent.`,
      }
    },
  }),

  // =========================================================================
  // DOCUMENT GENERATION — NQAi authors a downloadable, branded PDF. The tool
  // itself just structures the content; the CLIENT renders the actual PDF from
  // this output (jsPDF, MCC house style) and shows a Download button. This keeps
  // PDF rendering in the browser, consistent with every other export.
  // =========================================================================
  createDocument: tool({
    description:
      "Author a downloadable, professionally formatted PDF document for the client. Use this whenever the client asks you to prepare/draft/create/generate a document, report, summary, briefing, quotation, memo or analysis that they can download or share (e.g. 'prepare a deal summary I can download', 'draft a market report as a PDF', 'put that in a document'). Provide a clear `title` and the full document body as `markdown` — use # / ## / ### headings, bullet and numbered lists, and Markdown tables for structured/comparative data. Write desk-grade, well-structured content. The client receives a branded PDF with a Download button. After calling this, also give a brief chat reply summarizing what you produced; do NOT repeat the entire document body in the chat.",
    inputSchema: z.object({
      title: z.string().describe("A concise document title, e.g. 'Brent CIF Rotterdam — Indicative Quotation'."),
      markdown: z
        .string()
        .describe(
          "The full document body in Markdown: headings (#/##/###), bullet/numbered lists, tables (| col | col |), paragraphs. This becomes the PDF content.",
        ),
      brand: z
        .enum(["capital", "petroli", "naftahub"])
        .nullable()
        .describe(
          "Which company letterhead/logo to stamp on the PDF, by document context: 'petroli' for oil, gas, petroleum, crude, diesel or any MCC Petroli trade document (FCO, SPA, quotation, cargo); 'naftahub' for platform onboarding / client handbook / product material; 'capital' for banking, instruments, statements and general MCC Capital documents. Leave null to auto-detect from the content.",
        ),
    }),
    execute: async ({ title, markdown, brand }) => {
      const docId = `NQAI-DOC-${Date.now().toString(36).toUpperCase()}`
      return {
        ok: true,
        docId,
        title,
        markdown,
        brand: brand ?? null,
        note: "Document prepared. The client can download it as a branded PDF from the chat. Give a short summary in your reply — do not paste the whole document.",
      }
    },
  }),
  }
  return guardTools(tools)
}
