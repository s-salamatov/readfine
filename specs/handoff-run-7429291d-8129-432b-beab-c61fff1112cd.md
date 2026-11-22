<!-- arh-w-dev run:run-7429291d-8129-432b-beab-c61fff1112cd handoff:separator-empty -->
<!-- arh-w-dev run:run-7429291d-8129-432b-beab-c61fff1112cd handoff:begin -->
# Handoff: run-7429291d-8129-432b-beab-c61fff1112cd

Status: as-built / current

Next: Resume completion with current approvals and evidence checks.

Current segment: s2 (active); fact 1335.9 min, norm 1810 min, attempts 1340.6 min

## Summary

Run run-7429291d-8129-432b-beab-c61fff1112cd: Редизайн пользовательского интерфейса Readfine: визуальный язык shadcn через Basecoat (HTML/Jinja-порт без React) поверх FastAPI + Jinja2 + HTMX, анимации anime.js 4 + View Transitions, миграция Tailwind 3.4 → 4, новая информационная архитектура (Читать / Источники / Ассистент / Настройки, палитра ⌘K, единая AI-панель, мобильная навигация, undo-тосты). Макеты: scratchpad/readfine-redesign; прототип: https://claude.ai/artifact/BsuMQ732ksD3waLJfoY6Qa.. Stage: completion.

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

## Open Decisions

None.

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
