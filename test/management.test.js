import test from "node:test"
import assert from "node:assert/strict"
import { createQuotaGuard } from "../core.js"
import { parseKimiProfile } from "../providers.js"
import { registerQuotaRpc } from "../rpc-server.js"

const NOW = 1_800_000_000_000

function snapshot(id = "openai", displayName = "ChatGPT", usedPercent = 50) {
  return {
    id,
    displayName,
    status: "ready",
    fetchedAt: NOW,
    windows: [{ id: "primary", label: "5h", usedPercent, resetAt: NOW + 3600_000 }],
  }
}

function harness({ stored, fetchers } = {}) {
  const store = stored ? { settings: stored } : {}
  const persisted = []
  const counters = { fetch: {}, interval: 0, cleared: 0 }
  const forbidden = { interrupt: 0, switchModel: 0 }
  const ctx = {
    session: {
      hook: async () => ({ dispose: async () => {} }),
      synthetic: async () => {},
      interrupt: async () => { forbidden.interrupt++ },
      switchModel: async () => { forbidden.switchModel++ },
    },
    command: { transform: async () => ({ dispose: async () => {} }) },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    storage: {
      get: async (key) => store[key],
      set: async (key, value) => {
        store[key] = value
        persisted.push({ key, value })
      },
    },
  }
  const guard = createQuotaGuard({
    ctx,
    fetchers: fetchers ?? {
      openai: async () => { counters.fetch.openai = (counters.fetch.openai ?? 0) + 1; return snapshot() },
      kimi: async () => { counters.fetch.kimi = (counters.fetch.kimi ?? 0) + 1; return snapshot("kimi", "Kimi Code", 30) },
    },
    now: () => NOW,
    setIntervalImpl: () => { counters.interval++; return { unref() {} } },
    clearIntervalImpl: () => { counters.cleared++ },
  })
  return { guard, counters, persisted, forbidden }
}

test("kimi profile parser reads the subscription plan from /me", () => {
  assert.equal(parseKimiProfile({ user_level_name: "Ultra", user_level: 7 }), "Ultra")
  assert.equal(parseKimiProfile({ data: { user_level_name: "Allegretto" } }), "Allegretto")
  assert.equal(parseKimiProfile({}), undefined)
  assert.equal(parseKimiProfile(null), undefined)
})

test("disabled provider is not fetched and is reported as disabled", async () => {
  const h = harness()
  const cleanup = await h.guard.setup()
  assert.equal(h.counters.fetch.openai, 1)
  assert.equal(h.counters.fetch.kimi, 1)

  const off = await h.guard.setOptions({ monitoring: { kimi: false } })
  assert.deepEqual(off.monitoring, { openai: true, kimi: false })
  const disabled = off.providers.find((provider) => provider.id === "kimi")
  assert.equal(disabled.status, "disabled")
  assert.equal(disabled.statusText, "monitoring disabled")
  assert.equal(h.counters.fetch.kimi, 1, "disabled provider is not refetched")

  await h.guard.refresh()
  assert.equal(h.counters.fetch.kimi, 1)
  assert.equal(h.counters.fetch.openai, 3, "setOptions and explicit refresh each fetch enabled providers")

  const on = await h.guard.setOptions({ monitoring: { kimi: true } })
  assert.equal(on.monitoring.kimi, true)
  assert.equal(h.counters.fetch.kimi, 2, "re-enabled provider is fetched again")
  assert.equal(on.providers.find((provider) => provider.id === "kimi").status, "ready")
  cleanup()
})

test("thresholds and refresh interval are configurable, persisted and validated", async () => {
  const h = harness()
  const cleanup = await h.guard.setup()
  const updated = await h.guard.setOptions({ warningPercent: 50, criticalPercent: 70, refreshMs: 60_000 })
  assert.deepEqual(updated.thresholds, { warningPercent: 50, criticalPercent: 70 })
  assert.equal(updated.refreshMs, 60_000)
  assert.deepEqual(h.persisted.at(-1).value, {
    enabled: true,
    monitoring: { openai: true, kimi: true },
    warningPercent: 50,
    criticalPercent: 70,
    refreshMs: 60_000,
  })

  const invalid = await h.guard.setOptions({ warningPercent: -5, criticalPercent: 500, refreshMs: 1 })
  assert.deepEqual(invalid.thresholds, { warningPercent: 50, criticalPercent: 70 })
  assert.equal(invalid.refreshMs, 60_000)
  cleanup()

  const restored = harness({ stored: { enabled: true, monitoring: { openai: true, kimi: false }, warningPercent: 50, criticalPercent: 70, refreshMs: 60_000 } })
  const restoreCleanup = await restored.guard.setup()
  const status = restored.guard.getStatus()
  assert.deepEqual(status.thresholds, { warningPercent: 50, criticalPercent: 70 })
  assert.equal(status.refreshMs, 60_000)
  assert.deepEqual(status.monitoring, { openai: true, kimi: false })
  assert.equal(restored.counters.fetch.kimi ?? 0, 0, "persisted disabled provider stays unfetched after restart")
  restoreCleanup()
})

test("rpc models lists provider models and switchModel maps to ctx.session.switchModel", async () => {
  const switched = []
  const ctx = {
    rpc: { register: async (contract, handlers) => ({ contract, handlers, dispose: async () => {} }) },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, model: { providerID: "openai", id: "gpt-old" } }),
      switchModel: async (input) => { switched.push(input) },
    },
    provider: {
      list: async () => ({
        data: [
          { id: "openai", name: "OpenAI" },
          { id: "kimi-code-plan-global", name: "Kimi Ultra (подписка)" },
          { id: "kimi-aprobo", name: "Kimi Ultra Aprobo (подписка)" },
        ],
      }),
    },
    model: {
      list: async () => ({
        data: [
          { providerID: "openai", modelID: "gpt-old", name: "GPT Old" },
          { providerID: "openai", modelID: "gpt-new", name: "GPT New" },
          { providerID: "kimi-code-plan-global", modelID: "kimi-k2", name: "Kimi K2" },
          { providerID: "kimi-aprobo", modelID: "k3.1-pro", name: "Kimi K3.1 Pro" },
        ],
      }),
    },
  }
  const registration = await registerQuotaRpc(ctx, {
    getStatus: () => ({ enabled: true, mode: "warn", monitoring: {}, refreshMs: 300_000, providers: [] }),
    refresh: async () => ({ enabled: true, mode: "warn", monitoring: {}, refreshMs: 300_000, providers: [] }),
    setOptions: async (input) => ({ enabled: true, mode: "warn", monitoring: {}, refreshMs: 300_000, providers: [], ...input }),
  })
  const { handlers } = registration

  const models = await handlers.models({ sessionID: "ses-1" })
  assert.deepEqual(models.current, { providerID: "openai", modelID: "gpt-old" })
  assert.deepEqual(models.options.at(0), { providerID: "openai", providerTitle: "OpenAI", modelID: "gpt-old", title: "GPT Old" })
  assert.equal(models.options.length, 4)
  assert.ok(models.options.some((option) => option.modelID === "k3.1-pro" && option.providerID === "kimi-aprobo" && option.providerTitle === "Kimi Ultra Aprobo (подписка)"))

  const result = await handlers.switchModel({ sessionID: "ses-1", providerID: "kimi-code-plan-global", modelID: "kimi-k2" })
  assert.deepEqual(result, { switched: true, providerID: "kimi-code-plan-global", modelID: "kimi-k2" })
  const aprobo = await handlers.switchModel({ sessionID: "ses-1", providerID: "kimi-aprobo", modelID: "k3.1-pro" })
  assert.deepEqual(aprobo, { switched: true, providerID: "kimi-aprobo", modelID: "k3.1-pro" })
  assert.deepEqual(switched, [
    { sessionID: "ses-1", model: { id: "kimi-k2", providerID: "kimi-code-plan-global" } },
    { sessionID: "ses-1", model: { id: "k3.1-pro", providerID: "kimi-aprobo" } },
  ])
})

test("guard itself never interrupts or switches models", async () => {
  const h = harness()
  const cleanup = await h.guard.setup()
  await h.guard.setOptions({ monitoring: { kimi: false }, warningPercent: 10 })
  await h.guard.refresh()
  assert.deepEqual(h.forbidden, { interrupt: 0, switchModel: 0 })
  cleanup()
})
