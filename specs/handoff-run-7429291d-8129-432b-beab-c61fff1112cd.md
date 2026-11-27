<!-- arh-w-dev run:run-7429291d-8129-432b-beab-c61fff1112cd handoff:separator-empty -->
<!-- arh-w-dev run:run-7429291d-8129-432b-beab-c61fff1112cd handoff:begin -->
# Handoff: run-7429291d-8129-432b-beab-c61fff1112cd

Status: as-built / current

Next: open the s8 PR into `selfhost` (PR open pending), then owner review and merge; s8 is not merged, not deployed and not accepted by the owner. After the merge: the backlog moves listed in the s8 section. Owner real-iPhone keyboard check of s6 and visual acceptance of s3/s4/s5 on production still pending.

Current segment: s8 (admin and public pages, removal of non-GET aliases), branch `feat/ui-redesign-s8` off `selfhost` `b07f8b6`, HEAD `ce009a4`; tasks s8-T1…T8 committed, branch checks and whole review passed; s1–s7 done and deployed (s7: PR #8, prod `selfhost` `b07f8b6`, 2026-11-27).

## Summary

Run run-7429291d-8129-432b-beab-c61fff1112cd: Редизайн пользовательского интерфейса Readfine: визуальный язык shadcn через Basecoat (HTML/Jinja-порт без React) поверх FastAPI + Jinja2 + HTMX, анимации anime.js 4 + View Transitions, миграция Tailwind 3.4 → 4, новая информационная архитектура (Читать / Источники / Ассистент / Настройки, палитра ⌘K, единая AI-панель, мобильная навигация, undo-тосты). Макеты: scratchpad/readfine-redesign; прототип: https://claude.ai/artifact/BsuMQ732ksD3waLJfoY6Qa.. Stage: s8 PR open pending.

### Segment s3 (merged, PR #3, 95fdb64)

- Оболочка и навигация: четыре зоны сайдбара, меню аккаунта и офлайн-зеркало, палитра ⌘K / Ctrl+K и `/` на странице чтения, пять вкладок телефона и сайдбар-шторка, диалог клавиш, `ui/shell.js`, единая система тостов `RFToast`.
- По решению владельца удаление лент, меток и фильтров отложено на 10 секунд с Undo: `ui/pending.js` и `POST /settings/deletes`; схема и тема приложения остаются на устройстве. Закрыты хвосты s2 по URL-схемам, `alert_html`, токенам и тёмным разделителям таблиц.
- 12 задач (11 исходных и одобренная T12 «Сверка и доводка»). По result-s3 на `6569cf2`: pytest 3894 + 1 известный нестабильный лексический тест, зелёный при перезапуске; npm 486/486; оболочка Chrome 6/6; layout A 32/32, B 32/32 против `4ffd84e`; Docker-сборка; итоговое ревью без blocker/major. Каждый e2e-спек был зелёным хотя бы в одном прогоне, logout flake сохранён в backlog. Визуальная приёмка владельцем ожидается.

### Segment s4 (merged, PR #5, b6ec385)

- Зона «Читать»: липкая шапка и меню «Вид», чипы папок, строки списка и скелетоны; панель статьи, serif-заголовок, AI-вкладки Кратко / Контекст / «Спросить», прогресс и плавающая панель телефона; `ui/read.js` со свайпами и Undo-тостами для массового прочтения и архива; офлайн-зеркало, баннер и страница на токенах. Исправлены переносы s3: клавиши списка при открытом меню и поиск ошибки чата через `data-chat-error`.
- Решения владельца Q1–Q4 (2026-11-23): Q1 — подтверждение массового прочтения только офлайн; Q2 — полноэкранная статья на телефоне только при отсутствии сохранённого выбора; Q3 — «Filter from this source» отсутствует в s4, перенесено в s7; Q4 — выбор «Вид» на аккаунт, плотность по типу устройства (телефон / desktop).
- `POST /htmx/articles/mark-read/undo`: окно 10 минут, отмена только собственных массовых прочтений с данной меткой времени. Офлайн-массовое прочтение без Undo. Версия офлайн-снимков 6 ещё не выпущена; в T6 хеш перезакреплён без подъёма до 7.
- 6 задач в 3 волнах. По result-s4 на `bafb1c1`: pytest 4030 (временная БД), npm 515/515, e2e Chrome 32 + 1 `fixme` (зона «Читать» 5/5), layout A 32/32 и B 32/32 против `95fdb64`; CSS, DOM-контракт (474), generated/drift checks свежие; Docker-сборка, одна голова миграций. Мутационные проверки пропущены: нет инструмента и настройки. Визуальная приёмка владельцем ожидается; эти проверки здесь не повторялись.
- Источники: result-s3.md, result-s4.md и s4-carry.md в `/var/tmp/claude-ssalamatov-recover/`; s3-carry.md раскрывает перечисленные там замечания s3. Решения Q1–Q4: [план s4](../docs/arh-w-dev/plans/2026-11-21-ui-redesign-s4-read-plan.md), раздел Open questions for the owner; общий контекст: [дизайн](../docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md). Merge SHA и ожидаемая приёмка — из текущего брифа; result-файлы написаны до слияний.

### Segment s5 (merged, PR #6, d6a4f93; deployed 2026-11-25)

- Зона «Источники»: общий лист добавления, правки, OPML и разбора страницы с full-page fallback; поиск ленты по сайту и кандидаты, таблица со счётчиками непрочитанного, папками и меню действий, переименование и перенос. Ошибки валидации сохраняют безопасные введённые значения; Sources online-only, запросы блокируются офлайн, отписки не ставятся в офлайн-очередь.
- Отписка через `RFPending` с 10 секундами Undo; при переходе офлайн ожидающие отписки отменяются. Канонические адреса `/sources`, `/sources/add`, `/sources/opml`, `/sources/scrape`; старые GET дают 308 с сохранением параметров, non-GET остаются алиасами до s8. Офлайн-снимок остаётся версии 6, хеш `60ff43c1c5f70e34` не менялся; упоминание «ещё не выпущена» в s4 выше относится к состоянию до деплоя.
- План/факт: 6 задач в 3 волнах по [плану s5](../docs/arh-w-dev/plans/2026-11-21-ui-redesign-s5-sources-plan.md). Волна 1: T1 лист/добавление `1e74578`, T2 таблица `704b481`, T3 правка/OPML/разбор `72a1e7a`; волна 2: T4 Undo-отписка `7d50701`, T5 маршруты `83e051b` / `cce784a`; волна 3: T6 CSS/контракт/e2e/визуал/доки `55c82d6` / `63078e9`. Доработки T1–T5 по ревью и проверкам; T6 последовательно ужесточил DB guard в `78d803b`, `5ea7258`, `f668b38`. Устаревшие подтверждения T1–T5 после T6 обновлены оркестратором по выбору владельца; whole review независимое.
- По result-s5 на продуктовом дереве `f668b38`: pytest 4080 на временной БД, npm 588/588 (Node 24), Sources Chrome 5/5 и WebKit 5/5; WebKit OPML export проверен сетевым ответом. Generated/CSS/DOM/token/class/colour/offline-drift checks чистые; Docker-сборка, одна голова миграций 0131, чистое слияние, whole review без замечаний. Layout A 32/32 строго, B 32/32 структурно; галерея 36 страниц без сбоев и тёмных пятен на `63078e9`, позже менялись только тесты/e2e/конфиги. Мутационные проверки пропущены: нет инструмента и настройки для стека. Проверки здесь не повторялись.
- CI после открытия PR #6 выявил отсутствие `backend/.venv` для двух Sources template tests. Head `10cc246` меняет только `.github/workflows/ci.yml`: frontend job устанавливает Jinja2 в venv; по result-s5 дельта-интеграция и дельта-ревью прошли, GitHub CI frontend/docker/test зелёный. Merge в `selfhost` — `d6a4f93`.
- Решения/условия продолжения: один запрос удаления, без chunking, лимит 50; >50 → 422 с восстановлением строк, выбор владельца «оставить или делить» открыт. `npm run test:e2e` и `npm run test:visual` требуют явный `E2E_DATABASE_URL`: loopback, явный порт не 4250, БД `readfine_e2e`, без query/fragment; проверка до сервера, миграций и сидов. «Filter from this source» остаётся в s7. S4W-F1/F2 и визуальная приёмка s3/s4/s5 открыты, владелец проверяет prod.
- Деплой по брифу: s1–s4 ранее на `b6ec385`, теперь s1–s5 на `selfhost` `d6a4f93` (2026-11-25). Rollback: `/var/backups/claude-ssalamatov/readfine-predeploy-20261125T090227Z`, image `readfine-app:rollback-b6ec3856`, expiry 2026-12-02; состояние backup/cleanup здесь не проверялось. Источники: `/var/tmp/claude-ssalamatov-recover/result-s5.md` (до слияния/деплоя), план s5, `git log b6ec385..d6a4f93`; сведения о деплое и prod-дефекте — из брифа. Далее s6 (сводка/chat), s7 (настройки и «Filter from this source»), s8 (удаление старых `/settings`-алиасов).

### Segment s6 (merged, PR #7, 12cc961; deployed 2026-11-26)

- Зона «Ассистент» на `/assistant`: чат по статье или общий (смена области начинает новую беседу, общий не ищет по библиотеке; истёкшая сессия сохраняет черновик и показывает повтор; тексты ошибок провайдера без секретов), Catch me up и расписания сводок с настройкой в листе и управлением фокусом, профиль интересов (перенесён из настроек AI без перезаписи настроек провайдера), ссылка «Open in Assistant» из чата статьи.
- Канонические `/assistant` и `/assistant/catch-up`; старый GET `/app/catch-me-up` даёт 308. Зона online-only, офлайн-очереди нет; офлайн-снимок остаётся версии 6, хеш `60ff43c1c5f70e34` не менялся. Миграций БД нет. As-built поведение: [CLAUDE.md](../CLAUDE.md), раздел CSS / Tailwind conventions.
- Решения владельца: область чата сужена до «эта статья / всё» — чата по ленте или папке в коде нет, s6 не добавляет поведения AI (подтверждено при одобрении плана 2026-11-25); ссылка из чата статьи добавлена по выбору владельца; три замечания приёмки (телефон: поле ввода и Send без прокрутки; подсказка о настройке модели один раз с одной ссылкой; строка разделов в одну строку) исправлены до открытия PR. Внешний вид принят по снимкам 2026-11-26.
- План/факт: 5 задач в 3 волнах по [плану s6](../docs/arh-w-dev/plans/2026-11-21-ui-redesign-s6-assistant-plan.md) (`a39f08a`). Волна 1: T1 страница/чат `2a842e6`, T2 Catch me up/сводки `dcd2e61`, T3 профиль `37c7853`, доработки `1e32915` / `dc0e096` / `05acef3` / `0b1f1a8`; волна 2: T4 адреса/навигация `ffe5edb` / `9e052b3`; волна 3: T5 приёмка/доки `cb20699`, доработки `1a2edf5` / `c7fdcba` / `795e00a`. Норма 90 мин на задачу; прошло от первого запуска (включая перезагрузку хоста, лимиты поставщика моделей, ожидание владельца): T1 1612 мин / 18 попыток, T2 1609 / 11, T3 1502 / 12, T4 1410 / 11, T5 1494 / 11. Весь прогон по result-s6: 10234 мин, в попытках 9196, сумма норм 4440.
- Ход ревью: Ревью, застрявшие на Rate Cloud, прерваны и повторены агентами Claude.
- По result-s6 на `795e00a`: pytest 4101 (временная БД), npm 595/595, check:generated и локальные проверки CI чистые; Chrome e2e 45 passed + 1 skipped (прежний fixme), Ассистент WebKit 8/8; layout A 32/32 строго, B 32/32 структурно; галерея 43 страницы, 510 снимков + 6 снимков отчёта OPML без сбоев и тёмных пятен; подтверждения задач, волн и интеграции свежие, итоговое ревью дельты пройдено (одно информационное замечание). Не выполнялось: проверка с экранной клавиатурой на настоящем iPhone, Docker-сборка локально, мутационное тестирование. Проверки здесь не повторялись.
- PR https://github.com/s-salamatov/readfine/pull/7: head `795e00a`, база `d6a4f93`, 15 коммитов (включая документацию закрытия s5), 71 файл +5814/−1497. Merge в `selfhost` `12cc961` 2026-11-26 по разрешению владельца, GitHub CI зелёный (test, frontend, docker). Источник: `/var/tmp/claude-ssalamatov-recover/result-s6.md` (написан до выкатки). Перенос — раздел «s6 carry» ниже; далее s7 (настройки и «Filter from this source»), s8 (удаление старых `/settings`-алиасов).
- Деплой s6 (по сообщению оркестратора, разрешён владельцем): 2026-11-26 `selfhost` `12cc961` на прод, только app; `/healthz` ok, alembic 0131. Rollback: `/var/backups/claude-ssalamatov/readfine-predeploy-20261126T225140Z`, image `readfine-app:rollback-d6a4f938`, expiry 2026-12-03, таймер очистки установлен; тогда же установлен таймер для backup s5 (expiry 2026-12-02). Прод, backup и таймеры здесь не проверялись. Проверка клавиатуры на настоящем iPhone теперь возможна и ожидается от владельца.

### Segment s7 (merged, PR #8, b07f8b6; deployed 2026-11-27)

- PR #8 слит в `selfhost` `b07f8b6` 2026-11-27 и в тот же день выкачен на прод (только app) по разрешению владельца; head `b602b66`, GitHub CI зелёный. После выкатки: `/healthz` 200, alembic 0131, ошибок в логе app нет, db и rsshub не перезапускались; вход на прод не выполнялся. Rollback: `/var/backups/claude-ssalamatov/readfine-predeploy-20261127T134345Z`, image `readfine-app:rollback-12cc961b`, expiry 2026-12-04, таймер очистки установлен. Пункты ниже написаны до мержа.

- Зона «Настройки»: подменю слева (на телефоне одна прокручиваемая строка вкладок, активная центрируется после загрузки и boosted-перехода в `app.js`): Reading & appearance, Relevance & filters, Labels, AI provider (только при `app_ai_enabled()`), Account (Profile · API tokens), Stats; ссылками ниже — Sources, Assistant, Admin. Страницы на карточках и токенах.
- Адреса: `/settings` 303 → `/settings/reading`; 308 через moved-pages helper: `/settings/preferences` → `/settings/reading`, `/settings/preferences/hidden` → `/settings/relevance/hidden`, `/settings/filters` → `/settings/relevance`. Полный legacy POST `/settings/reading` (и алиас `/settings/preferences`) для старых вкладок — до s8; `POST /settings/filters` и действия фильтров не переезжали.
- Немедленное сохранение: `POST /settings/field` с закрытым allowlist `FIELDS` (12 полей, `routers/web/settings/fields.py`) и `RFSettings` (`ui/settings.js`): при ошибке, офлайне или редиректе возвращает последнее подтверждённое значение и сообщает об этом; поздний старый ответ не перекрывает новый выбор. Используется на Reading & appearance и для `story_dedup`; часовой пояс и числовые поля — `#reading-form` с липкой Save → `/settings/reading/save`. Relevance (термины) и AI provider сохраняют свою кнопку Save — решение владельца 2026-11-27.
- Отложенное удаление меток и фильтров через `RFPending` (10 с, Undo) вместо двухкликового `.swap-confirm`; разметка списков `data-rf-pending-list|empty|sep|count`, счётчики и пустые состояния следуют удалению и Undo без перезагрузки (исправлено в s7 по замечанию владельца). Отправка по таймеру уходит только для наступивших записей: два удаления с разницей в секунды могут уйти двумя запросами (план, Review Focus 3, ожидал один batch); навигация, history, hide и unload отправляют всё ожидающее разом. Владелец 2026-11-27: такое поведение таймера оставить.
- «Filter from this source» в меню ··· статьи (только при `feed_id`, online-only) → `/settings/filters/new?feed=<Feed.id>`; предзаполнение только для своей подписки, иначе пустая форма. Офлайн-снимок версии 7, хеш `6a5a389617b4977d` (пункт не зеркалится в `templates.js`). Телефонный режим сайдбара Collapsible упразднён: `init.js`/`applyBucket` переписывают сохранённое значение в `hideable-up`. Созданный API-токен показывается один раз с Copy в `no-store` ответе.
- Перенос s6 закрыт в s7-T6 (`61eaffa`): `htmx:afterSettle` возвращает ограничение высоты под клавиатуру, ссылка подсказки о настройке структурная (`chat_setup` = `{text, link_label, href}`, WRE-1), тест формы подсказки, правила Sources/Assistant внутри `@layer utilities`, заголовок «Catch me up»; заметка о телефонной раскладке в CLAUDE.md и строка Fixed в CHANGELOG — в s7-T9. Проверка клавиатуры на настоящем iPhone остаётся за владельцем.
- План/факт: 9 задач по [плану s7](../docs/arh-w-dev/plans/2026-11-21-ui-redesign-s7-settings-plan.md) (`bd1c127`). Волна 1: T5 AI/Stats `352dad3`, T3 Relevance/фильтры `6e958fe`, T2 Reading `037f7c2`, T4 метки/аккаунт/токены `2ac9e50` / `b44a3d5`, T6 перенос s6 `61eaffa`, T1 оболочка и немедленное сохранение `44b3366`; волна 2: T7 переезды, пункт меню, снимок 7 `3b7bc67`; волна 3: T8 регенерация стилей/контракта и браузерные сценарии `d42bfa2`, T9 документация `1097848`. Длительности задач здесь не сводились.
- Проверки на итоговом дереве `1097848` (по сообщению оркестратора): семь branch checks прошли — полный pytest, `npm test`, generated, sources, полный e2e Chrome, settings/assistant/sources WebKit, visual layout против `12cc961`. Это закрывает пробел доказательств T8-R1/R2 (layout, галерея, Assistant e2e, Sources WebKit были сняты до последних правок). Итоговое ревью pass, без blocker/major; info: формулировка `help.html:439` (упоминает collapsible), Relevance и AI provider с кнопкой Save, счётчик kept-out в Stories обновляется только после перезагрузки. Мутационное тестирование не выполнялось (нет инструмента). Здесь проверки не повторялись.
- Владелец 2026-11-27: визуальная приёмка s7 дана. Галерея: `/var/tmp/claude-ssalamatov-s7-visual/final` (вне git, удалить позже); строки Stats на телефоне выровнены по свежему снимку.
- Источники: материал T9 `/var/tmp/claude-ssalamatov-recover/spec-handoff-s7.md` (написан до финальных проверок, числа тестов T8 в нём устарели), план s7, `git log 12cc961..1097848`, бриф оркестратора 2026-11-27.
- Заметки вне продукта: arh-w-dev 1.6.4 `claude/src/platforms/claude/policy-enforcer.js:15` выдаёт decision `"ask"`, который Claude Code отвергает, поэтому ask-вердикты delete guard срабатывают как разрешение (fail open; не исправлено). 2026-11-27 на sgn-main кончилась память (около 0,3–0,5 GB доступно, swap нет) из-за параллельных агентских сессий, браузерный прогон был убит — тяжёлые e2e/visual запускать по одному.

### Segment s8 (PR open pending, ветка `feat/ui-redesign-s8`, HEAD `ce009a4`; не слито, не выкачено, владелец не принял)

- Админка перестроена на макросы и токены: таблицы в `rf-scroll-x`, переключатель с `aria-pressed`, цвета графика из токенов `--rf-chart-visitors` / `--rf-chart-views`. Одно поведенческое ядро `static/js/ui/admin.js` (`RFAdmin`) заменяет `admin-feeds.js`, `admin-settings.js`, `traffic-chart.js` и админский блок `app.js`. Бейджи ok/warn используют `text-foreground` на подложке (исправлено в s8).
- Публичные страницы (возможности, changelog, help, legal) на `templates/public/base.html`: подключены только стили и `init.js`, без app-JS. Замороженный пример лендинга `b07f8b6` сканируется сборкой CSS; изменения примера минимальны против формулировки плана (минорное замечание).
- Не-GET алиасы перенесённых страниц удалены. Устаревший не-GET отвечает «This page is out of date. Reload it and try again.»; `/settings/ai/preferences` отвергает старые поля профиля (409). Вызовы переведены на канонические адреса (s8-T4) до удаления алиасов.
- Settings carry: подсказка прокрутки у статистики на 360 px, наложение вступительного текста фильтров, предзаполнение названия ленты обрезано до 100 символов, редактор фильтров на токенах, старые названия Settings в перечисленных файлах.
- Документация as-built: CLAUDE.md, README.md, CHANGELOG.md, RELEASING.md (`ce009a4`).
- Коммиты: T1 `561acb9`, T2 `16af565`, T3 `3049bbf`, T4 `5c2bfe5`, T5 `481bd95`, T6 `42e99a6`, T7 `1d17929`, T8 `ce009a4`; план `f57ee86`; база `b07f8b6`.
- План/факт: 8 задач в 4 волнах по [плану s8](../docs/arh-w-dev/plans/2026-11-21-ui-redesign-s8-admin-public-plan.md). Волна 1: T1–T5 (непересекающиеся писатели); волна 2: T6; волна 3: T7; волна 4: T8. Норма по плану 495 мин (4×L + 3×M + S), критический путь 235 мин. Фактические длительности в материале не сведены (`fact n/a`).
- Проверки, по данным оркестратора на итоговом дереве `ce009a4` (в этом спек-проходе не перезапускались): семь branch checks прошли — полный pytest, `npm test`, generated, sources, полный e2e Chrome, touched WebKit (admin-public, sources, settings, assistant), visual layout против `b07f8b6`. Четыре проверки волн прошли. Итоговое ревью: blocker и major нет.
- Минорные замечания итогового ревью (не исправлены, в backlog «[ui-redesign] s8 carry»): WR-S8-F1 — ссылка `/help#basic-relevance` в `templates/settings/relevance.html:74` внутри hx-boost формы грузит публичную help-страницу в оболочке приложения (исправление: `hx-boost="false"`); WR-S8-F2 — переключатель A-Z / By host внутри h1 страницы админских лент.
- Процесс: обзоры задач s8-T1 и s8-T3 были ограничены слишком узко помощником оркестратора; итоговое ревью покрыло оба diff полностью.
- Хост: 2026-11-27 sgn-main снова почти без памяти (около 150 МБ доступно, swap нет) из-за параллельных сессий других проектов; одна проверка волны остановлена и перезапущена.
- Не сделано и не проверено: визуальная приёмка s8 владельцем (галерея `/var/tmp/claude-ssalamatov-s8-visual/gallery.html`, вне git); проверки на реальных устройствах; S4W-F1, S4W-F2, двойной заголовок «Add source» на телефоне, лимит 50 удалений, размещение sticky Save на админ-настройках — открыты владельцу (см. backlog). Мутационные проверки в материале s8 не упомянуты.
- Оставшиеся вне s8 пункты (s3, s4, s2-пункты, s6/s7 и тулинг) перечислены в backlog; по s7-10 arh-w-dev `"ask"` остаётся открытым.
- PR: `PR open pending`. Merge SHA, номер PR и результаты CI заполнить после открытия.

Backlog moves (только после merge в `selfhost`; здесь не выполнены, ничего не перенесено в `backlog-resolved.md`):
1. «Redesign UI and animations» → `backlog-resolved.md`: сделано в s1–s8 (PR #1–#8 и PR s8, `PR open pending`). Проверки устройств и приёмки из s5/s6 остаются открытыми, если владелец их не закрыл.
2. s7 carry: пункты 1, 2 и 4 перенести целиком; пункт 3 — кроме комментариев offline shell (`sw.js`, `init.js`, `offline/{boot,page}.js` остаются, s7-3d); из пункта 5 — layout-исключения (T8-R3, T8-R10) и фиксированные id (T7-R2); из пункта 6 — T2-R1; из пункта 7 — предзаполнение и `filter_edit.html`. Оставить T8-R6, T8-R9, T2-R2, счётчик kept-out и пункты 8–11.
3. s5 carry пункт 5 (ссылки таблицы Sources на `/settings/...`) закрыт s8-T4 — перенести вместе с s7-4.
4. Добавления (follow-ups s8, строки «Left» и s3/s4 carry) уже внесены в `backlog.md` до merge, это открытые задачи, а не перенос.

Task s1-T1: completed

Task s1-T2: completed

Task s1-T3: completed

Task s1-T4: completed

Task s1-T5: completed

Task s1-T6: completed

Task s1-T7: completed

Task s1-T8: completed

Task s2-T1: completed

Task s2-T2: completed

Task s2-T3: completed

Task s2-T4: completed

Task s2-T5: completed

Task s2-T6: completed

Task s2-T7: completed

Task s2-T8: completed

Task s2-T9: completed

Task s2-T10: completed

Task s2-T11: completed

Task s2-T12: completed

Task s2-T13: completed

Task s2-T14: completed

Task s2-T15: completed

Task s2-T16: completed

Task s2-T17: completed

Task s2-T18: completed

Task s2-T19: completed

Task s2-T23: completed

Task s2-T24: completed

Task s2-T25: completed

Task s2-T26: completed

Task s2-T27: completed

Task s2-T29: completed

Task s2-T30: completed

Task s2-T31: completed

Task s2-T32: completed

Task s2-T33: completed

Task s2-T34: completed

Task s2-T35: completed

Task s2-T28: completed

Task s2-T20: completed

Task s2-T21: completed

Task s2-T22: completed

Task s2-T36: completed

Task s2-T37: completed

Task s2-T38: completed

Task s2-T39: completed

s1-T1.a1 (task, implementation, claude/worker, reported, outcome done): Tailwind 4.3.5 toolchain, CSS-first input.css (sources, typography plugin, dark/hover variants, v3 palette @theme, ring…; worktree host sgn-main, wave s1.wave1, base 2aad600bd8de8d83854ba6af31fa6560bd741e35

s1-T1.a2 (task, implementation, claude/verifier, reported, outcome done): s1-T1 verification pass: 5/5 new tests, scratch build css-vars OK (63 gray utilities via var), npm test 299/299, tailwi…

s1-T1.a3 (task, implementation, claude/reviewer, reported, outcome done): Code review of s1-T1: pass, no blockers or majors. Sources, variants, v3 palette (all families checked), ring, keyframe…

s1-T1.a4 (task, implementation, claude/verifier, reported, outcome done): Reconfirmed s1-T1 at HEAD 012d0bc after T7 edited input.css and the css-vars script/tests: npm test 310/310; check:gene…

s1-T1.a5 (task, implementation, claude/reviewer, reported, outcome done): Reconfirmed s1-T1 review: the only changes to T1's files since review are T7's (input.css compat block, check-css-vars …

s1-T2.a1 (task, implementation, claude/worker, reported, outcome done): Templates and JS moved to v4 class names. The official upgrade tool 4.3.5 ran on a scratch git-archive export of c81977…; worktree host sgn-main, wave s1.wave1, base 2aad600bd8de8d83854ba6af31fa6560bd741e35

s1-T2.a2 (task, implementation, claude/verifier, reported, outcome done): s1-T2 verification pass: 4/4 new tests; legacy scan templates/js OK (156 files); --base c81977a OK; goldens 37 passed; …

s1-T2.a3 (task, implementation, claude/reviewer, reported, outcome done): Code review of s1-T2: pass, no blockers/majors. Renames and canonicalised arbitrary values equal v3 values; JS strings/…

s1-T2.a4 (task, implementation, claude/verifier, reported, outcome done): Reconfirmed s1-T2 at HEAD 012d0bc after T7 edited check-tw4-classes (base verification), its test and one article&#95;row.h…

s1-T2.a5 (task, implementation, claude/reviewer, reported, outcome done): Reconfirmed s1-T2 review: since its review the only changes to T2 files are T7's (check-tw4-classes --base verification…

s1-T2.a6 (task, implementation, claude/verifier, reported, outcome done): Reconfirmed s1-T2 checks at 63523a3 after T8 changed story&#95;members.html, sidebar.html, app.js, offline/templates.js, ch…

s1-T2.a7 (task, implementation, claude/reviewer, reported, outcome done): Review reconfirmed for s1-T2 at 63523a3: the only changes since the last T2 review are T8's (story&#95;members.html, sideba…

s1-T2.a8 (task, implementation, claude/reviewer, reported, outcome done): Task review s1-T2 reconfirmed at 63523a3: the diff since the last T2 review is T8's (read-mark display class, spin keyf…

s1-T2.a9 (task, implementation, claude/verifier, reported, outcome done): Reconfirmed s1-T2 at 2a8d66b after rebase onto selfhost 94a9385: check:sources tw4-classes OK (253 files incl. upstream…

s1-T2.a10 (task, implementation, claude/reviewer, reported, outcome done): Task review s1-T2 reconfirmed after rebase onto selfhost 94a9385: T2 commits replayed without conflict; upstream change…

s1-T3.a1 (task, implementation, claude/worker, reported, outcome done): Migrated 7 Python-built class fragments to v4 names: catchup.py:331 flex-shrink-0-&#62;shrink-0; scrape.py:146,161,227,235 …; worktree host sgn-main, wave s1.wave2, base cd57f64d5aa57f2d89e5a083d3b4bc71e5dc1fcc

s1-T3.a2 (task, implementation, claude/verifier, reported, outcome done): s1-T3 verification pass (checks run by the orchestrator in the applied tree): check-tw4-classes over all roots OK (251 …

s1-T3.a3 (task, implementation, claude/reviewer, reported, outcome done): Code review of s1-T3: pass. 7 one-token renames, semantics equal to v3, each matches its template sibling; prose untouc…

s1-T4.a1 (task, implementation, claude/worker, reported, outcome done): Visual diff harness implemented as planned. Base-vs-base run: 34/34 screens at 0.0000%, equal css sha256 on both sides …; worktree host sgn-main, wave s1.wave1, base 2aad600bd8de8d83854ba6af31fa6560bd741e35

s1-T4.a2 (task, implementation, claude/verifier, reported, outcome done): s1-T4 verification pass: unit tests 2/2; base-vs-base 34/34 at 0.0000% with equal css sha and altered-shot self-check (…

s1-T4.a3 (task, implementation, claude/reviewer, reported, outcome done): Code review of s1-T4: diff, size-mismatch, exit code, shot-count and CSS-sha guards, ports 4251/4252 (registered), DB g…

s1-T4.a4 (task, implementation, claude/worker, reported, outcome done): Repair of s1-T4 per review-47d9568e: M1 seed.py role choices user|admin and exit non-zero when rowcount != 1, capture a…

s1-T4.a5 (task, implementation, claude/verifier, reported, outcome done): Re-verification of s1-T4 after repair: pass. Unit 2/2; role negative paths (unknown user rc=1, bad role rc=2) and posit…

s1-T4.a6 (task, implementation, claude/reviewer, reported, outcome done): Re-review of s1-T4 repair: pass. M1, M2, m1, m3, m4/m5, m6 resolved; pre-seed uses e2e env only; all key-screen routes …

s1-T4.a7 (task, implementation, claude/verifier, reported, outcome done): Reconfirmed s1-T4 at HEAD 012d0bc after T7 edited tests/visual/run.mjs (signal handling): npm test 310/310 including vi…

s1-T4.a8 (task, implementation, claude/reviewer, reported, outcome done): Reconfirmed s1-T4 review: since its review the only change to T4 files is T7's run.mjs signal handling (flag listeners,…

s1-T4.a9 (task, implementation, claude/verifier, reported, outcome done): Reconfirmed s1-T4 checks at 63523a3: T8 changed only a comment in tests/visual/run.mjs; harness ran 34/34 within 0.1% (…

… 202 more summary lines omitted; full records: [run directory](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd)

## Plan and facts

- Retained inventory: 1367 files, 278740683 bytes; skipped symlinks 0, node_modules 0.
- Plan/fact segment s1: fact 2190.8 min, norm 470 min, attempts 214.7 min
- Plan/fact segment s2: fact 1335.9 min, norm 1810 min, attempts 1340.6 min
- Plan/fact segment s3: fact n/a min, norm 0 min, attempts n/a min
- Plan/fact segment s4: fact n/a min, norm 0 min, attempts n/a min
- Plan/fact segment s5: fact n/a min, norm 0 min, attempts n/a min
- Plan/fact segment s6: fact n/a min, norm 0 min, attempts n/a min
- Plan/fact segment s7: fact n/a min, norm 0 min, attempts n/a min
- Plan/fact segment s8: fact n/a min, norm 0 min, attempts n/a min
- Plan/fact run: fact 3570.4 min, norm 2280 min
- Plan/fact task s1-T1 (L): fact 65.8 min, norm 90 min
- Plan/fact task s1-T2 (L): fact 359.5 min, norm 90 min
- Plan/fact task s1-T3 (S): fact 20.9 min, norm 15 min
- Plan/fact task s1-T4 (L): fact 359.5 min, norm 90 min
- Plan/fact task s1-T5 (M): fact 68.3 min, norm 40 min
- Plan/fact task s1-T6 (S): fact 1.3 min, norm 15 min
- Plan/fact task s1-T7 (L): fact 28.9 min, norm 90 min
- Plan/fact task s1-T8 (M): fact 14 min, norm 40 min
- Plan/fact task s2-T1 (M): fact 61.4 min, norm 40 min
- Plan/fact task s2-T2 (S): fact 61.4 min, norm 15 min
- Plan/fact task s2-T3 (M): fact 61.4 min, norm 40 min
- Plan/fact task s2-T4 (L): fact 61.4 min, norm 90 min
- Plan/fact task s2-T5 (L): fact 61.4 min, norm 90 min
- Plan/fact task s2-T6 (S): fact 61.4 min, norm 15 min
- Plan/fact task s2-T7 (S): fact 61.4 min, norm 15 min
- Plan/fact task s2-T8 (L): fact 61.4 min, norm 90 min
- Plan/fact task s2-T9 (L): fact 103.6 min, norm 90 min
- Plan/fact task s2-T10 (M): fact 44.1 min, norm 40 min
- Plan/fact task s2-T11 (M): fact 78.8 min, norm 40 min
- Plan/fact task s2-T12 (L): fact 44.1 min, norm 90 min
- Plan/fact task s2-T13 (L): fact 40.2 min, norm 90 min
- Plan/fact task s2-T14 (M): fact 40.2 min, norm 40 min
- Plan/fact task s2-T15 (M): fact 40.2 min, norm 40 min
- Plan/fact task s2-T16 (L): fact 40.2 min, norm 90 min
- Plan/fact task s2-T17 (M): fact 40.2 min, norm 40 min
- Plan/fact task s2-T18 (L): fact 48.9 min, norm 90 min
- Plan/fact task s2-T19 (M): fact 48.9 min, norm 40 min
- Plan/fact task s2-T23 (L): fact 47.2 min, norm 90 min
- Plan/fact task s2-T24 (L): fact 47.2 min, norm 90 min
- Plan/fact task s2-T25 (L): fact 48.9 min, norm 90 min
- Plan/fact task s2-T26 (M): fact 48.9 min, norm 40 min
- Plan/fact task s2-T27 (M): fact 40.2 min, norm 40 min
- Plan/fact task s2-T29 (M): fact 53.9 min, norm 40 min
- Plan/fact task s2-T30 (S): fact 53.9 min, norm 15 min
- Plan/fact task s2-T31 (M): fact 53.9 min, norm 40 min
- Plan/fact task s2-T32 (M): fact 53.9 min, norm 40 min
- Plan/fact task s2-T33 (M): fact 53.9 min, norm 40 min
- Plan/fact task s2-T34 (S): fact 53.9 min, norm 15 min
- Plan/fact task s2-T35 (S): fact 53.9 min, norm 15 min
- Plan/fact task s2-T28 (M): fact 508.5 min, norm 40 min
- Plan/fact task s2-T20 (S): fact 131 min, norm 15 min
- Plan/fact task s2-T21 (M): fact 100 min, norm 40 min
- Plan/fact task s2-T22 (S): fact 8.8 min, norm 15 min
- Plan/fact task s2-T36 (S): fact 15.6 min, norm 15 min
- Plan/fact task s2-T37 (S): fact 14.5 min, norm 15 min
- Plan/fact task s2-T38 (S): fact 25.1 min, norm 15 min
- Plan/fact task s2-T39 (S): fact 12.5 min, norm 15 min

## Backlog (carried)

Перенос из s4-carry.md, result-s3/result-s4 и указанного в carry s3-carry.md; s5 дополнен по result-s5, плану и брифу 2026-11-25; s6 — по result-s6, плану, отчётам попыток и брифу 2026-11-26. Промежуточные wave notes сохранены как сверка там, где итоговый источник не подтверждает закрытие; это не утверждение о воспроизведённом дефекте на текущем HEAD. Исторические Plan/fact выше не пересчитаны: длительности s3/s4/s5 в источниках отсутствуют; факт задач s5 и s6 записан в Summary.

### s3 carry

- s3-T12 F1: нет теста замены ожидающего timer flush на flush при navigation/history в `pending.js`.
- s3-T12 F2: `shell.spec.mjs` `settled()` без deadline; fill-forwards/paused animation может ждать до таймаута теста.
- s3-T12 F3: слабая проверка после Undo; проверять отсутствие ключа в `sessionStorage rf.deletedKeys`.
- s3-T12 F4: нет теста, закрепляющего `aria-label` / `aria-pressed` образцов цвета.
- s3-T12 noticed: `markDue` использует `Date.now` и чувствителен к переводу часов.
- s3-T12 noticed: неизвестный kind даёт silent no-op.
- s3-T12 noticed: у Offline reading `menuitemcheckbox` нет видимой отметки.
- s3-T12 noticed: подпись Color не связана с группой образцов.
- s3-T12 noticed: Playwright webServer стартует до миграции в globalSetup.
- S3W-F1: шторка сайдбара телефона не закрывается по Escape; inert только у списка и статьи.
- S3W-F2: алиас `_showShareToast` в `app.js` (7 мест).
- S3W-F3: `batch_lock` использует `pg_advisory_lock` без `lock_timeout` в `deletes.py`.
- S3W-F4: строки desktop-сайдбара не достижимы через Tab (pre-existing).
- S3W-F5: клавиши j/k/m/s/Shift+A и Escape проходили через меню аккаунта; result-s4 сообщает исправление в s4-T5.
- S3W-F6: устаревший текст `/` в `help.html` и расположение тем в `CHANGELOG.md`.
- WebKit: forced-server-error палитры не показывает «Search failed. Try again.» (`shell.spec.mjs:104/118`), отмечено на `6569cf2`.
- Новый Undo-тост оказывается за старым; carry оставляет открытым после T5, итоговый result-s4 отдельно закрытие порядка стека не подтверждает (подъём над панелью телефона подтверждён).
- `pending.js` не делит batch > 50: сервер 422, строки восстанавливаются; s5 — первый реальный пользователь по плану s4.
- `offline/router.js` не передаёт `opts.autoAdvance` в `sidebar()`; исправление не однострочное: `mark_read_auto_advance` отсутствует в синхронизируемых настройках.
- Закрыто в s6: bare-text 404 в `catchup.py` и `<p>` ответа тестовой рассылки briefing заменены на `alert_html` (проверено по коду `12cc961`).
- AI chat retry по `.text-red-500` и фрагменты ошибок AI: result-s4 сообщает переход к `data-chat-error` и алертам.

### s4 carry

- `ui/readfine.html`: сверить docstring и название «Labeled» в плане с «Labels» сайдбара.
- `test_mark_all_undo.py`: добавить случай, когда read handlers только очищают `suppressed_by` (`services/article.py:1040`).
- `articles.py:979`: замечание по пробелам.
- `article_list.html`: ветка заголовка `saved_only+search` сейчас недостижима; сверить при дальнейшем изменении.
- T5-R1: Undo считает любой 200 успехом; redirect на login при истёкшей сессии показывает Restored — проверять `res.redirected` или `showToast` в `HX-Trigger`; явного закрытия в result-s4 нет.
- T5-R2: цвет звезды зависит от `title="Remove star"`; нужен state attribute и согласованные изменения `app.js`, `offline/overlay.js`, `offline/templates.js`, drift goldens и версии шаблона 7.
- T5-R3: переключатель переведённого заголовка в `read.js` без JS-теста; carry указывает покрытие e2e 1.
- Неиспользуемый токен `--rf-legacy-dark-loading-veil` в `styles/tokens.css`.
- `hideable-up` скрывает «Вид» / mark-all сохранённого поиска на телефоне (`base.html`); итоговый статус отдельно не указан.
- `label_picker.html`: out-of-band trigger строки ещё серый; после правки удалить 3 записи drift adapter.
- `sw.js:85`: import-failure fallback page оставлена без изменений (R5).
- T4-R1: офлайн-чипы идут по именам сайдбара, онлайн — по `get_folder_order`; синхронизируемые папки имеют `position`.
- `check-dom-contract.mjs` не видит чтение хуков через `startsWith`: `archive-btn-*` удержан через read.spec, `text-gray-900` выпал.
- На 390 px в мета-строке статьи нет имени источника — проверить намерение.
- s4-T6 F1: устаревший комментарий о `article-detail-menu` в `article_detail.html:29–30`; селектора уже нет, контракт его удалил.
- s4-T6 F2 (accepted): исключение `settings-preferences #offline-diagnostics` в s4-T6.json относится к restyle s4-T4 вне зоны; причины s2-T10 для `#detail-mode-small` / `#sidebar-mode-small` устарели.
- s4-T6 F3: polling вкладок Basecoat в `gallery-pages.mjs:90`.
- s4-T6 F4: лишнее «s4» в комментарии `offline.spec.mjs:76`.
- `app.js` переключает старые классы заголовков строк `text-gray-800/900` — позднее перевести на токены.
- Wave-note / сверка: stamp с `+00:00` нужно отправлять form-encoded (`hx-vals` / FormData / URLSearchParams), иначе 400.
- Wave-note / ограничение: офлайн-синхронизированное mark-all нельзя отменить сервером (`ops.py` меняет дату); stamp null офлайн соответствует этому.
- Wave-note / принято: «Nothing to restore» сохраняет `sidebarRefresh` и toast type ok.
- Wave-note / сверка CSS: удалить старые `html.dark .saved-search-header`, `.expand-indicator` и правила `detail-topbar-next` / `[id^=star-btn-]`; `.ai-score-*` остаются нужны `detailScore` / `article_content.html`.
- Wave-note / сверка свайпов: `data-rf-swipe` right/left и `touch-action` на самой `.article-row`.
- Wave-note / сверка контрактов: `data-rf-skeleton`, `dropdown-menu`, `popover`, `data-popover`, `data-rf-*`, `data-chat-error`, `data-bottom-read`; старые `detail-topbar-*`, `data-close-menu`, `data-menu-persist`, `data-show-context-panel` и ветка overlay требуют согласования с итоговым контрактом (result-s4 сообщает регенерацию).
- Wave-note / сверка статьи: синхронизация иконки `[data-bottom-read]`, прогресс через `--rf-progress` 0..1 и его inline anchor при статичном toolbar; result-s4 сообщает работу прогресса и панели без детализации этих пунктов.
- Wave-note / сверка e2e: локаторы новых heading/chips/второго Mark all, ширина Stories на 390 px, Basecoat menus после HTMX swap и summary fallback на удалённый `[data-menu-toggle]` в `offline.spec.mjs:651`; итоговые Chrome/layout проверки зелёные, отдельного статуса каждого пункта нет.
- Wave-note / закрыто по result-s4: тосты над плавающей панелью телефона через `--rf-bottom-inset`, меню «Вид» на 390 px, выбранный чип `--primary`, reduced-motion для строк и тостов; приёмка владельцем ожидается.
- Wave-note / принято: `test_sync_snapshots.py` count Ask/chat 2 → 3 (toolbar, panel, footer).
- Wave-note / принято: 3 keyboard-теста T5 переведены в офлайн по Q1, assertions сохранены; 390 px без `detail_mode_small` теперь полноэкранный по Q2.
- Wave-note / историческое ограничение: T5 имел 15 worktree-only npm failures без `node_modules`, свайпы/прогресс тогда проверялись только jsdom; последующий result-s4 сообщает npm 515/515 и Chrome 32 + 1 fixme.

### s4 whole review S4W-F1..F5

- S4W-F1 — owner question (open): `confirm()` смотрит только на `navigator.onLine`; forced offline / недоступный сервер при onLine true дают mark-all без подтверждения и Undo. Проверять также офлайн-состояние страницы?
- S4W-F2 — owner question (open): Sort в saved-search игнорируется (порядок поиска), Show в Starred/Archived/Saved не влияет на вид; скрыть эти группы или оставить как общие настройки аккаунта?
- S4W-F3 — закрыто в s5: README описывает swipe left как переключение прочитанности (проверено по diff `b6ec385..d6a4f93`).
- S4W-F4 — закрыто в s5: CHANGELOG содержит Q2 о полноэкранном открытии статьи на телефоне без сохранённого выбора (тот же diff).
- S4W-F5: счётчик Marked N включает скрытых участников свёрнутой истории и может превышать badge.

### s5 carry

- Owner acceptance: двойной заголовок «Добавить источник» в телефонном листе (шапка + форма); оставить или убрать форменный.
- Owner choice: удаление >50 возвращает 422 и восстанавливает строки; оставить лимит или делить batch.
- Website candidate selection покрыт backend-тестами, браузерного сценария нет; WebKit OPML export проверяется только сетевым ответом.
- Закрыто в s6 (`cb20699`): `tests/e2e/read.spec.mjs` использует `tests/e2e/db-guard.mjs` (проверено по коду `12cc961`).
- s8: действия таблицы ещё ссылаются на `/settings/...` через 308-алиасы; заменить ссылки перед удалением алиасов.
- Env/CI: для `tests/js/tailwind-build.test.mjs` нужен `TMPDIR=/var/tmp` из-за `/tmp/.gitignore` с `*`; Sources template tests требуют Jinja2 в venv (CI исправлен `10cc246`). E2E/visual требуют `E2E_DATABASE_URL` по ограничениям выше.
- S4W-F1/F2 остаются открыты: Q1 confirm при недоступном сервере и `navigator.onLine === true`; группы «Вид» в специальных видах. Визуальная приёмка s3/s4/s5 ожидается, владелец тестирует prod.
- Известный WebKit offline-logout defect на prod отложен; 15 backend RuntimeWarnings (`AsyncMock`, `app_settings_cache.py:34`, `translation_service.py:723`) — перенос из брифа, здесь не воспроизводились.
- Мутационное тестирование не выполнено: для Python/Jinja/plain ESM нет настроенного инструмента.

### s6 carry — в s7

Закрыто в s7-T6 / s7-T9 (см. Segment s7), кроме проверки клавиатуры на настоящем iPhone (владелец). Список ниже сохранён как история.


- s6-T1.a18 F1: после ответа чата htmx settle стирает inline `--rf-assistant-viewport-height`, а `watchViewport` в `ui/assistant.js` выходит раньше (viewport для этого root уже отслеживается); ограничение высоты под клавиатуру пропадает до следующего изменения visual viewport. Нужен тест через настоящие htmx swap и settle. Проба: `../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/attempts/s6-T1/18/work/settle-probe.mjs`.
- Проверка клавиатуры на настоящем iPhone (s6 выкачен 2026-11-26, ожидает владельца): расчётно низ Send около 582px при видимых 450px (раньше около 500); при 330px сжимается transcript; 320x568 с подсказкой прокручивается на 34px.
- CSS `input.css` (сверено по `12cc961`): `@layer utilities` — строки 289–813; весь блок Assistant (851–960), включая новые телефонные правила `@media (max-width: 640px)` (922–960), вне слоя, как и блок Sources перед ним (815–849); из добавленного в s6 внутри слоя только reduced-motion правило для `#general-chat-input` / `#general-chat-submit` (около 756). Это расходится с правилом CLAUDE.md; отметка pass в отчёте ревью s6-T1.a18 «new card, section and nav rules … inside @layer utilities» неверна. Замечания s6-T1.a15/a16, s6-T2.a9, s6-T5.a10/a11 о правилах вне слоя верны. Unlayered-правила перекрывают utility-классы на тех же элементах.
- Нет теста, закрепляющего форму подсказки о настройке в Catch me up.
- WRE-1: ссылка в подсказке о настройке зависит от литерала `Settings → AI` (`assistant/page.html` делит текст по нему).
- В CLAUDE.md нет заметки о телефонной раскладке Ассистента.
- CHANGELOG: отдельная строка Fixed в Unreleased описывает поведение ещё не выпущенной зоны.
- Косметика: на 390px подсказка о настройке вплотную к карточке чата; заголовок `h2` «Catch me up» без стиля, в отличие от «Chat».

### s6 carry — позже

- e2e-приложение кэширует AI-переключатель между прерванными прогонами; s6-T2.a11 T2-D2: правило строки разделов действует и на Catch me up; нет теста, что вставленные ссылки отключаются офлайн; замечания об области переписывания ссылок; на телефоне из полноэкранной статьи с недоступным чатом нет входа в Ассистент.
- `backend/app/templates/help.html` около строки 628: «in the reader»; поле `catchup` из `_ai_availability()` (`common.py`) не читается.
- WR8-F5: пустое сообщение в Assistant-чате отвечает 400, htmx его не вставляет (из UI недостижимо). WR8-F6 (pre-existing): не-Assistant путь `/htmx/ai-chat` даёт 500 на слишком длинном или Unicode-digit `article_id`. WR8-F7: `catchup.js` на всех страницах держит document-wide MutationObserver.
- id конфигурации briefing больше int32 даёт 500 (общий guard разбора id закрыл бы и WR8-F6); raw fallback в `describe_ai_error`; устаревший комментарий в `ai-settings.js`; устаревшие комментарии T5; focus trap под jsdom; ограничения галереи (отчёт OPML снимается только в light, лимит импорта 10/час).
- Нестабильные тесты: `test_moved_pages` — пересечение id (строка 139 вставляет `Feed(id=18)`); редкий `MissingGreenlet` в тесте редиректа Sources; e2e offline logout replay.
- Вопросы и проверки владельца: двойной заголовок «Add source» в телефонном листе; удаление >50 → 422; у выбора website-кандидата нет браузерного сценария; WebKit OPML export проверен только по сети; S4W-F1/F2; визуальная приёмка s3–s5; backend RuntimeWarnings; WebKit offline-logout defect на prod. Пункт переноса «name-only DB guard в `read.spec.mjs`» уже закрыт в `cb20699` (см. s5 carry).
- Сообщено, не воспроизведено: на iPhone 16 Pro Max смещены кнопки в списке и в полноэкранной статье; ждём снимок владельца. Гипотезы: кнопки View / mark-read стоят справа в пустой строке при скрытом заголовке (`input.css` около 683, так задумано); `hideable-up` сохранённого поиска скрывает View (`base.html` около 316); действия статьи переехали в плавающую нижнюю панель (`base.html` около 370). Побочные находки: пустой заголовок верхней панели при первом запуске (`app.js` около 3580); поворот в landscape и обратно закрывает статью.

### s7 carry — в s8 или позже

- Stats на 360px: таблицы обрезаны и прокручиваются внутри, без подсказки о прокрутке (T8-R5).
- Filters на 360px: вступительный текст сжат рядом с кнопкой New filter (T8-R4).
- Старые названия Settings: `.env.example:87` («Settings → Preferences»), `templates/app/welcome.html:22` («Settings → Relevance», видно пользователю); `help.html` (в т.ч. 439, collapsible), `legal/privacy.html`; комментарии в `routers/web/app/articles.py` (~220, ~704), `routers/web/app/welcome.py`, docstring `settings/fields.py` (`POST /settings/preferences`), `services/preference_values.py`, `services/feed.py`, `static/js/{sw.js,init.js}`, `static/js/offline/{boot.js,page.js}`, `templates/base.html` (~539).
- s8: удалить legacy POST `/settings/reading` / `/settings/preferences`, `/settings/ai/preferences` и старые POST/DELETE алиасы Sources; сначала обновить ссылки таблицы Sources на `/settings/...`.
- Тесты: `layout-allow/s7-T8.json` разрешает `*` для шести экранов Settings — сузить или удалить (T8-R3); `layout-allow/s2-T10.json` ещё ключует `#sidebar-mode-small` (T8-R10); отказ сохранения под офлайн-воркером не покрыт (T8-R6); Copy токена в e2e не нажимается (T8-R9); `test_moved_pages.py` ещё с фиксированными id UserFeed/Folder (T7-R2).
- T2-R1: старая вкладка Preferences после полного POST получает новую страницу без `ui/settings.js`, контролы не сохраняются до перезагрузки. T2-R2: select часового пояса потерял группы регионов (нужен optgroup в `ui/forms.html`).
- T3: название ленты длиннее 100 символов предзаполняется целиком и отвергается при сохранении; счётчик Stories kept-out меняется только при следующем визите; в теле формы `filter_edit.html` legacy-утилиты gray/blue.
- T4-F7: во время окна Undo имя удалённой метки считается занятым.
- T6: текст ссылки о настройке различается в чате, на странице Catch me up и в `catchup.py` (как в плане).

### pre-existing

- `alembic check` drift: отсутствуют `ix_*`, unique vs index у `api_tokens.token_hash` / `users.email`, nullability `app_settings`; CI не запускает `alembic check`.
- `/tmp/.gitignore` с `*` ломает 2 tailwind-build теста при `TMPDIR=/tmp`.
- `offline.spec.mjs` logout flake (809/886; отмечен на базе `4ffd84e`, повторился в s4); WebKit flakes также в `offline-freshness.spec.mjs:33` и `offline.spec.mjs:556,886`.
- `admin.py:10`: неиспользуемый импорт `RedirectResponse`.
- Дубли tab-panel id при двойном рендере статьи (inline + overlay), существующий duplicate-id pattern.
- Офлайн-кнопка mark-all в сайдбаре без confirm и Undo (carry отмечает pre-existing; связана с открытым S4W-F1).

## Open Decisions

- s5 (owner, open): двойной заголовок «Добавить источник» на телефоне — оставить или убрать из формы; >50 удалений — оставить 422/restore или добавить chunking.
- s3/s4/s5 (owner, pending): визуальная приёмка desktop/phone на prod; деплой не означает визуальное одобрение.
- s7 (owner, resolved 2026-11-27): визуальная приёмка s7 дана; Relevance и AI provider сохраняют кнопку Save; счётчики отложенного удаления исправлены в s7; пакетирование по таймеру остаётся.
- s6 (owner, pending): проверка клавиатуры на настоящем iPhone на prod `12cc961` (вид по снимкам принят 2026-11-26).
- S4W-F1 (owner, open): дополнить проверку `navigator.onLine` офлайн-состоянием страницы для подтверждения mark-all при forced offline / недоступности сервера?
- S4W-F2 (owner, open): скрывать неработающие группы «Вид» (Sort в saved-search, Show в Starred/Archived/Saved) или оставить их как общие настройки аккаунта?

## Retained evidence

- [.arh-w-dev/plans/2026-11-19-ui-redesign-design.md](../.arh-w-dev/plans/2026-11-19-ui-redesign-design.md) · SHA-256 2dad817aa0ecef0a92d5a7516261969293ecf5d1878afcdfe5807cd4e83ab91b · design&#95;document
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-087b0456-d61f-4cc3-ade4-26050deee69d.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-087b0456-d61f-4cc3-ade4-26050deee69d.json) · SHA-256 117a89b9e8406273dfbbee951c7ed1f49b3ab137a0bf3616cc8d43cecac20702 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-25124c17-c0bb-4e0c-a15e-aec45a83665c.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-25124c17-c0bb-4e0c-a15e-aec45a83665c.json) · SHA-256 2bc90e08100c21d3e50c03687093247ebc859a01df7390272c0870ab2ba856e5 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-26ba0cbe-9cc7-4b46-9354-83d5f607d112.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-26ba0cbe-9cc7-4b46-9354-83d5f607d112.json) · SHA-256 8f76e458933399012274223b6aed7969dbb56ef1c5344fec94d3dc220635df27 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-3ece50f9-59a0-4cdc-b4bf-2a49c6417f24.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-3ece50f9-59a0-4cdc-b4bf-2a49c6417f24.json) · SHA-256 552fb138334c7980b8b5e76662b5f7a963afa526e281a06a9a6c99818dceabbe · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-48f84aa4-89be-4c64-a64c-10371cad04c1.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-48f84aa4-89be-4c64-a64c-10371cad04c1.json) · SHA-256 27ddbbd82bf0457e1a6159f1341c65eb84ab042236dbc9da7609a91cfc6e3a43 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-569ccc41-fd8f-441f-8366-51d4e3474912.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-569ccc41-fd8f-441f-8366-51d4e3474912.json) · SHA-256 0b9dbee2d8dc9eeed7ea7683cd85e9cf003b4b9a453b7e09efbe389fef66e235 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-6b2ee0dc-2ee7-4f2f-b61b-5a06018d4b41.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-6b2ee0dc-2ee7-4f2f-b61b-5a06018d4b41.json) · SHA-256 3b521d5e3e66c687de2b2090f7ea91f5a7a59b1e008b7ee802a01a51032d72b8 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-9256584a-3d6c-4f56-b3c4-0daf67a7d844.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-9256584a-3d6c-4f56-b3c4-0daf67a7d844.json) · SHA-256 78e4d922f4e7fca246d5f1e55c6ed2b2d9f896e9094b6b5603a9a2583782fdc7 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-9ec8446f-47f1-4c66-ac43-b4c3927136c8.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-9ec8446f-47f1-4c66-ac43-b4c3927136c8.json) · SHA-256 9eed5fb4c2c3b9b99bfa00861598da5eebff281747f95c80eac9c1c298d1eb7d · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-cd58ec02-95ab-41b7-a928-39c55e223284.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-cd58ec02-95ab-41b7-a928-39c55e223284.json) · SHA-256 1cc1cac85a2e029abd0aca884c8a238378eb3c4f63acbd0c36180001344092bc · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-e7ff1828-3e3e-440a-afe4-8fa4675c94e7.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-e7ff1828-3e3e-440a-afe4-8fa4675c94e7.json) · SHA-256 22a9e0c48f94d0634f3dbdfd6060a2b4ea0bdc050d160f9621b145b1a7d86839 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-f99815d0-0841-4fa1-934b-a7b5c5db65eb.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/approvals/approval-f99815d0-0841-4fa1-934b-a7b5c5db65eb.json) · SHA-256 42664fb8078dda2d3681ee6f70993cf85a9a711d5793267a5df434738f78ec17 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/design-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/design-content.json) · SHA-256 cc7b5ca6927f2d451c2d36bc781124ef9448b5b34fc32d9f8d57614302fd6d18 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s1-amend-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s1-amend-content.json) · SHA-256 a387be697e03ca4b6ca7ad20b61f6cb2267d01e3f9670263e32ac7b71ef97510 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s1-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s1-content.json) · SHA-256 048e28c12b8b29b94d2cee1ab812ffec184b342794bf0938c67c861b30c5dad6 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s1-t8-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s1-t8-content.json) · SHA-256 434a1b1469026eaff6afebf811839dcba325318a4bb34f74bca6ed29484f3fcc · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend-content.json) · SHA-256 0d8bcaa6ac1c324e1c50f1c2ec3dfb160020180de22b468d03e2191dff8cf54f · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend22-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend22-content.json) · SHA-256 115c6e033fe2838625389ff938252fdce6a7100462d68772ad3c838bc7a07ee7 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend23-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend23-content.json) · SHA-256 279aab5cc72de40d5bd7df95ab5fdfdaa2ad585178d719e0f713b70d035bc0ad · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend24-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend24-content.json) · SHA-256 1287aff33440660db7cdd58cba870027a09b86a96e7a333d21a1c929e7fd2e49 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend25-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend25-content.json) · SHA-256 905d0b90d9048d30e455a25b22a9382902925e6bd0a1c02ba56a2963648f8b05 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend26-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend26-content.json) · SHA-256 053bae455fa0c3468a96d0e00d2fd7f0dc8f2da08ee158da53d48b76d2d73005 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend27-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-amend27-content.json) · SHA-256 cefdfaa381d5cd350f51fddde68c75fe48ca3801293854ebbf091a46e036be66 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/plan-s2-content.json) · SHA-256 7fdfcb6da6a576f8fc16feafb4513fdb725902f98d4fec317d5a11c482bfa4ce · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/content.json) · SHA-256 461f179331be5dcd8f3efe0e8ea38511d467e96e64d4a37ab941aa0a45ffac0c · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/publisher/qa.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/publisher/qa.json) · SHA-256 d322be17ea92e32cc9e8683c6cfcdae6b6557551cb302ef4f2356b1f4148f94a · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/publisher/quality.md](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/publisher/quality.md) · SHA-256 569711c7db2b14980bc8a2e6f5d4373458efc29cb33df658e07622f4f565f1ba · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/publisher/response.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/publisher/response.json) · SHA-256 772dded03cdb21936a646f187bb8d53ccb6296cb6abff573894af3f11b9ddb21 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/quality.md](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/quality.md) · SHA-256 cf9ee1d1700aac7a1b57fa0dd477a7b3ec82ecd62648194e067252403541e29c · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/receipt.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-0ea8f972-d7dc-454d-b9e1-2104e4ce3628/receipt.json) · SHA-256 b7eaec1c4c263af25ac7efcf80e7e85a8089a52c6571d318ac327083a763bb82 · durable run artifact
- [.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-25108219-4e14-4c0b-8433-b711417e4c4b/content.json](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/artifacts/publication-25108219-4e14-4c0b-8433-b711417e4c4b/content.json) · SHA-256 c474a6c73d11e5b843343ccfebd4495e25cad4c2b7744e04c5ea6b1658f047c6 · durable run artifact
… 1336 more retained files omitted; full records: [run directory](../.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd)
<!-- arh-w-dev run:run-7429291d-8129-432b-beab-c61fff1112cd handoff:end -->
