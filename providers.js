const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function epochMs(value) {
  const number = numberValue(value)
  if (number === undefined || number <= 0) return undefined
  return number < 1_000_000_000_000 ? number * 1000 : number
}

function statusSnapshot(id, displayName, status, statusText) {
  return { id, displayName, status, statusText, windows: [] }
}

async function activeCredential(ctx, integrationIDs) {
  for (const integrationID of integrationIDs) {
    try {
      const connection = await ctx.integration.connection.active(integrationID)
      if (!connection) continue
      const value = await ctx.integration.connection.resolve(connection)
      if (value) return { integrationID, value }
    } catch {
      return { error: true }
    }
  }
  return {}
}

async function requestJson(url, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) return { error: response.status === 401 || response.status === 403 ? "forbidden" : `api ${response.status}` }
    return { value: await response.json() }
  } catch (error) {
    return { error: controller.signal.aborted ? "timeout" : "network error" }
  } finally {
    clearTimeout(timer)
  }
}

function labelForSeconds(seconds) {
  if (!finitePositive(seconds)) return "rolling"
  if (seconds % 604800 === 0) return seconds === 604800 ? "week" : `${seconds / 604800}w`
  if (seconds % 86400 === 0) return seconds === 86400 ? "day" : `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function numeric(value) {
  if (typeof value === "number") return numberValue(value)
  if (typeof value !== "string" || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function messageRange(value) {
  if (!Array.isArray(value)) return undefined
  const numbers = value.map(numberValue).filter((item) => item !== undefined)
  return numbers.length > 0 ? numbers : undefined
}

// Кредиты плана ChatGPT: баланс и ориентировочное число сообщений.
function parseOpenAICredits(root) {
  const credits = record(root.credits)
  if (!credits) return undefined
  return {
    hasCredits: credits.has_credits === true,
    unlimited: credits.unlimited === true,
    overageLimitReached: credits.overage_limit_reached === true,
    balance: numeric(credits.balance),
    approxLocalMessages: messageRange(credits.approx_local_messages),
    approxCloudMessages: messageRange(credits.approx_cloud_messages),
  }
}

export function parseOpenAIUsage(raw, now = Date.now()) {
  const root = record(raw) ?? {}
  const rateLimit = record(root.rate_limit) ?? {}
  const windows = []
  for (const [key, id] of [["primary_window", "openai-primary"], ["secondary_window", "openai-secondary"]]) {
    const source = record(rateLimit[key])
    const usedPercent = numberValue(source?.used_percent)
    if (!source || usedPercent === undefined) continue
    const seconds = numberValue(source.limit_window_seconds)
    const resetAfterSeconds = numberValue(source.reset_after_seconds)
    windows.push({
      id,
      label: key === "secondary_window" ? "week" : labelForSeconds(seconds),
      usedPercent,
      resetAt: epochMs(source.reset_at) ?? (resetAfterSeconds === undefined ? undefined : now + resetAfterSeconds * 1000),
      limitReached: rateLimit.limit_reached === true && key === "primary_window",
    })
  }
  return {
    id: "openai",
    displayName: "ChatGPT",
    status: windows.length > 0 ? "ready" : "partial",
    statusText: windows.length > 0 ? undefined : "usage windows unavailable",
    plan: stringValue(root.plan_type),
    credits: parseOpenAICredits(root),
    fetchedAt: now,
    windows,
  }
}

export function createOpenAIFetcher(ctx, timeoutMs = 15_000) {
  return async () => {
    const credential = await activeCredential(ctx, ["openai"])
    if (credential.error) return statusSnapshot("openai", "ChatGPT", "error", "credential source unavailable")
    const value = credential.value
    if (!value || value.type !== "oauth") return statusSnapshot("openai", "ChatGPT", "missing-auth", "OAuth credential missing")
    const access = stringValue(value.access)
    const expires = numberValue(value.expires)
    const metadata = record(value.metadata)
    const accountId = stringValue(metadata?.accountID) ?? stringValue(metadata?.accountId)
    if (!access) return statusSnapshot("openai", "ChatGPT", "missing-auth", "OAuth access token missing")
    if (!expires || expires <= Date.now()) return statusSnapshot("openai", "ChatGPT", "missing-auth", "OAuth expired")
    if (!accountId) return statusSnapshot("openai", "ChatGPT", "missing-auth", "OAuth account ID missing")
    const result = await requestJson(OPENAI_USAGE_URL, {
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    }, timeoutMs)
    if (result.error) return statusSnapshot("openai", "ChatGPT", result.error === "forbidden" ? "forbidden" : "error", result.error)
    return parseOpenAIUsage(result.value)
  }
}

const KIMI_DEFAULT_BASE_URL = "https://api.kimi.ai/coding/v1"
const KIMI_USAGE_PATH = "/usages"
const KIMI_ME_PATH = "/me"
// Принимаются две формы ответа: локальный сервер Kimi Code (data.quota.usages,
// camelCase) и прямой upstream (корневой usages, snake_case).
const KIMI_WINDOWS = [
  [["limit5h", "limit_5h"], "kimi-5h", "5 ч"],
  [["limit7d", "limit_7d"], "kimi-7d", "7 дн"],
  [["monthTotal", "limit_month_total"], "kimi-month-total", "Месяц (всего)"],
  [["monthCode", "limit_month_code"], "kimi-month-code", "Месяц (код)"],
]

function rfc3339Ms(value) {
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function firstRecord(source, keys) {
  for (const key of keys) {
    const value = record(source[key])
    if (value) return value
  }
  return undefined
}

function kimiRatio(source) {
  return numberValue(source.usedRatio) ?? numberValue(source.used_ratio)
}

function kimiReset(source) {
  return rfc3339Ms(source.resetAt) ?? rfc3339Ms(source.reset_time)
}

function durationLabel(duration, timeUnit) {
  const value = numberValue(duration)
  if (!value || value <= 0) return undefined
  const unit = stringValue(timeUnit) ?? ""
  if (unit.endsWith("MINUTE")) return value % 60 === 0 ? `${value / 60} ч` : `${value} мин`
  if (unit.endsWith("HOUR")) return value % 24 === 0 ? `${value / 24} дн` : `${value} ч`
  if (unit.endsWith("DAY")) return `${value} дн`
  return undefined
}

// Запасной источник: абсолютные лимиты, когда относительные окна не возвращены.
function parseKimiLimits(limits) {
  const source = Array.isArray(limits) ? limits : []
  const windows = []
  for (const entry of source) {
    const item = record(entry)
    const detail = record(item?.detail)
    if (!detail) continue
    const limit = numeric(detail.limit)
    const used = numeric(detail.used)
    if (limit === undefined || limit <= 0 || used === undefined) continue
    const scope = record(item.window)
    const usedPercent = used / limit * 100
    windows.push({
      id: `kimi-limit-${windows.length + 1}`,
      label: durationLabel(scope?.duration, scope?.timeUnit) ?? "лимит",
      usedPercent,
      resetAt: rfc3339Ms(detail.resetTime),
      limitReached: usedPercent >= 100,
    })
  }
  return windows
}

export function parseKimiUsage(raw, now = Date.now()) {
  const root = record(raw) ?? {}
  const data = record(root.data)
  if (data?.kind === "error") {
    return {
      id: "kimi",
      displayName: "Kimi Code",
      status: "error",
      statusText: stringValue(data.message)?.slice(0, 160) ?? "usage request failed",
      windows: [],
    }
  }
  const usageRoot = record(data?.quota) ?? data ?? root
  const usages = record(usageRoot?.usages) ?? record(root.usages) ?? {}
  const windows = []
  for (const [keys, id, label] of KIMI_WINDOWS) {
    const source = firstRecord(usages, keys)
    if (!source) continue
    const ratio = kimiRatio(source)
    if (ratio === undefined) continue
    windows.push({
      id,
      label,
      usedPercent: ratio * 100,
      resetAt: kimiReset(source),
      limitReached: ratio >= 1,
    })
  }
  const resolved = windows.length > 0 ? windows : parseKimiLimits(usageRoot?.limits ?? root.limits)
  return {
    id: "kimi",
    displayName: "Kimi Code",
    status: resolved.length > 0 ? "ready" : "partial",
    statusText: resolved.length > 0 ? undefined : "usage windows unavailable",
    fetchedAt: now,
    windows: resolved,
  }
}

// План подписки Kimi Code: GET /me возвращает user_level_name (например "Ultra").
export function parseKimiProfile(raw) {
  const root = record(raw) ?? {}
  return stringValue(root.user_level_name) ?? stringValue(record(root.data)?.user_level_name)
}

async function resolveKimiCredential(ctx, integrationIDs, environmentName) {
  const credential = await activeCredential(ctx, integrationIDs)
  const stored = credential.value?.type === "key" ? stringValue(credential.value.key) : undefined
  if (stored) return { key: stored }
  const environment = stringValue(process.env[environmentName])
  if (environment) return { key: environment }
  if (credential.error) return { error: true }
  return {}
}

function createKimiAccountFetcher(ctx, timeoutMs, account) {
  return async () => {
    const credential = await resolveKimiCredential(ctx, account.integrationIDs, account.environmentName)
    if (credential.error) return statusSnapshot(account.id, account.displayName, "error", "credential source unavailable")
    if (!credential.key) return statusSnapshot(account.id, account.displayName, "missing-auth", account.missingText)
    const baseUrl = stringValue(process.env[account.baseUrlEnvironment])?.replace(/\/+$/, "") ?? account.baseUrl
    const result = await requestJson(`${baseUrl}${KIMI_USAGE_PATH}`, {
      Authorization: `Bearer ${credential.key}`,
      Accept: "application/json",
    }, timeoutMs)
    if (result.error) return statusSnapshot(account.id, account.displayName, result.error === "forbidden" ? "forbidden" : "error", result.error)
    const snapshot = parseKimiUsage(result.value)
    const profile = await requestJson(`${baseUrl}${KIMI_ME_PATH}`, {
      Authorization: `Bearer ${credential.key}`,
      Accept: "application/json",
    }, timeoutMs)
    const plan = parseKimiProfile(profile.value)
    if (plan) snapshot.plan = plan
    return { ...snapshot, id: account.id, displayName: account.displayName }
  }
}

export function createKimiFetcher(ctx, timeoutMs = 15_000) {
  return createKimiAccountFetcher(ctx, timeoutMs, {
    id: "kimi",
    displayName: "Kimi Ultra",
    integrationIDs: ["kimi-code-plan-global", "kimi-code", "kimi"],
    environmentName: "KIMI_API_KEY",
    baseUrlEnvironment: "KIMI_CODE_BASE_URL",
    baseUrl: KIMI_DEFAULT_BASE_URL,
    missingText: "Kimi Code credential missing",
  })
}

export function createKimiAproboFetcher(ctx, timeoutMs = 15_000) {
  return createKimiAccountFetcher(ctx, timeoutMs, {
    id: "kimi-aprobo",
    displayName: "Kimi Ultra Aprobo",
    integrationIDs: ["kimi-aprobo"],
    environmentName: "KIMI_APROBO_API_KEY",
    baseUrlEnvironment: "KIMI_APROBO_BASE_URL",
    baseUrl: KIMI_DEFAULT_BASE_URL,
    missingText: "Kimi Aprobo credential missing",
  })
}
