<!-- arh-w-dev run:run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b handoff:separator-empty -->
<!-- arh-w-dev run:run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b handoff:begin -->
# Handoff: run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b

Status: as-built / current

Next: Resume completion with current approvals and evidence checks.

Current segment: s1 (active); fact 351.7 min, norm 275 min, attempts 284 min

## Summary

Run run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b: Readfine instant launch: no white screen when the iPhone home-screen app opens, online or offline. (1) Cache-first app shell: the flagged worker answers the /app (and /) launch navigation from the stored readfine-pages-&#60;uid&#62; copy at once, also online, and refreshes the stored copy from the network in the background (stale-while-revalidate), keeping offline v2 guarantees (decision table rows, mirror, logout/wipe, user switch, session expiry, app-version change). (2) Versioned static assets (?v= content hash) served cache-first by the worker (they never change under their URL), network on miss. (3) Branded launch: iOS apple-touch-startup-image splash screens and manifest background/theme colors instead of a white screen. Owner request 2026-11-20 after the launch-timing hotfix (immutable versioned statics) made launch faster but a white screen remains.. Stage: completion.

Task worker-launch: completed

Task clean-launch-url: completed

Task shell-publish: completed

Task ios-splash: completed

Task launch-e2e: completed

worker-launch.a1 (task, implementation, codex/worker, reported, outcome done): Flagged worker paints the neutral launch page from memory, confirms sessions with one-time client-bound codes, and rout…

worker-launch.a2 (task, implementation, codex/verifier, reported, outcome done): Worker-launch verification found one major gap in the confirmation deadline. The planned suites, both standalone npm te…

worker-launch.a3 (task, implementation, codex/worker, reported, outcome done): wlv-1 fixed. The single 8000 ms abort deadline now covers the /sync/changes fetch and eligible HTTP 200 JSON body read.…

worker-launch.a4 (task, implementation, codex/verifier, reported, outcome done): wlv-1 resolved. On a real clock with HTTP 200 headers/body read at 504 ms and an unfinished body, the same 8 s deadline…

worker-launch.a5 (task, implementation, codex/reviewer, reported, outcome done): PASS. Spec compliance: ✅ scoped worker-launch requirements; ⚠️ browser paint/SMIL and physical iOS require launch-e2e/o…

worker-launch.a6 (task, implementation, codex/verifier, reported, outcome done): На HEAD cb66545 проверка worker-launch пройдена в пределах файлов задачи. Общая проверка неизменности backend/app/stati…

worker-launch.a7 (task, implementation, codex/verifier, reported, outcome done): Повторная проверка worker-launch на cb66545 пройдена в исправленных границах. Diff трёх файлов пуст, целевые тесты 60/6…

worker-launch.a8 (task, implementation, codex/reviewer, reported, outcome done): Spec compliance: ✅ — tests/js/offline-worker-nav.test.mjs:497–504 соответствует указанной границе design rev 6 §4.1: пе…

clean-launch-url.a1 (task, implementation, codex/worker, reported, outcome done): Page startup removes rf&#95;launch from / and /app with history.replaceState before async controller startup. Preserves his…

clean-launch-url.a2 (task, implementation, codex/verifier, reported, outcome done): Task verdict: fail. Direct page.js startup cleans both app paths for all three values and preserves state, repeated que…

clean-launch-url.a3 (task, implementation, codex/worker, reported, outcome done): clv-1 fixed. Synchronous init.js removes rf&#95;launch on / and /app before app.js list routing, including when offline boo…

clean-launch-url.a4 (task, implementation, codex/verifier, reported, outcome done): Повторная проверка clv-1 пройдена. В порядке загрузки из base.html синхронный init.js удаляет rf&#95;launch до чтения URL в…

clean-launch-url.a5 (task, implementation, codex/reviewer, reported, outcome done): FAIL. Spec compliance: ❌ backend/app/static/js/init.js:5-8 violates the brief's must-never-throw and existing-layout no…

clean-launch-url.a6 (task, implementation, codex/worker, reported, outcome done): clr-1 fixed. The synchronous rf&#95;launch cleanup in the approved init.js owner catches errors across URL parsing and hist…

clean-launch-url.a7 (task, implementation, codex/reviewer, reported, outcome done): PASS. Spec compliance: ✅ clr-1 ADDRESSED at backend/app/static/js/init.js:4-14: location access, URL parsing, query mut…

clean-launch-url.a8 (task, implementation, codex/verifier, reported, outcome done): Final verification passed on the current tree after the clr-1 repair. The task GREEN command passed 27 tests, the stand…

shell-publish.a1 (task, implementation, codex/worker, reported, outcome done): a6 excludes startup-image links and validates newly fetched versioned assets before Cache Storage writes. /&#95;&#95;rf/pages-i…

shell-publish.a2 (task, implementation, codex/verifier, reported, outcome done): Сделано: проверены два файла shell-publish по утверждённому плану и дизайну rev 6 (P3/P4). Независимый прогон cachePage…

shell-publish.a3 (task, implementation, codex/reviewer, reported, outcome done): PASS. Spec compliance: ✅; Quality: Approved. Сделано: статическое review shell-publish по P3/P4 и task brief. sync.js:5…

ios-splash.a1 (task, implementation, codex/worker, reported, outcome done): Implemented the approved 68-link iOS/iPadOS startup matrix and generated 68 indexed PNGs totaling 917108 bytes. The cen…

ios-splash.a2 (task, implementation, codex/verifier, reported, outcome done): Scoped verification passed against the approved P3 revision 6 and ios-splash task. All 68 links and PNGs match the 17-r…

ios-splash.a3 (task, implementation, codex/reviewer, reported, outcome done): PASS. Spec compliance: ✅ — base.html:25–42, scripts/gen&#95;splash.py:1–45 and test&#95;pwa.py:65–122 implement the approved io…

ios-splash.a4 (task, implementation, codex/verifier, reported, outcome done): Повторная проверка ios-splash на HEAD cb66545 прошла по всем трём критериям.

ios-splash.a5 (task, implementation, codex/reviewer, reported, outcome done): Spec compliance: ✅. Quality: Approved. Статический review cb66545: утверждения корректны для всех 68 записей матрицы, ч…

launch-e2e.a1 (task, implementation, codex/worker, reported, outcome done): Added four instant-launch E2E scenarios shared by Chrome and WebKit, guarded loopback controls for the real worker conf…

launch-e2e.a2 (task, implementation, codex/verifier, reported, outcome done): Independent verification ran all five requested commands. Both scoped coverage findings are major: the online test does…

launch-e2e.a3 (task, implementation, codex/worker, reported, outcome done): lev-1 fixed: compare main-frame commits, document initialization and reader DOM observations against the loopback fixtu…

launch-e2e.a4 (task, implementation, codex/verifier, reported, outcome done): Independent WebKit re-verification passed. lev-1 is resolved by checking navigation and reader DOM chronology against t…

launch-e2e.a5 (task, implementation, codex/reviewer, reported, outcome done): Spec compliance: ❌ deterministic ordering requirement — tests/e2e/instant-launch.spec.mjs:220–231 compares independentl…

launch-e2e.a6 (task, implementation, codex/worker, reported, outcome done): ler-1 fixed. A single Node journal records main-frame commits, browser DOM observations, release and the HTTP 200 obser…

… 24 more summary lines omitted; full records: [run directory](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b)

## Plan and facts

- Retained inventory: 211 files, 1230043 bytes; skipped symlinks 0, node_modules 0.
- Plan/fact segment s1: fact 351.7 min, norm 275 min, attempts 284 min
- Plan/fact run: fact 351.7 min, norm 275 min
- Plan/fact task worker-launch (L): fact 265.7 min, norm 90 min
- Plan/fact task clean-launch-url (S): fact 24 min, norm 15 min
- Plan/fact task shell-publish (M): fact 12.7 min, norm 40 min
- Plan/fact task ios-splash (M): fact 251.8 min, norm 40 min
- Plan/fact task launch-e2e (L): fact 213.2 min, norm 90 min

## Open Decisions

None.

## Retained evidence

- [.arh-w-dev/plans/2026-11-20-instant-launch-design.md](../.arh-w-dev/plans/2026-11-20-instant-launch-design.md) · SHA-256 b9515fedf959e67fbc0d62aad6e7f9ec6c307094cf7fb90f017bdfaedd36d29a · design&#95;document
- [.arh-w-dev/plans/2026-11-20-instant-launch-plan.md](../.arh-w-dev/plans/2026-11-20-instant-launch-plan.md) · SHA-256 d87a2f7b3a332d35dc320884dd97ee20512a1fe5c38047ba376a522c8f425295 · implementation&#95;plan
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/approvals/approval-7a9cce77-bf0a-416f-831b-b494b05c7f49.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/approvals/approval-7a9cce77-bf0a-416f-831b-b494b05c7f49.json) · SHA-256 632208593c16815c940f6bb0c017e334f6433c72c22da1c369995382260a5586 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/approvals/approval-f633d357-063f-4d1d-895e-08eb2fc74388.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/approvals/approval-f633d357-063f-4d1d-895e-08eb2fc74388.json) · SHA-256 2d6b17f36e477eca28a8c610a8b2db92e38342d35c63ad77f47ce9fb30da1fdd · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/design-content.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/design-content.json) · SHA-256 51716ad922ff4f569491281a1a52f4742c31e575c5870326538c0123b56b6d7e · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/page.html](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/page.html) · SHA-256 fab970e1719bcc08c4843fa2048598cd69e0af3e53a08e0ce7babbfadebbb35c · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/plan-content.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/plan-content.json) · SHA-256 98216e43e479fac3a8ee7274be9d30fa9ae862599a28d7063f7a64aff149ad88 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/content.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/content.json) · SHA-256 ec128db1dbf227137ce76c32e1f6d897074986deb5a96c798f6a470ff508b10a · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/publisher/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/publisher/quality.md) · SHA-256 93d067037e8adbfc32bd58703fc9a7b784a07833ef82093c6b3f6f75097969d7 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/publisher/response.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/publisher/response.json) · SHA-256 2655d2d580dfa76ef133256630d94907bbd317507b74276c89d55f2f48353b7a · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/quality.md) · SHA-256 f215449f6cc946810062018d4cb033b6d6302606a68353f5981a1fd2b407ffde · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/receipt.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-4b566b43-ef2c-4b0b-ba44-a08894bd4ff1/receipt.json) · SHA-256 6f1143819f4a7a707a167279c3245ecb413effa053f4a9bbbbf1436fd95b4035 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/content.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/content.json) · SHA-256 4ec218695b2a41e91e0faff1abe02e740f94bf1bf4f50789566c98a7f45155bb · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/publisher/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/publisher/quality.md) · SHA-256 3fc47cd2965e7f262af0cf5eec1f2f41bd96e9608776358c75524d9b7d1f426f · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/publisher/response.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/publisher/response.json) · SHA-256 da30929047793bfb61b48fab19b28082c6e59e619dab349390697250194c7cf9 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/quality.md) · SHA-256 b08f1bc757f80cca728a0d28b6ac10a8e6059bf027f06a882e2495af891d895b · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/receipt.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-74354b1d-6387-4fc3-b82d-bf7b94d28e85/receipt.json) · SHA-256 57d2ae6f5081351f94aa0d07c840d4a3031182dbbf0eb2af495c45ec11bad20b · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/content.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/content.json) · SHA-256 118524fb33f66dd66037d33e57e79a3ada33126f5526fd033565eb52ea5c8766 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/publisher/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/publisher/quality.md) · SHA-256 c3bda87eaf5b57763cd7f540f2a288740dc4d33f4aabbd930e7dcbc685ef0c94 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/publisher/response.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/publisher/response.json) · SHA-256 39d0201f8d25195056f2400ed7b0f98b13ef1b298d025aaee49ac7a337d2d70a · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/quality.md) · SHA-256 0fe0ee5a5b511db8c00b4e1ef413d23fb98b31413a7210430634d525dfa9a49d · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/receipt.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-87792ad4-ba23-4668-9e31-855a0fb5aac3/receipt.json) · SHA-256 29931a475e3aedf45809fe01024f006af7f842abcb8c423343b5b7cf74be5b33 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/content.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/content.json) · SHA-256 123034674765308369924af8f70ffdaaa977a4c16b31a935815c0c58296a7352 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/publisher/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/publisher/quality.md) · SHA-256 a3bb76ca4d797ab0f46a1bf0ed1e352c32788b86823655ab4e8e58b285876c2e · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/publisher/response.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/publisher/response.json) · SHA-256 b04ed5845a8e3b309ba13f6f49029f7b2993c7b586c3dd0b36ab45e5302980ab · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/quality.md) · SHA-256 01f57ff15c575ccedaa1fa5b245f46d1c2626326d101228d1caf53a45d71104f · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/receipt.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b7041094-01b0-4b1a-898f-a6cff66783e3/receipt.json) · SHA-256 515969987106a97a18a31778715ffc89d03e8edcc89db943ca7527b4b9d7548c · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b893aa73-578a-46c3-95dc-a66cc2b6dd1b/content.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b893aa73-578a-46c3-95dc-a66cc2b6dd1b/content.json) · SHA-256 3d318c3f4e61985f896504aa52825004dd581ab9d2496a0c0b859eccf73fa303 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b893aa73-578a-46c3-95dc-a66cc2b6dd1b/publisher/quality.md](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b893aa73-578a-46c3-95dc-a66cc2b6dd1b/publisher/quality.md) · SHA-256 df5e250f0627b54746320138cd1f1645943c151a4f32219763377dbc7af88c42 · durable run artifact
- [.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b893aa73-578a-46c3-95dc-a66cc2b6dd1b/publisher/response.json](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b/artifacts/publication-b893aa73-578a-46c3-95dc-a66cc2b6dd1b/publisher/response.json) · SHA-256 9232980da7d49b5058408f16515dead21b82bf40b18f4ff4587239270c90d45c · durable run artifact
… 183 more retained files omitted; full records: [run directory](../.arh-w-dev/runs/run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b)
<!-- arh-w-dev run:run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b handoff:end -->
