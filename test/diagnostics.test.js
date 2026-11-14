import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDiagnostics } from "../diagnostics.js"

const NOW = new Date(2026, 10, 15, 12).getTime()
const directory = "D:/work/local"
const sessions = {
  root: { id: "root", projectID: "p1", location: { directory } },
  child: { id: "child", projectID: "p1", parentID: "root", location: { directory } },
  other: { id: "other", projectID: "p2", location: { directory: "D:/work/other" } },
  loopA: { id: "loopA", projectID: "p1", parentID: "loopB", location: { directory } },
  loopB: { id: "loopB", projectID: "p1", parentID: "loopA", location: { directory } },
}

async function fixture(options = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), "quota-diagnostics-"))
  const filePath = path.join(folder, "diagnostics.jsonl")
  const queue = []
  let push
  let failSubscribe = false
  const ctx = {
    location: { directory },
    session: {
      get: async ({ sessionID }) => {
        if (options.sessionFailure) throw new Error("offline")
        return sessions[sessionID] ?? { id: sessionID, projectID: "p1", location: { directory } }
      },
      message: { get: async ({ messageID }) => {
        if (options.messageFailure) throw new Error("missing")
        return { id: messageID, model: { providerID: "fallback", id: "message-model", variant: "high" } }
      } },
    },
    event: { subscribe: async function* () {
      if (failSubscribe) throw new Error("subscription failed")
      while (true) {
        if (!queue.length) await new Promise((resolve) => { push = resolve })
        yield queue.shift()
      }
    } },
  }
  const diagnostics = createDiagnostics({ ctx, now: () => NOW, filePath, instanceID: options.instanceID ?? "test-instance" })
  return { diagnostics, filePath, folder, emit: async (event) => {
    queue.push(event)
    push?.()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }, failSubscribe: () => { failSubscribe = true } }
}

function step(id, { sessionID = "root", at = NOW - 1000, started = at - 100, input = 100000, read = 0, write = 0, output = 20, reasoning = 5, providerID = "p", modelID = "m" } = {}) {
  return [
    { id: `start-${id}`, created: started, type: "session.step.started", location: { directory }, data: { sessionID, assistantMessageID: id, model: { providerID, id: modelID }, started } },
    { id: `end-${id}`, created: at, type: "session.step.ended", location: { directory }, data: { sessionID, assistantMessageID: id, finish: "stop", cost: 99, tokens: { input, output, reasoning, cache: { read, write } } } },
  ]
}

test("exact token arithmetic, cold/no-cache threshold, zero denominator and pause", async () => {
  const f = await fixture()
  const cleanup = await f.diagnostics.setup()
  for (const event of step("a", { at: NOW - 4000, started: NOW - 5000, input: 80000, read: 19000, write: 1000, output: 10, reasoning: 2 })) await f.emit(event)
  for (const event of step("b", { at: NOW - 1000, started: NOW - 2000, input: 79999, read: 20001, write: 1, output: 30, reasoning: 0 })) await f.emit(event)
  for (const event of step("zero", { at: NOW - 500, started: NOW - 600, input: 0, read: 0, write: 0 })) await f.emit(event)
  await cleanup()
  const result = await f.diagnostics.read("day")
  assert.equal(result.coldSteps.length, 1)
  const cold = result.coldSteps[0]
  assert.equal(cold.inputTokens, 100000)
  assert.equal(cold.ordinaryInputTokens, 80000)
  assert.equal(cold.cacheReadTokens, 19000)
  assert.equal(cold.cacheWriteTokens, 1000)
  assert.equal(cold.outputTokens, 12)
  assert.equal(cold.cacheReadPercent, 19)
  assert.equal(cold.noCache, false)
  assert.equal(cold.pauseMs, null)
  assert.equal(result.projects[0].inputTokens, 200001)
  assert.equal(result.projects[0].outputTokens, 67)
  const zero = result.projects[0]
  assert.equal(zero.steps, 3)
})

test("no-cache cold step and same-session pause, never cross-session pause", async () => {
  const f = await fixture()
  const cleanup = await f.diagnostics.setup()
  for (const event of step("one", { at: NOW - 10000, started: NOW - 11000 })) await f.emit(event)
  for (const event of step("two", { sessionID: "child", at: NOW - 8000, started: NOW - 9000 })) await f.emit(event)
  for (const event of step("three", { at: NOW - 5000, started: NOW - 6000 })) await f.emit(event)
  await cleanup()
  const result = await f.diagnostics.read()
  assert.equal(result.coldSteps.length, 3)
  assert.equal(result.coldSteps.find((x) => x.id === "step.end:three").pauseMs, 4000)
  assert.equal(result.coldSteps.find((x) => x.id === "step.end:two").pauseMs, null)
  assert.ok(result.coldSteps.every((x) => x.noCache))
})

test("deduplicates hot-reload copies before all aggregation", async () => {
  const f = await fixture()
  const cleanup = await f.diagnostics.setup()
  for (const event of [...step("same"), ...step("same")]) await f.emit(event)
  await cleanup()
  const result = await f.diagnostics.read()
  assert.equal(result.projects[0].steps, 1)
  assert.equal(result.coldSteps.length, 1)
})

test("parent/root hierarchy groups subagents and compaction adds no tokens or cost", async () => {
  const f = await fixture()
  const cleanup = await f.diagnostics.setup()
  for (const event of step("root-step", { sessionID: "root", input: 1, read: 0 })) await f.emit(event)
  for (const event of step("child-step", { sessionID: "child", input: 2, read: 0 })) await f.emit(event)
  await f.emit({ id: "compact", created: NOW, type: "session.compaction.ended", location: { directory }, data: { sessionID: "child", reason: "auto", tokens: { input: 999999 }, cost: 500 } })
  await cleanup()
  const result = await f.diagnostics.read()
  const root = result.projects[0].roots[0]
  assert.equal(root.id, "root")
  assert.equal(root.steps, 2)
  assert.equal(root.subagents[0].id, "child")
  assert.equal(root.subagents[0].steps, 1)
  assert.equal(root.models.length, 1)
  assert.equal(root.models[0].steps, 1)
  assert.equal(root.models[0].inputTokens, 1)
  assert.equal(root.subagents[0].models[0].inputTokens, 2)
  assert.equal(result.projects[0].inputTokens, 3)
  assert.equal(result.timeline.filter((x) => x.kind === "compaction").length, 1)
  assert.ok(!JSON.stringify(result).includes("999999"))
  assert.ok(!JSON.stringify(result).includes("500"))
})

test("step end without start uses assistant message model, never current session model", async () => {
  const f = await fixture()
  const cleanup = await f.diagnostics.setup()
  await f.emit({ id: "end-only", created: NOW, type: "session.step.ended", location: { directory }, data: { sessionID: "root", assistantMessageID: "end-only", tokens: { input: 100000, cache: { read: 0 } } } })
  await cleanup()
  const result = await f.diagnostics.read()
  assert.equal(result.coldSteps[0].providerID, "fallback")
  assert.equal(result.coldSteps[0].modelID, "message-model")
  assert.equal(result.coldSteps[0].variant, "high")
})

test("locality filters event directory and falls back to session directory", async () => {
  const f = await fixture()
  const cleanup = await f.diagnostics.setup()
  for (const event of step("remote", { sessionID: "other" })) {
    event.location.directory = sessions.other.location.directory
    await f.emit(event)
  }
  const localWithoutEnvelopeDirectory = step("local", { at: NOW - 100 })[1]
  delete localWithoutEnvelopeDirectory.location
  await f.emit(localWithoutEnvelopeDirectory)
  await cleanup()
  const result = await f.diagnostics.read()
  assert.equal(result.projects.length, 1, JSON.stringify(result.projects))
  assert.equal(result.projects[0].steps, 1)
  assert.equal(result.projects[0].roots[0].subagents.length, 0)
})

test("quota records only genuine valid snapshots and reports delta/reset without summing", async () => {
  const f = await fixture()
  f.diagnostics.recordQuota({ providers: [
    { id: "ok", status: "ready", fetchedAt: NOW - 3000, windows: [{ windowID: "five", usedPercent: 10, resetAt: 50, limitReached: false }] },
    { id: "cached", status: "cached", fetchedAt: NOW, windows: [{ windowID: "five", usedPercent: 80 }] },
    { id: "error", status: "error", fetchedAt: NOW, windows: [{ windowID: "five", usedPercent: 90 }] },
    { id: "bad", status: "ready", fetchedAt: Infinity, windows: [{ windowID: "five", usedPercent: 90 }] },
  ] })
  f.diagnostics.recordQuota({ providers: [{ id: "ok", status: "partial", fetchedAt: NOW - 2000, windows: [{ windowID: "five", usedPercent: 12.5, resetAt: 50 }] }] })
  f.diagnostics.recordQuota({ providers: [{ id: "ok", status: "ready", fetchedAt: NOW - 1000, windows: [{ windowID: "five", usedPercent: 11, resetAt: 50 }] }] })
  f.diagnostics.recordQuota({ providers: [{ id: "ok", status: "ready", fetchedAt: NOW - 500, windows: [{ windowID: "five", usedPercent: 11, resetAt: 1050 }] }] })
  f.diagnostics.recordQuota({ providers: [{ id: "ok", status: "ready", fetchedAt: NOW, windows: [{ windowID: "five", usedPercent: 2, resetAt: 60, limitReached: true }] }] })
  const cleanup = await f.diagnostics.setup()
  await cleanup()
  const result = await f.diagnostics.read()
  const quota = result.timeline.filter((x) => x.kind === "quota").sort((a, b) => a.at - b.at)
  assert.equal(quota.length, 4)
  assert.ok(!quota[0].label.includes("delta"))
  assert.ok(quota[1].label.includes("изменение 2,5 п.п."))
  assert.ok(quota[2].label.includes("сброс/снижение"))
  assert.ok(quota[3].label.includes("сброс/снижение"))
})

test("malformed JSONL, dedupe, retention and cap are bounded", async () => {
  const f = await fixture()
  const current = { v: 1, id: "quota:x:1", kind: "quota", at: NOW, providerID: "x", windows: [{ windowID: "w", usedPercent: 1 }] }
  const old = { ...current, id: "old", at: NOW - 8 * 86400000 }
  await writeFile(f.filePath, `${JSON.stringify(current)}\nnot-json\n${JSON.stringify(old)}\n${JSON.stringify(current)}\n{"v":1`)
  const result = await f.diagnostics.read("week")
  assert.equal(result.available, true)
  assert.equal(result.timeline.filter((x) => x.kind === "quota").length, 1)
  const records = (await readFile(f.filePath, "utf8")).trim().split("\n").map(JSON.parse)
  assert.deepEqual(records.map((x) => x.id), ["quota:x:1"])
  await f.diagnostics.recordQuota({ providers: [{ id: "large", status: "ready", fetchedAt: NOW, windows: Array.from({ length: 150000 }, (_, i) => ({ windowID: `window-${i}`, usedPercent: 1 })) }] })
  const cleanup = await f.diagnostics.setup()
  await cleanup()
  assert.ok((await readFile(f.filePath)).byteLength <= 10 * 1024 * 1024)
})

test("missing session metadata keeps cold-step RPC fields valid", async () => {
  const f = await fixture({ sessionFailure: true })
  const cleanup = await f.diagnostics.setup()
  await f.emit(step("unknown-project")[1])
  await cleanup()
  const result = await f.diagnostics.read()
  assert.equal(result.coldSteps[0].projectID, "unknown")
  assert.equal(result.coldSteps[0].projectLabel, "unknown")
  assert.equal(result.coldSteps[0].parentID, null)
})

test("new steps expose reasoning and per-field completeness; legacy fields remain optional", async () => {
  const f = await fixture()
  const legacy = { v: 1, id: "step.end:legacy", kind: "step.end", at: NOW - 10, sessionID: "root",
    projectID: "p1", assistantMessageID: "legacy", inputTokens: 7, ordinaryInputTokens: 7,
    cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 }
  await writeFile(f.filePath, `${JSON.stringify(legacy)}\n`)
  const cleanup = await f.diagnostics.setup()
  for (const event of step("new", { input: 10, read: 2, write: 3, output: 4, reasoning: 5 })) await f.emit(event)
  await f.emit({ id: "partial-end", created: NOW, type: "session.step.ended", location: { directory },
    data: { sessionID: "root", assistantMessageID: "partial", tokens: { input: 0, output: 0 } } })
  await cleanup()
  const result = await f.diagnostics.read()
  const current = result.steps.find((item) => item.id === "step.end:new")
  assert.equal(current.reasoningTokens, 5)
  assert.equal(current.outputTokens, 9)
  assert.deepEqual(current.tokenCompleteness, { input: true, output: true, reasoning: true, cacheRead: true, cacheWrite: true })
  const old = result.steps.find((item) => item.id === "step.end:legacy")
  assert.equal(old.reasoningTokens, 0)
  assert.equal(old.tokenCompleteness, null)
  const partial = result.steps.find((item) => item.id === "step.end:partial")
  assert.equal(partial.inputTokens, 0)
  assert.deepEqual(partial.tokenCompleteness, { input: true, output: true, reasoning: false, cacheRead: false, cacheWrite: false })
  assert.equal(result.projects[0].reasoningTokens, 5)
  assert.equal(result.projects[0].cacheWriteTokens, 3)
})

test("step details rank by full input, tie-break deterministically and stay bounded", async () => {
  const f = await fixture()
  const records = Array.from({ length: 205 }, (_, index) => ({ v: 1, id: `step.end:${index}`, kind: "step.end",
    at: NOW - 1000, sessionID: "root", projectID: "p1", assistantMessageID: String(index),
    inputTokens: index, ordinaryInputTokens: index, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningTokens: 0, providerID: "p", modelID: "m", variant: null }))
  for (const id of ["b", "a"]) records.push({ v: 1, id: `step.end:${id}`, kind: "step.end",
    at: NOW - 1000, sessionID: "root", projectID: "p1", assistantMessageID: id,
    inputTokens: 999, ordinaryInputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningTokens: 0, providerID: "p", modelID: "m", variant: null })
  await writeFile(f.filePath, records.map((record) => JSON.stringify(record)).join("\n"))
  const result = await f.diagnostics.read()
  assert.equal(result.steps.length, 200)
  assert.deepEqual(result.steps.slice(0, 3).map((item) => item.id), ["step.end:a", "step.end:b", "step.end:204"])
  assert.equal(result.steps.at(-1).id, "step.end:7")
  assert.equal(result.projects[0].steps, 207)
  assert.equal(new Set(result.steps.map((item) => item.id)).size, 200)
})

test("duplicate step IDs use the last payload once in details and aggregates", async () => {
  const f = await fixture()
  const base = { v: 1, id: "step.end:duplicate", kind: "step.end", at: NOW, sessionID: "root", projectID: "p1",
    assistantMessageID: "duplicate", ordinaryInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 1, reasoningTokens: 0, providerID: "p", modelID: "m" }
  await writeFile(f.filePath, `${JSON.stringify({ ...base, inputTokens: 1 })}\n${JSON.stringify({ ...base, inputTokens: 9, ordinaryInputTokens: 9 })}\n`)
  const result = await f.diagnostics.read()
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0].inputTokens, 9)
  assert.equal(result.projects[0].steps, 1)
  assert.equal(result.projects[0].inputTokens, 9)
})

test("model identity falls back as a pair for partial or unknown starts without mixing variants", async () => {
  const f = await fixture()
  const cleanup = await f.diagnostics.setup()
  for (const [id, identity] of [["unknown-provider", { providerID: "unknown", id: "start-model", variant: "start" }],
    ["unknown-model", { providerID: "start-provider", id: "unknown", variant: "start" }],
    ["valid", { providerID: "start-provider", id: "start-model", variant: null }]]) {
    const events = step(id, { input: 1 })
    events[0].data.model = identity
    for (const event of events) await f.emit(event)
  }
  await cleanup()
  const result = await f.diagnostics.read()
  for (const id of ["unknown-provider", "unknown-model"]) {
    const item = result.steps.find((step) => step.id === `step.end:${id}`)
    assert.equal(item.providerID, "fallback")
    assert.equal(item.modelID, "message-model")
    assert.equal(item.variant, "high")
  }
  const valid = result.steps.find((step) => step.id === "step.end:valid")
  assert.equal(valid.providerID, "start-provider")
  assert.equal(valid.modelID, "start-model")
  assert.equal(valid.variant, null)
})

test("setup and host process markers are distinct; failures fail open", async () => {
  const f = await fixture({ sessionFailure: true, messageFailure: true })
  f.failSubscribe()
  const cleanup = await f.diagnostics.setup()
  f.diagnostics.recordQuota(null)
  await f.emit({ type: "session.step.ended", data: null })
  await cleanup()
  const result = await f.diagnostics.read()
  assert.equal(result.available, true)
  const setup = result.timeline.find((x) => x.kind === "plugin.setup")
  assert.equal(setup.label, "Загрузка/перезагрузка Quota Guard")
  assert.ok(!setup.label.toLowerCase().includes("restart"))
  const second = await fixture({ instanceID: "second-instance" })
  const cleanup2 = await second.diagnostics.setup()
  await cleanup2()
  const result2 = await second.diagnostics.read()
  assert.ok(result2.timeline.some((x) => x.kind === "plugin.setup"))
})
