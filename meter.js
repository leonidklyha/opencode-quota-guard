const EVENT_TYPES = [
  "session.step.started",
  "session.step.first-token",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.usage.updated",
]

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function nonNegative(value) {
  const number = finite(value)
  return number !== undefined && number >= 0 ? number : 0
}

function rounded(value) {
  return Math.round(value * 10) / 10
}

function tokenTotals(tokens) {
  const uncachedInput = nonNegative(tokens?.input)
  const cacheRead = nonNegative(tokens?.cache?.read)
  const cacheWrite = nonNegative(tokens?.cache?.write)
  const reasoning = nonNegative(tokens?.reasoning)
  return {
    input: uncachedInput + cacheRead + cacheWrite,
    output: nonNegative(tokens?.output) + reasoning,
    uncachedInput,
    cacheRead,
    cacheWrite,
    reasoning,
  }
}

// Все счётчики — фактические значения OpenCode, а не оценка по длине текста.
// Вход включает кэш, выход включает reasoning: так видна полная работа шага.
export function calculateTokenRates({ startedAt, firstTokenAt, streamedAt, completedAt, tokens }) {
  const totals = tokenTotals(tokens)
  const inputTokens = totals.input
  const outputTokens = totals.output
  const started = finite(startedAt)
  const first = finite(firstTokenAt)
  const streamEnd = finite(streamedAt) ?? finite(completedAt)
  const firstTokenMs = started !== undefined && first !== undefined && first > started ? first - started : undefined
  const outputDurationMs = first !== undefined && streamEnd !== undefined && streamEnd > first ? streamEnd - first : undefined
  return {
    inputTokens,
    outputTokens,
    uncachedInputTokens: totals.uncachedInput,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    reasoningTokens: totals.reasoning,
    firstTokenMs,
    outputDurationMs,
    inputPerSecond: firstTokenMs ? rounded(inputTokens / firstTokenMs * 1000) : undefined,
    outputPerSecond: outputDurationMs ? rounded(outputTokens / outputDurationMs * 1000) : undefined,
  }
}

function listData(value) {
  return Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : []
}

export function createTokenMeter({ ctx, onUpdated, limit = 12, now = () => Date.now() }) {
  const entries = new Map()
  const providerNames = new Map()
  const modelNames = new Map()
  const localSessions = new Map()
  let namesLoaded

  async function loadNames() {
    if (!namesLoaded) {
      namesLoaded = (async () => {
        try {
          for (const provider of listData(await ctx.provider.list())) {
            if (provider?.id) providerNames.set(provider.id, String(provider.name ?? provider.id))
          }
        } catch {}
        try {
          for (const model of listData(await ctx.model.list())) {
            const modelID = model?.modelID ?? model?.id
            if (model?.providerID && modelID) modelNames.set(`${model.providerID}/${modelID}`, String(model.name ?? modelID))
          }
        } catch {}
      })()
    }
    return namesLoaded
  }

  function applyNames(entry) {
    entry.providerName = providerNames.get(entry.providerID) ?? entry.providerID
    entry.modelName = modelNames.get(`${entry.providerID}/${entry.modelID}`) ?? entry.modelID
    return entry
  }

  function publish() {
    onUpdated?.()
  }

  async function isLocal(sessionID, event) {
    const directory = ctx.location?.directory
    const eventDirectory = event?.location?.directory
    if (directory && eventDirectory) return eventDirectory === directory
    if (localSessions.has(sessionID)) return localSessions.get(sessionID)
    let local = true
    try {
      const session = await ctx.session.get({ sessionID })
      const sessionDirectory = session?.location?.directory
      if (directory && sessionDirectory) local = sessionDirectory === directory
    } catch {
      local = false
    }
    localSessions.set(sessionID, local)
    return local
  }

  async function ingestMessage(session, message, active = false) {
    if (!session?.id || !message?.id || !message?.tokens || !message?.model) return false
    const metrics = calculateTokenRates({
      startedAt: message.time?.created,
      firstTokenAt: message.time?.firstToken,
      streamedAt: message.time?.streamed,
      completedAt: message.time?.completed,
      tokens: message.tokens,
    })
    const sessionTokens = session.tokens ? tokenTotals(session.tokens) : undefined
    const entry = {
      ...entries.get(session.id),
      sessionID: session.id,
      messageID: message.id,
      providerID: String(message.model.providerID),
      modelID: String(message.model.id),
      variant: typeof message.model.variant === "string" ? message.model.variant : undefined,
      active,
      sessionInputTokens: sessionTokens?.input,
      sessionOutputTokens: sessionTokens?.output,
      ratesCurrent: !active,
      startedAt: active ? finite(session.time?.busy) ?? finite(message.time?.created) : finite(message.time?.created),
      firstTokenAt: finite(message.time?.firstToken),
      streamedAt: finite(message.time?.streamed),
      completedAt: finite(message.time?.completed),
      finish: typeof message.finish === "string" ? message.finish : undefined,
      ...metrics,
      updatedAt: active ? now() : finite(message.time?.completed) ?? now(),
    }
    entries.set(session.id, applyNames(entry))
    return true
  }

  async function seed() {
    let page
    try {
      page = await ctx.session.list({ directory: ctx.location?.directory, limit: 8 })
    } catch {
      return
    }
    let active = {}
    try {
      if (typeof ctx.session.active === "function") {
        const value = await ctx.session.active()
        active = value?.data ?? value ?? {}
      }
    } catch {}
    await Promise.all(listData(page).map(async (session) => {
      localSessions.set(session.id, true)
      let messages
      try {
        if (typeof ctx.message?.list === "function") {
          messages = await ctx.message.list({ sessionID: session.id, limit: 5, order: "desc", type: "assistant" })
        }
      } catch {}
      if (!messages) {
        try {
          messages = await ctx.session.context({ sessionID: session.id })
        } catch {}
      }
      const message = listData(messages).reduce((latest, item) => {
        if (!item?.tokens || !item?.time?.completed) return latest
        return !latest || item.time.completed > latest.time.completed ? item : latest
      }, undefined)
      if (message) await ingestMessage(session, message, active?.[session.id]?.type === "running")
    }))
  }

  async function handleEvent(event) {
    const data = event?.data ?? {}
    const sessionID = data.sessionID
    if (!sessionID || !await isLocal(sessionID, event)) return
    const timestamp = finite(event.created) ?? now()

    if (event.type === "session.step.started") {
      const previous = entries.get(sessionID)
      const providerID = String(data.model?.providerID ?? previous?.providerID ?? "unknown")
      const modelID = String(data.model?.id ?? previous?.modelID ?? "unknown")
      const sameModel = previous?.providerID === providerID && previous?.modelID === modelID
      let sessionTokens = previous?.sessionInputTokens !== undefined ? {
        input: previous.sessionInputTokens,
        output: previous.sessionOutputTokens,
      } : undefined
      if (!sessionTokens) {
        try {
          const session = await ctx.session.get({ sessionID })
          if (session?.tokens) sessionTokens = tokenTotals(session.tokens)
        } catch {}
      }
      const entry = {
        ...(sameModel ? previous : undefined),
        sessionID,
        messageID: String(data.assistantMessageID),
        providerID,
        modelID,
        variant: typeof data.model?.variant === "string" ? data.model.variant : undefined,
        active: true,
        sessionInputTokens: sessionTokens?.input,
        sessionOutputTokens: sessionTokens?.output,
        ratesCurrent: !sameModel || previous?.inputTokens === undefined,
        startedAt: finite(data.started) ?? timestamp,
        firstTokenAt: undefined,
        streamedAt: undefined,
        finish: undefined,
        updatedAt: timestamp,
      }
      entries.set(sessionID, applyNames(entry))
      publish()
      return
    }

    const current = entries.get(sessionID)
    if (event.type === "session.usage.updated") {
      if (!current || !data.tokens) return
      const totals = tokenTotals(data.tokens)
      current.sessionInputTokens = totals.input
      current.sessionOutputTokens = totals.output
      current.updatedAt = timestamp
      publish()
      return
    }

    if (event.type === "session.step.first-token" || event.type === "session.step.streamed") {
      if (!current || current.messageID !== data.assistantMessageID) return
      if (event.type === "session.step.first-token") current.firstTokenAt = timestamp
      else current.streamedAt = timestamp
      current.active = true
      current.updatedAt = timestamp
      publish()
      return
    }

    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      if (!current || current.messageID !== data.assistantMessageID) {
        try {
          const [session, message] = await Promise.all([
            ctx.session.get({ sessionID }),
            ctx.session.message.get({ sessionID, messageID: data.assistantMessageID }),
          ])
          if (await ingestMessage(session, message, false)) {
            publish()
            return
          }
        } catch {}
      }
      const base = current ?? entries.get(sessionID) ?? {
        sessionID,
        messageID: String(data.assistantMessageID),
        providerID: "unknown",
        modelID: "unknown",
      }
      const metrics = data.tokens ? calculateTokenRates({
        startedAt: base.startedAt,
        firstTokenAt: base.firstTokenAt,
        streamedAt: base.streamedAt,
        completedAt: timestamp,
        tokens: data.tokens,
      }) : {}
      entries.set(sessionID, applyNames({
        ...base,
        active: false,
        ratesCurrent: true,
        completedAt: timestamp,
        finish: event.type === "session.step.failed" ? "error" : String(data.finish ?? "unknown"),
        ...metrics,
        updatedAt: timestamp,
      }))
      publish()
      return
    }

    if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
      if (!current || !current.active) return
      current.active = false
      current.updatedAt = timestamp
      publish()
    }
  }

  function getRates({ activeOnly = false } = {}) {
    return [...entries.values()]
      .filter((entry) => !activeOnly || entry.active)
      .sort((a, b) => Number(b.active) - Number(a.active) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit)
      .map((entry) => ({ ...entry }))
  }

  function getActiveRates() {
    return getRates({ activeOnly: true })
  }

  async function setup() {
    await loadNames()
    await seed()
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: EVENT_TYPES, signal: controller.signal })) {
        await handleEvent(event)
      }
    })().catch(() => {})
    return () => controller.abort()
  }

  return { setup, handleEvent, getRates, getActiveRates }
}
