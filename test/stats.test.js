import test from "node:test"
import assert from "node:assert/strict"
import { compareStats, compareStatsModels, normalizeStats, readUsageStats, statsEfficiency, statsRange, statsRanges, statsTokens } from "../stats.js"

const DAY_MS = 24 * 60 * 60 * 1000

function aggregate(range, tokens = {}, models = []) {
  return { range, steps: models.reduce((sum, model) => sum + model.steps, 0), cost: 0, tokens, models }
}

function model(providerID, id, steps, tokens = {}) {
  return { model: { providerID, id }, steps, cost: 0, tokens }
}

const context = {
  provider: { list: async () => ({ data: [] }) },
  model: { list: async () => ({ data: [] }) },
  integration: { connection: { active: async () => null, resolve: async () => null } },
}

test("stats range uses local today and a rolling seven-day period", () => {
  const now = new Date(2026, 10, 15, 10, 30, 0).getTime()
  assert.deepEqual(statsRange("day", now), { from: new Date(2026, 10, 15).getTime(), to: now })
  assert.deepEqual(statsRange("week", now), { from: now - 7 * DAY_MS, to: now })
})

test("day baseline preserves wall-clock across a DST transition", () => {
  const previousTZ = process.env.TZ
  process.env.TZ = "America/New_York"
  try {
    const now = Date.parse("2026-11-01T10:30:00-05:00")
    assert.deepEqual(statsRanges("day", now), {
      current: { from: Date.parse("2026-11-01T00:00:00-04:00"), to: now },
      baseline: { from: Date.parse("2026-10-31T00:00:00-04:00"), to: Date.parse("2026-10-31T10:30:00-04:00") },
    })
    assert.equal(now - statsRanges("day", now).baseline.to, 25 * 60 * 60 * 1000)
  } finally {
    if (previousTZ === undefined) delete process.env.TZ
    else process.env.TZ = previousTZ
  }
})

test("rolling week baseline is the immediately preceding seven days", () => {
  const now = Date.parse("2026-11-15T10:30:00Z")
  assert.deepEqual(statsRanges("week", now), {
    current: { from: now - 7 * DAY_MS, to: now },
    baseline: { from: now - 14 * DAY_MS, to: now - 7 * DAY_MS },
  })
})

test("stats tokens include cache and reasoning exactly once and retain their breakdown", () => {
  assert.deepEqual(statsTokens({ input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } }), { input: 125, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 10 })
  assert.deepEqual(statsTokens(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
})

test("reported efficiency uses aggregate-first weighted formulas", () => {
  const efficiency = statsEfficiency({ input: 50, cache: { read: 30, write: 20 } })
  assert.deepEqual(efficiency, {
    uncachedInputTokens: 50,
    cacheReadTokens: 30,
    cacheWriteTokens: 20,
    outputTokens: null,
    reasoningTokens: null,
    readShare: 0.3,
    amortization: 1.5,
    secondKpi: { kind: "amortization", value: 1.5, numerator: 30, denominator: 20 },
  })
  const result = normalizeStats(aggregate({ from: 1, to: 2 }, { input: 90, cache: { read: 90, write: 20 } }, [
    model("p", "a", 1, { input: 1, cache: { read: 99, write: 0 } }),
    model("p", "b", 1, { input: 999, cache: { read: 1, write: 0 } }),
  ]))
  assert.equal(result.efficiency.readShare, 90 / 200)
  assert.equal(result.efficiency.amortization, 4.5)
  assert.notEqual(result.efficiency.readShare, (0.99 + 1 / 1000) / 2)
})

test("missing reported fields are unknown, explicit zeros are real, and each KPI has its own completeness", () => {
  assert.deepEqual(statsEfficiency(undefined), {
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    readShare: null,
    amortization: null,
    secondKpi: { kind: null, value: null, numerator: null, denominator: null },
  })
  assert.deepEqual(statsEfficiency({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }), {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    readShare: null,
    amortization: null,
    secondKpi: { kind: null, value: null, numerator: null, denominator: null },
  })
  const partial = statsEfficiency({ input: 10, cache: { read: 5 } })
  assert.deepEqual(partial, {
    uncachedInputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    readShare: null,
    amortization: null,
    secondKpi: { kind: null, value: null, numerator: null, denominator: null },
  })
  assert.equal(statsEfficiency({ cache: { read: 6, write: 2 } }).amortization, 3)
  assert.equal(statsEfficiency({ cache: { read: 6, write: 2 } }).readShare, null)
  assert.equal(statsEfficiency({ input: Number.NaN, cache: { read: 5, write: 1 } }).readShare, null)
  assert.equal(statsEfficiency({ input: 10, cache: { read: 5, write: 0 } }).readShare, 5 / 15)
  assert.equal(statsEfficiency({ input: 10, cache: { read: 5, write: 0 } }).amortization, null)
})

test("stats normalization merges model variants and distinguishes plan, local and paid usage", () => {
  const result = normalizeStats({
    range: { from: 1000, to: 2000 },
    steps: 6,
    cost: 0.01,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } },
    models: [
      { model: { providerID: "kimi-code-plan-global", id: "k3.1-pro" }, steps: 2, cost: 0, tokens: { input: 100, cache: { read: 20 } } },
      { model: { providerID: "kimi-code-plan-global", id: "k3.1-pro", variant: "max" }, steps: 3, cost: 0, tokens: { input: 200, output: 10 } },
      { model: { providerID: "moonshotai", id: "kimi-k3.1-pro" }, steps: 1, cost: 0.01, tokens: { output: 5, reasoning: 2 } },
      { model: { providerID: "ollama", id: "qwen-local" }, steps: 4, cost: 0, tokens: { input: 50 } },
    ],
  }, { names: new Map([["kimi-code-plan-global/k3.1-pro", "Kimi Ultra · K3.1 Pro"]]) })

  assert.equal(result.inputTokens, 125)
  assert.equal(result.outputTokens, 50)
  assert.equal(result.cacheReadTokens, 20)
  assert.equal(result.cacheWriteTokens, 5)
  assert.equal(result.reasoningTokens, 10)
  assert.equal(result.cacheReadTokens / result.inputTokens * 100, 16)
  assert.equal(result.reasoningTokens / result.outputTokens * 100, 20)
  assert.equal(result.models.length, 3)
  assert.equal(result.models[0].steps, 5)
  assert.equal(result.models[0].label, "Kimi Ultra · K3.1 Pro")
  assert.equal(result.models[0].costKind, "plan")
  assert.equal(result.models[0].inputTokens, 320)
  assert.equal(result.models[0].outputTokens, 10)
  assert.equal(result.models[0].cacheReadTokens, 20)
  assert.equal(result.models[0].cacheWriteTokens, 0)
  assert.equal(result.models[0].reasoningTokens, 0)
  assert.equal(result.models.find((model) => model.providerID === "moonshotai").reasoningTokens, 2)
  assert.equal(result.models.find((model) => model.providerID === "moonshotai").costKind, "value")
  assert.equal(result.models.find((model) => model.providerID === "ollama").costKind, "local")
  assert.equal(result.showCost, true)
})

test("partial model token fields keep numeric sums but unknown efficiency stays null and private", () => {
  const result = normalizeStats(aggregate({ from: 1, to: 2 }, {}, [
    model("kimi", "partial", 3, { input: 100, output: 40, cache: { read: 20 } }),
  ]))
  const current = result.models[0]
  assert.equal(current.inputTokens, 120)
  assert.equal(current.outputTokens, 40)
  assert.equal(current.cacheReadTokens, 20)
  assert.equal(current.cacheWriteTokens, 0)
  assert.equal(current.reasoningTokens, 0)
  assert.equal(current.efficiency.uncachedInputTokens, 100)
  assert.equal(current.efficiency.cacheReadTokens, 20)
  assert.equal(current.efficiency.cacheWriteTokens, null)
  assert.equal(current.efficiency.readShare, null)
  assert.equal(current.efficiency.outputTokens, null)
  assert.equal(current.efficiency.reasoningTokens, null)
  assert.equal(Object.keys(current).some((key) => key.toLowerCase().includes("completeness")), false)
  assert.equal(JSON.stringify(current).includes("Completeness"), false)
})

test("stats hides cost when the period contains only subscription or local usage", () => {
  const result = normalizeStats({
    range: { from: 1, to: 2 }, steps: 1, cost: 0, tokens: {},
    models: [
      { model: { providerID: "openai", id: "gpt-subscription" }, steps: 1, cost: 0, tokens: {} },
      { model: { providerID: "ollama", id: "local" }, steps: 1, cost: 0, tokens: {} },
      { model: { providerID: "kimi-aprobo", id: "k3.1-pro" }, steps: 1, cost: 0, tokens: {} },
    ],
  }, { openAISubscription: true })
  assert.equal(result.models[0].costKind, "plan")
  assert.equal(result.models[1].costKind, "local")
  assert.equal(result.models[2].costKind, "plan")
  assert.equal(result.showCost, false)
})

test("model comparisons use the same provider/model union and current-minus-baseline deltas", () => {
  const current = normalizeStats(aggregate({ from: 20, to: 30 }, {}, [
    model("kimi", "shared", 5, { input: 100 }),
    model("kimi", "new", 2, { input: 20 }),
  ]))
  const baseline = normalizeStats(aggregate({ from: 0, to: 10 }, {}, [
    model("kimi", "shared", 2, { input: 40 }),
    model("other", "shared", 8, { input: 80 }),
    model("kimi", "old", 4, { input: 60 }),
  ]))
  const comparisons = compareStatsModels(current.models, baseline.models)
  assert.equal(comparisons.length, 4)
  const shared = comparisons.find((entry) => entry.id === "kimi/shared")
  assert.deepEqual(shared.deltas.steps, { absolute: 3, relative: 1.5 })
  assert.deepEqual(shared.deltas.inputTokens, { absolute: 60, relative: 1.5 })
  const added = comparisons.find((entry) => entry.id === "kimi/new")
  assert.equal(added.baseline.steps, 0)
  assert.deepEqual(added.deltas.steps, { absolute: 2, relative: null })
  const removed = comparisons.find((entry) => entry.id === "kimi/old")
  assert.equal(removed.current.steps, 0)
  assert.deepEqual(removed.deltas.steps, { absolute: -4, relative: -1 })
  assert.ok(comparisons.some((entry) => entry.id === "other/shared"))
})

test("model KPI deltas use reported read share and amortization", () => {
  const current = normalizeStats(aggregate({ from: 20, to: 30 }, {}, [
    model("kimi", "known", 1, { input: 40, output: 30, reasoning: 10, cache: { read: 40, write: 20 } }),
  ]))
  const baseline = normalizeStats(aggregate({ from: 0, to: 10 }, {}, [
    model("kimi", "known", 1, { input: 20, output: 10, reasoning: 5, cache: { read: 10, write: 10 } }),
  ]))
  const [comparison] = compareStatsModels(current.models, baseline.models)
  assert.ok(Math.abs(comparison.deltas.readShare.absolute - 0.15) < 1e-12)
  assert.ok(Math.abs(comparison.deltas.readShare.relative - 0.6) < 1e-12)
  assert.deepEqual(comparison.deltas.amortization, { absolute: 1, relative: 1 })
  assert.equal(comparison.current.efficiency.outputTokens, 40)
  assert.equal(comparison.current.efficiency.reasoningTokens, 10)
  assert.equal(comparison.baseline.efficiency.outputTokens, 15)
  assert.equal(comparison.baseline.efficiency.reasoningTokens, 5)
})

test("model KPI deltas propagate nulls and never infer zero KPIs for absent models", () => {
  const current = normalizeStats(aggregate({ from: 20, to: 30 }, {}, [
    model("kimi", "unknown-current", 1, { input: 0, cache: { read: 0, write: 0 } }),
    model("kimi", "new", 1, { input: 40, cache: { read: 40, write: 20 } }),
  ]))
  const baseline = normalizeStats(aggregate({ from: 0, to: 10 }, {}, [
    model("kimi", "unknown-current", 1, { input: 20, cache: { read: 10, write: 10 } }),
  ]))
  const comparisons = compareStatsModels(current.models, baseline.models)
  const unknown = comparisons.find((entry) => entry.id === "kimi/unknown-current")
  assert.equal(unknown.current.efficiency.readShare, null)
  assert.deepEqual(unknown.deltas.readShare, { absolute: null, relative: null })
  const added = comparisons.find((entry) => entry.id === "kimi/new")
  assert.equal(added.current.efficiency.readShare, 0.4)
  assert.equal(added.baseline.efficiency.readShare, null)
  assert.deepEqual(added.deltas.readShare, { absolute: null, relative: null })
  assert.deepEqual(added.deltas.amortization, { absolute: null, relative: null })
})

test("non-finite values produce null deltas and gray affected assessments", () => {
  const current = normalizeStats(aggregate({ from: 20, to: 30 }, {}, [model("kimi", "m", 3, { input: Number.MAX_VALUE, cache: { read: Number.MAX_VALUE, write: 1 } })]))
  const baseline = normalizeStats(aggregate({ from: 0, to: 10 }, {}, [model("kimi", "m", 3, { input: -Number.MAX_VALUE, cache: { read: 1e-300, write: 1 } })]))
  const [comparison] = compareStatsModels(current.models, baseline.models)
  assert.deepEqual(comparison.deltas.inputTokens, { absolute: null, relative: null })
  assert.equal(comparison.current.efficiency.readShare, null)
  assert.equal(comparison.current.efficiency.amortization, Number.MAX_VALUE)
  assert.deepEqual(comparison.deltas.readShare, { absolute: null, relative: null })
  assert.equal(comparison.deltas.secondKpi.relative, null)
  assert.ok(Number.isFinite(comparison.deltas.secondKpi.absolute))
  assert.equal(comparison.assessment.components.cache.level, "gray")
  assert.equal(comparison.assessment.components.input.level, "gray")
})

test("second KPI selects R/W before R/U and preserves legacy amortization", () => {
  assert.deepEqual(statsEfficiency({ input: 40, cache: { read: 30, write: 10 } }).secondKpi, {
    kind: "amortization", value: 3, numerator: 30, denominator: 10,
  })
  const fallback = statsEfficiency({ input: 10, cache: { read: 20, write: 0 } })
  assert.deepEqual(fallback.secondKpi, { kind: "readPerUncached", value: 2, numerator: 20, denominator: 10 })
  assert.equal(fallback.amortization, null)
})

test("second KPI is null for missing, invalid, and non-positive fallback cases", () => {
  for (const tokens of [
    undefined,
    { input: 10, cache: { read: 0, write: 0 } },
    { input: 0, cache: { read: 20, write: 0 } },
    { input: 10, cache: { read: 20, write: Number.NaN } },
    { input: 10, cache: { read: 20 } },
  ]) {
    assert.deepEqual(statsEfficiency(tokens).secondKpi, { kind: null, value: null, numerator: null, denominator: null })
  }
})

test("second KPI deltas never compare amortization with read-per-uncached", () => {
  const current = normalizeStats(aggregate({ from: 20, to: 30 }, { input: 40, cache: { read: 30, write: 10 } }))
  const baseline = normalizeStats(aggregate({ from: 0, to: 10 }, { input: 10, cache: { read: 20, write: 0 } }))
  assert.deepEqual(compareStats(current, baseline).deltas.secondKpi, { absolute: null, relative: null })
  const sameKind = compareStats(baseline, normalizeStats(aggregate({ from: 0, to: 10 }, { input: 20, cache: { read: 20, write: 0 } })))
  assert.deepEqual(sameKind.deltas.secondKpi, { absolute: 1, relative: 1 })
})

function assessedModel(currentTokens, baselineTokens, currentSteps = 3, baselineSteps = 3) {
  const current = normalizeStats(aggregate({ from: 20, to: 30 }, {}, [model("kimi", "m", currentSteps, currentTokens)]))
  const baseline = normalizeStats(aggregate({ from: 0, to: 10 }, {}, [model("kimi", "m", baselineSteps, baselineTokens)]))
  return compareStatsModels(current.models, baseline.models)[0]
}

test("model assessments gray only insufficient or incompatible components", () => {
  const enough = { input: 800000, cache: { read: 100000, write: 100000 } }
  const tooFewSteps = assessedModel(enough, enough, 2, 3).assessment
  assert.equal(tooFewSteps.level, "gray")
  assert.deepEqual(tooFewSteps.reasons, ["insufficient-data"])
  assert.ok(Object.values(tooFewSteps.components).every((component) => component.level === "gray"))
  const crossKind = assessedModel({ input: 800000, cache: { read: 100000, write: 0 } }, enough)
  assert.equal(crossKind.assessment.level, "green")
  assert.equal(crossKind.assessment.components.input.level, "green")
  assert.equal(crossKind.assessment.components.cache.level, "green")
  assert.deepEqual(crossKind.assessment.components.reuse, { level: "gray", reasons: ["insufficient-data"] })
  assert.deepEqual(crossKind.deltas.secondKpi, { absolute: null, relative: null })
  const current = normalizeStats(aggregate({ from: 20, to: 30 }, {}, [model("kimi", "m", 3, enough)]))
  const noBaseline = compareStatsModels(current.models, [], { baselineAvailable: false })[0].assessment
  assert.equal(noBaseline.level, "gray")
  assert.deepEqual(noBaseline.reasons, ["no-baseline", "insufficient-data"])
  assert.ok(Object.values(noBaseline.components).every((component) => component.level === "gray"))
})

test("complete input remains assessable when cache KPI data is missing or incompatible", () => {
  const enough = { input: 800000, cache: { read: 100000, write: 100000 } }
  for (const baselineTokens of [{ input: 800000 }, { input: 800000, cache: { read: 100000, write: 0 } }]) {
    const { assessment } = assessedModel(enough, baselineTokens)
    assert.equal(assessment.components.input.level, "green")
    assert.equal(assessment.components.cache.level, baselineTokens.cache ? "green" : "gray")
    assert.equal(assessment.components.reuse.level, "gray")
    assert.equal(assessment.level, "green")
  }
})

test("model assessment is green when comparable windows have no material regression", () => {
  const tokens = { input: 800000, cache: { read: 100000, write: 100000 } }
  const assessment = assessedModel(tokens, tokens).assessment
  assert.equal(assessment.level, "green")
  assert.deepEqual(assessment.reasons, [])
  assert.deepEqual(Object.fromEntries(Object.entries(assessment.components).map(([key, value]) => [key, value.level])), { input: "green", cache: "green", reuse: "green" })
})

test("assessment thresholds include exact boundaries and exclude values just below them", () => {
  for (const [currentInput, expected] of [[1999999, "green"], [2000000, "amber"], [2000001, "amber"]]) {
    assert.equal(assessedModel({ input: currentInput }, { input: 1000000 }).assessment.components.input.level, expected)
  }
  for (const [currentInput, expected] of [[2999999, "green"], [3000000, "amber"], [3000001, "amber"]]) {
    assert.equal(assessedModel({ input: currentInput }, { input: 2000000 }).assessment.components.input.level, expected)
  }
  for (const [read, expected] of [[400.1, "green"], [400, "amber"], [399.9, "amber"]]) {
    const current = { input: 500, cache: { read, write: 100 } }
    const baseline = { input: 300, cache: { read: 500, write: 200 } }
    assert.equal(assessedModel(current, baseline).assessment.components.cache.level, expected)
  }
  for (const [read, expected] of [[350.1, "green"], [350, "amber"], [349.9, "amber"]]) {
    const current = { input: 100, cache: { read, write: 100 } }
    const baseline = { input: 100, cache: { read: 500, write: 100 } }
    assert.equal(assessedModel(current, baseline).assessment.components.reuse.level, expected)
  }
})

test("model assessment is amber at material token, cache, and reuse boundaries without severe growth", () => {
  const token = assessedModel(
    { input: 2800000, cache: { read: 600000, write: 600000 } },
    { input: 1800000, cache: { read: 100000, write: 100000 } },
  )
  assert.equal(token.assessment.level, "amber")
  assert.ok(token.assessment.reasons.includes("token-growth"))
  const cache = assessedModel(
    { input: 510000, cache: { read: 390000, write: 100000 } },
    { input: 400000, cache: { read: 500000, write: 100000 } },
  )
  assert.equal(cache.assessment.level, "amber")
  assert.ok(cache.assessment.reasons.includes("cache-drop"))
  const reuse = assessedModel(
    { input: 550000, cache: { read: 350000, write: 100000 } },
    { input: 400000, cache: { read: 500000, write: 100000 } },
  )
  assert.equal(reuse.assessment.level, "amber")
  assert.ok(reuse.assessment.reasons.includes("reuse-drop"))
})

test("model assessment is red only at severe token growth; cache regression alone is not red", () => {
  const severe = assessedModel(
    { input: 18000000, cache: { read: 1000000, write: 1000000 } },
    { input: 9000000, cache: { read: 500000, write: 500000 } },
  )
  assert.equal(severe.assessment.level, "red")
  assert.ok(severe.assessment.reasons.includes("severe-token-growth"))
  const cacheOnly = assessedModel(
    { input: 510000, cache: { read: 390000, write: 100000 } },
    { input: 400000, cache: { read: 500000, write: 100000 } },
  )
  assert.equal(cacheOnly.assessment.level, "amber")
})

test("extreme relative token growth is red with a small baseline only after sufficient absolute growth", () => {
  const extreme = assessedModel(
    { input: 188000000, cache: { read: 1000000, write: 1000000 } },
    { input: 1000000, cache: { read: 100000, write: 100000 } },
  )
  assert.equal(extreme.assessment.level, "red")
  assert.ok(extreme.assessment.reasons.includes("severe-token-growth"))

  const highRelativeButSmallAbsolute = assessedModel(
    { input: 8000000, cache: { read: 100000, write: 100000 } },
    { input: 1000000, cache: { read: 100000, write: 100000 } },
  )
  assert.equal(highRelativeButSmallAbsolute.assessment.level, "amber")
  assert.ok(!highRelativeButSmallAbsolute.assessment.reasons.includes("severe-token-growth"))
})

test("readUsageStats captures now once and passes exact independent half-open ranges without project filters", async () => {
  const now = new Date(2026, 10, 15, 10, 30, 0).getTime()
  const ranges = statsRanges("day", now)
  let nowCalls = 0
  const calls = []
  const result = await readUsageStats(context, "day", () => { nowCalls++; return now }, {
    discoverService: async () => ({ url: "http://unused" }),
    createClient: () => ({ experimental: { session: { stats: async (query) => {
      calls.push(query)
      const range = query.to === ranges.current.to ? ranges.current : ranges.baseline
      return aggregate(range, { input: 1 }, [])
    } } } }),
  })
  assert.equal(nowCalls, 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(({ from, to }) => ({ from, to })), [ranges.current, ranges.baseline])
  assert.ok(calls.every((query) => !("project" in query) && query.tools === "none"))
  assert.equal(result.available, true)
  assert.equal(result.baseline.available, true)
})

test("current and baseline availability are independent; empty success differs from failure", async () => {
  const now = new Date(2026, 10, 15, 10, 30, 0).getTime()
  const ranges = statsRanges("day", now)
  const result = await readUsageStats(context, "day", () => now, {
    discoverService: async () => ({ url: "http://unused" }),
    createClient: () => ({ experimental: { session: { stats: async (query) => {
      if (query.from === ranges.current.from) throw new Error("current unavailable")
      return aggregate(ranges.baseline, {}, [])
    } } } }),
  })
  assert.equal(result.available, false)
  assert.equal(result.baseline.available, true)
  assert.equal(result.baseline.steps, 0)
  assert.equal(result.efficiency.readShare, null)
  assert.deepEqual(result.baseline.efficiency, statsEfficiency(undefined))

  const reversed = await readUsageStats(context, "day", () => now, {
    discoverService: async () => ({ url: "http://unused" }),
    createClient: () => ({ experimental: { session: { stats: async (query) => {
      if (query.from === ranges.baseline.from) throw new Error("baseline unavailable")
      return aggregate(ranges.current, {}, [])
    } } } }),
  })
  assert.equal(reversed.available, true)
  assert.equal(reversed.baseline.available, false)
  assert.equal(reversed.baseline.efficiency.amortization, null)
})
