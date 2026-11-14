import { Command, MenuItem, Panel, Plugin, SettingsPage, TitlebarItem } from "@opencode/plugin/gui"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { QuotaGuardRpc } from "../rpc.js"

const dateTime = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" })
const resetDateTime = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
const percent = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 })

function rateText(value?: number) {
  return tokenText(value)
}

function durationText(value?: number) {
  return typeof value === "number" ? `${percent.format(value / 1000)} с` : "—"
}

function pauseText(value?: number | null) {
  if (typeof value !== "number") return "—"
  if (value >= 60 * 60 * 1000) return `${percent.format(value / (60 * 60 * 1000))} ч`
  if (value >= 60 * 1000) return `${percent.format(value / (60 * 1000))} мин`
  return `${percent.format(value / 1000)} с`
}

function tokenText(value?: number | null) {
  if (typeof value !== "number") return "—"
  const absolute = Math.abs(value)
  if (absolute >= 1e9) return `${percent.format(value / 1e9)}B`
  if (absolute >= 1e6) return `${percent.format(value / 1e6)}M`
  if (absolute >= 1e3) return `${percent.format(value / 1e3)}k`
  return integer.format(value)
}

function exactTokenText(value?: number | null) {
  return typeof value === "number" ? integer.format(value) : "нет данных"
}

function shareText(part: number, total: number) {
  return total > 0 ? `${percent.format(part / total * 100)}%` : "—"
}

function moneyText(value?: number) {
  if (typeof value !== "number") return "—"
  if (value === 0) return "$0"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function statsModelCost(model: any) {
  if (model.costKind === "plan") return "по плану"
  if (model.costKind === "local") return "локально"
  return moneyText(model.cost)
}

function finiteNumber(value: any): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function knownSum(...values: any[]) {
  return values.every(finiteNumber) ? values.reduce((sum, value) => sum + value, 0) : null
}

function efficiencyInput(efficiency: any) {
  return knownSum(efficiency?.uncachedInputTokens, efficiency?.cacheReadTokens, efficiency?.cacheWriteTokens)
}

function efficiencyReadShare(efficiency: any) {
  const input = efficiencyInput(efficiency)
  return input !== null && input > 0 && finiteNumber(efficiency?.cacheReadTokens) ? efficiency.cacheReadTokens / input : null
}

function efficiencyAmortization(efficiency: any) {
  const read = efficiency?.cacheReadTokens
  const write = efficiency?.cacheWriteTokens
  return finiteNumber(read) && finiteNumber(write) && write > 0 ? read / write : null
}

function efficiencySecondKpi(efficiency: any) {
  if (efficiency && "secondKpi" in efficiency) {
    const kpi = efficiency.secondKpi
    return kpi && (kpi.kind === "amortization" || kpi.kind === "readPerUncached") ? kpi : null
  }
  const legacy = efficiencyAmortization(efficiency)
  return legacy === null ? null : {
    kind: "amortization",
    value: legacy,
    numerator: efficiency.cacheReadTokens,
    denominator: efficiency.cacheWriteTokens,
  }
}

function secondKpiLabel(kind: any, short = false) {
  if (kind === "amortization") return short ? "чтение/запись" : "Чтение на запись кэша"
  if (kind === "readPerUncached") return short ? "переиспользование" : "Переиспользование входа"
  return short ? "кратность" : "Кратность кэша"
}

function readShareValueText(value: any) {
  return finiteNumber(value) ? `${percent.format(value * 100)}%` : "—"
}

function secondKpiValueText(kpi: any) {
  return finiteNumber(kpi?.value) ? `${percent.format(kpi.value)}×` : "—"
}

function baselineComparable(baseline: any) {
  return baseline?.available === true && finiteNumber(baseline.steps) && baseline.steps > 0
}

function relativeDeltaText(value: any) {
  if (!finiteNumber(value)) return "—"
  const sign = value > 0 ? "+" : value < 0 ? "−" : ""
  return `${sign}${percent.format(Math.abs(value) * 100)}%`
}

function pointDeltaText(value: any) {
  if (!finiteNumber(value)) return "—"
  const sign = value > 0 ? "+" : value < 0 ? "−" : ""
  return `${sign}${percent.format(Math.abs(value))} п.п.`
}

function signedTokenText(value: any) {
  if (!finiteNumber(value)) return "—"
  const sign = value > 0 ? "+" : value < 0 ? "−" : ""
  return `${sign}${tokenText(Math.abs(value))}`
}

function signedStepsText(value: any) {
  if (!finiteNumber(value)) return "—"
  const sign = value > 0 ? "+" : value < 0 ? "−" : ""
  return `${sign}${integer.format(Math.abs(value))}`
}

function numericDelta(current: any, baseline: any) {
  if (!finiteNumber(current) || !finiteNumber(baseline)) return { absolute: null, relative: null }
  return { absolute: current - baseline, relative: baseline === 0 ? null : (current - baseline) / baseline }
}

function tokenDeltaText(delta: any) {
  if (!finiteNumber(delta?.absolute)) return "—"
  const relative = relativeDeltaText(delta.relative)
  return `${signedTokenText(delta.absolute)}${relative === "—" ? "" : ` (${relative})`}`
}

function stepsDeltaText(delta: any) {
  if (!finiteNumber(delta?.absolute)) return "—"
  const relative = relativeDeltaText(delta.relative)
  return `${signedStepsText(delta.absolute)}${relative === "—" ? "" : ` (${relative})`}`
}

const ASSESSMENT_COLORS: Record<string, string> = {
  gray: "#8a939c",
  green: "#42a36b",
  amber: "#d99a28",
  red: "#d95555",
}

const ASSESSMENT_REASON_RU: Record<string, string> = {
  "no-baseline": "Нет базы",
  "insufficient-data": "Недостаточно данных",
  "token-growth": "Рост входа",
  "cache-drop": "Доля кэша ниже базы",
  "reuse-drop": "Переиспользование ниже базы",
  "severe-token-growth": "Резкий рост входа",
}

function assessmentLabel(assessment: any) {
  if (assessment?.level === "green") return "Без материальных отклонений"
  if (assessment?.level === "amber") return "Материальное отклонение"
  if (assessment?.level === "red") return "Резкий рост входа"
  return assessment?.reasons?.includes?.("no-baseline") ? "Нет сравнения" : "Нет данных"
}

function knownAssessmentLevel(assessment: any) {
  return ["gray", "green", "amber", "red"].includes(assessment?.level) ? assessment.level : "gray"
}

function assessmentSurfaceStyle(level: string) {
  const color = ASSESSMENT_COLORS[level] ?? ASSESSMENT_COLORS.gray
  return {
    border: `1px solid color-mix(in srgb, ${color} 48%, transparent)`,
    "border-left": `3px solid ${color}`,
    "border-radius": "6px",
    background: `color-mix(in srgb, ${color} 11%, transparent)`,
  }
}

function assessmentPillStyle(level: string, compact = false) {
  const color = ASSESSMENT_COLORS[level] ?? ASSESSMENT_COLORS.gray
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "4px",
    padding: compact ? "2px 5px" : "3px 7px",
    border: `1px solid color-mix(in srgb, ${color} 48%, transparent)`,
    "border-radius": "999px",
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    color: "currentColor",
    "font-size": compact ? "10px" : "11px",
    "font-weight": "600",
    "line-height": "1.25",
    "white-space": "normal",
  }
}

function TrafficBadge(props: { level: string; text: string; compact?: boolean; testId?: string }) {
  const level = () => ASSESSMENT_COLORS[props.level] ? props.level : "gray"
  return <span data-testid={props.testId} data-level={level()} style={assessmentPillStyle(level(), props.compact)}>
    <span aria-hidden="true" style={{ color: ASSESSMENT_COLORS[level()] }}>●</span><span>{props.text}</span>
  </span>
}

function AssessmentBadge(props: { assessment: any; compact?: boolean }) {
  const level = () => knownAssessmentLevel(props.assessment)
  return <TrafficBadge testId="quota-guard-efficiency-assessment" level={level()} text={assessmentLabel(props.assessment)} compact={props.compact} />
}

function modelComponentAssessment(comparison: any, component: "input" | "cache" | "reuse") {
  const assessment = comparison?.assessment
  const direct = assessment?.components?.[component]
  if (["gray", "green", "amber", "red"].includes(direct?.level)) return direct
  if (knownAssessmentLevel(assessment) === "gray") return { level: "gray", reasons: assessment?.reasons ?? ["insufficient-data"] }
  if (component === "input") {
    const reasons = (assessment?.reasons ?? []).filter((reason: string) => reason === "token-growth" || reason === "severe-token-growth")
    return { level: reasons.includes("severe-token-growth") ? "red" : reasons.includes("token-growth") ? "amber" : "green", reasons }
  }
  const reason = component === "cache" ? "cache-drop" : "reuse-drop"
  const reasons = (assessment?.reasons ?? []).filter((item: string) => item === reason)
  return { level: reasons.length ? "amber" : "green", reasons }
}

function worstAvailableAssessment(assessments: any[]) {
  for (const level of ["red", "amber", "green"]) {
    const found = assessments.find((assessment) => assessment?.level === level)
    if (found) return found
  }
  return assessments.find((assessment) => knownAssessmentLevel(assessment) === "gray") ?? { level: "gray", reasons: ["insufficient-data"] }
}

function aggregateModelComponent(comparisons: any[], component: "input" | "cache" | "reuse") {
  return worstAvailableAssessment((comparisons ?? []).map((comparison) => modelComponentAssessment(comparison, component)))
}

function inputAssessmentText(assessment: any) {
  const level = knownAssessmentLevel(assessment)
  if (level === "red") return "Резкий рост входа"
  if (level === "amber") return "Рост входа"
  if (level === "green") return "Вход в норме"
  return assessment?.reasons?.includes?.("no-baseline") ? "Нет базы для сравнения" : "Недостаточно данных"
}

function outputVolumeAssessment(current: any, baseline: any) {
  if (!baselineComparable(baseline)) return { level: "gray", reasons: ["no-baseline"] }
  const currentOutput = current?.outputTokens
  const baselineOutput = baseline?.efficiency?.outputTokens
  if (!finiteNumber(currentOutput) || !finiteNumber(baselineOutput) || baselineOutput <= 0) return { level: "gray", reasons: ["insufficient-data"] }
  const delta = currentOutput - baselineOutput
  const relative = delta / baselineOutput
  if (delta >= 100_000 && relative >= 10) return { level: "red", reasons: [] }
  if (delta >= 50_000 && relative >= 0.5) return { level: "amber", reasons: [] }
  return { level: "green", reasons: [] }
}

function outputVolumeText(assessment: any) {
  const level = knownAssessmentLevel(assessment)
  if (level === "red") return "Резкий рост выхода"
  if (level === "amber") return "Рост выхода"
  if (level === "green") return "Без материального роста объёма"
  return assessment?.reasons?.includes?.("no-baseline") ? "Нет базы для сравнения" : "Недостаточно данных"
}

function assessmentStatusText(assessment: any) {
  const level = knownAssessmentLevel(assessment)
  if (level === "green") return "Норма"
  if (level === "amber") return "Отклонение"
  if (level === "red") return "Резкое отклонение"
  return assessment?.reasons?.includes?.("no-baseline") ? "Нет базы для сравнения" : "Недостаточно данных"
}

function worstModelAssessment(comparisons: any[]) {
  const assessments = (comparisons ?? []).map((comparison) => comparison.assessment).filter((assessment) => ["gray", "green", "amber", "red"].includes(assessment?.level))
  for (const level of ["red", "amber", "green"]) {
    const found = assessments.find((assessment) => assessment.level === level)
    if (found) return found
  }
  return assessments[0] ?? { level: "gray", reasons: ["insufficient-data"] }
}

function modelComparisonAvailable(comparison: any, baseline: any) {
  if (!baselineComparable(baseline)) return false
  if (comparison.assessment) return comparison.assessment.level !== "gray" && !comparison.assessment.reasons?.includes?.("no-baseline") && !comparison.assessment.reasons?.includes?.("insufficient-data")
  return finiteNumber(comparison.baseline?.steps) && comparison.baseline.steps > 0
}

function modelUsageDeltaText(comparison: any) {
  const parts = []
  if (finiteNumber(comparison.deltas?.steps?.absolute)) parts.push(`шаги ${stepsDeltaText(comparison.deltas.steps)}`)
  if (finiteNumber(comparison.deltas?.inputTokens?.absolute)) parts.push(`вход ${tokenDeltaText(comparison.deltas.inputTokens)}`)
  if (finiteNumber(comparison.deltas?.outputTokens?.absolute)) parts.push(`выход ${tokenDeltaText(comparison.deltas.outputTokens)}`)
  return parts.length ? parts.join(" · ") : null
}

function modelCacheDeltaText(comparison: any) {
  const parts = []
  if (finiteNumber(comparison.deltas?.readShare?.absolute)) parts.push(`кэш ${pointDeltaText(comparison.deltas.readShare.absolute * 100)}`)
  const secondDelta = comparison.deltas?.secondKpi
  if (finiteNumber(secondDelta?.relative)) {
    const kind = efficiencySecondKpi(comparison.current?.efficiency)?.kind
    parts.push(`${secondKpiLabel(kind, true)} ${relativeDeltaText(secondDelta.relative)}`)
  }
  return parts.length ? `К базе: ${parts.join(" · ")}` : null
}

function assessmentReasonsText(assessment: any) {
  if (assessment?.level !== "amber" && assessment?.level !== "red") return null
  const reasons = (assessment.reasons ?? []).map((reason: string) => ASSESSMENT_REASON_RU[reason]).filter(Boolean)
  return reasons.length ? reasons.join(" · ") : null
}

const efficiencyCardStyle = {
  padding: "6px 7px",
  display: "flex",
  "flex-direction": "column",
  gap: "3px",
  "min-width": "0",
  width: "100%",
  "box-sizing": "border-box",
}

function EfficiencyKpi(props: { kind: "readShare" | "secondKpi"; efficiency: any; baseline?: any; deltas?: any; assessment?: any }) {
  const second = () => efficiencySecondKpi(props.efficiency)
  const baselineSecond = () => {
    const kpi = efficiencySecondKpi(props.baseline?.efficiency)
    return kpi?.kind === second()?.kind ? kpi : null
  }
  const value = () => props.kind === "readShare" ? efficiencyReadShare(props.efficiency) : finiteNumber(second()?.value) ? second().value : null
  const baselineValue = () => props.kind === "readShare" ? efficiencyReadShare(props.baseline?.efficiency) : finiteNumber(baselineSecond()?.value) ? baselineSecond().value : null
  const canShowDelta = () => baselineComparable(props.baseline) && knownAssessmentLevel(props.assessment) !== "gray"
  const delta = () => canShowDelta() ? numericDelta(value(), baselineValue()) : { absolute: null, relative: null }
  const label = () => props.kind === "readShare" ? "Доля чтения кэша" : secondKpiLabel(second()?.kind)
  const valueText = () => props.kind === "readShare" ? readShareValueText(value()) : secondKpiValueText(second())
  const numerator = () => props.kind === "readShare" ? props.efficiency?.cacheReadTokens : second()?.numerator
  const denominator = () => props.kind === "readShare" ? efficiencyInput(props.efficiency) : second()?.denominator
  const denominatorLabel = () => props.kind === "readShare" ? "весь вход" : second()?.kind === "readPerUncached" ? "новый вход" : "запись"
  const deltaText = () => {
    if (!canShowDelta()) return null
    const key = props.kind === "readShare" ? "readShare" : "secondKpi"
    if (props.deltas && key in props.deltas) {
      const provided = props.deltas[key]
      if (props.kind === "readShare") return finiteNumber(provided?.absolute) ? pointDeltaText(provided.absolute) : null
      return finiteNumber(provided?.relative) ? relativeDeltaText(provided.relative) : null
    }
    if (props.kind === "readShare") return finiteNumber(delta().absolute) ? pointDeltaText(delta().absolute * 100) : null
    return finiteNumber(delta().relative) ? relativeDeltaText(delta().relative) : null
  }
  const showDelta = () => canShowDelta() && deltaText() !== null
  const level = () => knownAssessmentLevel(props.assessment)
  return <article data-testid={props.kind === "readShare" ? "quota-guard-efficiency-read-share" : "quota-guard-efficiency-amortization"} data-kind={props.kind === "readShare" ? "readShare" : second()?.kind ?? "unknown"} data-level={level()} style={{ ...efficiencyCardStyle, ...assessmentSurfaceStyle(level()) }}>
    <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: "8px" }}>
      <span style={{ "font-size": "11px", "font-weight": "600", "min-width": "0", "overflow-wrap": "anywhere" }}>{label()}</span>
      <strong style={{ "font-size": "17px", "line-height": "1.15", "white-space": "nowrap", "flex-shrink": "0" }}>{valueText()}</strong>
    </div>
    <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "flex-wrap": "wrap", gap: "3px 6px" }}>
      <TrafficBadge level={level()} text={assessmentStatusText(props.assessment)} compact />
      <Show when={showDelta()}>
        <span style={{ "font-size": "10px", "font-weight": "600" }}>К базе: {deltaText()}</span>
      </Show>
    </div>
    <span style={{ "font-size": "10px", opacity: "0.7", "overflow-wrap": "anywhere", "line-height": "1.3" }} title={`Точно: ${exactTokenText(numerator())} / ${exactTokenText(denominator())}`}>
      {tokenText(numerator())} / {tokenText(denominator())} · {denominatorLabel()}
    </span>
  </article>
}

function TokenSegments(props: { segments: { label: string; value: number; color: string }[]; total: number }) {
  return <div style={{ display: "flex", "flex-direction": "column", gap: "3px" }}>
    <div role="img" aria-label={props.segments.map((segment) => `${segment.label}: ${exactTokenText(segment.value)}`).join(", ")} style={{ display: "flex", width: "100%", height: "8px", overflow: "hidden", "border-radius": "4px", background: "color-mix(in srgb, currentColor 8%, transparent)" }}>
      <For each={props.segments}>
        {(segment) => <div title={`${segment.label}: ${exactTokenText(segment.value)} (${shareText(segment.value, props.total)})`} style={{ width: `${props.total > 0 ? segment.value / props.total * 100 : 0}%`, background: segment.color }} />}
      </For>
    </div>
    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "3px 8px", "font-size": "10px", opacity: "0.78" }}>
      <For each={props.segments}>
        {(segment) => <span title={`${exactTokenText(segment.value)} токенов`} style={{ "white-space": "nowrap" }}><span style={{ color: segment.color }}>■</span> {segment.label} {shareText(segment.value, props.total)}</span>}
      </For>
    </div>
  </div>
}

function EfficiencyComposition(props: { efficiency: any; assessment?: any; baseline?: any }) {
  const input = () => efficiencyInput(props.efficiency)
  const output = () => props.efficiency?.outputTokens
  const reasoning = () => props.efficiency?.reasoningTokens
  const outputRest = () => finiteNumber(output()) && finiteNumber(reasoning()) && output() >= reasoning() ? output() - reasoning() : null
  const inputLevel = () => knownAssessmentLevel(props.assessment)
  const outputAssessment = () => outputVolumeAssessment(props.efficiency, props.baseline)
  const outputLevel = () => knownAssessmentLevel(outputAssessment())
  const outputDelta = () => outputLevel() !== "gray" ? numericDelta(output(), props.baseline?.efficiency?.outputTokens) : { absolute: null, relative: null }
  const segmentColor = (level: string, strength: number) => `color-mix(in srgb, ${ASSESSMENT_COLORS[level]} ${strength}%, transparent)`
  return <div data-testid="quota-guard-efficiency-composition" style={{ display: "flex", "flex-direction": "column", gap: "6px", "font-size": "11px" }}>
    <div data-level={inputLevel()} style={{ display: "flex", "flex-direction": "column", gap: "4px", padding: "6px 7px", ...assessmentSurfaceStyle(inputLevel()) }}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "flex-wrap": "wrap", gap: "3px 6px" }}>
        <strong>Вход: {tokenText(input())}</strong>
        <TrafficBadge level={inputLevel()} text={inputAssessmentText(props.assessment)} compact />
      </div>
      <Show when={input() !== null && (input() ?? 0) > 0} fallback={<span style={{ opacity: "0.65" }}>{input() === 0 ? "Нет входных токенов за период." : "Разбивка входа недоступна."}</span>}>
        <TokenSegments total={input()!} segments={[
          { label: "Без кэша", value: props.efficiency.uncachedInputTokens, color: segmentColor(inputLevel(), 48) },
          { label: "Чтение", value: props.efficiency.cacheReadTokens, color: segmentColor(inputLevel(), 72) },
          { label: "Запись", value: props.efficiency.cacheWriteTokens, color: segmentColor(inputLevel(), 92) },
        ]} />
      </Show>
    </div>
    <div data-level={outputLevel()} style={{ display: "flex", "flex-direction": "column", gap: "4px", padding: "6px 7px", ...assessmentSurfaceStyle(outputLevel()) }}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "flex-wrap": "wrap", gap: "3px 6px" }}>
        <strong>Выход: {tokenText(output())}</strong>
        <TrafficBadge level={outputLevel()} text={outputVolumeText(outputAssessment())} compact />
      </div>
      <span style={{ "font-size": "10px", opacity: "0.75", "line-height": "1.3" }}>По итогу периода · только объём, не качество.</span>
      <span style={{ "font-size": "10px", opacity: "0.7", "line-height": "1.3" }}>Рассуждения: {tokenText(reasoning())} · уже включены в выход.</span>
      <Show when={outputLevel() !== "gray"}>
        <span style={{ "font-size": "10px", "font-weight": "600" }}>К базе: {tokenDeltaText(outputDelta())}</span>
      </Show>
      <Show when={outputRest() !== null && (output() ?? 0) > 0} fallback={<span style={{ opacity: "0.65" }}>{output() === 0 && reasoning() === 0 ? "Нет выходных токенов за период." : "Разбивка выхода недоступна."}</span>}>
        <TokenSegments total={output()} segments={[
          { label: "Остальной выход", value: outputRest()!, color: segmentColor(outputLevel(), 55) },
          { label: "Рассуждения", value: reasoning(), color: segmentColor(outputLevel(), 85) },
        ]} />
      </Show>
    </div>
  </div>
}

function baselineNoticeText(stats: any) {
  if (baselineComparable(stats?.baseline)) return null
  if (stats?.baseline?.available === true && stats.baseline.steps === 0) {
    return stats.period === "week"
      ? "В предыдущие 7 дней не было активности — отклонения не оцениваются. Ниже текущие данные."
      : "В базовом периоде не было активности — отклонения не оцениваются. Ниже текущие данные."
  }
  return "Базовый период недоступен — отклонения не оцениваются. Ниже текущие данные."
}

function StatsBaseline(props: { baseline: any; current?: any }) {
  return <Show when={baselineComparable(props.baseline)}>
    <div data-testid="quota-guard-stats-baseline" style={{ "font-size": "11px", "line-height": "1.35", "border-top": "1px solid color-mix(in srgb, currentColor 10%, transparent)", "padding-top": "5px" }}>
      <div><strong>База:</strong> {integer.format(props.baseline.steps)} шагов · вход {tokenText(props.baseline.inputTokens)} · выход {tokenText(props.baseline.outputTokens)}</div>
      <Show when={props.current}>
        <div>Отклонение: шаги {stepsDeltaText(numericDelta(props.current.steps, props.baseline.steps))} · вход {tokenDeltaText(numericDelta(props.current.inputTokens, props.baseline.inputTokens))}</div>
        <div>Выход {tokenDeltaText(numericDelta(props.current.outputTokens, props.baseline.outputTokens))}</div>
      </Show>
    </div>
  </Show>
}

function StatsEfficiencyHelp(props: { stats: any }) {
  const baselinePeriod = () => props.stats.baseline?.period ?? props.stats.baseline
  const periodLabel = () => props.stats.period === "week" ? "7 дней" : "Сегодня"
  return <details data-testid="quota-guard-efficiency-help" style={{ "font-size": "10px", "line-height": "1.4" }}>
    <summary style={{ cursor: "pointer", opacity: "0.78" }}>Как считается</summary>
    <div style={{ display: "flex", "flex-direction": "column", gap: "7px", "margin-top": "6px", opacity: "0.78" }}>
      <section>
        <strong>Формулы</strong>
        <div>U — вход без кэша, R — чтение, W — запись. Полный вход = U + R + W.</div>
        <div>Доля чтения = R / (U + R + W). Чтение на запись = R / W. Переиспользование входа = R / U.</div>
      </section>
      <section>
        <strong>Период и база</strong>
        <div>{periodLabel()}{finiteNumber(props.stats.from) && finiteNumber(props.stats.to) ? `: ${formatDate(props.stats.from)} — ${formatDate(props.stats.to)}` : ""}.</div>
        <div>База: {props.stats.period === "week" ? "предыдущие 7 дней" : "вчера до того же времени"}{finiteNumber(baselinePeriod()?.from) && finiteNumber(baselinePeriod()?.to) ? ` · ${formatDate(baselinePeriod().from)} — ${formatDate(baselinePeriod().to)}` : ""}.</div>
      </section>
      <section>
        <strong>Сравнение моделей</strong>
        <div>Только та же группа провайдера/аккаунта и модель; варианты объединены. Область: OpenCode, все проекты.</div>
        <div>Статусы кэша и входа — по худшей сопоставимой модели; значения — итог периода. Выход — по итогу периода.</div>
      </section>
      <section>
        <strong>Светофор</strong>
        <div>Зелёный — нет заданного отклонения, а не оценка качества или экономии. Жёлтый — умеренное отклонение, красный — резкое.</div>
        <div>Выход: жёлтый при росте объёма от 50% и 50k; красный — от 1000% и 100k. Качество ответа не оценивается.</div>
        <div>Серый — нет базы для сравнения или недостаточно данных; это не оценка отклонения.</div>
      </section>
      <section>
        <strong>Ограничения данных</strong>
        <div>Агрегаты сообщает провайдер: полнота отдельных строк и доступность кэша из них не следуют. «—» — нет данных, не ноль.</div>
      </section>
    </div>
  </details>
}

function messageRangeText(values?: number[]) {
  if (!values || values.length === 0) return "—"
  return values.length === 1 ? String(values[0]) : `${values[0]}–${values[values.length - 1]}`
}

function showMessageEstimates(credits: any) {
  const values = [...(credits?.approxLocalMessages ?? []), ...(credits?.approxCloudMessages ?? [])].filter(finiteNumber)
  if (credits?.balance === 0 && values.length > 0 && values.every((value) => value === 0)) return false
  return values.length > 0
}

function formatDate(value?: number) {
  return value ? dateTime.format(new Date(value)) : "не указано"
}

function formatReset(value?: number) {
  return value ? resetDateTime.format(new Date(value)) : "сброс не указан"
}

function windowLabel(label: string) {
  if (label === "week") return "Неделя"
  if (label === "day") return "День"
  if (label === "month") return "Месяц"
  return label.replace(/(\d+)\s*ч$/, "$1 ч").replace(/(\d+)h$/, "$1 ч").replace(/(\d+)m$/, "$1 мин")
}

function quotaWindowParts(window: any) {
  const full = windowLabel(String(window.label ?? ""))
  const match = full.match(/^(.+?)\s*\(([^)]+)\)$/)
  const qualifier = match?.[2] ? match[2][0].toLocaleUpperCase("ru-RU") + match[2].slice(1) : null
  return { full, period: match?.[1] ?? full, qualifier }
}

function quotaWindowGroups(windows: any[]) {
  const groups: any[] = []
  for (const window of windows ?? []) {
    const parts = quotaWindowParts(window)
    const previous = groups[groups.length - 1]
    const adjacentSamePeriod = previous && previous.period === parts.period && previous.resetAt === (window.resetAt ?? null)
      && previous.items[previous.items.length - 1].parts.qualifier && parts.qualifier
    if (adjacentSamePeriod) previous.items.push({ window, parts })
    else groups.push({ period: parts.period, resetAt: window.resetAt ?? null, items: [{ window, parts }] })
  }
  return groups.map((group) => ({ ...group, grouped: group.items.length > 1 }))
}

const STATUS_TEXT_RU: Record<string, string> = {
  "API key missing": "API-ключ не подключён",
  "OAuth account ID missing": "В OAuth отсутствует account ID; нужен повторный вход (Codex browser legacy)",
  "OAuth expired": "Срок OAuth авторизации истёк",
  "OAuth credential missing": "OAuth авторизация не подключена",
  "OAuth access token missing": "В OAuth нет access-токена",
  "Kimi Code credential missing": "Ключ Kimi Code не найден (KIMI_API_KEY или подключение Kimi)",
  "credential source unavailable": "Источник учётных данных недоступен",
  "usage windows unavailable": "Провайдер не вернул окна квоты",
  "monitoring disabled": "Опрос провайдера выключен в настройках Quota Guard",
  forbidden: "Доступ к квоте запрещён; проверьте авторизацию",
  timeout: "Провайдер не ответил вовремя",
  "network error": "Ошибка сети при запросе квоты",
  "request failed": "Запрос к провайдеру не выполнен",
}

function providerStatus(provider: any) {
  return STATUS_TEXT_RU[provider.statusText] ?? provider.statusText ?? `Статус: ${provider.status}`
}

function worstPercent(status: any) {
  let worst: number | undefined
  for (const provider of status?.providers ?? []) {
    if (provider.status !== "ready" && provider.status !== "partial") continue
    for (const window of provider.windows ?? []) {
      if (typeof window.usedPercent === "number" && (worst === undefined || window.usedPercent > worst)) worst = window.usedPercent
    }
  }
  return worst
}

function providerName(status: any, id: string) {
  return status?.providers?.find?.((provider: any) => provider.id === id)?.displayName ?? id
}

function rateMatchesQuota(rate: any, providerID: string) {
  if (providerID === "openai") return rate.providerID === "openai"
  if (providerID === "kimi") return rate.providerID === "kimi-code-plan-global" || rate.providerID === "kimi-code-plan-cn"
  return rate.providerID === providerID
}

function quotaRates(status: any, providerID: string) {
  return (status?.rates ?? []).filter((rate: any) => rateMatchesQuota(rate, providerID))
}

function cardRates(status: any, providerID: string) {
  const matched = quotaRates(status, providerID)
  const active = matched.filter((rate: any) => rate.active)
  return active.length > 0 ? active : matched.slice(0, 1)
}

function otherRates(status: any) {
  return (status?.rates ?? []).filter((rate: any) => rate.active && !(status?.providers ?? []).some((provider: any) => rateMatchesQuota(rate, provider.id)))
}

const compactCardStyle = {
  border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
  "border-radius": "7px",
  padding: "6px",
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
  "min-width": "0",
}

function RateInline(props: { rate: any; showProvider?: boolean }) {
  const rate = () => props.rate
  return <article
    data-testid="quota-guard-active-rate"
    data-session-id={rate().sessionID}
    title={`Сессия …${rate().sessionID.slice(-6)}${rate().variant ? ` · ${rate().variant}` : ""}. Скорость — средняя завершённого шага.`}
    style={{ display: "flex", "flex-direction": "column", gap: "1px", "border-top": "1px solid color-mix(in srgb, currentColor 10%, transparent)", "padding-top": "3px", "font-size": "10px", "line-height": "1.25" }}
  >
    <div style={{ display: "flex", "justify-content": "space-between", gap: "6px", "font-size": "11px" }}>
      <strong>{props.showProvider === false ? rate().modelName : `${rate().providerName} · ${rate().modelName}`}</strong>
      <span style={{ color: rate().active ? "#42a36b" : undefined, opacity: rate().active ? "1" : "0.65", "white-space": "nowrap" }}>{rate().active ? "в работе" : "последний шаг"}</span>
    </div>
    <div title="Средняя скорость завершённого шага. Эффективная скорость входа может включать ожидание первого токена, очередь и сеть.">
      Скорость{rate().ratesCurrent ? "" : " (пред.)"}: вход {rateText(rate().inputPerSecond)} ток/с · выход {rateText(rate().outputPerSecond)} ток/с
    </div>
    <div title={`Точные токены шага, вход / выход: ${exactTokenText(rate().inputTokens)} / ${exactTokenText(rate().outputTokens)}`}>
      Токены шага: вход {tokenText(rate().inputTokens)} · выход {tokenText(rate().outputTokens)}
    </div>
    <div data-testid="quota-guard-stage-1-details" style={{ display: "flex", "flex-direction": "column", gap: "1px", opacity: "0.78" }}>
      <div>Кэш шага: {tokenText(rate().cacheReadTokens)} ({shareText(rate().cacheReadTokens ?? 0, rate().inputTokens ?? 0)})</div>
      <div>Обычный вход: {tokenText(rate().uncachedInputTokens)} · запись: {tokenText(rate().cacheWriteTokens)}</div>
    </div>
    <div style={{ opacity: "0.72" }} title={`Сессия, точные токены вход / выход: ${exactTokenText(rate().sessionInputTokens)} / ${exactTokenText(rate().sessionOutputTokens)}`}>
      Сессия: вход {tokenText(rate().sessionInputTokens)} · выход {tokenText(rate().sessionOutputTokens)}
    </div>
    <div style={{ opacity: "0.72" }}>1-й токен: {durationText(rate().firstTokenMs)} · поток: {durationText(rate().outputDurationMs)}</div>
  </article>
}

const diagnosticListStyle = {
  display: "flex",
  "flex-direction": "column",
  gap: "5px",
  "max-height": "260px",
  "overflow-y": "auto",
  "scrollbar-width": "thin",
  "scrollbar-gutter": "stable",
  "padding-right": "3px",
  "padding-bottom": "8px",
  "scroll-padding-bottom": "8px",
}

function DiagnosticModels(props: { models: any[] }) {
  return <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "padding-left": "7px", "font-size": "11px" }}>
    <For each={props.models ?? []}>
      {(model) => <div>
        {model.providerID}/{model.modelID}{model.variant ? ` · ${model.variant}` : ""}: {integer.format(model.steps)} шагов · вход {tokenText(model.inputTokens)} · холодных {integer.format(model.coldSteps)}
      </div>}
    </For>
  </div>
}

function diagnosticTokenText(step: any, field: "input" | "fullInput" | "cacheRead" | "cacheWrite" | "output" | "reasoning", value: any) {
  if (!finiteNumber(value)) return "—"
  const completeness = step.tokenCompleteness
  if (completeness == null) return value === 0 ? "—*" : tokenText(value)
  const required = field === "fullInput" ? ["input", "cacheRead", "cacheWrite"] : field === "output" ? ["output", "reasoning"] : [field]
  return required.some((key) => completeness[key] === false) ? "—" : tokenText(value)
}

function diagnosticShareText(step: any) {
  if (step.tokenCompleteness == null && step.cacheReadTokens === 0) return "—*"
  if (step.tokenCompleteness && ["input", "cacheRead", "cacheWrite"].some((key) => step.tokenCompleteness[key] === false)) return "—"
  return shareText(step.cacheReadTokens, step.inputTokens)
}

function DiagnosticStepDetail(props: { step: any; onBack: () => void; cold?: boolean }) {
  const duration = () => finiteNumber(props.step.startedAt) && finiteNumber(props.step.at) && props.step.at >= props.step.startedAt ? props.step.at - props.step.startedAt : undefined
  const field = (label: string, key: "input" | "fullInput" | "cacheRead" | "cacheWrite" | "output" | "reasoning", value: any) => <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
    <span style={{ opacity: "0.72" }}>{label}</span><strong style={{ "text-align": "right" }}>{diagnosticTokenText(props.step, key, value)}</strong>
  </div>
  return <article data-testid="quota-guard-diagnostics-step-detail" style={{ display: "flex", "flex-direction": "column", gap: "5px", "font-size": "11px", "line-height": "1.35", "overflow-wrap": "anywhere" }}>
    <div><button type="button" data-testid="quota-guard-diagnostics-step-back" onClick={props.onBack} style={{ padding: "3px 6px", "font-size": "11px" }}>← Назад</button></div>
    <div><strong>{formatDate(props.step.at)}</strong><br />{props.step.projectLabel}</div>
    <div>{props.step.providerID}/{props.step.modelID}{props.step.variant ? ` · ${props.step.variant}` : ""}</div>
    <div style={{ opacity: "0.7" }}>основной …{String(props.step.rootID).slice(-6)}{props.step.parentID ? ` · субагент …${String(props.step.sessionID).slice(-6)}` : ""}</div>
    <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "border-top": "1px solid color-mix(in srgb, currentColor 12%, transparent)", "padding-top": "5px" }}>
      {field("Без кэша (U)", "input", props.step.ordinaryInputTokens)}
      {field("Чтение кэша (R)", "cacheRead", props.step.cacheReadTokens)}
      {field("Запись кэша (W)", "cacheWrite", props.step.cacheWriteTokens)}
      {field("Полный вход", "fullInput", props.step.inputTokens)}
      {field("Выход, включая рассуждения", "output", props.step.outputTokens)}
      {field("Из них рассуждения", "reasoning", props.step.reasoningTokens)}
    </div>
    <div>Начало: {formatDate(props.step.startedAt)} · длительность: {durationText(duration())}</div>
    <div>Завершение: {props.step.finish ?? "—"} · пауза перед шагом: {pauseText(props.step.pauseMs)}</div>
    <Show when={props.cold && finiteNumber(props.step.pauseMs) && props.step.pauseMs >= 0 && props.step.pauseMs < 60_000}>
      <div style={{ "font-size": "10px", opacity: "0.75" }}>Короткая пауза: проверить префикс/маршрут. Совпадение не доказывает причину.</div>
    </Show>
    <Show when={props.cold && finiteNumber(props.step.pauseMs) && props.step.pauseMs >= 60 * 60 * 1000}>
      <div style={{ "font-size": "10px", opacity: "0.75" }}>Длительная пауза: возможен TTL. Совпадение не доказывает причину.</div>
    </Show>
    <Show when={props.step.tokenCompleteness == null}>
      <div style={{ "font-size": "10px", opacity: "0.7" }}>* Старая запись: ноль может означать отсутствие данных.</div>
    </Show>
    <Show when={props.step.tokenCompleteness != null}>
      <div style={{ "font-size": "10px", opacity: "0.7" }}>«—» — поле не сообщено; это не ноль. Рассуждения уже включены в выход.</div>
    </Show>
  </article>
}

function diagnosticGroupKey(step: any) {
  return [step.sessionID, step.providerID, step.modelID, step.variant ?? ""].join("\u0000")
}

function diagnosticGroups(steps: any[]) {
  const groups = new Map<string, any>()
  for (const step of steps) {
    const key = diagnosticGroupKey(step)
    const group = groups.get(key) ?? { key, sessionID: step.sessionID, parentID: step.parentID, providerID: step.providerID, modelID: step.modelID, variant: step.variant, steps: [] }
    group.steps.push(step)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function DiagnosticStepsBrowser(props: { projects: any[]; steps: any[] }) {
  const [projectID, setProjectID] = createSignal<string | null>(null)
  const [groupKey, setGroupKey] = createSignal<string | null>(null)
  const [stepID, setStepID] = createSignal<string | null>(null)
  createEffect(() => {
    props.steps
    setProjectID(null)
    setGroupKey(null)
    setStepID(null)
  })
  const projectSteps = () => (props.steps ?? []).filter((step) => step.projectID === projectID())
  const groups = () => diagnosticGroups(projectSteps())
  const selectedGroup = () => groups().find((group) => group.key === groupKey())
  const selectedStep = () => (props.steps ?? []).find((step) => step.id === stepID())
  const selectedProject = () => (props.projects ?? []).find((project) => project.id === projectID())
  const openProject = (id: string) => { setProjectID(id); setGroupKey(null); setStepID(null) }
  return <div data-testid="quota-guard-diagnostics-steps" style={{ display: "flex", "flex-direction": "column", gap: "5px", "min-width": "0" }}>
    <Show when={!projectID()}>
      <div data-testid="quota-guard-diagnostics-projects-list" style={diagnosticListStyle}>
        <For each={props.projects ?? []} fallback={<div style={{ "font-size": "11px", opacity: "0.65" }}>Данные появятся после новых шагов.</div>}>
          {(project) => <section style={{ "font-size": "11px", "line-height": "1.35", "overflow-wrap": "anywhere" }}>
            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: "6px" }}>
              <strong>{project.label}</strong>
              <Show when={(props.steps ?? []).some((step) => step.projectID === project.id)}>
                <button type="button" data-testid="quota-guard-diagnostics-project-open" onClick={() => openProject(project.id)} style={{ padding: "2px 6px", "font-size": "10px" }}>Шаги ›</button>
              </Show>
            </div>
            <div>{integer.format(project.steps)} шагов · вход {tokenText(project.inputTokens)} · холодных {integer.format(project.coldSteps)}</div>
            <For each={project.roots ?? []}>
              {(root) => <div style={{ "border-left": "2px solid color-mix(in srgb, currentColor 15%, transparent)", "padding-left": "6px", "margin-top": "5px" }}>
                <div title="Шаги и вход включают субагентов; модели ниже относятся только к основному сеансу.">основной …{String(root.id).slice(-6)}: {integer.format(root.steps)} шагов · вход {tokenText(root.inputTokens)} · холодных {integer.format(root.coldSteps)}</div>
                <DiagnosticModels models={root.models} />
                <For each={root.subagents ?? []}>
                  {(subagent) => <div style={{ "margin-top": "4px", "padding-left": "7px" }}>
                    <div>субагент …{String(subagent.id).slice(-6)}: {integer.format(subagent.steps)} шагов · вход {tokenText(subagent.inputTokens)} · холодных {integer.format(subagent.coldSteps)}</div>
                    <DiagnosticModels models={subagent.models} />
                  </div>}
                </For>
              </div>}
            </For>
          </section>}
        </For>
      </div>
    </Show>
    <Show when={projectID() && !groupKey()}>
      <div><button type="button" onClick={() => setProjectID(null)} style={{ padding: "3px 6px", "font-size": "11px" }}>← Проекты</button></div>
      <strong style={{ "font-size": "11px", "overflow-wrap": "anywhere" }}>{selectedProject()?.label ?? projectID()}</strong>
      <div style={{ "font-size": "10px", opacity: "0.7", "line-height": "1.35" }}>Сессии и модели · в выборке до 200 шагов с наибольшим полным входом.</div>
      <div style={diagnosticListStyle}>
        <For each={groups()} fallback={<div style={{ "font-size": "11px", opacity: "0.65" }}>Нет шагов в ограниченной выборке.</div>}>
          {(group) => <button type="button" data-testid="quota-guard-diagnostics-session-model" onClick={() => setGroupKey(group.key)} style={{ padding: "5px", "text-align": "left", "font-size": "11px", cursor: "pointer" }}>
            {group.parentID ? "субагент" : "основной"} …{String(group.sessionID).slice(-6)} · {group.providerID}/{group.modelID}{group.variant ? ` · ${group.variant}` : ""}<br />
            <span style={{ opacity: "0.7" }}>Шагов в выборке: {group.steps.length}</span>
          </button>}
        </For>
      </div>
    </Show>
    <Show when={selectedGroup() && !stepID()}>
      {(group) => <>
        <div><button type="button" onClick={() => setGroupKey(null)} style={{ padding: "3px 6px", "font-size": "11px" }}>← Сессии и модели</button></div>
        <div style={{ "font-size": "11px", "overflow-wrap": "anywhere" }}>{group().providerID}/{group().modelID}{group().variant ? ` · ${group().variant}` : ""}</div>
        <div style={diagnosticListStyle}>
          <For each={group().steps}>
            {(step) => <button type="button" data-testid="quota-guard-diagnostics-step" onClick={() => setStepID(step.id)} style={{ padding: "5px", "text-align": "left", "font-size": "11px", cursor: "pointer" }}>
              {formatDate(step.at)}<br />Полный вход: {diagnosticTokenText(step, "fullInput", step.inputTokens)} · кэш {diagnosticShareText(step)}<br />
              <span style={{ opacity: "0.7" }}>Выход: {diagnosticTokenText(step, "output", step.outputTokens)} · {step.finish ?? "завершение не указано"}</span>
            </button>}
          </For>
        </div>
      </>}
    </Show>
    <Show when={selectedStep()}>
      {(step) => <DiagnosticStepDetail step={step()} onBack={() => setStepID(null)} />}
    </Show>
  </div>
}

const DIAGNOSTIC_KIND_RU: Record<string, string> = {
  cold: "холодный шаг",
  compaction: "компакция",
  model: "смена модели",
  "plugin.setup": "загрузка плагина",
  "process.started": "запуск хоста",
  quota: "квота",
}

function DiagnosticTimelineLabel(props: { event: any }) {
  const label = () => props.event.kind === "plugin.setup" ? "Загрузка/перезагрузка плагина" : props.event.kind === "process.started" ? "Запуск хоста плагинов" : props.event.label
  return <>{label()}</>
}

function QuotaView(props: { ctx: any; onChanged?: (status: any) => void }) {
  const [snapshot, setSnapshot] = createSignal<any>()
  const [loading, setLoading] = createSignal(true)
  const [toggling, setToggling] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  let generation = 0

  function publish(result: any) {
    setSnapshot(result)
    props.onChanged?.(result)
  }

  async function load(refresh: boolean) {
    const current = ++generation
    setLoading(true)
    setFailed(false)
    try {
      publish(await props.ctx.client.rpc(QuotaGuardRpc).status({ refresh }))
    } catch {
      if (current === generation) setFailed(true)
    } finally {
      if (current === generation) setLoading(false)
    }
  }

  async function setMode(next: boolean) {
    const current = ++generation
    setToggling(true)
    setFailed(false)
    try {
      publish(await props.ctx.client.rpc(QuotaGuardRpc).configure({ enabled: next }))
    } catch {
      if (current === generation) setFailed(true)
    } finally {
      if (current === generation) setToggling(false)
    }
  }

  const [models, setModels] = createSignal<any>()
  const [selected, setSelected] = createSignal("")
  const [switching, setSwitching] = createSignal(false)
  const [switchNote, setSwitchNote] = createSignal("")
  const [usageStats, setUsageStats] = createSignal<any>()
  const [analyticsPeriod, setAnalyticsPeriod] = createSignal<"day" | "week">("day")
  const [statsOpen, setStatsOpen] = createSignal(false)
  const [statsLoading, setStatsLoading] = createSignal(false)
  const [statsFailed, setStatsFailed] = createSignal(false)
  let statsGeneration = 0
  const [diagnostics, setDiagnostics] = createSignal<any>()
  const [diagnosticsTab, setDiagnosticsTab] = createSignal<"cold" | "projects" | "timeline">("cold")
  const [diagnosticsLoading, setDiagnosticsLoading] = createSignal(false)
  const [diagnosticsFailed, setDiagnosticsFailed] = createSignal(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = createSignal(false)
  const [selectedColdStep, setSelectedColdStep] = createSignal<any>(null)
  let diagnosticsGeneration = 0

  async function loadDiagnostics(period: "day" | "week") {
    const current = ++diagnosticsGeneration
    setDiagnosticsLoading(true)
    setDiagnosticsFailed(false)
    try {
      const result = await props.ctx.client.rpc(QuotaGuardRpc).diagnostics({ period })
      const payload = result?.output ?? result?.data ?? result
      const valid = payload && Array.isArray(payload.coldSteps) && Array.isArray(payload.projects) && Array.isArray(payload.timeline)
      if (current === diagnosticsGeneration) {
        setDiagnostics(valid ? payload : undefined)
        setDiagnosticsFailed(!valid || payload.available !== true)
        setSelectedColdStep(null)
      }
    } catch {
      if (current === diagnosticsGeneration) setDiagnosticsFailed(true)
    } finally {
      if (current === diagnosticsGeneration) setDiagnosticsLoading(false)
    }
  }

  async function loadStats(period: "day" | "week") {
    const current = ++statsGeneration
    setStatsLoading(true)
    setStatsFailed(false)
    try {
      const result = await props.ctx.client.rpc(QuotaGuardRpc).stats({ period })
      const payload = result?.output ?? result?.data ?? result
      const valid = payload && typeof payload.steps === "number" && Array.isArray(payload.models)
      if (current === statsGeneration) {
        setUsageStats(valid ? payload : undefined)
        setStatsFailed(!valid)
      }
    } catch {
      if (current === statsGeneration) setStatsFailed(true)
    } finally {
      if (current === statsGeneration) setStatsLoading(false)
    }
  }

  function changeAnalyticsPeriod(period: "day" | "week") {
    if (period === analyticsPeriod()) return
    setAnalyticsPeriod(period)
    if (statsOpen()) void loadStats(period)
    if (diagnosticsOpen()) void loadDiagnostics(period)
  }

  function sessionID() {
    try {
      return props.ctx.sessions.current()?.id
    } catch {
      return undefined
    }
  }

  function currentModelKey() {
    const current = models()?.current
    return current ? `${current.providerID}/${current.modelID}` : ""
  }

  async function loadModels() {
    const id = sessionID()
    if (!id) return
    try {
      const result = await props.ctx.client.rpc(QuotaGuardRpc).models({ sessionID: id })
      setModels(result)
      if (result?.current) setSelected(currentModelKey())
    } catch {}
  }

  async function patch(input: any) {
    const current = ++generation
    setToggling(true)
    setFailed(false)
    try {
      publish(await props.ctx.client.rpc(QuotaGuardRpc).configure(input))
    } catch {
      if (current === generation) setFailed(true)
    } finally {
      if (current === generation) setToggling(false)
    }
  }

  async function switchTo() {
    const id = sessionID()
    const value = selected()
    const slash = value.indexOf("/")
    if (!id || slash <= 0) return
    setSwitching(true)
    setSwitchNote("")
    try {
      await props.ctx.client.rpc(QuotaGuardRpc).switchModel({
        sessionID: id,
        providerID: value.slice(0, slash),
        modelID: value.slice(slash + 1),
      })
      setSwitchNote("Модель сессии переключена.")
      await loadModels()
    } catch {
      setSwitchNote("Не удалось переключить модель сессии.")
    } finally {
      setSwitching(false)
    }
  }

  onMount(() => {
    void load(false)
    void loadModels()
    const off = props.ctx.client.rpc(QuotaGuardRpc).events.on("updated", (event: any) => publish(event?.data?.status))
    onCleanup(() => { off?.() })
  })
  onCleanup(() => { generation++; statsGeneration++; diagnosticsGeneration++ })

  return (
    <div data-testid="quota-guard-panel" style={{ padding: "7px", display: "flex", "flex-direction": "column", gap: "5px", "box-sizing": "border-box", height: "100%", "overflow-y": "auto", "font-size": "12px" }}>
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "6px" }}>
        <div style={{ display: "flex", "align-items": "baseline", "flex-wrap": "wrap", gap: "2px 7px" }}>
          <h2 style={{ margin: "0", "font-size": "14px", "line-height": "1.2" }}>Квоты LLM</h2>
          <span style={{ opacity: "0.65", "font-size": "10px" }}>Quota Guard · только чтение</span>
        </div>
        <button
          type="button"
          data-testid="quota-guard-refresh"
          aria-label="Обновить квоты"
          disabled={loading() || toggling() || snapshot()?.enabled === false}
          onClick={() => void load(true)}
          style={{ padding: "3px 7px", "font-size": "11px", cursor: loading() || toggling() ? "wait" : "pointer" }}
        >
          {loading() ? "Обновление…" : "Обновить"}
        </button>
      </div>

      <label data-testid="quota-guard-mode" style={{ display: "flex", "align-items": "center", gap: "5px", "font-size": "11px", "line-height": "1.2" }}>
        <input
          type="checkbox"
          aria-label="Мониторинг квот и предупреждения"
          disabled={toggling() || loading()}
          checked={snapshot()?.enabled !== false}
          onChange={(event: any) => void setMode(event.currentTarget.checked === true)}
        />
        <span>Мониторинг и предупреждения</span>
      </label>

      <Show when={failed()}>
        <div role="alert" style={{ padding: "6px", border: "1px solid #d66", "border-radius": "6px", "font-size": "11px" }}>
          Не удалось получить данные. Проверьте соединение с сервером OpenCode и повторите обновление.
        </div>
      </Show>

      <Show when={snapshot()?.enabled === false}>
        <div role="status" style={{ padding: "6px", "border-radius": "6px", border: "1px solid color-mix(in srgb, currentColor 18%, transparent)", "font-size": "11px" }}>
          Мониторинг выключен: опрос провайдеров и предупреждения в сессиях не выполняются. Данные ниже — последний сохранённый снимок.
        </div>
      </Show>

      <Show when={snapshot()}>
        {(data) => <details data-testid="quota-guard-management" style={compactCardStyle}>
          <summary style={{ cursor: "pointer", "font-size": "12px", "font-weight": "600" }}>Управление</summary>
          <div style={{ display: "flex", "flex-direction": "column", gap: "5px", "margin-top": "4px" }}>
            <For each={Object.entries(data().monitoring ?? {})}>
              {([id, on]) => <label style={{ display: "flex", "align-items": "center", gap: "6px", "font-size": "12px" }}>
                <input
                  type="checkbox"
                  data-testid={`quota-guard-monitor-${id}`}
                  aria-label={`Опрос провайдера ${providerName(data(), id)}`}
                  disabled={toggling() || data().enabled === false}
                  checked={on === true}
                  onChange={(event: any) => void patch({ monitoring: { [id]: event.currentTarget.checked === true } })}
                />
                <span>Опрос: {providerName(data(), id)}</span>
              </label>}
            </For>
            <Show when={models()?.options?.length > 0}>
              <div style={{ display: "flex", "flex-direction": "column", gap: "5px" }}>
                <label style={{ "font-size": "12px" }} for="quota-guard-model">Модель текущей сессии</label>
                <select
                  id="quota-guard-model"
                  data-testid="quota-guard-model"
                  disabled={switching()}
                  value={selected()}
                  onChange={(event: any) => setSelected(event.currentTarget.value)}
                  style={{ padding: "4px 6px", "font-size": "12px" }}
                >
                  <For each={models().options}>{(option: any) => <option value={`${option.providerID}/${option.modelID}`}>{option.providerTitle} · {option.title}</option>}</For>
                </select>
                <button
                  type="button"
                  data-testid="quota-guard-switch"
                  disabled={switching() || !selected() || selected() === currentModelKey()}
                  onClick={() => void switchTo()}
                  style={{ padding: "4px 8px", "font-size": "11px", cursor: switching() ? "wait" : "pointer" }}
                >
                  {switching() ? "Переключение…" : "Переключить модель сессии"}
                </button>
                <div style={{ "font-size": "11px", opacity: "0.7", "line-height": "1.3" }}>
                  Только по вашему нажатию. Автоматически модель и сессия не изменяются.
                </div>
                <Show when={switchNote()}>
                  <div role="status" style={{ "font-size": "11px" }}>{switchNote()}</div>
                </Show>
              </div>
            </Show>
          </div>
        </details>}
      </Show>

      <Show when={snapshot()} fallback={<div style={{ opacity: "0.7" }}>Загрузка состояния квот…</div>}>
        {(data) => <>
          <div style={{ "font-size": "10px", opacity: "0.7", "line-height": "1.25" }}>
            Обновлено: {formatDate(data().lastRefreshAt)}{data().stale ? " · данные могут быть устаревшими" : ""}
          </div>
          <For each={data().providers} fallback={<div>Нет настроенных провайдеров.</div>}>
            {(provider) => <section data-provider-id={provider.id} style={compactCardStyle}>
              <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline", gap: "6px", "font-size": "12px", "line-height": "1.2" }}>
                <strong>{provider.displayName}</strong>
                <Show when={provider.plan}><span style={{ opacity: "0.65", "text-transform": "uppercase", "font-size": "10px" }}>{provider.plan}</span></Show>
              </div>
              <Show when={provider.credits}>
                {(credits) => <div data-testid="quota-guard-credits" style={{ "font-size": "10px", display: "flex", "flex-wrap": "wrap", gap: "2px 8px", "line-height": "1.25" }}>
                  <span>Кредиты: {credits().unlimited ? "без лимита" : credits().balance !== undefined ? `баланс ${percent.format(credits().balance)}` : "нет данных"}</span>
                  <Show when={showMessageEstimates(credits())}>
                    <span style={{ opacity: "0.75" }}>≈ сообщений: локально {messageRangeText(credits().approxLocalMessages)}, облако {messageRangeText(credits().approxCloudMessages)}</span>
                  </Show>
                  <Show when={credits().overageLimitReached}>
                    <span style={{ color: "#e66", "font-weight": "600" }}>Лимит перерасхода достигнут</span>
                  </Show>
                </div>}
              </Show>
              <Show when={provider.status === "ready" || provider.status === "partial"} fallback={<div style={{ "font-size": "12px", opacity: "0.8" }}>{providerStatus(provider)}</div>}>
                <For each={quotaWindowGroups(provider.windows)} fallback={<div style={{ opacity: "0.75" }}>{providerStatus(provider)}</div>}>
                  {(group) => <div data-testid="quota-guard-window-group" style={{ display: "flex", "flex-direction": "column", gap: "3px" }}>
                    <Show when={group.grouped}>
                      <div style={{ "font-size": "11px", "font-weight": "600" }} title={`Сброс: ${formatDate(group.resetAt)}`}>
                        {group.period} <span style={{ opacity: "0.65", "font-weight": "400" }}>· {formatReset(group.resetAt)}</span>
                      </div>
                    </Show>
                    <For each={group.items}>
                      {(item) => {
                        const window = item.window
                        const used = () => typeof window.usedPercent === "number" ? window.usedPercent : undefined
                        const critical = () => used() !== undefined && (used()! >= data().thresholds.criticalPercent || window.limitReached)
                        const warning = () => used() !== undefined && used()! >= data().thresholds.warningPercent
                        return <div data-window-id={window.id} style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
                          <div style={{ display: "flex", "justify-content": "space-between", gap: "6px", "font-size": "11px", "line-height": "1.25" }}>
                            <span title={`Сброс: ${formatDate(window.resetAt)}`}>
                              {group.grouped ? item.parts.qualifier : item.parts.full}
                              <Show when={!group.grouped}><span style={{ "font-size": "11px", opacity: "0.65" }}> · {formatReset(window.resetAt)}</span></Show>
                            </span>
                            <strong>{used() === undefined ? "нет данных" : `${percent.format(used()!)}%`}</strong>
                          </div>
                          <Show when={used() !== undefined}>
                            <div
                              role="progressbar"
                              aria-label={`${item.parts.full}: использовано`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.min(100, Math.max(0, used()!))}
                              style={{ width: "100%", height: "4px", overflow: "hidden", "border-radius": "2px", background: "color-mix(in srgb, currentColor 16%, transparent)" }}
                            >
                              <div style={{ width: `${Math.min(100, Math.max(0, used()!))}%`, height: "100%", background: critical() ? "#d95555" : warning() ? "#d99a28" : "#42a36b" }} />
                            </div>
                          </Show>
                          <Show when={window.limitReached === true}>
                            <div style={{ color: "#e66", "font-size": "11px", "font-weight": "600" }}>Лимит исчерпан</div>
                          </Show>
                        </div>
                      }}
                    </For>
                  </div>}
                </For>
              </Show>
              <section data-testid={`quota-guard-speed-${provider.id}`} style={{ display: "flex", "flex-direction": "column", gap: "3px", "border-top": "1px solid color-mix(in srgb, currentColor 12%, transparent)", "padding-top": "4px" }}>
                <div style={{ display: "flex", "justify-content": "space-between", gap: "6px", "line-height": "1.2" }}>
                  <strong style={{ "font-size": "11px" }}>Скорость LLM</strong>
                  <span style={{ "font-size": "10px", opacity: "0.6" }}>вход / выход</span>
                </div>
                <For each={cardRates(data(), provider.id)} fallback={<div style={{ "font-size": "11px", opacity: "0.65" }}>Нет измерений.</div>}>
                  {(rate) => <RateInline rate={rate} showProvider={false} />}
                </For>
              </section>
            </section>}
          </For>
          <Show when={otherRates(data()).length > 0}>
            <section data-testid="quota-guard-rates" style={compactCardStyle}>
              <div style={{ display: "flex", "justify-content": "space-between", gap: "6px" }}>
                <strong style={{ "font-size": "12px" }}>Активные LLM</strong>
                <span style={{ "font-size": "11px", opacity: "0.6" }}>вход / выход</span>
              </div>
              <For each={otherRates(data())}>
                {(rate) => <RateInline rate={rate} />}
              </For>
            </section>
          </Show>
          <Show when={!(data().rates ?? []).some((rate: any) => rate.active)}>
            <div data-testid="quota-guard-rates-empty" style={{ "font-size": "11px", opacity: "0.65" }}>Сейчас нет активных LLM. Последние замеры закреплены в карточках выше.</div>
          </Show>
          <div data-testid="quota-guard-analytics-period" style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: "6px", "font-size": "11px" }}>
            <span style={{ opacity: "0.7" }}>Период аналитики</span>
            <div style={{ display: "flex", gap: "4px" }}>
              <button type="button" data-testid="quota-guard-analytics-day" aria-pressed={analyticsPeriod() === "day"} disabled={(statsOpen() && statsLoading()) || (diagnosticsOpen() && diagnosticsLoading())} onClick={() => changeAnalyticsPeriod("day")} style={{ padding: "3px 7px", "font-size": "11px", "font-weight": analyticsPeriod() === "day" ? "600" : "400" }}>Сегодня</button>
              <button type="button" data-testid="quota-guard-analytics-week" aria-pressed={analyticsPeriod() === "week"} disabled={(statsOpen() && statsLoading()) || (diagnosticsOpen() && diagnosticsLoading())} onClick={() => changeAnalyticsPeriod("week")} style={{ padding: "3px 7px", "font-size": "11px", "font-weight": analyticsPeriod() === "week" ? "600" : "400" }}>7 дней</button>
            </div>
          </div>
          <details
            data-testid="quota-guard-stats"
            style={compactCardStyle}
            onToggle={(event: any) => {
              const open = event.currentTarget.open === true
              setStatsOpen(open)
              if (open) void loadStats(analyticsPeriod())
            }}
          >
            <summary style={{ cursor: "pointer", "font-size": "12px", "font-weight": "600" }}>Статистика и эффективность</summary>
            <div style={{ display: "flex", "flex-direction": "column", gap: "5px", "margin-top": "4px" }}>
              <div style={{ "font-size": "10px", opacity: "0.6", "text-align": "right" }}>OpenCode · все проекты</div>
              <Show when={statsLoading()}><div role="status" aria-live="polite" style={{ "font-size": "11px", opacity: "0.65" }}>Загрузка…</div></Show>
              <Show when={statsFailed() && !statsLoading()}>
                <div role="alert" style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "flex-wrap": "wrap", gap: "5px", "font-size": "11px" }}>
                  <span>Статистика сейчас недоступна.</span>
                  <button type="button" data-testid="quota-guard-stats-retry" onClick={() => void loadStats(analyticsPeriod())} style={{ padding: "3px 7px", "font-size": "11px" }}>Повторить</button>
                </div>
              </Show>
              <Show when={!statsLoading() && !statsFailed() && usageStats()}>
                {(stats) => <Show when={stats().available !== false} fallback={
                  <div role="alert" style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "flex-wrap": "wrap", gap: "5px", "font-size": "11px" }}>
                    <span>Текущий период недоступен.</span>
                    <button type="button" data-testid="quota-guard-stats-retry" onClick={() => void loadStats(analyticsPeriod())} style={{ padding: "3px 7px", "font-size": "11px" }}>Повторить</button>
                  </div>
                }>
                  <div data-testid="quota-guard-stats-summary" style={{ "font-size": "12px", "font-weight": "600" }}>
                    {integer.format(stats().steps)} шагов · {tokenText(knownSum(stats().inputTokens, stats().outputTokens))} токенов{stats().showCost ? ` · ${moneyText(stats().cost)}` : ""}
                  </div>
                  <Show when={baselineNoticeText(stats())}>
                    <div data-testid="quota-guard-stats-no-baseline" style={{ padding: "6px 7px", "font-size": "11px", "line-height": "1.35", ...assessmentSurfaceStyle("gray") }}>{baselineNoticeText(stats())}</div>
                  </Show>
                  <Show when={baselineComparable(stats().baseline) && Array.isArray(stats().modelComparisons)}>
                    <div data-testid="quota-guard-stats-assessment" style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start", gap: "3px", padding: "6px 7px", ...assessmentSurfaceStyle(worstModelAssessment(stats().modelComparisons).level) }}>
                      <AssessmentBadge assessment={worstModelAssessment(stats().modelComparisons)} />
                      <Show when={assessmentReasonsText(worstModelAssessment(stats().modelComparisons))}>
                        <span style={{ "font-size": "10px", "font-weight": "600" }}>{assessmentReasonsText(worstModelAssessment(stats().modelComparisons))}</span>
                      </Show>
                    </div>
                  </Show>
                  <div style={{ "font-size": "10px", opacity: "0.75", "line-height": "1.35" }}>Статусы кэша/входа — по худшей сопоставимой модели; значения — итог периода.</div>
                  <div style={{ "font-size": "10px", opacity: "0.65", "line-height": "1.3" }}>Вход за период — сумма повторных обращений, не размер контекста.</div>
                  <div data-testid="quota-guard-stats-efficiency" style={{ display: "flex", "flex-direction": "column", gap: "5px", "align-items": "stretch" }}>
                    <EfficiencyKpi kind="readShare" efficiency={stats().efficiency} baseline={stats().baseline} deltas={stats().deltas} assessment={aggregateModelComponent(stats().modelComparisons, "cache")} />
                    <EfficiencyKpi kind="secondKpi" efficiency={stats().efficiency} baseline={stats().baseline} deltas={stats().deltas} assessment={aggregateModelComponent(stats().modelComparisons, "reuse")} />
                  </div>
                  <EfficiencyComposition efficiency={stats().efficiency} assessment={aggregateModelComponent(stats().modelComparisons, "input")} baseline={stats().baseline} />
                  <StatsBaseline baseline={stats().baseline} current={stats()} />
                  <StatsEfficiencyHelp stats={stats()} />
                  <details data-testid="quota-guard-stats-comparison" style={{ "font-size": "11px" }}>
                    <summary style={{ cursor: "pointer" }}>По моделям и сравнение с базой</summary>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "5px", "margin-top": "5px", "max-height": "220px", "overflow-y": "auto", "min-width": "0", "scrollbar-gutter": "stable" }}>
                      <Show when={Array.isArray(stats().modelComparisons)} fallback={
                        <For each={stats().models} fallback={<div style={{ opacity: "0.65" }}>Нет данных за выбранный период.</div>}>
                          {(model) => <div data-testid="quota-guard-stats-model" style={{ display: "flex", "justify-content": "space-between", "flex-wrap": "wrap", gap: "2px 8px", "line-height": "1.3", "min-width": "0" }}>
                            <span style={{ "min-width": "0", "overflow-wrap": "anywhere" }}>{model.label}</span>
                            <span style={{ "text-align": "right" }}>{integer.format(model.steps)} · {tokenText(knownSum(model.inputTokens, model.outputTokens))} · {statsModelCost(model)}</span>
                          </div>}
                        </For>
                      }>
                        <For each={stats().modelComparisons} fallback={<div style={{ opacity: "0.65" }}>{stats().steps > 0 ? stats().baseline?.available === true && stats().baseline.steps === 0 ? "Нет сопоставимых моделей: базовый период пуст." : stats().baseline?.available === false ? "Нет сопоставимых моделей: базовый период недоступен." : "Нет сопоставимых моделей для выбранного и базового периодов." : "Нет данных за выбранный период и базовый период."}</div>}>
                          {(comparison) => {
                            const current = () => comparison.current ?? comparison
                            const efficiency = () => current().efficiency
                            const second = () => efficiencySecondKpi(efficiency())
                            const comparable = () => modelComparisonAvailable(comparison, stats().baseline)
                            const reasons = () => assessmentReasonsText(comparison.assessment)
                            const cacheLevel = () => knownAssessmentLevel(worstAvailableAssessment([modelComponentAssessment(comparison, "cache"), modelComponentAssessment(comparison, "reuse")]))
                            return <div data-testid="quota-guard-stats-model" data-level={knownAssessmentLevel(comparison.assessment)} style={{ display: "flex", "flex-direction": "column", gap: "4px", "line-height": "1.35", padding: "6px 7px", "min-width": "0", ...assessmentSurfaceStyle(knownAssessmentLevel(comparison.assessment)) }}>
                              <div style={{ "font-weight": "600", "min-width": "0", "overflow-wrap": "anywhere" }}>{comparison.title ?? comparison.label ?? `${comparison.providerID}/${comparison.modelID}`}</div>
                              <div style={{ "font-size": "10px", opacity: "0.7", "white-space": "normal" }}>{integer.format(current().steps)} шагов · {tokenText(knownSum(current().inputTokens, current().outputTokens))} токенов · {statsModelCost(current())}</div>
                              <div data-testid="quota-guard-stats-model-current" style={{ display: "flex", "flex-wrap": "wrap", gap: "2px 8px", "font-size": "11px" }}>
                                <span style={{ "white-space": "nowrap" }}>Кэш {readShareValueText(efficiencyReadShare(efficiency()))}</span>
                                <span style={{ "white-space": "nowrap" }}>{secondKpiLabel(second()?.kind, true)} {secondKpiValueText(second())}</span>
                              </div>
                              <Show when={comparison.assessment}>
                                <div><AssessmentBadge assessment={comparison.assessment} compact /></div>
                                <Show when={reasons()}><div style={{ "font-size": "10px", opacity: "0.72" }}>{reasons()}</div></Show>
                              </Show>
                              <Show when={comparable() && knownAssessmentLevel(modelComponentAssessment(comparison, "input")) !== "gray" && modelUsageDeltaText(comparison)}>
                                <div><TrafficBadge level={knownAssessmentLevel(modelComponentAssessment(comparison, "input"))} text={`К базе: ${modelUsageDeltaText(comparison)}`} compact /></div>
                              </Show>
                              <Show when={comparable() && cacheLevel() !== "gray" && modelCacheDeltaText(comparison)}>
                                <div><TrafficBadge level={cacheLevel()} text={modelCacheDeltaText(comparison) ?? ""} compact /></div>
                              </Show>
                            </div>
                          }}
                        </For>
                      </Show>
                    </div>
                  </details>
                </Show>}
              </Show>
            </div>
          </details>
          <details
            data-testid="quota-guard-diagnostics"
            style={compactCardStyle}
            onToggle={(event: any) => {
              const open = event.currentTarget.open === true
              setDiagnosticsOpen(open)
              if (open) void loadDiagnostics(analyticsPeriod())
            }}
          >
            <summary style={{ cursor: "pointer", "font-size": "12px", "font-weight": "600" }}>Диагностика</summary>
            <div style={{ display: "flex", "flex-direction": "column", gap: "5px", "margin-top": "4px", "min-width": "0" }}>
              <div style={{ "font-size": "10px", opacity: "0.65", "line-height": "1.3" }}>Локальная история за выбранный период · без текстов диалогов · хранится до 7 дней</div>
              <Show when={diagnosticsLoading()}><div style={{ "font-size": "11px", opacity: "0.65" }}>Загрузка…</div></Show>
              <Show when={diagnosticsFailed() && !diagnosticsLoading()}><div role="status" style={{ "font-size": "11px", opacity: "0.7" }}>Диагностика сейчас недоступна.</div></Show>
              <Show when={diagnosticsOpen() && !diagnosticsLoading() && !diagnosticsFailed() && diagnostics()}>
                {(result) => <>
                  <div role="tablist" aria-label="Раздел диагностики" style={{ display: "flex", gap: "3px", "flex-wrap": "wrap" }}>
                    <button type="button" role="tab" data-testid="quota-guard-diagnostics-tab-cold" aria-selected={diagnosticsTab() === "cold"} onClick={() => setDiagnosticsTab("cold")} style={{ padding: "3px 6px", "font-size": "11px", "font-weight": diagnosticsTab() === "cold" ? "600" : "400" }}>Холодные</button>
                    <button type="button" role="tab" data-testid="quota-guard-diagnostics-tab-projects" aria-selected={diagnosticsTab() === "projects"} onClick={() => setDiagnosticsTab("projects")} style={{ padding: "3px 6px", "font-size": "11px", "font-weight": diagnosticsTab() === "projects" ? "600" : "400" }}>Проекты</button>
                    <button type="button" role="tab" data-testid="quota-guard-diagnostics-tab-timeline" aria-selected={diagnosticsTab() === "timeline"} onClick={() => setDiagnosticsTab("timeline")} style={{ padding: "3px 6px", "font-size": "11px", "font-weight": diagnosticsTab() === "timeline" ? "600" : "400" }}>Время</button>
                  </div>
                  <Show when={diagnosticsTab() === "cold"}>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "font-size": "11px" }}>
                      <strong>Холодные: {integer.format(result().coldSummary?.count ?? result().coldSteps.length)}</strong>
                      <span style={{ opacity: "0.72" }}>Обычный вход: {finiteNumber(result().coldSummary?.uncachedInputTokens) ? tokenText(result().coldSummary.uncachedInputTokens) : "нет полных данных"}</span>
                    </div>
                    <div style={{ "font-size": "10px", opacity: "0.7", "line-height": "1.3" }}>Холодный: вход ≥ {tokenText(result().coldRule.minInputTokens)} и кэш ≤ {percent.format(result().coldRule.maxCacheReadPercent)}%. Это не доказывает истечение кэша.</div>
                    <Show when={(result().coldSummary?.legacyCount ?? 0) > 0}>
                      <div style={{ "font-size": "10px", opacity: "0.7", "line-height": "1.3" }}>* В старых записях ноль может означать отсутствие данных.</div>
                    </Show>
                    <Show when={selectedColdStep()} fallback={
                      <div data-testid="quota-guard-diagnostics-cold-list" style={diagnosticListStyle}>
                        <For each={result().coldSteps} fallback={<div style={{ "font-size": "11px", opacity: "0.65" }}>Данные появятся после новых шагов.</div>}>
                          {(step) => <article style={{ "border-top": "1px solid color-mix(in srgb, currentColor 12%, transparent)", "padding-top": "4px", "font-size": "11px", "line-height": "1.35", "overflow-wrap": "anywhere" }}>
                            <div>{formatDate(step.at)} · {step.projectLabel}</div>
                            <div>{step.providerID}/{step.modelID}{step.variant ? ` · ${step.variant}` : ""}</div>
                            <div style={{ opacity: "0.7" }}>основной …{String(step.rootID).slice(-6)}{step.parentID ? ` · субагент …${String(step.sessionID).slice(-6)}` : ""}</div>
                            <div>Обычный/полный вход: {diagnosticTokenText(step, "input", step.ordinaryInputTokens)} / {diagnosticTokenText(step, "fullInput", step.inputTokens)} · кэш {diagnosticShareText(step)}</div>
                            <div>Пауза: {pauseText(step.pauseMs)}{step.noCache ? " · чтение кэша не сообщено" : ""}</div>
                            <button type="button" data-testid="quota-guard-diagnostics-cold-step" onClick={() => setSelectedColdStep(step)} style={{ "margin-top": "2px", padding: "0", border: "0", background: "transparent", color: "#4287c7", "font-size": "10px", cursor: "pointer", "text-decoration": "underline", "text-underline-offset": "2px" }}>Подробнее ›</button>
                          </article>}
                        </For>
                      </div>
                    }>
                      {(step) => <DiagnosticStepDetail step={step()} cold onBack={() => setSelectedColdStep(null)} />}
                    </Show>
                  </Show>
                  <Show when={diagnosticsTab() === "projects"}>
                    <DiagnosticStepsBrowser projects={result().projects} steps={result().steps ?? []} />
                  </Show>
                  <Show when={diagnosticsTab() === "timeline"}>
                    <div style={{ "font-size": "10px", opacity: "0.7" }}>Совпадение по времени не доказывает причину.</div>
                    <div data-testid="quota-guard-diagnostics-timeline-list" style={diagnosticListStyle}>
                      <For each={[...result().timeline].sort((a: any, b: any) => b.at - a.at)} fallback={<div style={{ "font-size": "11px", opacity: "0.65" }}>Данные появятся после новых шагов.</div>}>
                        {(event) => <div data-kind={event.kind} style={{ "border-left": `3px solid ${event.kind === "cold" ? "#d99a28" : event.kind === "compaction" ? "#9b72cf" : event.kind === "model" ? "#4287c7" : "#78838d"}`, "padding-left": "6px", "font-size": "11px", "line-height": "1.35", "overflow-wrap": "anywhere" }}>
                          <div>{formatDate(event.at)} · <strong><DiagnosticTimelineLabel event={event} /></strong></div>
                          <div style={{ opacity: "0.65" }}>{DIAGNOSTIC_KIND_RU[event.kind] ?? event.kind}{event.providerID ? ` · ${event.providerID}` : ""}{event.sessionID ? ` · …${String(event.sessionID).slice(-6)}` : ""}</div>
                        </div>}
                      </For>
                    </div>
                  </Show>
                </>}
              </Show>
            </div>
          </details>
          <footer style={{ "font-size": "11px", opacity: "0.7", "line-height": "1.35" }}>
            <Show when={data().enabled !== false} fallback={<>Режим: мониторинг выключен. </>}>
              Только предупреждения ({data().thresholds.warningPercent}% / {data().thresholds.criticalPercent}%).
            </Show> Автоматические действия отключены.
          </footer>
        </>}
      </Show>
    </div>
  )
}

function QuotaSettings(props: { ctx: any }) {
  const ui = props.ctx.ui
  const [status, setStatus] = createSignal<any>()
  const [loaded, setLoaded] = createSignal(false)
  const [failed, setFailed] = createSignal("")
  const [warning, setWarning] = createSignal(80)
  const [critical, setCritical] = createSignal(95)
  const [intervalMs, setIntervalMs] = createSignal(300000)
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)

  async function configure(input: any) {
    setFailed("")
    try {
      const next = await props.ctx.client.rpc(QuotaGuardRpc).configure(input)
      setStatus(next)
      return next
    } catch {
      setFailed("Сервер OpenCode недоступен: изменение не применено.")
      return undefined
    }
  }

  async function apply(next: boolean) {
    const before = status()?.enabled !== false
    setStatus({ ...status(), enabled: next })
    const result = await configure({ enabled: next })
    if (!result) setStatus({ ...status(), enabled: before })
  }

  async function applyProvider(id: string, value: boolean) {
    await configure({ monitoring: { [id]: value } })
  }

  async function saveThresholds() {
    setSaving(true)
    setSaved(false)
    await configure({ warningPercent: warning(), criticalPercent: critical(), refreshMs: intervalMs() })
    setSaving(false)
    setSaved(true)
  }

  onMount(async () => {
    let alive = true
    onCleanup(() => { alive = false })
    try {
      const current = await props.ctx.client.rpc(QuotaGuardRpc).status({ refresh: false })
      if (!alive) return
      setStatus(current)
      setWarning(current.thresholds?.warningPercent ?? 80)
      setCritical(current.thresholds?.criticalPercent ?? 95)
      setIntervalMs(current.refreshMs ?? 300000)
      setLoaded(true)
    } catch {
      if (alive) setFailed("Не удалось прочитать состояние мониторинга.")
    }
  })

  return (
    <ui.SettingsLayout title="Квоты LLM" description="Quota Guard: подписочные квоты провайдеров и управление мониторингом">
      <ui.SettingsSection title="Мониторинг">
        <ui.SettingsRow
          id="monitoring"
          title="Мониторинг квот"
          description="Опрос провайдеров и предупреждения в сессиях. Автоматическая остановка и смена модели всегда отключены."
        >
          <ui.Switch label="Мониторинг квот" hideLabel checked={status()?.enabled !== false} disabled={!loaded()} onChange={(next: boolean) => void apply(next)} />
        </ui.SettingsRow>
        <For each={Object.entries(status()?.monitoring ?? {})}>
          {([id, on]) => <ui.SettingsRow
            id={`provider-${id}`}
            title={`Опрос провайдера ${providerName(status(), id)}`}
            description="Выключите, чтобы не опрашивать провайдера и не показывать его карточку с данными."
          >
            <ui.Switch label={`Опрос ${id}`} hideLabel checked={on === true} disabled={!loaded() || status()?.enabled === false} onChange={(next: boolean) => void applyProvider(id, next)} />
          </ui.SettingsRow>}
        </For>
        <ui.SettingsRow
          id="thresholds"
          title="Пороги и интервал"
          description="Процент предупреждения, критический процент и интервал автоматического опроса."
        >
          <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
            <input data-testid="quota-settings-warning" type="number" min="1" max="100" value={warning()} disabled={!loaded() || saving()} onChange={(event: any) => setWarning(Number(event.currentTarget.value))} style={{ width: "70px", padding: "4px 6px" }} />
            <input data-testid="quota-settings-critical" type="number" min="1" max="100" value={critical()} disabled={!loaded() || saving()} onChange={(event: any) => setCritical(Number(event.currentTarget.value))} style={{ width: "70px", padding: "4px 6px" }} />
            <select data-testid="quota-settings-interval" value={String(intervalMs())} disabled={!loaded() || saving()} onChange={(event: any) => setIntervalMs(Number(event.currentTarget.value))} style={{ padding: "4px 6px" }}>
              <option value="60000">1 мин</option>
              <option value="300000">5 мин</option>
              <option value="900000">15 мин</option>
              <option value="3600000">60 мин</option>
            </select>
            <button type="button" data-testid="quota-settings-save" disabled={!loaded() || saving()} onClick={() => void saveThresholds()} style={{ padding: "5px 10px", cursor: "pointer" }}>
              {saving() ? "Сохранение…" : "Сохранить"}
            </button>
            <Show when={saved()}>
              <span style={{ "font-size": "12px", opacity: "0.7" }}>Сохранено</span>
            </Show>
          </div>
        </ui.SettingsRow>
        <ui.SettingsRow
          id="panel"
          title="Панель квот"
          description="Открывается в сессии: «+» в боковой области → «Квоты LLM», значок квот в заголовке окна или команда «Квоты LLM: открыть панель». Переключение модели сессии — только кнопкой в панели."
        />
      </ui.SettingsSection>
      <Show when={failed()}>
        <ui.SettingsSection title="Состояние">
          <div role="alert">{failed()}</div>
        </ui.SettingsSection>
      </Show>
    </ui.SettingsLayout>
  )
}

export default Plugin.define({
  setup(ctx) {
    const [status, setStatus] = createSignal<any>()

    const tab = {
      id: "quota",
      get title() { return "Квоты LLM" },
      closable: "compact" as const,
      fallback: true,
    }

    const panelKey = () => `${ctx.id}:quota`

    const open = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(panelKey(), session)
    }

    const isOpen = () => {
      try {
        const session = ctx.sessions.current()
        return !!session && ctx.layout.state(panelKey(), session) !== "closed"
      } catch {
        return false
      }
    }

    async function sync(refresh = false) {
      try {
        setStatus(await ctx.client.rpc(QuotaGuardRpc).status({ refresh }))
      } catch {}
    }

    void sync(false)
    const poll = setInterval(() => void sync(false), 60_000)
    const offEvents = ctx.client.rpc(QuotaGuardRpc).events.on("updated", (event: any) => setStatus(event?.data?.status))

    ctx.add(Panel, {
      id: "quota",
      region: "side",
      width: "narrow",
      list: (input) => input.open.includes("quota") ? [tab] : [],
      render: () => <QuotaView ctx={ctx} onChanged={setStatus} />,
      focus: () => void sync(false),
    })

    ctx.add(MenuItem, (): MenuItem => ({
      menu: "session.panel",
      id: "open",
      title: "Квоты LLM",
      description: "Использование и время сброса",
      icon: "status",
      opened: isOpen(),
      run: open,
    }))

    ctx.add(TitlebarItem, (): TitlebarItem | undefined => {
      const current = status()
      if (!current) return { id: "quota", icon: "status", title: "Квоты LLM: загрузка…", label: "Квоты …", run: open }
      const worst = worstPercent(current)
      const label = current.enabled === false
        ? "Квоты: выкл"
        : worst === undefined ? "Квоты: —" : `Квоты: ${percent.format(worst)}%`
      return {
        id: "quota",
        icon: "status",
        label,
        title: current.enabled === false
          ? "Квоты LLM: мониторинг выключен — открыть панель"
          : "Квоты LLM: открыть панель",
        pressed: isOpen(),
        run: open,
      }
    })

    ctx.add(Command, (): Command => ({
      id: "open",
      title: "Квоты LLM: открыть панель",
      keywords: "quota квоты usage limits провайдеры",
      run: open,
    }))

    ctx.add(Command, (): Command => ({
      id: "toggle-mode",
      title: "Квоты LLM: включить или выключить мониторинг",
      keywords: "quota квоты мониторинг режим warnings включить выключить",
      run: async () => {
        const current = status()
        const next = current ? current.enabled === false : true
        try {
          setStatus(await ctx.client.rpc(QuotaGuardRpc).configure({ enabled: next }))
        } catch {}
      },
    }))

    ctx.add(SettingsPage, {
      id: "quota",
      icon: "status",
      get title() { return "Квоты LLM" },
      entries: [
        { id: "monitoring", title: "Мониторинг квот", description: "Включить или выключить опрос провайдеров и предупреждения", keywords: "quota квоты мониторинг режим" },
        { id: "panel", title: "Панель квот", description: "Как открыть панель в сессии", keywords: "panel панель квоты" },
      ],
      render: () => <QuotaSettings ctx={ctx} />,
    })

    return () => {
      clearInterval(poll)
      offEvents?.()
    }
  },
})
