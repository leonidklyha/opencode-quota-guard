import assert from "node:assert/strict"
import test from "node:test"
import { registerQuotaRpc } from "../rpc-server.js"
import { QuotaGuardRpc } from "../rpc.js"
import { compareStats, normalizeStats } from "../stats.js"

function context() {
  const state = { contract: undefined, handlers: undefined }
  return {
    state,
    ctx: {
      rpc: {
        register: async (contract, handlers) => {
          state.contract = contract
          state.handlers = handlers
          return { dispose: async () => { state.disposed = true } }
        },
      },
    },
  }
}

test("RPC returns cached status by default and refreshes only on request", async () => {
  const { state, ctx } = context()
  let refreshes = 0
  const cached = { mode: "warn", providers: [], label: "cached" }
  const refreshed = { mode: "warn", providers: [], label: "refreshed" }
  await registerQuotaRpc(ctx, {
    getStatus: () => cached,
    refresh: async () => { refreshes++; return refreshed },
  })
  assert.equal(state.contract, QuotaGuardRpc)
  assert.deepEqual(await state.handlers.status({}), cached)
  assert.deepEqual(await state.handlers.status({ refresh: false }), cached)
  assert.equal(refreshes, 0)
  assert.deepEqual(await state.handlers.status({ refresh: true }), refreshed)
  assert.equal(refreshes, 1)
})

test("RPC registration can be disposed without changing quota data", async () => {
  const { state, ctx } = context()
  const registration = await registerQuotaRpc(ctx, {
    getStatus: () => ({ mode: "warn", automaticActions: { interrupt: false, switchModel: false }, providers: [] }),
    refresh: async () => { throw new Error("not expected") },
  })
  const status = await state.handlers.status({ refresh: false })
  assert.equal(status.mode, "warn")
  assert.equal(status.automaticActions.interrupt, false)
  assert.equal(status.automaticActions.switchModel, false)
  await registration.dispose()
  assert.equal(state.disposed, true)
})

test("RPC strips optional fields whose values are undefined", async () => {
  const { state, ctx } = context()
  await registerQuotaRpc(ctx, {
    getStatus: () => ({
      mode: "warn",
      automaticActions: { interrupt: false, switchModel: false },
      lastRefreshAt: undefined,
      providers: [{
        id: "openai",
        displayName: "ChatGPT",
        status: "ready",
        statusText: undefined,
        plan: "pro",
        windows: [{ id: "week", label: "week", usedPercent: undefined, limitReached: false }],
      }],
    }),
    refresh: async () => { throw new Error("not expected") },
  })
  const status = await state.handlers.status({ refresh: false })
  assert.equal("lastRefreshAt" in status, false)
  assert.equal("statusText" in status.providers[0], false)
  assert.equal("usedPercent" in status.providers[0].windows[0], false)
  assert.equal(status.providers[0].plan, "pro")
})

test("RPC attaches token rates without changing quota providers", async () => {
  const { state, ctx } = context()
  const rate = { sessionID: "ses-1", providerID: "kimi-code-plan-global", providerName: "Kimi", modelID: "k3.1-pro", modelName: "K3.1", active: false, ratesCurrent: true, updatedAt: 1, inputPerSecond: 62.5, outputPerSecond: 12.5 }
  await registerQuotaRpc(ctx, {
    getStatus: () => ({ enabled: true, mode: "warn", providers: [] }),
    refresh: async () => { throw new Error("not expected") },
  }, { getRates: () => [rate] })
  const status = await state.handlers.status({ refresh: false })
  assert.deepEqual(status.rates, [rate])
  assert.deepEqual(status.providers, [])
})

test("RPC configure switches monitoring mode through the guard only", async () => {
  const { state, ctx } = context()
  const calls = []
  await registerQuotaRpc(ctx, {
    getStatus: () => ({ enabled: true, mode: "warn", providers: [] }),
    refresh: async () => { throw new Error("not expected") },
    setOptions: async (input) => {
      calls.push(input)
      return {
        enabled: input.enabled === true,
        mode: input.enabled === true ? "warn" : "off",
        automaticActions: { interrupt: false, switchModel: false },
        lastRefreshAt: undefined,
        providers: [],
      }
    },
  })

  const off = await state.handlers.configure({ enabled: false })
  assert.deepEqual(calls, [{ enabled: false }])
  assert.equal(off.enabled, false)
  assert.equal(off.mode, "off")
  assert.equal("lastRefreshAt" in off, false)
  assert.deepEqual(off.automaticActions, { interrupt: false, switchModel: false })

  const on = await state.handlers.configure({ enabled: true })
  assert.equal(on.mode, "warn")
  assert.deepEqual(calls, [{ enabled: false }, { enabled: true }])
})

test("RPC diagnostics reads local history on demand without refreshing quotas", async () => {
  const { state, ctx } = context()
  const calls = []
  await registerQuotaRpc(ctx, {
    getStatus: () => ({ enabled: true, mode: "warn", providers: [] }),
    refresh: async () => { throw new Error("not expected") },
  }, undefined, async () => { throw new Error("stats not expected") }, {
    read: async (period) => {
      calls.push(period)
      return { available: true, period, coldSteps: [], projects: [], timeline: [] }
    },
  })
  assert.deepEqual(await state.handlers.diagnostics({ period: "week" }), { available: true, period: "week", coldSteps: [], projects: [], timeline: [] })
  assert.deepEqual(await state.handlers.diagnostics({}), { available: true, period: "day", coldSteps: [], projects: [], timeline: [] })
  assert.deepEqual(calls, ["week", "day"])
})

test("RPC stats is loaded on demand for the selected period", async () => {
  const { state, ctx } = context()
  const calls = []
  await registerQuotaRpc(ctx, {
    getStatus: () => ({ enabled: true, mode: "warn", providers: [] }),
    refresh: async () => { throw new Error("not expected") },
  }, undefined, async (_ctx, period) => {
    calls.push(period)
    return { available: true, period, models: [] }
  })
  assert.deepEqual(await state.handlers.stats({ period: "week" }), { available: true, period: "week", models: [] })
  assert.deepEqual(await state.handlers.stats({}), { available: true, period: "day", models: [] })
  assert.deepEqual(calls, ["week", "day"])
})

test("RPC stats schema permits an unavailable second KPI in either period", () => {
  const output = QuotaGuardRpc.methods.stats.output
  for (const period of [output, output.properties.baseline]) {
    const kind = period.properties.efficiency.properties.secondKpi.properties.kind
    assert.ok(kind.anyOf.some((schema) => schema.type === "null"))
  }
})

function assertSchema(schema, value, path = "stats") {
  if (schema.anyOf) {
    assert.ok(schema.anyOf.some((candidate) => {
      try { assertSchema(candidate, value, path); return true } catch { return false }
    }), `${path} does not match any allowed schema`)
    return
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} has an invalid enum value`)
  if (schema.type === "object") {
    assert.equal(typeof value, "object", path)
    assert.notEqual(value, null, path)
    assert.equal(Array.isArray(value), false, path)
    for (const key of schema.required ?? []) assert.ok(key in value, `${path}.${key} is required`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(key in schema.properties, `${path}.${key} is not declared`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) assertSchema(child, value[key], `${path}.${key}`)
    }
  } else if (schema.type === "array") {
    assert.ok(Array.isArray(value), path)
    value.forEach((item, index) => assertSchema(schema.items, item, `${path}[${index}]`))
  } else if (schema.type === "number") {
    assert.equal(typeof value, "number", path)
    assert.ok(Number.isFinite(value), `${path} must be finite`)
  } else if (schema.type === "string") {
    assert.equal(typeof value, "string", path)
  } else if (schema.type === "boolean") {
    assert.equal(typeof value, "boolean", path)
  } else if (schema.type === "null") {
    assert.equal(value, null, path)
  }
}

test("RPC stats schema validates the complete real compareStats output", () => {
  const raw = (from, to, input, read) => ({
    range: { from, to }, steps: 3, cost: 0,
    tokens: { input, output: 30, reasoning: 10, cache: { read, write: 100 } },
    models: [{ model: { providerID: "kimi", id: "m" }, steps: 3, cost: 0, tokens: { input, output: 30, reasoning: 10, cache: { read, write: 100 } } }],
  })
  const current = normalizeStats(raw(20, 30, 800000, 100000))
  const baseline = normalizeStats(raw(0, 10, 700000, 100000))
  const result = { ...compareStats(current, baseline), period: "week" }
  assertSchema(QuotaGuardRpc.methods.stats.output, result)
  assert.ok(result.deltas.secondKpi)
  assert.ok(result.modelComparisons[0].assessment.components.input)
})
