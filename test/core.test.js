import test from "node:test"
import assert from "node:assert/strict"
import { createQuotaGuard, evaluateWarnings, normalizeOptions } from "../core.js"

const NOW = 1_800_000_000_000

function snapshot(usedPercent, resetAt = NOW + 3600_000) {
  return {
    id: "openai",
    displayName: "ChatGPT",
    status: "ready",
    fetchedAt: NOW,
    windows: [{ id: "primary", label: "5h", usedPercent, resetAt }],
  }
}

function harness(initial) {
  let current = initial
  let promptHook
  let timerCleared = false
  const synthetic = []
  const forbidden = { interrupt: 0, switchModel: 0 }
  const ctx = {
    session: {
      hook: async (name, hook) => {
        assert.equal(name, "prompt")
        promptHook = hook
        return { dispose: async () => {} }
      },
      synthetic: async ({ sessionID, text }) => synthetic.push({ sessionID, text }),
      interrupt: async () => { forbidden.interrupt++ },
      switchModel: async () => { forbidden.switchModel++ },
    },
    command: { transform: async () => ({ dispose: async () => {} }) },
    tool: { transform: async () => ({ dispose: async () => {} }) },
  }
  const guard = createQuotaGuard({
    ctx,
    fetchers: { openai: async () => current },
    now: () => NOW,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => { timerCleared = true },
  })
  return {
    guard,
    synthetic,
    forbidden,
    set: (value) => { current = value },
    prompt: async (sessionID = "session-1") => promptHook({ sessionID }),
    timerCleared: () => timerCleared,
  }
}

test("thresholds produce no warning below 80%, warning at 80%, critical at 95%", () => {
  const options = normalizeOptions()
  assert.deepEqual(evaluateWarnings([snapshot(79.9)], options, NOW), [])
  assert.equal(evaluateWarnings([snapshot(80)], options, NOW)[0].severity, "warning")
  assert.equal(evaluateWarnings([snapshot(95)], options, NOW)[0].severity, "critical")
  assert.match(evaluateWarnings([snapshot(100)], options, NOW)[0].text, /лимит исчерпан/)
})

test("stale snapshots never trigger warnings", () => {
  const old = { ...snapshot(100), fetchedAt: NOW - 7 * 60 * 60 * 1000 }
  assert.deepEqual(evaluateWarnings([old], {}, NOW), [])
})

test("prompt warnings are deduplicated and never stop or switch", async () => {
  const h = harness(snapshot(83))
  const cleanup = await h.guard.setup()
  await h.prompt()
  await h.prompt()
  assert.equal(h.synthetic.length, 1)
  assert.match(h.synthetic[0].text, /Автоматические действия отключены/)

  h.set(snapshot(96))
  await h.guard.refresh()
  await h.prompt()
  assert.equal(h.synthetic.length, 2, "crossing critical creates a new warning")
  assert.match(h.synthetic[1].text, /🚨/)

  h.set(snapshot(96, NOW + 7200_000))
  await h.guard.refresh()
  await h.prompt()
  assert.equal(h.synthetic.length, 3, "a new quota window can warn again")

  await h.prompt("another-session")
  assert.equal(h.synthetic.length, 4, "deduplication is scoped per session")
  assert.deepEqual(h.forbidden, { interrupt: 0, switchModel: 0 })
  assert.deepEqual(h.guard.getStatus().automaticActions, { interrupt: false, switchModel: false })
  cleanup()
  assert.equal(h.timerCleared(), true)
})

test("refresh-completion diagnostics callback excludes cached and disabled states", async () => {
  const refreshed = []
  let updates = 0
  const guard = createQuotaGuard({
    ctx: {},
    fetchers: { openai: async () => snapshot(42) },
    onRefreshed: (status) => refreshed.push(status),
    onUpdated: () => { updates++ },
    now: () => NOW,
    setIntervalImpl: () => ({ unref() {} }),
  })
  await guard.refresh()
  guard.getStatus()
  assert.equal(refreshed.length, 1)
  assert.equal(refreshed[0].providers[0].fetchedAt, NOW)
  await guard.setOptions({ enabled: false })
  await guard.refresh()
  assert.equal(refreshed.length, 1)
  assert.equal(updates, 2)
})

test("invalid options fall back to safe warnings-only defaults", () => {
  const options = normalizeOptions({ warningPercent: -10, criticalPercent: 1000, refreshMs: 1 })
  assert.equal(options.mode, "warn")
  assert.equal(options.warningPercent, 80)
  assert.equal(options.criticalPercent, 95)
  assert.equal(options.refreshMs, 300_000)
})

function modeHarness(stored) {
  const store = { ...stored }
  const persisted = []
  const current = snapshot(90)
  let promptHook
  const synthetic = []
  const counters = { fetch: 0, interval: 0, cleared: 0 }
  const ctx = {
    session: {
      hook: async (name, hook) => {
        assert.equal(name, "prompt")
        promptHook = hook
        return { dispose: async () => {} }
      },
      synthetic: async ({ sessionID, text }) => synthetic.push({ sessionID, text }),
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
    fetchers: { openai: async () => { counters.fetch++; return current } },
    now: () => NOW,
    setIntervalImpl: () => { counters.interval++; return { unref() {} } },
    clearIntervalImpl: () => { counters.cleared++ },
  })
  return {
    guard,
    counters,
    persisted,
    synthetic,
    prompt: async (sessionID = "session-mode") => promptHook({ sessionID }),
  }
}

test("persisted disabled mode stops polling, provider calls and warnings", async () => {
  const h = modeHarness({ settings: { enabled: false } })
  const cleanup = await h.guard.setup()
  assert.equal(h.counters.fetch, 0, "disabled guard never calls providers")
  assert.equal(h.counters.interval, 0, "disabled guard never schedules polling")
  assert.equal(h.guard.getStatus().enabled, false)
  assert.equal(h.guard.getStatus().mode, "off")
  await h.prompt()
  assert.deepEqual(h.synthetic, [])
  assert.deepEqual(await h.guard.checkSession("session-mode"), [])
  cleanup()
})

test("mode toggle persists and stops/resumes polling without automatic actions", async () => {
  const h = modeHarness({})
  const cleanup = await h.guard.setup()
  assert.equal(h.counters.fetch, 1)
  assert.equal(h.counters.interval, 1)
  assert.equal(h.guard.getStatus().mode, "warn")

  const off = await h.guard.setOptions({ enabled: false })
  assert.equal(off.enabled, false)
  assert.equal(off.mode, "off")
  assert.equal(h.counters.cleared, 1, "disabling stops the polling timer")
  assert.deepEqual(h.persisted.at(-1), { key: "settings", value: { enabled: false, monitoring: { openai: true }, warningPercent: 80, criticalPercent: 95, refreshMs: 300_000 } })
  await h.guard.refresh()
  assert.equal(h.counters.fetch, 1, "refresh while disabled does not call providers")

  const on = await h.guard.setOptions({ enabled: true })
  assert.equal(on.enabled, true)
  assert.equal(on.mode, "warn")
  assert.equal(h.counters.fetch, 2, "re-enabling refreshes providers again")
  assert.equal(h.counters.interval, 2, "re-enabling restarts polling")
  assert.deepEqual(h.persisted.at(-1), { key: "settings", value: { enabled: true, monitoring: { openai: true }, warningPercent: 80, criticalPercent: 95, refreshMs: 300_000 } })
  assert.deepEqual(on.automaticActions, { interrupt: false, switchModel: false })

  cleanup()
  assert.equal(h.counters.cleared, 2)
})
