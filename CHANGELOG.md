# Changelog

## 0.5.2

The activity log scrolled while the coverage number never moved.

### Fixed

- **Stale progress numbers.** The `state` SSE frame is an envelope
  (`{kind, seq, at, state}`). The `hello` handler unwrapped it correctly, but the
  `state` handler passed the **envelope** to the page, so every reader of
  `live.phase` / `live.coverage` got `undefined` forever. The activity log kept
  scrolling because it does not read `live` — which is exactly why the two
  disagreed: a fresh page load looked right (via `hello`), and only subsequent
  updates were lost.
- **Coverage only moved once per pass.** `refreshCoverage()` ran when a pass
  ended. A pass is capped at `maxFilesPerRun` notes at minutes per note, so the bar
  sat still for the entire batch. Each `note-done` now advances the ledger
  incrementally — one distilled note is one unit — so the number tracks the log.

### Added

- `test/client-frames.test.js` — pins the frame contract: consumers must receive
  `event.state`, never the envelope. Verified by reintroducing the bug, which the
  test catches.

## 0.5.1

Fix the load-time failure that removed the plugin from the Host, and make a
partial install impossible.

### Fixed

- **The settings page disappeared after a restart.** `lib/index.js` imported
  `readDistillEffort`, `writeDistillEffort`, `DEFAULT_DISTILL_EFFORT` and
  `DISTILL_EFFORTS` from `lib/persist.js`, but the installed `persist.js` was a
  stale copy that exported none of them. ESM resolves named imports at
  **instantiation**, before any code runs, so the module threw and the plugin was
  dropped from the profile: no log line, no error the Host could surface, and no
  settings page. A partial update — one file copied, its dependency not — produces
  exactly this. Confirmed live: every `/mnemon-sync-monitor/*` path answered 404
  while `/api/health` answered 401, i.e. the Host was up and the route was never
  mounted.

### Added

- `scripts/install.mjs` — installs the **whole** shipment atomically. Stages into
  a temporary directory, checks every named import against the sibling that should
  provide it (naming the missing symbol), loads the staged tree as the
  authoritative check, then swaps it into place and keeps the previous install as
  a rollback point. `--dry-run` verifies without writing.
- `test/imports.test.js` — the same checks as a test. Verified by reintroducing
  the stale `persist.js`: it reports all four missing exports by name.

### Changed

- Test isolation. `apply-wiring` and both e2e suites now pass an explicit
  `patchPath`, because `apply()` prefers the distillation switch persisted in the
  profile over the one in `config`. Without it they read the user's real profile
  and could fire a real pass into the real memory space.

## 0.5.0

Thinking tier for distillation, defaulting to `low`.

Distillation inherited whatever effort the model applied by default (measured:
`high` on `workbuddy/deepseek-v4.1-flash`). That default is tuned for reasoning
tasks, but distillation runs **once per changed note** and answers with a short
JSON list, so thinking spent above that level is paid on every note in the vault.

### Added

- `distill.reasoningEffort`, default **`low`**. Forwarded verbatim as
  `reasoning_effort`; empty sends no override at all, which is deliberately
  different from sending `default`.
- **思考等级** control on the Settings page: a segmented row under the model
  picker. Tiers are read from the selected model's own capability declaration, so
  an unsupported value cannot be selected. Changing it applies to the next note —
  no restart, and a pass already in flight picks it up.
- `GET /mnemon-sync-monitor/efforts` and `POST /mnemon-sync-monitor/effort`.
- `scripts/distill-gateway.mjs` — the reference adapter, now reading
  `DISTILL_EFFORT` and passing it through.
- `readDistillEffort` / `writeDistillEffort` in `lib/persist.js`, scoped to the
  `distill:` block so a same-named key in another plugin row is never touched.

### Measured

4 runs per tier, same note, same gateway (`workbuddy/deepseek-v4.1-flash`):

| Effort | Avg completion tokens | Avg reasoning chars | Avg latency |
|---|---:|---:|---:|
| `low` | 1,582 | 1,663 | 7.2 s |
| `high` (model default) | 1,655 | 2,243 | 7.2 s |
| `max` | 2,395 | 4,405 | 10.1 s |

`low` uses ~26% less reasoning and ~4% fewer completion tokens than `high`. A
single run is too noisy to compare tiers: an earlier one-off sample had `low`
producing *more* reasoning than `high`, which is why these are averages.

## 0.4.0

Live activity, pushed instead of polled.

The Settings page used to read `/state` exactly once, on mount, and never again.
That was not a rendering bug: the numbers on screen were a snapshot taken when the
pane opened, so a pass that started afterwards could not move them. The visible
symptom was a coverage bar frozen at the same value forever, which reads as
"distillation is stuck" even when it is working.

The repair is a subscription, not a timer. Every fact the page shows is now
produced by the code that already knows it changed.

### Added

- `lib/events.js` — an `ActivityHub` (observer pattern) plus an SSE transport.
  `setState()` publishes the whole status object; `note()` appends one activity
  line to a bounded ring. Publishing with zero subscribers is an array push.
- `GET /mnemon-sync-monitor/events` — `text/event-stream`. Sends `hello` (current
  snapshot + recent activity) immediately on connect, then `state` and
  `activity` frames. Sits inside the trust fence: an unauthenticated caller gets
  the same 401 as every other path and cannot probe it.
- A live activity panel on the Settings page: phase, current file and its size,
  batch progress (`done / planned`), insights written, next scheduled run, the
  last error, and a scrolling activity log. Plus a **立即蒸馏** button.
- `distill.autoContinue` (default `true`). A pass is capped at `maxFilesPerRun`;
  finishing one with backlog left now queues the next, so a 1,171-note backlog
  actually drains. Chaining uses `force`, so a single manual start also finishes
  the backlog it began even when `automatic` is off.

### Changed

- `POST /distill` answers **202 Accepted** immediately instead of holding the
  request open for the whole pass and returning the report in the reply. The
  outcome travels over `/events` like every other progress fact. A second start
  while one is running returns **409**.
- `runDistillPass()` accepts `onEvent` and publishes `{type: 'root'} `,
  `note-start`, `note-done`, `note-failed`. `note-start` fires **before** the
  model call, so a page opened mid-call names the file actually in flight.
  A throwing observer cannot abort the pass.
- `/state` also reports `distill.live` and `distill.subscribers`, so the first
  paint and the stream cannot disagree.
- Startup walks coverage once per root and publishes it. That is the only
  scheduled scan; afterwards the number moves because something happened.

### Fixed

- The coverage bar never updated while the page was open. It now updates within
  one tick of a pass completing.

## 0.3.0

- Model-driven distillation through the local gateway, with a model picker sourced
  from the composer's own catalog.
- Live on/off switch that persists to the profile patch without a restart.
- Ledger-based coverage: a content-hash set difference, correct across edits,
  restarts and a lost ledger.

## 0.2.0

- Distillation sidecar: vault changes become Memory Space insights.
- Change detection through git where the root is a healthy repo, mtime otherwise.

## 0.1.0

Initial release.

- Real-time `fs.watch` monitoring of Markdown knowledge bases.
- Incremental reconciliation: create on new file, update on content-hash change, archive on delete.
- Interoperates with the dsh-mnemon Documents index lock and atomic-rename protocol.
- Cross-root isolation via explicit owning-root encoding in `sourcePaths[0]`.
- Capacity ceiling and single-document size ceiling enforced.
