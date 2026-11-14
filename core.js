const DEFAULTS = Object.freeze({
  warningPercent: 80,
  criticalPercent: 95,
  refreshMs: 300_000,
  maxSnapshotAgeMs: 6 * 60 * 60 * 1000,
})

function numberOption(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback
}

export function normalizeOptions(input = {}) {
  const warningPercent = numberOption(input.warningPercent, DEFAULTS.warningPercent, 1, 99)
  const criticalPercent = Math.max(
    warningPercent,
    numberOption(input.criticalPercent, DEFAULTS.criticalPercent, 1, 100),
  )
  return Object.freeze({
    mode: "warn",
    warningPercent,
    criticalPercent,
    refreshMs: numberOption(input.refreshMs, DEFAULTS.refreshMs, 30_000, 24 * 60 * 60 * 1000),
    maxSnapshotAgeMs: numberOption(input.maxSnapshotAgeMs, DEFAULTS.maxSnapshotAgeMs, 60_000, 7 * 24 * 60 * 60 * 1000),
  })
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value)
}

function clampNumber(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function publicWindow(window) {
  return {
    id: String(window.id ?? "window"),
    label: String(window.label ?? "quota"),
    usedPercent: finite(window.usedPercent) ? window.usedPercent : undefined,
    resetAt: finite(window.resetAt) ? window.resetAt : undefined,
    limitReached: window.limitReached === true,
  }
}

function publicSnapshot(snapshot) {
  return {
    id: String(snapshot.id ?? "unknown"),
    displayName: String(snapshot.displayName ?? snapshot.id ?? "unknown"),
    status: String(snapshot.status ?? "error"),
    statusText: typeof snapshot.statusText === "string" ? snapshot.statusText.slice(0, 160) : undefined,
    plan: typeof snapshot.plan === "string" ? snapshot.plan.slice(0, 80) : undefined,
    credits: snapshot.credits && typeof snapshot.credits === "object" ? snapshot.credits : undefined,
    fetchedAt: finite(snapshot.fetchedAt) ? snapshot.fetchedAt : undefined,
    windows: Array.isArray(snapshot.windows) ? snapshot.windows.map(publicWindow) : [],
  }
}

function rounded(value) {
  return Math.round(value * 10) / 10
}

export function evaluateWarnings(snapshots, optionsInput = {}, now = Date.now()) {
  const options = normalizeOptions(optionsInput)
  const warnings = []
  for (const snapshot of snapshots) {
    if (!snapshot || !finite(snapshot.fetchedAt) || now - snapshot.fetchedAt > options.maxSnapshotAgeMs) continue
    for (const window of snapshot.windows ?? []) {
      const used = window.usedPercent
      if (!finite(used) || used < options.warningPercent) continue
      const critical = used >= options.criticalPercent || window.limitReached === true || used >= 100
      const severity = critical ? "critical" : "warning"
      const reset = finite(window.resetAt) ? window.resetAt : "current"
      const key = `${snapshot.id}:${window.id}:${reset}:${severity}`
      const remaining = Math.max(0, 100 - used)
      const resetText = finite(window.resetAt)
        ? ` Сброс: ${new Date(window.resetAt).toLocaleString("ru-RU")}.`
        : ""
      const state = used >= 100 || window.limitReached === true ? "лимит исчерпан" : `осталось ${rounded(remaining)}%`
      warnings.push({
        key,
        providerID: snapshot.id,
        windowID: window.id,
        severity,
        usedPercent: used,
        remainingPercent: remaining,
        text: `${critical ? "🚨" : "⚠️"} Quota Guard: ${snapshot.displayName} — ${window.label}: использовано ${rounded(used)}%, ${state}.${resetText} Автоматические действия отключены.`,
      })
    }
  }
  return warnings
}

function statusText(snapshots, options, lastRefreshAt, now, enabled = true) {
  const lines = [
    enabled
      ? "Quota Guard: режим «только предупреждения»."
      : "Quota Guard: мониторинг выключен (опрос и предупреждения отключены).",
    `Пороги: ${options.warningPercent}% и ${options.criticalPercent}%; остановка и смена модели отключены.`,
  ]
  if (snapshots.length === 0) lines.push("Данные квот пока не получены.")
  for (const provider of snapshots) {
    const age = finite(provider.fetchedAt) ? Math.max(0, Math.round((now - provider.fetchedAt) / 1000)) : undefined
    const suffix = age === undefined ? "" : `; обновлено ${age} с назад`
    if (provider.status !== "ready" && provider.status !== "partial") {
      lines.push(`• ${provider.displayName}: ${provider.statusText ?? provider.status}${suffix}`)
      continue
    }
    const windows = provider.windows.length > 0
      ? provider.windows.map((window) => `${window.label}: ${finite(window.usedPercent) ? `${rounded(window.usedPercent)}%` : "нет данных"}`).join(", ")
      : provider.statusText ?? "окна квоты не возвращены"
    lines.push(`• ${provider.displayName}: ${windows}${suffix}`)
  }
  if (!lastRefreshAt) lines.push("Автоматическое обновление ещё не завершено.")
  return lines.join("\n")
}

export function createQuotaGuard({
  ctx,
  options: optionsInput = {},
  fetchers = {},
  onUpdated,
  onRefreshed,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  let options = normalizeOptions(optionsInput)
  const snapshots = new Map()
  const names = new Map()
  const monitoring = {}
  for (const id of Object.keys(fetchers)) monitoring[id] = optionsInput?.monitoring?.[id] !== false
  const seenBySession = new Map()
  let lastRefreshAt = 0
  let refreshing
  let enabled = true
  let timer

  async function loadSettings() {
    try {
      const stored = await ctx.storage?.get?.("settings")
      if (!stored || typeof stored !== "object") return
      if (typeof stored.enabled === "boolean") enabled = stored.enabled
      if (stored.monitoring && typeof stored.monitoring === "object") {
        for (const id of Object.keys(monitoring)) {
          if (typeof stored.monitoring[id] === "boolean") monitoring[id] = stored.monitoring[id]
        }
      }
      options = normalizeOptions({
        warningPercent: clampNumber(stored.warningPercent, options.warningPercent, 1, 99),
        criticalPercent: clampNumber(stored.criticalPercent, options.criticalPercent, 1, 100),
        refreshMs: clampNumber(stored.refreshMs, options.refreshMs, 30_000, 24 * 60 * 60 * 1000),
        maxSnapshotAgeMs: clampNumber(stored.maxSnapshotAgeMs, options.maxSnapshotAgeMs, 60_000, 7 * 24 * 60 * 60 * 1000),
      })
    } catch {}
  }

  async function persistSettings() {
    try {
      await ctx.storage?.set?.("settings", {
        enabled,
        monitoring: { ...monitoring },
        warningPercent: options.warningPercent,
        criticalPercent: options.criticalPercent,
        refreshMs: options.refreshMs,
      })
    } catch {}
  }

  function startTimer() {
    if (timer || !enabled) return
    timer = setIntervalImpl(() => void refresh().catch(() => {}), options.refreshMs)
    timer?.unref?.()
  }

  function stopTimer() {
    if (!timer) return
    clearIntervalImpl(timer)
    timer = undefined
  }

  async function setOptions(input = {}) {
    let changed = false
    if (typeof input.enabled === "boolean" && input.enabled !== enabled) {
      enabled = input.enabled
      changed = true
    }
    if (input.monitoring && typeof input.monitoring === "object") {
      for (const id of Object.keys(monitoring)) {
        const value = input.monitoring[id]
        if (typeof value === "boolean" && value !== monitoring[id]) {
          monitoring[id] = value
          if (!value) snapshots.delete(id)
          changed = true
        }
      }
    }
    const nextOptions = normalizeOptions({
      warningPercent: clampNumber(input.warningPercent, options.warningPercent, 1, 99),
      criticalPercent: clampNumber(input.criticalPercent, options.criticalPercent, 1, 100),
      refreshMs: clampNumber(input.refreshMs, options.refreshMs, 30_000, 24 * 60 * 60 * 1000),
      maxSnapshotAgeMs: options.maxSnapshotAgeMs,
    })
    if (
      nextOptions.warningPercent !== options.warningPercent
      || nextOptions.criticalPercent !== options.criticalPercent
      || nextOptions.refreshMs !== options.refreshMs
    ) {
      options = nextOptions
      changed = true
    }
    if (changed) {
      await persistSettings()
      if (!enabled) {
        stopTimer()
        onUpdated?.(getStatus())
      } else {
        stopTimer()
        startTimer()
        await refresh()
      }
    }
    return getStatus()
  }

  async function refresh() {
    if (!enabled) return getStatus()
    if (refreshing) return refreshing
    refreshing = (async () => {
      const entries = Object.entries(fetchers).filter(([id]) => monitoring[id] !== false)
      const results = await Promise.allSettled(entries.map(([, fetch]) => fetch()))
      results.forEach((result, index) => {
        const id = entries[index][0]
        const snapshot = result.status === "fulfilled"
          ? result.value
          : { id, displayName: id, status: "error", statusText: "request failed", windows: [] }
        names.set(id, String(snapshot?.displayName ?? id))
        snapshots.set(id, publicSnapshot(snapshot))
      })
      lastRefreshAt = now()
      const status = getStatus()
      onRefreshed?.(status)
      onUpdated?.(status)
      return status
    })()
    try {
      return await refreshing
    } finally {
      refreshing = undefined
    }
  }

  function getStatus() {
    const providers = [...snapshots.values()].map((snapshot) => ({ ...snapshot, windows: snapshot.windows.map((window) => ({ ...window })) }))
    for (const id of Object.keys(monitoring)) {
      if (monitoring[id] !== false || snapshots.has(id)) continue
      providers.push({
        id,
        displayName: names.get(id) ?? id,
        status: "disabled",
        statusText: "monitoring disabled",
        windows: [],
      })
    }
    return {
      enabled,
      mode: enabled ? "warn" : "off",
      automaticActions: { interrupt: false, switchModel: false },
      thresholds: { warningPercent: options.warningPercent, criticalPercent: options.criticalPercent },
      monitoring: { ...monitoring },
      refreshMs: options.refreshMs,
      lastRefreshAt: lastRefreshAt || undefined,
      stale: !lastRefreshAt || now() - lastRefreshAt >= options.refreshMs,
      providers,
    }
  }

  async function checkSession(sessionID) {
    if (!sessionID || !enabled) return []
    const warnings = evaluateWarnings([...snapshots.values()], options, now())
    const seen = seenBySession.get(sessionID) ?? new Set()
    seenBySession.set(sessionID, seen)
    const delivered = []
    for (const warning of warnings) {
      if (seen.has(warning.key)) continue
      await ctx.session.synthetic({ sessionID, text: warning.text })
      seen.add(warning.key)
      delivered.push(warning)
    }
    return delivered
  }

  async function setup() {
    await loadSettings()

    await ctx.session.hook("prompt", async (event) => {
      if (!enabled) return
      if (!lastRefreshAt || now() - lastRefreshAt >= options.refreshMs) {
        void refresh().catch(() => {})
      }
      await checkSession(event.sessionID)
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "quota-status",
        description: "Показать квоты и режим Quota Guard (без смены модели)",
        execute: async ({ sessionID }) => {
          await refresh()
          await ctx.session.synthetic({
            sessionID,
            text: statusText([...snapshots.values()], options, lastRefreshAt, now(), enabled),
          })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "quota", description: "Read-only quota monitoring; warnings only" })
      editor.add({
        name: "status",
        description: "Return current provider quota data. Never interrupts a session or switches a model.",
        input: {
          type: "object",
          properties: { refresh: { type: "boolean", description: "Refresh provider data before returning" } },
          additionalProperties: false,
        },
        options: { namespace: "quota", codemode: true },
        execute: async (input) => {
          if (input?.refresh === true || !lastRefreshAt || now() - lastRefreshAt >= options.refreshMs) await refresh()
          return {
            content: JSON.stringify(getStatus()),
            summary: statusText([...snapshots.values()], options, lastRefreshAt, now(), enabled),
          }
        },
      })
    })

    if (enabled) {
      await refresh()
      startTimer()
    }
    return () => stopTimer()
  }

  return { setup, refresh, getStatus, checkSession, setOptions, isEnabled: () => enabled }
}
