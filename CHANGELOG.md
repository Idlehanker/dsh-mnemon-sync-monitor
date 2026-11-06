# Changelog

## 0.5.4

并发蒸馏: several notes distil at once, under a bound.

A pass used to be a strictly serial `await` inside a `for` loop — one model call per
note, each taking 7–25 s. Walking a 389-file vault takes ~0.4 s (a full import of 326
documents measured 362 ms), so essentially the whole wall-clock cost of a pass was
one socket waiting at a time, and a large vault drained at exactly one note per call
latency.

### Added

- `distill.concurrency`, default **3**, hard range **1..8**. A value read from the
  patch file is clamped rather than rejected, so a hand-edited patch file cannot fan
  out past the ceiling: `1` reproduces 0.5.3 behaviour exactly, down to note order.
  Authored value wins over the bundle default, same precedence as the other `distill`
  keys.
- `GET /mnemon-sync-monitor/concurrency`, returning
  `{ "concurrency": { "value": 3, "max": 8, "default": 3 } }`, and
  `POST /mnemon-sync-monitor/concurrency` taking `{ "concurrency": 3 }` and replying
  `{ "concurrency": 3, "status": {...} }`. A non-integer or out-of-range value is
  **400** `invalid-concurrency`: the route rejects instead of clamping, so a page that
  asked for 12 is never left showing 12 while 8 is in force.
- `live.current.active` (how many notes are in flight) and `live.current.files`
  (`{file, bytes, startedAt}` per note) on the `/events` and `/state` payloads, so a
  page can show which notes are running concurrently. `live.current.file` is kept for
  compatibility and names the most recently started note.
- `/state` also reports top-level `concurrency`, `concurrencyMax`,
  `concurrencyDefault`.
- **并发蒸馏** control on the Settings page: a segmented row (1/2/3/4/6/8) under
  思考等级, plus a **`N 个 Agent 并行`** pill and the list of running notes in the live
  activity panel.

### Changed

- A note's insights are still persisted by that note's own `mnemon import`, and the
  ledger entry is still written only **after** the write succeeds — a failed call
  leaves the note pending for the next pass, unchanged. Content-key dedupe still
  spans the whole pass, now across workers. `maxFilesPerRun` still caps the notes one
  pass touches. The vault scan, the ledger save and the coverage total stay
  single-threaded.
- Changing the value applies from the next note onward; no restart and no reload.

## 0.5.3

The rescan button moved out of the input row.

### Changed

- **「立即扫描」 now sits in the watched-list header**, next to the list it
  operates on, instead of beside the path field. It re-scans the roots that are
  already being watched and never reads the text box - the route takes no body at
  all - but sharing a row with 添加 invited the reading "scan the path I just
  typed". The button is disabled when nothing is watched.
- A one-line hint under the field states the split: 添加 scans the directory it
  adds, 「立即扫描」 only covers the already-watched list.
- The button reports 扫描中… while a scan is in flight, so a slow pass over a
  2,897-file vault does not look like a dead click.

### Added

- `test/rescan-scope.test.js` pins the semantics three ways: only configured
  roots are scanned, the client sends no body, and the button renders in the list
  header rather than the input row.

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

Distillation that actually runs, coverage you can see, and a settings page rebuilt
around two functional groups.

- **Coverage is a content-hash ledger.** "Has this note been distilled?" is now a
  set difference against a ledger keyed by the hash of the cleaned body, not a
  comparison against a timestamp. A watermark asks *what changed since last time?*,
  and that question fails in two ways that both produced silently empty Memory
  Spaces: a first run had no previous mark and so distilled nothing ever, and a
  budget-capped pass advanced the mark over files it never consumed, so those were
  never retried. The ledger answers the question a user actually has -- *which
  documents have no distilled content right now?* -- and cannot drift.
  One hash links a file on one side and the content nodes produced from it on the
  other. A note that fails to distil gets **no** ledger entry, so the next pass
  retries it; a lost ledger simply makes every note pending again.
- **First run distils the backlog.** A vault with no recorded state is scanned in
  full instead of reporting "nothing changed".
- **Frontmatter is stripped on both line endings.** Matching only a bare LF
  delimiter left a Windows-saved Obsidian vault with its entire YAML block in the
  body: 277 of 352 records in one vault carried a duplicated `title:`/`tags:`
  block, which polluted the indexed text and broke body-level dedupe, since the same
  note hashed differently in a CRLF vault and an LF one.
- **Code blocks are dropped before the model sees a note.** A note that is almost
  entirely a Dataview query is template scaffolding, not knowledge; distilling it
  produced a description of syntax rather than a fact.
- **A note that is only frontmatter is skipped.** It has no indexable text.
- **The distillation command is resolved without trusting PATH.** The npm global
  prefix is probed, since `dirname(process.execPath)` does not point at it on an
  nvm-for-Windows layout, and the `.cmd` shim is invoked through `ComSpec`.
- **The model call gets a real timeout.** The adapter's own timeout is passed
  through, so a larger parent timeout actually applies.
- **Profile writes cannot corrupt the patch.** The roots key is inserted inside the
  `config:` block instead of above it (which produced YAML a parser rejects and an
  unloadable profile); the writer keeps the file's own line endings instead of
  mixing them; a row nested under `insert:` is found and edited rather than
  invisible, which previously made the switch fail and the roots save append a
  duplicate row; and the distillation switch creates its own block when the
  profile has none.
- **The settings page is two groups.** 知识库监听 (roots, add, remove, rescan) and
  语义蒸馏 (switch, model tree, coverage), with a real toggle instead of a
  checkbox, a provider-to-model tree, and a coverage bar reading
  *distilled / total*.
- **`GET /coverage`** reports the ledger without spending a model call, and
  `/state` embeds the same figures.
- **The bundle ships a `distill:` block.** A profile row replaces the whole config
  object, so a fresh profile without that block could not persist the switch at all.
## 0.2.0

Memory Space distillation, change detection for edits made while DSH was down, and
settings-page controls for both.

- **Distillation into Memory Spaces.** A changed note can be distilled by a model
  into self-contained conclusions and written to Memory Spaces, which is the only
  layer that answers by meaning rather than by wording. Off by default; enable with
  the `distill` block.
- **Model selection from the settings page.** The picker reads the composer's own
  `ctx.llm` catalog, so the two surfaces can never disagree about available models.
  The selection persists in the plugin's row as `distillModel`.
- **Live on/off switch.** `POST /enabled` flips distillation without a restart and
  cancels a pass that was already scheduled.
- **Change detection for offline edits.** Git roots are diffed against the last
  recorded commit; other roots are scanned by mtime high-water mark. Git is used only
  when the work tree is clean and the probe succeeds; otherwise the detector degrades
  to mtime and logs why.
- **Tooling sidecars are excluded.** `.agents`, `logseq`, `assets`, `.git` and
  the build/cache directories are no longer indexed.
- **Root consolidation.** One root per knowledge base; sub-directories of the same
  repository belong under one root.

## 0.1.0

Initial release.

- Real-time `fs.watch` monitoring of Markdown knowledge bases.
- Incremental reconciliation: create on new file, update on content-hash change, archive on delete.
- Interoperates with the dsh-mnemon Documents index lock and atomic-rename protocol.
- Cross-root isolation via explicit owning-root encoding in `sourcePaths[0]`.
- Capacity ceiling and single-document size ceiling enforced.
