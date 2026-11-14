import { Rpc } from "@opencode/plugin/rpc"

const quotaWindow = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    usedPercent: { type: "number" },
    resetAt: { type: "number" },
    limitReached: { type: "boolean" },
  },
  required: ["id", "label", "limitReached"],
  additionalProperties: false,
}

const providerCredits = {
  type: "object",
  properties: {
    hasCredits: { type: "boolean" },
    unlimited: { type: "boolean" },
    overageLimitReached: { type: "boolean" },
    balance: { type: "number" },
    approxLocalMessages: { type: "array", items: { type: "number" } },
    approxCloudMessages: { type: "array", items: { type: "number" } },
  },
  required: ["hasCredits", "unlimited", "overageLimitReached"],
  additionalProperties: false,
}

const provider = {
  type: "object",
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    status: { type: "string" },
    statusText: { type: "string" },
    plan: { type: "string" },
    credits: providerCredits,
    fetchedAt: { type: "number" },
    windows: { type: "array", items: quotaWindow },
  },
  required: ["id", "displayName", "status", "windows"],
  additionalProperties: false,
}

const tokenRate = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    messageID: { type: "string" },
    providerID: { type: "string" },
    providerName: { type: "string" },
    modelID: { type: "string" },
    modelName: { type: "string" },
    variant: { type: "string" },
    active: { type: "boolean" },
    sessionInputTokens: { type: "number" },
    sessionOutputTokens: { type: "number" },
    ratesCurrent: { type: "boolean" },
    startedAt: { type: "number" },
    firstTokenAt: { type: "number" },
    streamedAt: { type: "number" },
    completedAt: { type: "number" },
    updatedAt: { type: "number" },
    inputTokens: { type: "number" },
    outputTokens: { type: "number" },
    uncachedInputTokens: { type: "number" },
    cacheReadTokens: { type: "number" },
    cacheWriteTokens: { type: "number" },
    reasoningTokens: { type: "number" },
    inputPerSecond: { type: "number" },
    outputPerSecond: { type: "number" },
    firstTokenMs: { type: "number" },
    outputDurationMs: { type: "number" },
    finish: { type: "string" },
  },
  required: ["sessionID", "providerID", "providerName", "modelID", "modelName", "active", "ratesCurrent", "updatedAt"],
  additionalProperties: false,
}

const status = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    mode: { type: "string", enum: ["warn", "off"] },
    automaticActions: {
      type: "object",
      properties: {
        interrupt: { type: "boolean", enum: [false] },
        switchModel: { type: "boolean", enum: [false] },
      },
      required: ["interrupt", "switchModel"],
      additionalProperties: false,
    },
    thresholds: {
      type: "object",
      properties: {
        warningPercent: { type: "number" },
        criticalPercent: { type: "number" },
      },
      required: ["warningPercent", "criticalPercent"],
      additionalProperties: false,
    },
    lastRefreshAt: { type: "number" },
    stale: { type: "boolean" },
    monitoring: { type: "object", additionalProperties: { type: "boolean" } },
    refreshMs: { type: "number" },
    providers: { type: "array", items: provider },
    rates: { type: "array", items: tokenRate },
  },
  required: ["enabled", "mode", "automaticActions", "thresholds", "monitoring", "refreshMs", "stale", "providers"],
  additionalProperties: false,
}

const modelOption = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    providerTitle: { type: "string" },
    modelID: { type: "string" },
    title: { type: "string" },
  },
  required: ["providerID", "providerTitle", "modelID", "title"],
  additionalProperties: false,
}

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] }
const statsSecondKpi = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { anyOf: [{ type: "string", enum: ["amortization", "readPerUncached"] }, { type: "null" }] },
    value: nullableNumber,
    numerator: nullableNumber,
    denominator: nullableNumber,
  },
  required: ["kind", "value", "numerator", "denominator"],
}
const statsAssessmentComponent = {
  type: "object",
  additionalProperties: false,
  properties: {
    level: { type: "string", enum: ["gray", "green", "amber", "red"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["level", "reasons"],
}
const statsAssessment = {
  ...statsAssessmentComponent,
  properties: {
    ...statsAssessmentComponent.properties,
    components: {
      type: "object",
      additionalProperties: false,
      properties: { input: statsAssessmentComponent, cache: statsAssessmentComponent, reuse: statsAssessmentComponent },
      required: ["input", "cache", "reuse"],
    },
  },
  required: [...statsAssessmentComponent.required, "components"],
}
const statsEfficiency = {
  type: "object",
  properties: {
    uncachedInputTokens: nullableNumber,
    cacheReadTokens: nullableNumber,
    cacheWriteTokens: nullableNumber,
    outputTokens: nullableNumber,
    reasoningTokens: nullableNumber,
    readShare: nullableNumber,
    amortization: nullableNumber,
    secondKpi: statsSecondKpi,
  },
  required: ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "readShare", "amortization", "secondKpi"],
  additionalProperties: false,
}

const statsModel = {
  type: "object",
  properties: {
    id: { type: "string" },
    providerID: { type: "string" },
    modelID: { type: "string" },
    label: { type: "string" },
    steps: { type: "number" },
    inputTokens: { type: "number" },
    outputTokens: { type: "number" },
    cacheReadTokens: { type: "number" },
    cacheWriteTokens: { type: "number" },
    reasoningTokens: { type: "number" },
    cost: { type: "number" },
    costKind: { type: "string", enum: ["plan", "local", "value"] },
    efficiency: statsEfficiency,
  },
  required: ["id", "providerID", "modelID", "label", "steps", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost", "costKind", "efficiency"],
  additionalProperties: false,
}

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] }
const statsPeriod = {
  type: "object",
  properties: {
    available: { type: "boolean" },
    from: { type: "number" },
    to: { type: "number" },
    steps: { type: "number" },
    inputTokens: { type: "number" },
    outputTokens: { type: "number" },
    cacheReadTokens: { type: "number" },
    cacheWriteTokens: { type: "number" },
    reasoningTokens: { type: "number" },
    cost: { type: "number" },
    showCost: { type: "boolean" },
    efficiency: statsEfficiency,
    models: { type: "array", items: statsModel },
  },
  required: ["available", "from", "to", "steps", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost", "showCost", "efficiency", "models"],
  additionalProperties: false,
}
const statsDelta = {
  type: "object",
  properties: { absolute: nullableNumber, relative: nullableNumber },
  required: ["absolute", "relative"],
  additionalProperties: false,
}
const statsComparison = {
  type: "object",
  properties: {
    id: { type: "string" },
    providerID: { type: "string" },
    modelID: { type: "string" },
    label: { type: "string" },
    costKind: { type: "string", enum: ["plan", "local", "value"] },
    current: statsModel,
    baseline: statsModel,
    assessment: statsAssessment,
    deltas: {
      type: "object",
      properties: {
        ...Object.fromEntries(["steps", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost"].map((key) => [key, statsDelta])),
        readShare: statsDelta,
        amortization: statsDelta,
        secondKpi: statsDelta,
      },
      required: ["steps", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost", "readShare", "amortization", "secondKpi"],
      additionalProperties: false,
    },
  },
  required: ["id", "providerID", "modelID", "label", "costKind", "current", "baseline", "deltas", "assessment"],
  additionalProperties: false,
}
const statsOutput = {
  type: "object",
  properties: {
    ...statsPeriod.properties,
    period: { type: "string", enum: ["day", "week"] },
    baseline: statsPeriod,
    deltas: {
      type: "object",
      properties: { secondKpi: statsDelta },
      required: ["secondKpi"],
      additionalProperties: false,
    },
    modelComparisons: { type: "array", items: statsComparison },
  },
  required: [...statsPeriod.required, "period", "baseline", "deltas", "modelComparisons"],
  additionalProperties: false,
}
const aggregateProperties = {
  steps: { type: "number" },
  coldSteps: { type: "number" },
  inputTokens: { type: "number" },
  outputTokens: { type: "number" },
  cacheReadTokens: { type: "number" },
  cacheWriteTokens: { type: "number" },
  reasoningTokens: { type: "number" },
}
const aggregateRequired = Object.keys(aggregateProperties)
const diagnosticsModel = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    modelID: { type: "string" },
    variant: nullableString,
    ...aggregateProperties,
  },
  required: ["providerID", "modelID", "variant", ...aggregateRequired],
  additionalProperties: false,
}
const diagnosticsSession = {
  type: "object",
  properties: { id: { type: "string" }, ...aggregateProperties, models: { type: "array", items: diagnosticsModel } },
  required: ["id", ...aggregateRequired, "models"],
  additionalProperties: false,
}
const diagnosticsRoot = {
  type: "object",
  properties: {
    ...diagnosticsSession.properties,
    subagents: { type: "array", items: diagnosticsSession },
  },
  required: [...diagnosticsSession.required, "subagents"],
  additionalProperties: false,
}
const diagnosticsProject = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    ...aggregateProperties,
    roots: { type: "array", items: diagnosticsRoot },
  },
  required: ["id", "label", ...aggregateRequired, "roots"],
  additionalProperties: false,
}
const tokenCompleteness = { anyOf: [
  { type: "null" },
  { type: "object", additionalProperties: false, properties: {
    input: { type: "boolean" }, output: { type: "boolean" }, reasoning: { type: "boolean" },
    cacheRead: { type: "boolean" }, cacheWrite: { type: "boolean" },
  }, required: ["input", "output", "reasoning", "cacheRead", "cacheWrite"] },
] }
const diagnosticsColdStep = {
  type: "object",
  properties: {
    id: { type: "string" },
    at: { type: "number" },
    sessionID: { type: "string" },
    parentID: nullableString,
    rootID: { type: "string" },
    projectID: { type: "string" },
    projectLabel: { type: "string" },
    providerID: { type: "string" },
    modelID: { type: "string" },
    variant: nullableString,
    inputTokens: { type: "number" },
    ordinaryInputTokens: { type: "number" },
    cacheReadTokens: { type: "number" },
    cacheWriteTokens: { type: "number" },
    outputTokens: { type: "number" },
    reasoningTokens: { type: "number" },
    startedAt: nullableNumber,
    finish: nullableString,
    tokenCompleteness,
    cacheReadPercent: nullableNumber,
    pauseMs: nullableNumber,
    noCache: { type: "boolean" },
  },
  required: ["id", "at", "sessionID", "parentID", "rootID", "projectID", "projectLabel", "providerID", "modelID", "variant", "inputTokens", "ordinaryInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "startedAt", "finish", "tokenCompleteness", "cacheReadPercent", "pauseMs", "noCache"],
  additionalProperties: false,
}
const diagnosticsTimeline = {
  type: "object",
  properties: {
    id: { type: "string" },
    at: { type: "number" },
    kind: { type: "string", enum: ["cold", "compaction", "model", "plugin.setup", "process.started", "quota"] },
    label: { type: "string" },
    projectID: nullableString,
    sessionID: nullableString,
    providerID: nullableString,
  },
  required: ["id", "at", "kind", "label", "projectID", "sessionID", "providerID"],
  additionalProperties: false,
}
const diagnosticsOutput = {
  type: "object",
  properties: {
    available: { type: "boolean" },
    period: { type: "string", enum: ["day", "week"] },
    from: { type: "number" },
    to: { type: "number" },
    retentionDays: { type: "number", enum: [7] },
    coldRule: {
      type: "object",
      properties: { minInputTokens: { type: "number" }, maxCacheReadPercent: { type: "number" } },
      required: ["minInputTokens", "maxCacheReadPercent"],
      additionalProperties: false,
    },
    coldSteps: { type: "array", items: diagnosticsColdStep },
    steps: { type: "array", items: diagnosticsColdStep },
    projects: { type: "array", items: diagnosticsProject },
    timeline: { type: "array", items: diagnosticsTimeline },
  },
  required: ["available", "period", "from", "to", "retentionDays", "coldRule", "coldSteps", "steps", "projects", "timeline"],
  additionalProperties: false,
}

export const QuotaGuardRpc = Rpc.define({
  id: "quota-guard",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        additionalProperties: false,
      },
      output: status,
    },
    configure: {
      input: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          warningPercent: { type: "number" },
          criticalPercent: { type: "number" },
          refreshMs: { type: "number" },
          monitoring: { type: "object", additionalProperties: { type: "boolean" } },
        },
        additionalProperties: false,
      },
      output: status,
    },
    models: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          current: {
            type: "object",
            properties: {
              providerID: { type: "string" },
              modelID: { type: "string" },
            },
            required: ["providerID", "modelID"],
            additionalProperties: false,
          },
          options: { type: "array", items: modelOption },
        },
        required: ["options"],
        additionalProperties: false,
      },
      errors: {
        session_not_found: {
          type: "object",
          properties: { sessionID: { type: "string" } },
          required: ["sessionID"],
          additionalProperties: false,
        },
      },
    },
    stats: {
      input: {
        type: "object",
        properties: { period: { type: "string", enum: ["day", "week"] } },
        additionalProperties: false,
      },
      output: statsOutput,
    },
    diagnostics: {
      input: {
        type: "object",
        properties: { period: { type: "string", enum: ["day", "week"] } },
        additionalProperties: false,
      },
      output: diagnosticsOutput,
    },
    switchModel: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
        },
        required: ["sessionID", "providerID", "modelID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          switched: { type: "boolean", enum: [true] },
          providerID: { type: "string" },
          modelID: { type: "string" },
        },
        required: ["switched", "providerID", "modelID"],
        additionalProperties: false,
      },
      errors: {
        session_not_found: {
          type: "object",
          properties: { sessionID: { type: "string" } },
          required: ["sessionID"],
          additionalProperties: false,
        },
        switch_failed: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { status },
        required: ["status"],
        additionalProperties: false,
      },
    },
  },
})
