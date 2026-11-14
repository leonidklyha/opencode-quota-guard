import test from "node:test"
import assert from "node:assert/strict"
import { createKimiAproboFetcher, createKimiFetcher, parseKimiUsage, parseOpenAIUsage } from "../providers.js"

const NOW = 1_800_000_000_000

test("OpenAI usage parser keeps primary and weekly quota windows", () => {
  const result = parseOpenAIUsage({
    plan_type: "plus",
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 82.5, limit_window_seconds: 18000, reset_at: 1_800_003_600 },
      secondary_window: { used_percent: 41, limit_window_seconds: 604800, reset_after_seconds: 7200 },
    },
  }, NOW)
  assert.equal(result.status, "ready")
  assert.equal(result.plan, "plus")
  assert.deepEqual(result.windows, [
    { id: "openai-primary", label: "5h", usedPercent: 82.5, resetAt: NOW + 3_600_000, limitReached: false },
    { id: "openai-secondary", label: "week", usedPercent: 41, resetAt: NOW + 7_200_000, limitReached: false },
  ])
})

test("OpenAI parser does not invent missing windows", () => {
  const result = parseOpenAIUsage({ rate_limit: {} }, NOW)
  assert.equal(result.status, "partial")
  assert.deepEqual(result.windows, [])
})

test("OpenAI parser exposes plan credits balance and message ranges", () => {
  const result = parseOpenAIUsage({
    plan_type: "pro",
    rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1_800_003_600 } },
    credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: "279.9153515006", approx_local_messages: [70, 364], approx_cloud_messages: [11, 70] },
  }, NOW)
  assert.deepEqual(result.credits, {
    hasCredits: true,
    unlimited: false,
    overageLimitReached: false,
    balance: 279.9153515006,
    approxLocalMessages: [70, 364],
    approxCloudMessages: [11, 70],
  })
  assert.equal(parseOpenAIUsage({ rate_limit: {} }, NOW).credits, undefined)
})

test("Kimi parser maps managed subscription windows", () => {
  const result = parseKimiUsage({ data: { kind: "ok", quota: { usages: {
    limit5h: { usedRatio: 0.4, resetAt: "2027-01-01T00:00:00Z" },
    limit7d: { usedRatio: 1 },
    monthTotal: { usedRatio: 0.25 },
  }, extraUsage: { balanceCents: 500, totalCents: 1000 } } } }, NOW)
  assert.equal(result.status, "ready")
  assert.deepEqual(result.windows, [
    { id: "kimi-5h", label: "5 ч", usedPercent: 40, resetAt: Date.parse("2027-01-01T00:00:00Z"), limitReached: false },
    { id: "kimi-7d", label: "7 дн", usedPercent: 100, resetAt: undefined, limitReached: true },
    { id: "kimi-month-total", label: "Месяц (всего)", usedPercent: 25, resetAt: undefined, limitReached: false },
  ])
})

test("Kimi parser reports error kind without windows", () => {
  const result = parseKimiUsage({ data: { kind: "error", message: "upstream rejected" } }, NOW)
  assert.equal(result.status, "error")
  assert.equal(result.statusText, "upstream rejected")
  assert.deepEqual(result.windows, [])
})

test("Kimi parser does not invent windows from booster wallet", () => {
  const result = parseKimiUsage({ data: { kind: "ok", quota: { extraUsage: { balanceCents: 100, totalCents: 100 } } } }, NOW)
  assert.equal(result.status, "partial")
  assert.deepEqual(result.windows, [])
})

test("Kimi parser reads direct upstream snake_case usages", () => {
  const result = parseKimiUsage({
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "26", remaining: "74", resetTime: "2026-11-14T09:12:12Z" } }],
    booster_wallet: { status: "STATUS_DISABLED", monthlyUsed: { currency: "USD", priceInCents: "0" } },
    usages: {
      limit_5h: { used_ratio: 0.25, reset_time: "2026-11-14T09:12:12Z" },
      limit_month_total: { used_ratio: 0.125, reset_time: "2026-12-14T00:00:00Z" },
      limit_month_code: { used_ratio: 0.5 },
    },
  }, NOW)
  assert.equal(result.status, "ready")
  assert.deepEqual(result.windows, [
    { id: "kimi-5h", label: "5 ч", usedPercent: 25, resetAt: Date.parse("2026-11-14T09:12:12Z"), limitReached: false },
    { id: "kimi-month-total", label: "Месяц (всего)", usedPercent: 12.5, resetAt: Date.parse("2026-12-14T00:00:00Z"), limitReached: false },
    { id: "kimi-month-code", label: "Месяц (код)", usedPercent: 50, resetAt: undefined, limitReached: false },
  ])
})

test("Kimi parser falls back to absolute limits when ratios are absent", () => {
  const result = parseKimiUsage({
    limits: [
      { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "200", used: "50", remaining: "150", resetTime: "2026-11-14T09:12:12Z" } },
      { window: { duration: 24, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", used: "100", remaining: "0", resetTime: "2026-11-15T00:00:00Z" } },
    ],
    booster_wallet: { status: "STATUS_DISABLED" },
  }, NOW)
  assert.equal(result.status, "ready")
  assert.deepEqual(result.windows, [
    { id: "kimi-limit-1", label: "5 ч", usedPercent: 25, resetAt: Date.parse("2026-11-14T09:12:12Z"), limitReached: false },
    { id: "kimi-limit-2", label: "1 дн", usedPercent: 100, resetAt: Date.parse("2026-11-15T00:00:00Z"), limitReached: true },
  ])
})

test("Kimi parser ignores root booster wallet", () => {
  const result = parseKimiUsage({ booster_wallet: { status: "STATUS_ENABLED", monthlyUsed: { currency: "USD", priceInCents: "500" } } }, NOW)
  assert.equal(result.status, "partial")
  assert.deepEqual(result.windows, [])
})

test("Kimi accounts use independent credentials and the reachable API endpoint", async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  const activeIDs = []
  const credentials = {
    "kimi-code-plan-global": "old-test-key",
    "kimi-aprobo": "aprobo-test-key",
  }
  const ctx = {
    integration: { connection: {
      active: async (id) => { activeIDs.push(id); return credentials[id] ? { id } : undefined },
      resolve: async (connection) => ({ type: "key", key: credentials[connection.id] }),
    } },
  }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization })
    return {
      ok: true,
      json: async () => url.endsWith("/me")
        ? { user_level_name: "Ultra" }
        : { data: { kind: "ok", quota: { usages: { limit5h: { usedRatio: 0.25 } } } } },
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const original = await createKimiFetcher(ctx)()
  const aprobo = await createKimiAproboFetcher(ctx)()
  assert.equal(original.id, "kimi")
  assert.equal(original.displayName, "Kimi Ultra")
  assert.equal(aprobo.id, "kimi-aprobo")
  assert.equal(aprobo.displayName, "Kimi Ultra Aprobo")
  assert.equal(original.windows[0].usedPercent, 25)
  assert.equal(aprobo.windows[0].usedPercent, 25)
  assert.deepEqual(activeIDs, ["kimi-code-plan-global", "kimi-aprobo"])
  assert.ok(calls.every((call) => call.url.startsWith("https://api.kimi.ai/coding/v1/")))
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer old-test-key", "Bearer old-test-key",
    "Bearer aprobo-test-key", "Bearer aprobo-test-key",
  ])
})

test("Kimi Aprobo never falls back to the original subscription credential", async (t) => {
  const originalFetch = globalThis.fetch
  let fetched = false
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch") }
  t.after(() => { globalThis.fetch = originalFetch })
  const ctx = {
    integration: { connection: {
      active: async (id) => id === "kimi-aprobo" ? undefined : { id },
      resolve: async () => ({ type: "key", key: "old-test-key" }),
    } },
  }
  const result = await createKimiAproboFetcher(ctx)()
  assert.equal(result.status, "missing-auth")
  assert.equal(fetched, false)
})
