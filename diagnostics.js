import { randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Flock } from "@opencode/util/flock"
import { OpenCode } from "@opencode/client"
import { discover, headers } from "@opencode/client/service"

const DAY = 24 * 60 * 60 * 1000
const RETENTION = 7 * DAY
const CAP = 10 * 1024 * 1024
const TYPES = [
  "session.step.started", "session.step.ended",
  "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
  "session.model.selected",
]
const BOOT = Symbol.for("opencode.quota-guard.diagnostics.boot")
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined
const text = (value) => typeof value === "string" && value ? value : undefined
const number = (value) => finite(value) ?? 0

function sameReset(a, b) {
  const left = finite(a)
  const right = finite(b)
  if (left === undefined || right === undefined) return left === right
  return Math.abs(left - right) <= 2000
}

function tokens(value) {
  const ordinaryInputTokens = number(value?.input)
  const cacheReadTokens = number(value?.cache?.read)
  const cacheWriteTokens = number(value?.cache?.write)
  const reasoningTokens = number(value?.reasoning)
  return {
    ordinaryInputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
    inputTokens: ordinaryInputTokens + cacheReadTokens + cacheWriteTokens,
    outputTokens: number(value?.output) + reasoningTokens,
    tokenCompleteness: {
      input: finite(value?.input) !== undefined,
      output: finite(value?.output) !== undefined,
      reasoning: finite(value?.reasoning) !== undefined,
      cacheRead: finite(value?.cache?.read) !== undefined,
      cacheWrite: finite(value?.cache?.write) !== undefined,
    },
  }
}

function model(value) {
  return {
    providerID: text(value?.providerID) ?? "unknown",
    modelID: text(value?.id) ?? text(value?.modelID) ?? "unknown",
    variant: text(value?.variant) ?? null,
  }
}

function validModel(value) {
  return text(value?.providerID) !== undefined && text(value.providerID) !== "unknown"
    && text(value?.modelID) !== undefined && text(value.modelID) !== "unknown"
}

function range(period, to) {
  if (period === "week") return { from: to - RETENTION, to }
  const date = new Date(to)
  date.setHours(0, 0, 0, 0)
  return { from: date.getTime(), to }
}

function emptyAggregate(id) {
  return { id, steps: 0, coldSteps: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function addStep(target, step, cold) {
  target.steps++
  if (cold) target.coldSteps++
  target.inputTokens += step.inputTokens
  target.outputTokens += step.outputTokens
  target.cacheReadTokens += step.cacheReadTokens
  target.cacheWriteTokens += step.cacheWriteTokens
  target.reasoningTokens += step.reasoningTokens
}

function modelAggregate(root, step, cold) {
  const key = `${step.providerID}\0${step.modelID}\0${step.variant ?? ""}`
  let item = root.models.get(key)
  if (!item) {
    item = { providerID: step.providerID, modelID: step.modelID, variant: step.variant, ...emptyAggregate(`${step.providerID}/${step.modelID}`) }
    delete item.id
    root.models.set(key, item)
  }
  addStep(item, step, cold)
}

function modelList(models) {
  return [...models.values()].sort((a, b) => b.steps - a.steps || b.inputTokens - a.inputTokens)
}

async function projectNames() {
  const names = new Map()
  try {
    const endpoint = await discover()
    if (!endpoint) return names
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) })
    const result = await client.project.list()
    for (const project of Array.isArray(result) ? result : result?.data ?? []) {
      if (!project?.id) continue
      const canonical = text(project.canonical)
      names.set(String(project.id), text(project.name) ?? (canonical ? path.basename(canonical) : String(project.id)))
    }
  } catch {}
  return names
}

export function createDiagnostics({
  ctx,
  now = () => Date.now(),
  filePath = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode", "quota-guard", "diagnostics.jsonl"),
  instanceID = randomUUID(),
} = {}) {
  const directory = path.dirname(filePath)
  const metadata = new Map()
  const locality = new Map()
  const pending = new Set()
  let writing = Promise.resolve()
  let controller
  let closed = false

  async function lock(fn) {
    return Flock.withLock("diagnostics", fn, { dir: path.join(directory, "locks"), timeoutMs: 2000 })
  }

  async function parseFile() {
    let source
    try { source = await readFile(filePath, "utf8") } catch { return [] }
    const records = new Map()
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (record?.v === 1 && text(record.id) && text(record.kind) && finite(record.at) !== undefined) records.set(record.id, record)
      } catch {}
    }
    return [...records.values()]
  }

  async function prune() {
    try {
      await lock(async () => {
        const records = (await parseFile()).filter((record) => record.at >= now() - RETENTION)
        let serialized = records.map((record) => JSON.stringify(record)).join("\n")
        if (serialized) serialized += "\n"
        if (Buffer.byteLength(serialized) > CAP) {
          const kept = []
          let size = 0
          for (const record of [...records].sort((a, b) => b.at - a.at)) {
            const bytes = Buffer.byteLength(JSON.stringify(record)) + 1
            if (size + bytes > CAP) continue
            kept.push(record)
            size += bytes
          }
          serialized = kept.map((record) => JSON.stringify(record)).join("\n") + (kept.length ? "\n" : "")
        }
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, serialized, { mode: 0o600 })
          await rename(temp, filePath)
          try { await chmod(filePath, 0o600) } catch {}
        } catch (error) {
          try { await unlink(temp) } catch {}
          throw error
        }
      })
    } catch {}
  }

  function enqueue(record) {
    if (closed || pending.size >= 100) return false
    const operation = (async () => {
      try {
        await lock(async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await appendFile(filePath, `${JSON.stringify({ v: 1, ...record })}\n`, { mode: 0o600 })
          try { await chmod(filePath, 0o600) } catch {}
        })
        try { if ((await stat(filePath)).size > CAP) await prune() } catch {}
      } catch {}
    })()
    pending.add(operation)
    operation.finally(() => pending.delete(operation)).catch(() => {})
    writing = Promise.allSettled([...pending])
    return true
  }

  async function sessionMetadata(sessionID) {
    if (metadata.has(sessionID)) return metadata.get(sessionID)
    let session
    try { session = await ctx?.session?.get({ sessionID }) } catch {}
    const value = {
      sessionID,
      projectID: text(session?.projectID) ?? null,
      parentID: text(session?.parentID) ?? null,
      directory: text(session?.location?.directory),
    }
    metadata.set(sessionID, value)
    return value
  }

  async function isLocal(sessionID, event) {
    if (!sessionID) return true
    if (locality.has(sessionID)) return locality.get(sessionID)
    const own = text(ctx?.location?.directory)
    const eventDirectory = text(event?.location?.directory)
    let local = true
    if (own && eventDirectory) local = own === eventDirectory
    else {
      const session = await sessionMetadata(sessionID)
      if (own && session.directory) local = own === session.directory
    }
    locality.set(sessionID, local)
    return local
  }

  async function roots(steps) {
    const result = new Map()
    for (const step of steps) {
      if (result.has(step.sessionID)) continue
      let current = await sessionMetadata(step.sessionID)
      let rootID = current.sessionID
      const seen = new Set()
      for (let depth = 0; current?.parentID && depth < 32 && !seen.has(current.sessionID); depth++) {
        seen.add(current.sessionID)
        rootID = current.parentID
        current = await sessionMetadata(current.parentID)
      }
      for (const id of seen) result.set(id, rootID)
      result.set(step.sessionID, rootID)
    }
    return result
  }

  async function handle(event) {
    const type = text(event?.type)
    const data = event?.data ?? {}
    const sessionID = text(data.sessionID)
    if (!TYPES.includes(type) || !await isLocal(sessionID, event)) return
    const at = finite(event.created) ?? now()
    const envelope = text(event.id) ?? randomUUID()
    if (type === "session.step.started") {
      const assistantMessageID = text(data.assistantMessageID)
      if (!sessionID || !assistantMessageID) return
      const info = await sessionMetadata(sessionID)
      enqueue({ id: `step.start:${assistantMessageID}`, kind: "step.start", at, sessionID,
        projectID: info.projectID, parentID: info.parentID, assistantMessageID,
        startedAt: finite(data.started) ?? at, agent: text(data.agent) ?? null, ...model(data.model) })
      return
    }
    if (type === "session.step.ended") {
      const assistantMessageID = text(data.assistantMessageID)
      if (!sessionID || !assistantMessageID || !data.tokens) return
      const info = await sessionMetadata(sessionID)
      let selected = model()
      try {
        const message = await ctx?.session?.message?.get({ sessionID, messageID: assistantMessageID })
        selected = model(message?.model)
      } catch {}
      enqueue({ id: `step.end:${assistantMessageID}`, kind: "step.end", at, sessionID,
        projectID: info.projectID, parentID: info.parentID, assistantMessageID,
        completedAt: at, finish: text(data.finish) ?? null, ...tokens(data.tokens), ...selected })
      return
    }
    if (type.startsWith("session.compaction.")) {
      if (!sessionID) return
      const info = await sessionMetadata(sessionID)
      enqueue({ id: `compaction:${envelope}`, kind: "compaction", at, sessionID,
        projectID: info.projectID, parentID: info.parentID, phase: type.slice(19), reason: text(data.reason) ?? null })
      return
    }
    if (type === "session.model.selected") {
      const info = sessionID ? await sessionMetadata(sessionID) : { projectID: null, parentID: null }
      enqueue({ id: `model:${envelope}`, kind: "model", at, sessionID,
        projectID: info.projectID, parentID: info.parentID, ...model(data.model),
        previous: data.previous ? model(data.previous) : null })
    }
  }

  async function setup() {
    closed = false
    const boot = globalThis[BOOT] ?? { id: randomUUID() }
    if (!globalThis[BOOT]) {
      globalThis[BOOT] = boot
      enqueue({ id: `process.started:${boot.id}`, kind: "process.started", at: now(), pid: process.pid, bootID: boot.id })
    }
    enqueue({ id: `plugin.setup:${instanceID}:${now()}:${randomUUID()}`, kind: "plugin.setup", at: now(), pid: process.pid, instanceID,
      projectID: text(ctx?.location?.project?.id) ?? null })
    controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: TYPES, signal: controller.signal })) await handle(event)
    })().catch(() => {})
    return async () => {
      closed = true
      controller?.abort()
      await Promise.allSettled([...pending])
      await prune()
    }
  }

  function recordQuota(status) {
    for (const provider of Array.isArray(status?.providers) ? status.providers : []) {
      const providerID = text(provider?.id) ?? text(provider?.providerID)
      const fetchedAt = finite(provider?.fetchedAt)
      if (!providerID || fetchedAt === undefined || !["ready", "partial"].includes(provider.status)) continue
      const windows = []
      for (const window of Array.isArray(provider.windows) ? provider.windows : []) {
        const windowID = text(window?.windowID) ?? text(window?.id)
        const usedPercent = finite(window?.usedPercent)
        if (!windowID || usedPercent === undefined) continue
        windows.push({ windowID, usedPercent, resetAt: finite(window.resetAt), limitReached: window.limitReached === true })
      }
      if (!windows.length) continue
      enqueue({ id: `quota:${providerID}:${fetchedAt}`, kind: "quota", at: fetchedAt, providerID, windows })
    }
  }

  async function read(period = "day") {
    const resolvedPeriod = period === "week" ? "week" : "day"
    const bounds = range(resolvedPeriod, now())
    const base = { available: false, period: resolvedPeriod, ...bounds, retentionDays: 7,
      coldRule: { minInputTokens: 100000, maxCacheReadPercent: 20 }, coldSteps: [], projects: [], steps: [], timeline: [] }
    try {
      await prune()
      const records = await parseFile()
      const starts = new Map(records.filter((r) => r.kind === "step.start").map((r) => [r.assistantMessageID, r]))
      const ends = records.filter((r) => r.kind === "step.end")
      const joined = []
      for (const end of ends) {
        const start = starts.get(end.assistantMessageID)
        const selected = validModel(start) ? start : end
        const sessionID = text(end.sessionID) ?? text(start?.sessionID)
        if (!sessionID) continue
        const inputTokens = number(end.inputTokens)
        const cacheReadTokens = number(end.cacheReadTokens)
        joined.push({ ...end, sessionID, projectID: text(end.projectID ?? start?.projectID) ?? null,
          parentID: text(end.parentID ?? start?.parentID) ?? null,
          providerID: text(selected.providerID) ?? "unknown", modelID: text(selected.modelID) ?? "unknown",
          variant: text(selected.variant) ?? null, startedAt: finite(start?.startedAt) ?? null,
          ordinaryInputTokens: number(end.ordinaryInputTokens), cacheReadTokens,
          cacheWriteTokens: number(end.cacheWriteTokens), reasoningTokens: number(end.reasoningTokens),
          tokenCompleteness: end.tokenCompleteness ?? null,
          cacheReadPercent: inputTokens > 0 ? cacheReadTokens / inputTokens * 100 : null })
      }
      const completed = joined.filter((step) => step.startedAt !== null).sort((a, b) => a.startedAt - b.startedAt)
      const previous = new Map()
      for (const step of completed) {
        const prior = previous.get(step.sessionID)
        step.pauseMs = prior && step.startedAt >= prior.at ? step.startedAt - prior.at : null
        previous.set(step.sessionID, step)
      }
      const rootIDs = await roots(joined)
      const selected = joined.filter((step) => step.at >= bounds.from && step.at <= bounds.to)
      const detail = (step) => ({ id: step.id, at: step.at, sessionID: step.sessionID, parentID: step.parentID,
        rootID: rootIDs.get(step.sessionID) ?? step.sessionID, projectID: step.projectID ?? "unknown", projectLabel: step.projectID ?? "unknown",
        providerID: step.providerID, modelID: step.modelID, variant: step.variant,
        startedAt: step.startedAt, finish: text(step.finish) ?? null,
        inputTokens: step.inputTokens, ordinaryInputTokens: step.ordinaryInputTokens,
        cacheReadTokens: step.cacheReadTokens, cacheWriteTokens: step.cacheWriteTokens,
        outputTokens: step.outputTokens, reasoningTokens: step.reasoningTokens,
        tokenCompleteness: step.tokenCompleteness, cacheReadPercent: step.cacheReadPercent,
        pauseMs: step.pauseMs ?? null, noCache: step.cacheReadTokens === 0 })
      const coldSteps = selected.filter((step) => step.inputTokens >= 100000 && step.cacheReadPercent !== null && step.cacheReadPercent <= 20)
        .map(detail).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
      const steps = selected.map(detail)
        .sort((a, b) => b.inputTokens - a.inputTokens || b.at - a.at || a.id.localeCompare(b.id))
        .slice(0, 200)
      const coldIDs = new Set(coldSteps.map((step) => step.id))
      const projects = new Map()
      for (const step of selected) {
        const cold = coldIDs.has(step.id)
        const projectID = step.projectID ?? "unknown"
        let project = projects.get(projectID)
        if (!project) {
          project = { ...emptyAggregate(projectID), label: projectID, roots: new Map() }
          projects.set(projectID, project)
        }
        addStep(project, step, cold)
        const rootID = rootIDs.get(step.sessionID) ?? step.sessionID
        let root = project.roots.get(rootID)
        if (!root) {
          root = { ...emptyAggregate(rootID), models: new Map(), subagents: new Map() }
          project.roots.set(rootID, root)
        }
        addStep(root, step, cold)
        if (step.sessionID === rootID) modelAggregate(root, step, cold)
        if (step.sessionID !== rootID) {
          let agent = root.subagents.get(step.sessionID)
          if (!agent) {
            agent = { ...emptyAggregate(step.sessionID), models: new Map() }
            root.subagents.set(step.sessionID, agent)
          }
          addStep(agent, step, cold)
          modelAggregate(agent, step, cold)
        }
      }
      const names = await projectNames()
      for (const project of projects.values()) project.label = names.get(project.id) ?? project.id
      for (const step of [...coldSteps, ...steps]) step.projectLabel = names.get(step.projectID) ?? step.projectID

      const quotas = new Map()
      for (const record of records) {
        if (record.kind !== "quota" || !Array.isArray(record.windows)) continue
        for (const window of record.windows) {
          const key = `${record.providerID}\0${window.windowID}`
          if (!quotas.has(key)) quotas.set(key, [])
          quotas.get(key).push({ ...window, at: record.at, providerID: record.providerID, recordID: record.id })
        }
      }
      const quotaInfo = new Map()
      const visibleQuota = new Map()
      for (const list of quotas.values()) {
        list.sort((a, b) => a.at - b.at)
        let prior
        for (const item of list) {
          const same = prior && sameReset(item.resetAt, prior.resetAt) && Math.abs(item.usedPercent - prior.usedPercent) < 0.05 && item.limitReached === prior.limitReached
          if (same) continue
          const valid = prior && sameReset(item.resetAt, prior.resetAt) && item.usedPercent >= prior.usedPercent
          const key = `${item.providerID}:${item.at}:${item.windowID}`
          quotaInfo.set(key, {
            delta: valid ? item.usedPercent - prior.usedPercent : null,
            reset: Boolean(prior && !valid),
          })
          if (!visibleQuota.has(item.recordID)) visibleQuota.set(item.recordID, [])
          visibleQuota.get(item.recordID).push(item)
          prior = item
        }
      }
      const timeline = []
      for (const record of records) {
        if (record.at < bounds.from || record.at > bounds.to) continue
        if (record.kind === "compaction") {
          const phase = { started: "начало", ended: "завершение", failed: "ошибка" }[record.phase] ?? "событие"
          const reason = record.reason === "auto" ? "автоматическая" : record.reason === "manual" ? "вручную" : null
          timeline.push({ id: record.id, at: record.at, kind: "compaction",
            label: `Компакция: ${phase}${reason ? ` · ${reason}` : ""}`, projectID: record.projectID ?? null, sessionID: record.sessionID ?? null, providerID: null })
        } else if (record.kind === "model") timeline.push({ id: record.id, at: record.at, kind: "model",
          label: `Выбрана модель: ${record.providerID}/${record.modelID}${record.variant ? ` · ${record.variant}` : ""}`, projectID: record.projectID ?? null, sessionID: record.sessionID ?? null, providerID: record.providerID ?? null })
        else if (record.kind === "plugin.setup") timeline.push({ id: record.id, at: record.at, kind: record.kind,
          label: `Загрузка/перезагрузка Quota Guard`, projectID: record.projectID ?? null, sessionID: null, providerID: null })
        else if (record.kind === "process.started") timeline.push({ id: record.id, at: record.at, kind: record.kind,
          label: `Запуск хоста плагинов (PID ${record.pid})`, projectID: null, sessionID: null, providerID: null })
        else if (record.kind === "quota") {
          const parts = (visibleQuota.get(record.id) ?? []).map((window) => {
            const info = quotaInfo.get(`${record.providerID}:${record.at}:${window.windowID}`)
            const suffix = info?.reset ? " · сброс/снижение" : info?.delta !== null && info?.delta !== undefined ? ` · изменение ${info.delta.toFixed(1).replace(".", ",")} п.п.` : ""
            return `${window.windowID}: ${Number(window.usedPercent.toFixed(2))}%${suffix}`
          })
          if (!parts.length) continue
          timeline.push({ id: record.id, at: record.at, kind: "quota", label: `${record.providerID}: ${parts.join("; ")}`,
            projectID: null, sessionID: null, providerID: record.providerID })
        }
      }
      return { ...base, available: true, coldSteps: coldSteps.slice(0, 200), steps,
        projects: [...projects.values()].map((project) => ({ ...project, roots: [...project.roots.values()].map((root) => ({
          ...root, models: modelList(root.models), subagents: [...root.subagents.values()].map((agent) => ({ ...agent, models: modelList(agent.models) })),
        })) })).sort((a, b) => b.steps - a.steps),
        timeline: [...timeline, ...coldSteps.map((step) => ({ id: step.id, at: step.at, kind: "cold",
          label: `Холодный шаг: ${step.providerID}/${step.modelID} · вход ${step.inputTokens}${step.noCache ? " · чтение кэша не сообщено" : ""}`,
          projectID: step.projectID, sessionID: step.sessionID, providerID: step.providerID }))]
          .sort((a, b) => b.at - a.at).slice(0, 200) }
    } catch {
      return base
    }
  }

  return { setup, recordQuota, read }
}
