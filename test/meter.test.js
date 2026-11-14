import test from "node:test"
import assert from "node:assert/strict"
import { calculateTokenRates, createTokenMeter } from "../meter.js"

function fakeContext({ seed = false } = {}) {
  const assistant = {
    id: "msg-seeded",
    type: "assistant",
    model: { providerID: "kimi-code-plan-global", id: "k3.1-pro", variant: "max" },
    time: { created: 1000, firstToken: 2000, streamed: 4000, completed: 4010 },
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } },
    finish: "stop",
  }
  return {
    seedMessage: assistant,
    location: { directory: "/work" },
    provider: { list: async () => ({ data: [{ id: "kimi-code-plan-global", name: "Kimi Ultra (подписка)" }] }) },
    model: { list: async () => ({ data: [{ providerID: "kimi-code-plan-global", modelID: "k3.1-pro", name: "Kimi K3.1 Pro" }] }) },
    session: {
      list: async () => ({ data: seed ? [{ id: "ses-1", time: { busy: 9000 }, tokens: { input: 500, cache: { read: 50 } } }] : [], cursor: {} }),
      active: async () => seed ? { "ses-1": { type: "running" } } : {},
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory: "/work" } }),
      message: { get: async () => { throw new Error("not expected") } },
    },
    message: { list: async () => ({ data: seed ? [assistant] : [], cursor: {} }) },
    event: { subscribe: async function* () {} },
  }
}

test("token rates include cache and reasoning without double counting", () => {
  const result = calculateTokenRates({
    startedAt: 1000,
    firstTokenAt: 3000,
    streamedAt: 7000,
    completedAt: 7050,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } },
  })
  assert.equal(result.inputTokens, 125)
  assert.equal(result.outputTokens, 50)
  assert.equal(result.uncachedInputTokens, 100)
  assert.equal(result.cacheReadTokens, 20)
  assert.equal(result.cacheWriteTokens, 5)
  assert.equal(result.reasoningTokens, 10)
  assert.equal(result.inputPerSecond, 62.5)
  assert.equal(result.outputPerSecond, 12.5)
  assert.equal(result.firstTokenMs, 2000)
  assert.equal(result.outputDurationMs, 4000)
})

test("token rates never produce Infinity for missing or zero durations", () => {
  const result = calculateTokenRates({
    startedAt: 1000,
    firstTokenAt: 1000,
    streamedAt: 1000,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  assert.equal(result.inputPerSecond, undefined)
  assert.equal(result.outputPerSecond, undefined)
  assert.equal(calculateTokenRates({ tokens: {} }).inputTokens, 0)
})

test("live step events publish exact metrics and preserve them while the next step runs", async () => {
  const ctx = fakeContext()
  let updates = 0
  const meter = createTokenMeter({ ctx, onUpdated: () => { updates++ } })
  const cleanup = await meter.setup()
  await meter.handleEvent({ type: "session.step.started", created: 1000, data: { sessionID: "ses-live", assistantMessageID: "msg-live", model: { providerID: "kimi-code-plan-global", id: "k3.1-pro" }, started: 1000 } })
  await meter.handleEvent({ type: "session.step.first-token", created: 3000, data: { sessionID: "ses-live", assistantMessageID: "msg-live" } })
  await meter.handleEvent({ type: "session.step.streamed", created: 7000, data: { sessionID: "ses-live", assistantMessageID: "msg-live" } })
  await meter.handleEvent({ type: "session.step.ended", created: 7050, data: { sessionID: "ses-live", assistantMessageID: "msg-live", finish: "stop", tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } } } })
  let [rate] = meter.getRates()
  assert.equal(rate.active, false)
  assert.equal(rate.ratesCurrent, true)
  assert.equal(rate.inputPerSecond, 62.5)
  assert.equal(rate.outputPerSecond, 12.5)
  assert.equal(rate.providerName, "Kimi Ultra (подписка)")
  assert.equal(rate.modelName, "Kimi K3.1 Pro")
  assert.deepEqual(meter.getActiveRates(), [], "completed workers disappear from the active-only panel")

  await meter.handleEvent({ type: "session.step.started", created: 8000, data: { sessionID: "ses-live", assistantMessageID: "msg-next", model: { providerID: "kimi-code-plan-global", id: "k3.1-pro" }, started: 8000 } })
  await meter.handleEvent({ type: "session.usage.updated", created: 8100, data: { sessionID: "ses-live", cost: 0, tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 100, write: 20 } } } })
  ;[rate] = meter.getRates()
  assert.equal(rate.active, true)
  assert.equal(rate.ratesCurrent, false)
  assert.equal(rate.inputTokens, 125, "previous exact totals stay visible")
  assert.equal(rate.inputPerSecond, 62.5, "previous exact rate stays visible")
  assert.equal(rate.firstTokenAt, undefined, "new step timing is not inherited")
  assert.equal(rate.sessionInputTokens, 1120, "session input includes cache")
  assert.equal(rate.sessionOutputTokens, 250, "session output includes reasoning")
  assert.equal(meter.getActiveRates().length, 1)
  await meter.handleEvent({ type: "session.execution.succeeded", created: 8200, data: { sessionID: "ses-live" } })
  assert.deepEqual(meter.getActiveRates(), [], "finished execution is removed from the active-only panel")
  assert.ok(updates >= 5)
  cleanup()
})

test("a different model never inherits the previous model's rates", async () => {
  const meter = createTokenMeter({ ctx: fakeContext() })
  const cleanup = await meter.setup()
  await meter.handleEvent({ type: "session.step.started", created: 1000, data: { sessionID: "ses-live", assistantMessageID: "msg-one", model: { providerID: "kimi-code-plan-global", id: "k3.1-pro" }, started: 1000 } })
  await meter.handleEvent({ type: "session.step.first-token", created: 2000, data: { sessionID: "ses-live", assistantMessageID: "msg-one" } })
  await meter.handleEvent({ type: "session.step.streamed", created: 3000, data: { sessionID: "ses-live", assistantMessageID: "msg-one" } })
  await meter.handleEvent({ type: "session.step.ended", created: 3010, data: { sessionID: "ses-live", assistantMessageID: "msg-one", finish: "stop", tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } } } })
  await meter.handleEvent({ type: "session.step.started", created: 4000, data: { sessionID: "ses-live", assistantMessageID: "msg-two", model: { providerID: "openai", id: "gpt-other" }, started: 4000 } })
  const [rate] = meter.getRates()
  assert.equal(rate.providerID, "openai")
  assert.equal(rate.inputTokens, undefined)
  assert.equal(rate.inputPerSecond, undefined)
  assert.equal(rate.outputPerSecond, undefined)
  cleanup()
})

test("seed survives active-status failure and falls back to session context", async () => {
  const ctx = fakeContext({ seed: true })
  ctx.session.active = async () => { throw new Error("active unavailable") }
  ctx.session.context = async () => [ctx.seedMessage]
  ctx.message = undefined
  const meter = createTokenMeter({ ctx })
  const cleanup = await meter.setup()
  const [rate] = meter.getRates()
  assert.equal(rate.sessionID, "ses-1")
  assert.equal(rate.active, false)
  assert.equal(rate.inputPerSecond, 125)
  assert.equal(rate.outputPerSecond, 25)
  cleanup()
})

test("seed reads recent exact metrics without model requests and marks a running session", async () => {
  const meter = createTokenMeter({ ctx: fakeContext({ seed: true }) })
  const cleanup = await meter.setup()
  const [rate] = meter.getRates()
  assert.equal(rate.sessionID, "ses-1")
  assert.equal(rate.active, true)
  assert.equal(rate.ratesCurrent, false)
  assert.equal(rate.inputPerSecond, 125)
  assert.equal(rate.outputPerSecond, 25)
  assert.equal(rate.variant, "max")
  assert.equal(rate.sessionInputTokens, 550)
  assert.equal(rate.sessionOutputTokens, 0)
  cleanup()
})
