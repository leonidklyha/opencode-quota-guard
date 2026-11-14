import { Plugin } from "@opencode/plugin"
import { createQuotaGuard } from "./core.js"
import { createTokenMeter } from "./meter.js"
import { createDiagnostics } from "./diagnostics.js"
import { createKimiFetcher, createKimiAproboFetcher, createOpenAIFetcher } from "./providers.js"
import { registerQuotaRpc } from "./rpc-server.js"

export default Plugin.define({
  id: "quota-guard",
  async setup(ctx) {
    let emitUpdated
    const diagnostics = createDiagnostics({ ctx })
    const meter = createTokenMeter({
      ctx,
      onUpdated: () => emitUpdated?.(statusWithRates()),
    })
    const guard = createQuotaGuard({
      ctx,
      options: ctx.options,
      onUpdated: (status) => emitUpdated?.(statusWithRates(status)),
      onRefreshed: (status) => diagnostics.recordQuota(status),
      fetchers: {
        ...(ctx.options.providers?.openai === false ? {} : { openai: createOpenAIFetcher(ctx) }),
        ...(ctx.options.providers?.kimi === false ? {} : { kimi: createKimiFetcher(ctx) }),
        ...(ctx.options.providers?.["kimi-aprobo"] === false ? {} : { "kimi-aprobo": createKimiAproboFetcher(ctx) }),
      },
    })
    function statusWithRates(status = guard.getStatus()) {
      return { ...status, rates: meter.getRates() }
    }
    const cleanupMeter = await meter.setup()
    let cleanupGuard
    let cleanupDiagnostics = async () => {}
    try {
      try { cleanupDiagnostics = await diagnostics.setup() } catch {}
      cleanupGuard = await guard.setup()
      const registration = await registerQuotaRpc(ctx, guard, meter, undefined, diagnostics)
      emitUpdated = (status) => {
        void registration.events.emit("updated", { status: JSON.parse(JSON.stringify(status)) }).catch(() => {})
      }
      return async () => {
        try {
          await registration.dispose()
        } finally {
          cleanupGuard()
          cleanupMeter()
          try { await cleanupDiagnostics() } catch {}
        }
      }
    } catch (error) {
      cleanupGuard?.()
      cleanupMeter()
      try { await cleanupDiagnostics() } catch {}
      throw error
    }
  },
})
