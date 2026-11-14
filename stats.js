import { OpenCode } from "@opencode/client"
import { discover, headers } from "@opencode/client/service"

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const COMPARED_FIELDS = ["steps", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost"]
const TOKEN_COMPLETENESS = Symbol("tokenCompleteness")

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function statsRanges(period, now = Date.now()) {
  const to = Math.floor(now)
  if (period === "week") {
    const from = to - WEEK_MS
    return { current: { from, to }, baseline: { from: from - WEEK_MS, to: from } }
  }
  const currentFrom = new Date(to)
  currentFrom.setHours(0, 0, 0, 0)
  const current = new Date(to)
  const baselineTo = new Date(
    current.getFullYear(), current.getMonth(), current.getDate() - 1,
    current.getHours(), current.getMinutes(), current.getSeconds(), current.getMilliseconds(),
  )
  const baselineFrom = new Date(baselineTo)
  baselineFrom.setHours(0, 0, 0, 0)
  return {
    current: { from: currentFrom.getTime(), to },
    baseline: { from: baselineFrom.getTime(), to: baselineTo.getTime() },
  }
}

// Legacy helper: the current range only. Use statsRanges for comparisons.
export function statsRange(period, now = Date.now()) {
  return statsRanges(period, now).current
}

export function statsTokens(tokens) {
  const cacheRead = finite(tokens?.cache?.read)
  const cacheWrite = finite(tokens?.cache?.write)
  const reasoning = finite(tokens?.reasoning)
  return {
    input: finite(tokens?.input) + cacheRead + cacheWrite,
    output: finite(tokens?.output) + reasoning,
    cacheRead,
    cacheWrite,
    reasoning,
  }
}

// These are ratios calculated from OpenCode's reported aggregate, not coverage metrics.
export function statsEfficiency(tokens) {
  const reported = (value) => typeof value === "number" && Number.isFinite(value) ? value : null
  const ratio = (numerator, denominator) => {
    if (numerator === null || denominator === null || denominator === 0) return null
    const value = numerator / denominator
    return Number.isFinite(value) ? value : null
  }
  const uncachedInputTokens = reported(tokens?.input)
  const cacheReadTokens = reported(tokens?.cache?.read)
  const cacheWriteTokens = reported(tokens?.cache?.write)
  const output = reported(tokens?.output)
  const reasoningTokens = reported(tokens?.reasoning)
  const readComplete = uncachedInputTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null
  const inputDenominator = readComplete ? uncachedInputTokens + cacheReadTokens + cacheWriteTokens : null
  const amortization = ratio(cacheReadTokens, cacheWriteTokens)
  const readShare = readComplete ? ratio(cacheReadTokens, inputDenominator) : null
  let secondKpi = { kind: null, value: null, numerator: null, denominator: null }
  if (cacheWriteTokens !== null && cacheWriteTokens > 0 && cacheReadTokens !== null && amortization !== null) {
    secondKpi = { kind: "amortization", value: amortization, numerator: cacheReadTokens, denominator: cacheWriteTokens }
  } else if (cacheWriteTokens === 0 && cacheReadTokens !== null && cacheReadTokens > 0 && uncachedInputTokens !== null && uncachedInputTokens > 0) {
    const value = ratio(cacheReadTokens, uncachedInputTokens)
    if (value !== null) secondKpi = { kind: "readPerUncached", value, numerator: cacheReadTokens, denominator: uncachedInputTokens }
  }
  const outputTokens = output === null || reasoningTokens === null ? null : finite(output + reasoningTokens, null)
  return {
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    readShare,
    amortization,
    secondKpi,
  }
}

function costKind(providerID, openAISubscription) {
  if (providerID === "ollama") return "local"
  if (providerID === "kimi-code-plan-global" || providerID === "kimi-code-plan-cn" || providerID === "kimi-aprobo") return "plan"
  if (providerID === "openai" && openAISubscription) return "plan"
  return "value"
}

function tokenCompleteness(tokens) {
  return {
    input: typeof tokens?.input === "number" && Number.isFinite(tokens.input),
    output: typeof tokens?.output === "number" && Number.isFinite(tokens.output),
    reasoning: typeof tokens?.reasoning === "number" && Number.isFinite(tokens.reasoning),
    cacheRead: typeof tokens?.cache?.read === "number" && Number.isFinite(tokens.cache.read),
    cacheWrite: typeof tokens?.cache?.write === "number" && Number.isFinite(tokens.cache.write),
  }
}

function modelEfficiency(model) {
  const complete = model[TOKEN_COMPLETENESS]
  return statsEfficiency({
    input: complete.input ? model.inputTokens - model.cacheReadTokens - model.cacheWriteTokens : undefined,
    output: complete.output ? model.outputTokens - model.reasoningTokens : undefined,
    reasoning: complete.reasoning ? model.reasoningTokens : undefined,
    cache: {
      read: complete.cacheRead ? model.cacheReadTokens : undefined,
      write: complete.cacheWrite ? model.cacheWriteTokens : undefined,
    },
  })
}

// Объединяем варианты одной модели и не смешиваем подписку с платным API.
export function normalizeStats(raw, { names = new Map(), openAISubscription = false } = {}) {
  const grouped = new Map()
  for (const entry of Array.isArray(raw?.models) ? raw.models : []) {
    const providerID = String(entry?.model?.providerID ?? "unknown")
    const modelID = String(entry?.model?.id ?? "unknown")
    const key = `${providerID}/${modelID}`
    const tokens = statsTokens(entry?.tokens)
    const current = grouped.get(key) ?? {
      id: key,
      providerID,
      modelID,
      label: names.get(key) ?? modelID,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      costKind: costKind(providerID, openAISubscription),
      [TOKEN_COMPLETENESS]: { input: true, output: true, reasoning: true, cacheRead: true, cacheWrite: true },
    }
    const complete = tokenCompleteness(entry?.tokens)
    for (const field of Object.keys(complete)) current[TOKEN_COMPLETENESS][field] &&= complete[field]
    current.steps += finite(entry?.steps)
    current.inputTokens += tokens.input
    current.outputTokens += tokens.output
    current.cacheReadTokens += tokens.cacheRead
    current.cacheWriteTokens += tokens.cacheWrite
    current.reasoningTokens += tokens.reasoning
    current.cost += finite(entry?.cost)
    grouped.set(key, current)
  }
  const models = [...grouped.values()].map((model) => ({
    ...model,
    efficiency: modelEfficiency(model),
  })).sort((a, b) => b.steps - a.steps || b.inputTokens - a.inputTokens)
  const tokens = statsTokens(raw?.tokens)
  return {
    available: true,
    from: finite(raw?.range?.from),
    to: finite(raw?.range?.to),
    steps: finite(raw?.steps),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    reasoningTokens: tokens.reasoning,
    cost: finite(raw?.cost),
    showCost: models.some((model) => model.costKind === "value" && model.steps > 0),
    efficiency: statsEfficiency(raw?.tokens),
    models,
  }
}

function zeroModel(model) {
  return {
    id: model.id,
    providerID: model.providerID,
    modelID: model.modelID,
    label: model.label,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    costKind: model.costKind,
    // An absent model has no reported token detail, so its KPIs remain unknown.
    efficiency: statsEfficiency(undefined),
  }
}

function delta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return { absolute: null, relative: null }
  const absolute = current - baseline
  const relative = baseline === 0 ? null : absolute / baseline
  return {
    absolute: Number.isFinite(absolute) ? absolute : null,
    relative: relative === null || Number.isFinite(relative) ? relative : null,
  }
}

function kpiDelta(current, baseline) {
  return delta(current, baseline)
}

function secondKpiDelta(current, baseline) {
  if (!current?.kind || current.kind !== baseline?.kind) return { absolute: null, relative: null }
  return delta(current.value, baseline.value)
}

function grayComponent(reasons) {
  return { level: "gray", reasons: [...new Set(reasons)] }
}

function atLeast(value, threshold) {
  return value >= threshold || Math.abs(value - threshold) <= Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(threshold))
}

function assessModel(current, baseline, { currentPresent, baselinePresent, baselineAvailable }) {
  const commonGrayReasons = []
  if (!baselineAvailable || !baselinePresent) commonGrayReasons.push("no-baseline")
  if (!currentPresent) commonGrayReasons.push("insufficient-data")
  if (current.steps < 3 || baseline.steps < 3 || current.inputTokens <= 0 || baseline.inputTokens <= 0) commonGrayReasons.push("insufficient-data")
  const commonGray = commonGrayReasons.length > 0

  let input = grayComponent(commonGrayReasons)
  if (!commonGray) {
    const deltaInput = current.inputTokens - baseline.inputTokens
    const tokenGrowth = atLeast(deltaInput, 1_000_000) && atLeast(deltaInput / baseline.inputTokens, 0.5)
    const severe = atLeast(current.inputTokens, 2 * baseline.inputTokens) && atLeast(deltaInput, 10_000_000)
      && (atLeast(baseline.inputTokens, 10_000_000) || atLeast(deltaInput / baseline.inputTokens, 10))
    const reasons = []
    if (tokenGrowth) reasons.push("token-growth")
    if (severe) reasons.push("severe-token-growth")
    input = { level: severe ? "red" : tokenGrowth ? "amber" : "green", reasons }
  }

  const cacheComparable = current.efficiency?.readShare !== null && current.efficiency?.readShare !== undefined
    && baseline.efficiency?.readShare !== null && baseline.efficiency?.readShare !== undefined
    && Number.isFinite(current.efficiency.readShare) && Number.isFinite(baseline.efficiency.readShare)
  let cache = grayComponent([...commonGrayReasons, "insufficient-data"])
  if (!commonGray && cacheComparable) {
    const readDrop = baseline.efficiency.readShare - current.efficiency.readShare
    const cacheDrop = atLeast(readDrop, 0.1) && atLeast(readDrop / baseline.efficiency.readShare, 0.2)
    cache = { level: cacheDrop ? "amber" : "green", reasons: cacheDrop ? ["cache-drop"] : [] }
  }

  const currentSecond = current.efficiency?.secondKpi
  const baselineSecond = baseline.efficiency?.secondKpi
  const reuseComparable = Boolean(currentSecond?.kind) && currentSecond.kind === baselineSecond?.kind
    && Number.isFinite(currentSecond.value) && Number.isFinite(baselineSecond.value)
  let reuse = grayComponent([...commonGrayReasons, "insufficient-data"])
  if (!commonGray && reuseComparable) {
    const secondDrop = baselineSecond.value - currentSecond.value
    const reuseDrop = atLeast(secondDrop, 1) && atLeast(secondDrop / baselineSecond.value, 0.3)
    reuse = { level: reuseDrop ? "amber" : "green", reasons: reuseDrop ? ["reuse-drop"] : [] }
  }

  const components = { input, cache, reuse }
  const available = Object.values(components).filter((component) => component.level !== "gray")
  const rank = { gray: 0, green: 1, amber: 2, red: 3 }
  const level = available.length === 0 ? "gray" : available.reduce((worst, component) => rank[component.level] > rank[worst] ? component.level : worst, "green")
  const reasons = [...new Set((available.length === 0 ? Object.values(components) : available).flatMap((component) => component.reasons))]
  return { level, reasons, components }
}

// Union by provider/account + model; variants have already been merged by normalizeStats.
export function compareStatsModels(currentModels, baselineModels, { baselineAvailable = true } = {}) {
  const current = new Map((Array.isArray(currentModels) ? currentModels : []).map((model) => [model.id, model]))
  const baseline = new Map((Array.isArray(baselineModels) ? baselineModels : []).map((model) => [model.id, model]))
  const comparisons = []
  for (const id of new Set([...current.keys(), ...baseline.keys()])) {
    const present = current.get(id) ?? baseline.get(id)
    const currentModel = current.get(id) ?? zeroModel(present)
    const baselineModel = baseline.get(id) ?? zeroModel(present)
    const deltas = {}
    for (const field of COMPARED_FIELDS) deltas[field] = delta(currentModel[field], baselineModel[field])
    deltas.readShare = kpiDelta(currentModel.efficiency?.readShare, baselineModel.efficiency?.readShare)
    deltas.amortization = kpiDelta(currentModel.efficiency?.amortization, baselineModel.efficiency?.amortization)
    deltas.secondKpi = secondKpiDelta(currentModel.efficiency?.secondKpi, baselineModel.efficiency?.secondKpi)
    const assessment = assessModel(currentModel, baselineModel, {
      currentPresent: current.has(id),
      baselinePresent: baseline.has(id),
      baselineAvailable,
    })
    comparisons.push({
      id,
      providerID: present.providerID,
      modelID: present.modelID,
      label: present.label,
      costKind: present.costKind,
      current: currentModel,
      baseline: baselineModel,
      deltas,
      assessment,
    })
  }
  return comparisons.sort((a, b) =>
    b.current.steps - a.current.steps ||
    b.baseline.steps - a.baseline.steps ||
    b.current.inputTokens - a.current.inputTokens ||
    a.id.localeCompare(b.id),
  )
}

export function compareStats(current, baseline) {
  return {
    ...current,
    baseline,
    deltas: { secondKpi: secondKpiDelta(current.efficiency?.secondKpi, baseline.efficiency?.secondKpi) },
    modelComparisons: compareStatsModels(current.models, baseline.models, { baselineAvailable: baseline.available }),
  }
}

function emptyStats(range) {
  return {
    available: false,
    from: range.from,
    to: range.to,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    showCost: false,
    efficiency: statsEfficiency(undefined),
    models: [],
  }
}

async function openAISubscription(ctx) {
  try {
    const connection = await ctx.integration.connection.active("openai")
    if (!connection) return false
    const value = await ctx.integration.connection.resolve(connection)
    return value?.type === "oauth"
  } catch {
    return false
  }
}

async function modelNames(ctx) {
  const names = new Map()
  try {
    const providers = new Map()
    for (const provider of (await ctx.provider.list())?.data ?? []) {
      if (provider?.id) providers.set(provider.id, String(provider.name ?? provider.id))
    }
    for (const model of (await ctx.model.list())?.data ?? []) {
      if (!model?.providerID || !model?.modelID) continue
      names.set(`${model.providerID}/${model.modelID}`, `${providers.get(model.providerID) ?? model.providerID} · ${model.name ?? model.modelID}`)
    }
  } catch {}
  return names
}

export async function readUsageStats(ctx, period = "day", now = () => Date.now(), dependencies = {}) {
  const resolvedPeriod = period === "week" ? "week" : "day"
  const ranges = statsRanges(resolvedPeriod, now())
  const discoverService = dependencies.discoverService ?? discover
  const createClient = dependencies.createClient ?? ((endpoint) => OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) }))
  let client
  try {
    const endpoint = await discoverService()
    if (!endpoint) {
      const current = emptyStats(ranges.current)
      return { ...compareStats(current, emptyStats(ranges.baseline)), period: resolvedPeriod }
    }
    client = createClient(endpoint)
  } catch {
    const current = emptyStats(ranges.current)
    return { ...compareStats(current, emptyStats(ranges.baseline)), period: resolvedPeriod }
  }

  const query = async (range) => {
    // The API ranges are half-open [from,to). No project filter: Stats is all-project.
    const raw = await client.experimental.session.stats({
      ...range,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tools: "none",
    })
    return raw
  }
  const [currentResult, baselineResult] = await Promise.allSettled([query(ranges.current), query(ranges.baseline)])
  if (currentResult.status === "rejected" && baselineResult.status === "rejected") {
    const current = emptyStats(ranges.current)
    return { ...compareStats(current, emptyStats(ranges.baseline)), period: resolvedPeriod }
  }

  const [names, subscription] = await Promise.all([modelNames(ctx), openAISubscription(ctx)])
  const options = { names, openAISubscription: subscription }
  const current = currentResult.status === "fulfilled" ? normalizeStats(currentResult.value, options) : emptyStats(ranges.current)
  const baseline = baselineResult.status === "fulfilled" ? normalizeStats(baselineResult.value, options) : emptyStats(ranges.baseline)
  return { ...compareStats(current, baseline), period: resolvedPeriod }
}
