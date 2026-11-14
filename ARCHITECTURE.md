# Архитектура Quota Guard

Версия 0.14.0. Все схемы — Mermaid (рендерятся на GitHub и в большинстве Markdown-просмотрщиков).

## 1. Компоненты

```mermaid
flowchart TB
  subgraph Desktop["OpenCode Desktop (Electron)"]
    GUI["GUI-бандл плагина<br/>dist/gui-experimental.cjs<br/>(Solid JS)"]
    Host["Хост GUI: Panel / MenuItem /<br/>TitlebarItem / Command / SettingsPage"]
    GUI --- Host
  end

  subgraph Server["OpenCode server (background service)"]
    Index["index.js<br/>Plugin.define setup()"]
    Core["core.js<br/>createQuotaGuard:<br/>снимок, таймер, пороги,<br/>предупреждения, настройки"]
    Meter["meter.js<br/>createTokenMeter:<br/>события шагов, токены/с"]
    Stats["stats.js<br/>readUsageStats:<br/>день/неделя, модели, стоимость"]
    Diag["diagnostics.js<br/>журнал шагов, проекты,<br/>квоты и временная шкала"]
    RpcSrv["rpc-server.js<br/>registerQuotaRpc()"]
    RpcDef["rpc.js<br/>Rpc.define: схемы,<br/>ошибки, событие updated"]
    subgraph Fetchers["providers.js — read-only fetchers"]
      F1["OpenAI<br/>wham/usage + credits"]
      F3["Kimi Ultra<br/>/usages + /me"]
      F4["Kimi Ultra Aprobo<br/>/usages + /me"]
    end
    Storage[("plugin-storage<br/>settings")]
    Journal[("JSONL diagnostics<br/>7 дней / 10 МБ")]
    Hook["prompt-hook:<br/>синтетические предупреждения"]
    Cmd["command /quota-status"]
    Tool["tool quota.status (read-only)"]
  end

  subgraph Providers["Внешние API и read-only агрегаты"]
    P1["chatgpt.com"]
    P3["api.kimi.ai<br/>два независимых аккаунта"]
    StatsApi["OpenCode<br/>experimental/session/stats"]
    SessionApi["OpenCode<br/>events / sessions / projects"]
  end

  TUI["TUI: /quota-status,<br/>сторонний usage-monitor (не изменяется)"]

  Host -->|"ctx.client.rpc(...)"| RpcSrv
  RpcSrv --> Core
  Index --> Core
  Index --> Meter
  Index --> Diag
  Index --> RpcSrv
  Meter --> RpcSrv
  RpcSrv --> Stats
  RpcSrv --> Diag
  Stats --> StatsApi
  Core -->|"onRefreshed(status)"| Diag
  SessionApi -->|"read-only events/metadata"| Diag
  Diag --> Journal
  RpcSrv --- RpcDef
  Core --> Fetchers
  Core <--> Storage
  Core --> Hook
  Core --> Cmd
  Core --> Tool
  F1 --> P1
  F3 --> P3
  RpcSrv -->|"events.updated {status}"| GUI
  Cmd --> TUI
  Hook -->|"текст в сессию"| TUI
```

Принципы:

- **Один источник истины** — снимок (`status`) в `core.js`. GUI, команда, tool и RPC читают только его.
- **Fetchers read-only**: только GET-запросы квот; никаких мутаций у провайдеров.
- **Мутации только явные**: `configure` (настройки), `switchModel` (модель сессии). Автоматических мутаций нет.
- **Секреты не покидают server**: fetchers читают auth-store/env/storage; в снимок попадают только коды ошибок, проценты и агрегаты кредитов.
- **Диагностика не мутирует OpenCode**: собственный JSONL — единственная новая запись; whitelist технических скаляров, cross-process lock, дедупликация, 7 дней / 10 МБ, fail-open.

## 2. Жизненный цикл и таймер

```mermaid
sequenceDiagram
  participant H as OpenCode host
  participant I as index.js
  participant C as core.js
  participant S as storage
  participant F as fetchers
  participant G as GUI

  H->>I: setup(ctx)
  I->>C: createQuotaGuard(ctx, fetchers, onUpdated)
  C->>S: load settings {enabled, monitoring, thresholds, refreshMs}
  C->>C: startTimer(refreshMs) если enabled
  I->>H: ctx.rpc.register(RpcDef, handlers)
  I->>I: emitUpdated = registration.events.emit
  loop каждые refreshMs (если enabled)
    C->>F: refresh() только включённые провайдеры
    F-->>C: снимки провайдеров
    C->>C: getStatus() + stale-проверка
    C-->>I: onRefreshed(status) → diagnostics.recordQuota
    C-->>I: onUpdated(status)
    I-->>G: events.updated {status}
  end
  H->>I: dispose()
  I->>C: stopTimer()
  I->>H: registration.dispose()
```

Выключенный режим (`enabled=false`): таймер остановлен, `refresh()` не делает запросов, prompt-hook молчит; `getStatus()` возвращает последний снимок с `mode:"off"`.

## 3. Предупреждения (prompt-hook)

```mermaid
flowchart LR
  A["Сообщение пользователя в сессии"] --> B{"enabled?"}
  B -- нет --> Z["без изменений"]
  B -- да --> C{"снимок свежий?<br/>(maxSnapshotAge)"}
  C -- нет --> Z
  C -- да --> D["окна с usedPercent >= warningPercent"]
  D --> E{"дедупликация:<br/>session+provider+window+reset+severity"}
  E -- уже было --> Z
  E -- новое --> F["синтетическое предупреждение (RU):<br/>провайдер, окно, %, сброс,<br/>«автоматические действия отключены»"]
  F --> G["добавляется к prompt; модель/сессия не меняются"]
```

Пороги: `warningPercent` (80 по умолчанию) и `criticalPercent` (95). `limitReached` всегда считается критическим. Дедупликация сбрасывается при новом `resetAt` или повышении уровня.

## 4. Ручное переключение модели

```mermaid
sequenceDiagram
  participant U as Пользователь
  participant G as GUI панель
  participant R as rpc-server
  participant S as ctx.session
  participant P as ctx.provider / ctx.model

  U->>G: открывает панель
  G->>R: models {sessionID}
  R->>S: session.get({sessionID}) → current {providerID, id}
  R->>P: provider.list() (имена) + model.list() (каталог)
  R-->>G: {current, options[≤200]}
  U->>G: выбирает модель + «Переключить модель сессии»
  G->>R: switchModel {sessionID, providerID, modelID}
  R->>S: session.switchModel({sessionID, model:{id, providerID}})
  S-->>R: ok
  R-->>G: {switched:true, providerID, modelID}
  G-->>U: отметка «Модель сессии переключена»
  Note over R,S: Только явный вызов.<br/>Автоматического failover нет.
```

Ошибки: `session_not_found` (сессия не существует), `switch_failed` (провайдер/хост отказал). Кнопка в GUI неактивна, пока выбранная модель совпадает с текущей.

## 5. Модель данных снимка

```mermaid
classDiagram
  class Status {
    +boolean enabled
    +string mode "warn" | "off"
    +Thresholds thresholds
    +Map monitoring
    +number refreshMs
    +number lastRefreshAt
    +boolean stale
    +AutomaticActions automaticActions
    +Provider[] providers
    +TokenRate[] rates
  }
  class Thresholds { +number warningPercent +number criticalPercent }
  class AutomaticActions { +boolean interrupt=false +boolean switchModel=false }
  class Provider {
    +string id
    +string displayName
    +string status ready|partial|missing-auth|forbidden|error|disabled
    +string statusText
    +string plan
    +number fetchedAt
    +Window[] windows
    +Credits credits
  }
  class Window {
    +string id
    +string label
    +number usedPercent
    +number resetAt
    +boolean limitReached
  }
  class Credits {
    +boolean hasCredits
    +boolean unlimited
    +boolean overageLimitReached
    +number balance
    +number[] approxLocalMessages
    +number[] approxCloudMessages
  }
  Status --> Thresholds
  Status --> AutomaticActions
  class TokenRate {
    +string sessionID
    +string providerID
    +string modelID
    +boolean active
    +boolean ratesCurrent
    +number sessionInputTokens
    +number sessionOutputTokens
    +number inputTokens
    +number outputTokens
    +number uncachedInputTokens
    +number cacheReadTokens
    +number cacheWriteTokens
    +number reasoningTokens
    +number inputPerSecond
    +number outputPerSecond
    +number firstTokenMs
    +number outputDurationMs
  }
  Status --> Provider
  Status --> TokenRate
  Provider --> Window
  Provider --> Credits
```

`stale = now - lastRefreshAt > maxSnapshotAge` (6 ч по умолчанию): предупреждения не выдаются по устаревшим данным, панель помечает их как возможные устаревшие. `credits` заполняется только для ChatGPT (поле `credits` ответа `wham/usage`): баланс кредитов плана и ориентировочные диапазоны сообщений; это кредиты подписки, а не денежный баланс OpenAI Platform.

`rates[]` заполняется `meter.js` из read-only событий `session.step.*` и инициализируется по последним assistant-сообщениям текущего location. RPC и событие `updated` передают последние записи `getRates`, чтобы закреплённые карточки не исчезали после завершения шага. GUI в карточке провайдера показывает все его активные шаги либо один последний замер; контейнер остаётся даже с заглушкой «Нет измерений». Отдельный блок прочих LLM фильтрует только `active=true`. `session.usage.updated` обновляет `sessionInputTokens` / `sessionOutputTokens` (вход включает кэш, выход — reasoning). Входная скорость = `input + cache.read + cache.write` за время до первого токена; выходная = `output + reasoning` за время потока. Это средняя скорость завершённого шага, а не мгновенная. У активного шага без его финальных токенов показываются предыдущие метрики с `ratesCurrent=false`; `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` описывают тот же завершённый шаг. Вход шага не называется текущим контекстом. Тексты сообщений в снимок не включаются.

`stats` — отдельный RPC, вызываемый только при раскрытии «Статистики и эффективности» или смене периода. `stats.js` через официальный `@opencode/client` и `service.discover` вызывает read-only `experimental/session/stats` с `tools:"none"`. Текущий `day` — локальная полночь до now, его база — предыдущие календарные сутки до того же wall-clock времени; текущий `week` — 7×24 ч, база — непосредственно предшествующие 7×24 ч. Запросы current/baseline независимы; успешный пустой baseline — валидный нулевой агрегат, failed/missing — unavailable. Диапазоны полуоткрытые.

Нормализация использует только сообщённые агрегаты, без оценки покрытия по отдельным записям. Неизвестные значения — `null`, не ноль. Взаимоисключающие U/R/W: U=`input-cache.read-cache.write`, R=`cache.read`, W=`cache.write`; полный вход=U+R+W, полный выход=`output+reasoning`. `readShare=R/(U+R+W)`, `amortization=R/W` — токеновые потоки окна, не lifetime одной записи. Нулевой знаменатель даёт `null`/«—». GUI показывает числитель/знаменатель, состав и сравнения только внутри одного provider+model. Абсолютное отклонение readShare хранится как доля и при отображении умножается на 100 (п.п.). Качество, экономия денег и экономия квоты не выводятся. Область — все проекты OpenCode; Diagnostics не смешивается с этой базой. Собственной базы/истории и текстов сообщений для stats нет.

Каждое сравнение модели содержит `deltas` и независимые `assessment.components.input/cache/reuse` со своими `level`/`reasons`; общий уровень — худший доступный, серый только если серы все компоненты. GUI агрегирует каждый компонент по всем моделям, а не выбирает одну худшую модель для всех KPI. Отсутствующая/пустая база, отсутствие модели в периоде и недостаточные/частичные данные дают серый статус с причиной; числовые дельты в этом состоянии не показываются. Для сопоставимых non-gray компонентов дельты сохраняются. Объём выхода сравнивается как `current.outputTokens` с `baseline.efficiency.outputTokens` и имеет отдельный светофор объёма, не качества. RPC включает `assessment.components` и верхнеуровневый `deltas.secondKpi`; `available=false` текущего периода отображается как недоступность с retry, а не как нулевая статистика.

`diagnostics` — on-demand RPC над существующим локальным журналом, без refresh провайдеров и stats. `diagnostics.js` подписывается только на события своего location, а общий JSONL объединяет location; записи дедуплицируются перед агрегацией. `step.start` и `step.end` соединяются по assistant message ID; модель при отсутствии start берётся из сохранённого assistant-сообщения, не из текущей модели сессии. Компакции являются маркерами и никогда не добавляют свои токены/стоимость к шагам.

Для новых шагов аддитивно сохраняются reasoningTokens и tokenCompleteness (input/output/reasoning/cacheRead/cacheWrite); старые записи имеют completeness=null, без миграции и задней реконструкции. В сравнение моделей попадают только полные корректные пары start/end одной модели. Агрегаты включают cacheWrite/reasoning; RPC `steps[]` ограничен 200 и сортирован по полному входу desc, затем at desc/id. GUI показывает project→session/model→step и подробную карточку; legacy-пробелы явно обозначаются.

Холодный шаг — эвристика `inputTokens >=100000` и `cacheReadPercent <=20`; `noCache` отдельно означает нулевое сообщённое чтение. Пауза — `startedAt` текущего шага минус завершение предыдущего в том же сеансе, иначе `null`. Иерархия строится по `projectID`, `parentID`, `rootID`: project/root totals суммируют фактические различные шаги, а собственные модели root исключают субагентов. Пути и названия сеансов не сохраняются; имена проектов разрешаются read-only при чтении.

Квоты пишутся только через `onRefreshed` для готовых ответов с `fetchedAt`, не из meter/cached/error публикаций. Проценты не суммируются. На шкале скрываются повторные значения с изменением <0,05 п.п.; различие `resetAt` до 2 с считается дрожью округления. Delta выражается в процентных пунктах, снижение/смена окна не выдаётся за рост. `plugin.setup` отмечает загрузку/перезагрузку, `process.started` — один маркер хост-процесса; причина перезапуска не утверждается. Все совпадения на шкале только временные.

## 6. Карта файлов

| Файл | Роль |
| --- | --- |
| `index.js` | точка входа: fetchers, core, meter, diagnostics, RPC, событие `updated`, cleanup |
| `core.js` | снимок, таймер, настройки, пороги, prompt-hook, `/quota-status`, tool; `onRefreshed` отдельно от `onUpdated` |
| `diagnostics.js` | локальный JSONL с Flock, события, cold/pause, иерархия, квоты и timeline; retention/cap, дедупликация, fail-open |
| `meter.js` | подписка на `session.step.*` и `session.usage.updated`, инициализация, расчёт скорости и накопленных токенов, активный список `getActiveRates` |
| `stats.js` | read-only current/baseline периоды, U/R/W и KPI, null-семантика, независимые input/cache/reuse-оценки и model deltas |
| `providers.js` | парсеры и fetchers OpenAI (окна + кредиты) / двух независимых Kimi-аккаунтов (окна + план, разные integration/env без общего ключа); чтение auth-store/env/storage |
| `rpc.js` | `Rpc.define`: схемы input/output (включая `credits`, `rates`, `assessment.components`, `deltas.secondKpi`), типизированные ошибки, событие `updated` |
| `rpc-server.js` | обработчики RPC: status/configure/models/stats/diagnostics/switchModel |
| `src/gui.tsx` | Solid GUI: компактные квоты и CSS-светофоры, состав шага, Stats с независимыми компонентами/gray-семантикой, Diagnostics drilldown/время, управление |
| `vite.config.ts` | сборка GUI (`gui()` preset) → `dist/gui-experimental.cjs` |
| `test/*.test.js` | node:test — 80 тестов: парсеры, независимые Kimi credentials/endpoints, скорость, KPI/null/baseline, component assessments/model deltas, diagnostics storage/aggregation/steps, RPC, инварианты |
| `TEST-PLAN.md` | универсальные AUTO/RPC/Desktop/fixture-проверки, роли QA/приёмщика и протокол публикации |

## 7. Границы ответственности

- Quota Guard **не** управляет биллингом и **не** знает денежных балансов API-платформ (OpenAI Platform, DeepSeek и т.п.) — только подписочные окна и кредиты плана ChatGPT, а также окна Kimi.
- TUI-сайдбар Usage принадлежит стороннему `opencode-usage-monitor`; Quota Guard добавляет Desktop GUI, предупреждения и управление, не вмешиваясь в него.
- Автоматический failover/остановка сознательно отсутствуют: это продуктовое решение безопасности, а не недоделка.
