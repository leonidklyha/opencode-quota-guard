import { QuotaGuardRpc } from "./rpc.js"
import { readUsageStats, statsRange } from "./stats.js"

function jsonStatus(value) {
  return JSON.parse(JSON.stringify(value))
}

function emptyDiagnostics(period) {
  const range = statsRange(period)
  return {
    available: false,
    period,
    ...range,
    retentionDays: 7,
    coldRule: { minInputTokens: 100_000, maxCacheReadPercent: 20 },
    coldSteps: [],
    steps: [],
    projects: [],
    timeline: [],
  }
}

async function listModelOptions(ctx, sessionID) {
  let current
  try {
    const session = await ctx.session.get({ sessionID })
    const model = session?.model
    if (model && typeof model.providerID === "string" && typeof model.id === "string") {
      current = { providerID: model.providerID, modelID: model.id }
    }
  } catch {}
  const names = new Map()
  try {
    const providers = (await ctx.provider.list())?.data ?? []
    for (const info of providers) {
      if (info && typeof info.id === "string") names.set(info.id, String(info.name ?? info.id))
    }
  } catch {}
  const options = []
  try {
    const models = (await ctx.model.list())?.data ?? []
    for (const model of models) {
      if (!model || typeof model.providerID !== "string" || typeof model.modelID !== "string") continue
      options.push({
        providerID: model.providerID,
        providerTitle: names.get(model.providerID) ?? model.providerID,
        modelID: model.modelID,
        title: String(model.name ?? model.modelID),
      })
      if (options.length >= 200) break
    }
  } catch {}
  return { current, options }
}

export function registerQuotaRpc(ctx, guard, meter, statsReader = readUsageStats, diagnostics) {
  function withRates(status) {
    return jsonStatus(meter ? { ...status, rates: meter.getRates() } : status)
  }
  return ctx.rpc.register(QuotaGuardRpc, {
    status: async (input) => {
      const status = input?.refresh === true ? await guard.refresh() : guard.getStatus()
      return withRates(status)
    },
    configure: async (input) => withRates(await guard.setOptions(input ?? {})),
    models: async (input, context) => {
      try {
        await ctx.session.get({ sessionID: input.sessionID })
      } catch {
        return context.error("session_not_found", "Session not found", { sessionID: input.sessionID })
      }
      return jsonStatus(await listModelOptions(ctx, input.sessionID))
    },
    stats: async (input) => jsonStatus(await statsReader(ctx, input?.period === "week" ? "week" : "day")),
    diagnostics: async (input) => {
      const period = input?.period === "week" ? "week" : "day"
      try {
        return jsonStatus(diagnostics ? await diagnostics.read(period) : emptyDiagnostics(period))
      } catch {
        return emptyDiagnostics(period)
      }
    },
    // Переключение модели выполняется ТОЛЬКО по явному вызову этого метода
    // (кнопка в панели Desktop). Автоматически guard его не вызывает.
    switchModel: async (input, context) => {
      try {
        await ctx.session.switchModel({
          sessionID: input.sessionID,
          model: { id: input.modelID, providerID: input.providerID },
        })
      } catch (error) {
        return context.error("switch_failed", "Model switch failed", { message: String(error?.message ?? error).slice(0, 160) })
      }
      return { switched: true, providerID: input.providerID, modelID: input.modelID }
    },
  })
}
