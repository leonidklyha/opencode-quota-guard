# Справочник: провайдеры квот и подключение LLM

Подробное руководство «что и как делать» для каждого провайдера Quota Guard 0.13.0: откуда берутся квоты, как подключить учётные данные, как проверить результат и что означают ошибки. Все запросы квот — read-only GET; плагин ничего не меняет у провайдеров.

Состав карточек: **ChatGPT (OpenAI)**, **Kimi Ultra** и **Kimi Ultra Aprobo**. Две Kimi-подписки независимы и не суммируются. Другие провайдеры (Z.AI/GLM, Qwen, платный Moonshot API и т.п.) из мониторинга квот исключены.

Общая проверка после любого подключения:

```sh
opencode api post '/api/rpc/quota-guard/status?location%5Bdirectory%5D=<URL-encoded путь проекта>' \
  --data '{"input":{"refresh":true}}'
```

В ответе `output.providers[]`: `status`, `plan`, `windows[]` (`usedPercent`, `resetAt`, `limitReached`), у ChatGPT также `credits`. В Desktop то же видно в панели «Квоты LLM» после «Обновить».

---

## 1. ChatGPT (OpenAI, подписка Plus/Pro)

**Что показывает:** окна `primary`/`secondary` (обычно 5 ч и неделя), `plan_type` (plus/pro/…), `limit_reached`, **кредиты плана** (`credits`).

**Endpoint:** `GET https://chatgpt.com/backend-api/wham/usage` с заголовками `Authorization: Bearer <access>` и `ChatGPT-Account-Id: <accountID>`.

**Требование к учётным данным:** активный OAuth OpenCode с `metadata.accountID` (или `accountId`). Такой credential даёт вход **Codex browser (legacy)**. Вход «Sign in with ChatGPT» (token-sharing) accountID **не содержит** — квоты не заработают.

**Подключение:**

1. В OpenCode: `/connect` → OpenAI → **Add account** → **Codex browser (legacy)**.
2. Завершить OAuth в браузере (вход в свой аккаунт ChatGPT).
3. Проверить: `opencode auth list` — активная запись OpenAI с методом `chatgpt-browser`.
4. `status refresh:true` → `openai.status = ready`, `plan = pro|plus|…`.

### 1.1. Кредиты плана

Ответ `wham/usage` содержит объект `credits`:

| Поле API | Поле снимка (`providers[].credits`) | Смысл |
| --- | --- | --- |
| `has_credits` | `hasCredits` | у плана есть пул кредитов |
| `unlimited` | `unlimited` | безлимитный пул (баланс не показывается) |
| `balance` (строка) | `balance` (число) | остаток кредитов плана |
| `approx_local_messages` | `approxLocalMessages` | ориентировочный диапазон локальных сообщений на остаток |
| `approx_cloud_messages` | `approxCloudMessages` | ориентировочный диапазон облачных сообщений на остаток |
| `overage_limit_reached` | `overageLimitReached` | достигнут лимит перерасхода |

В панели карточка ChatGPT показывает строку «Кредиты плана: баланс N» (или «без лимита»), диапазоны сообщений и предупреждение «Лимит перерасхода достигнут». Если API не вернул `credits`, строка просто отсутствует — это не ошибка.

**Важно:** кредиты плана ChatGPT ≠ денежный баланс OpenAI Platform (API-ключи). Биллинг Platform этим плагином не читается.

**Диагностика:**

| statusText | Значение / действие |
| --- | --- |
| `OAuth credential missing` | нет активного OAuth OpenAI → `/connect` |
| `OAuth expired` | истёк access → повторный `/connect` (refresh выполняется хостом) |
| `OAuth account ID missing` | вход token-sharing без accountID → переподключить через **Codex browser (legacy)** |
| `forbidden` | 401/403 от chatgpt.com → проверить аккаунт/подписку, повторный вход |
| `usage windows unavailable` | ответ без окон → временная проблема API, повторить позже |

---

## 2. Kimi Ultra и Kimi Ultra Aprobo (две подписки Kimi)

**Что показывает каждая карточка:** свои окна `5 ч`, `7 дн`, `Месяц (всего)`, `Месяц (код)` и план подписки (`Ultra`, …). Значения двух аккаунтов не складываются.

**Endpoints обеих подписок:**

- `GET {base}/usages`, по умолчанию base = `https://api.kimi.ai/coding/v1`; `Authorization: Bearer <key>`. Ответ принимается в двух формах: `data.quota.usages` (camelCase: `limit5h`, `monthTotal`, `monthCode`, `usedRatio`, `resetAt`) и корневой `usages` (snake_case: `limit_5h`, `used_ratio`, `reset_time`). Запасной источник — `limits[]` с `detail.limit/used/resetTime`.
- `GET {base}/me` → `user_level_name` — **источник плана подписки**. Эндпоинты `/user`, `/profile`, `/subscription`, `/plan` не существуют (404) — не использовать.

**Независимое подключение:**

| Карточка / ID | Integration OpenCode | Env credential | Env base URL |
| --- | --- | --- | --- |
| Kimi Ultra / `kimi` | `kimi-code-plan-global` (или `kimi-code`, `kimi`) | `KIMI_API_KEY` | `KIMI_CODE_BASE_URL` |
| Kimi Ultra Aprobo / `kimi-aprobo` | только `kimi-aprobo` | `KIMI_APROBO_API_KEY` | `KIMI_APROBO_BASE_URL` |

Aprobo никогда не использует ключ основной подписки, даже если её integration доступен. Если свой integration отсутствует, используется только собственная переменная окружения. Добавление второго аккаунта не меняет модель сессии: выбор выполняется вручную через «Управление → Модель текущей сессии».

**Проверка:** `status refresh:true` → `kimi.status = ready` и `kimi-aprobo.status = ready`, у каждой свой `plan`, проценты и сбросы.

**Диагностика:**

| statusText | Действие |
| --- | --- |
| `Kimi Code credential missing` | подключить integration основной подписки или задать `KIMI_API_KEY` |
| `Kimi Aprobo credential missing` | подключить integration `kimi-aprobo` или задать `KIMI_APROBO_API_KEY`; ключ основной подписки не подставляется |
| `forbidden` | ключ недействителен → перевыпустить в кабинете Kimi |
| `usage windows unavailable` | нет ни `usages`, ни `limits` → проверить тариф |
| план не отображается | `/me` недоступен (403/404) — окна квот при этом работают; план появится после восстановления доступа |

**Примечание:** `booster_wallet` в ответе `/usages` — бонусный кошелёк, **не** подписочная квота; плагин его не учитывает.

---

## 3. Локальные модели (Ollama и др.)

Квот и биллинга нет — провайдер не опрашивается и в панели не отображается. Это ожидаемое поведение.

## 4. Добавление нового провайдера (для разработчиков)

1. В `providers.js`: `parse<Name>Usage(raw)` (чистая функция) + `create<Name>Fetcher(ctx)` (read-only GET, коды ошибок вместо секретов).
2. В `index.js`: добавить fetcher в карту (с уважением `ctx.options.providers.<id> === false`).
3. В `test/`: тесты парсера и fetcher'а (стаб `globalThis.fetch`).
4. GUI и RPC менять не нужно: карточка и переключатель «Опрос: …» появляются автоматически из снимка.
5. Обновить этот справочник и таблицу в README.

## 5. Общие правила безопасности

- Не передавайте токены/ключи в аргументах команд, которые попадают в логи shells; используйте RPC-тело или env.
- Не коммитьте `opencode.json`, auth-export, storage-файлы и скриншоты с токенами.
- Ошибки квот не должны блокировать работу сессии: плагин деградирует до `missing-auth`/`error` и продолжает работать с остальными провайдерами.
