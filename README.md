# dsh-mnemon-sync-monitor

Real-time file watcher that keeps [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) Project Documents in sync with local Markdown knowledge bases, and optionally distils those notes into Memory Spaces so they are reachable **by meaning** rather than by wording.

dsh-mnemon's Documents Source is a **snapshot store**: it imports files once and never notices later edits, additions, or deletions. This plugin closes that gap. It watches your knowledge bases and reconciles changes within a debounce window.

## Why this exists

Measured behaviour of dsh-mnemon 0.5.39 before this plugin:

| Change to your knowledge base | Automatic? | Why |
|---|---|---|
| New file | No | No file-system watcher anywhere in the Documents Source |
| Edited file | No | The store holds a **copy**, not a reference |
| Deleted file | No | The copy survives the source forever |

A `grep` for `fs.watch`, `chokidar`, or `FSWatcher` across `dsh-mnemon-source-documents` returns zero hits. There is also no reindex path: `index.json` is the only source of truth and nothing rescans directories.

## What it does

| Source change | Action |
|---|---|
| New file | Create a document |
| Content hash changed | Update the document in place, `revision + 1` |
| File deleted | Archive the document (only with `prune: true`) |
| Unchanged | Skip |

Changes are coalesced with a debounce window, then applied atomically under the Documents index lock.

Optionally, the same notes can be **distilled into Memory Spaces**. See [Distillation into Memory Spaces](#distillation-into-memory-spaces).

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-mnemon-sync-monitor
```

Then configure the roots to watch in your profile's `cordis.patch.yml`:

```yaml
- id: mnemon-sync-monitor
  name: dsh-mnemon-sync-monitor
  config:
    enabled: true
    roots:
      - C:\Users\me\Obsidian\vault
      - C:\Users\me\Logseq\pages
    debounceMs: 800
    minBytes: 200
    distill:
      enabled: false
      command: 'node C:\path\to\distill-gateway.mjs'
```

Restart DSH. The plugin reconciles each root once at startup, then follows changes.

> **A profile row replaces the whole config object.** Write every key you need; a key
> left out is not merged with the bundle's default, it is *gone*. In particular the
> `distill:` block must exist in your profile or the Settings switch cannot be
> persisted and distillation never runs.

## Settings page

The bundle ships a Client half: a **Settings → 知识库同步** page with two groups.

**知识库监听** — the watched roots and the add/remove/rescan controls.

| Action | Effect |
|---|---|
| See roots | Each row shows the path, whether it exists, and its Markdown count |
| Add | Validates the path is an existing directory, then starts watching it immediately |
| Remove | Stops watching; documents already synced stay in the store |
| Rescan | Runs one reconciliation pass over every watched root now |

**语义蒸馏** — the Memory Space distillation controls.

| Action | Effect |
|---|---|
| **Switch** | Turns distillation on or off, live |
| **Model picker** | A provider→model tree; pick which model distils changed notes |
| **Coverage** | How many notes have distilled content, and how many still do not |

Both distillation controls take effect immediately — no restart. The switch also clears a debounce timer that was already scheduled, so a pass never fires after you switch it off.

The model list is the **same catalog the main composer renders under its input box**, read from the one `ctx.llm` registry, so the two can never disagree about which models exist. Selecting a model writes it into the plugin's row and survives a restart; choosing "follow the page default" clears it.

The page writes through the Host route `/mnemon-sync-monitor`, which owns the connection trust fence. Edits are persisted into the plugin's own row in the profile `cordis.patch.yml`, and **every other line of that file is preserved byte for byte** — the writer replaces only the lines it owns rather than re-serializing the YAML, so comments and neighbouring rows survive.

Adding or removing a root takes effect without a restart: the watcher is attached or detached live. The configuration file is still updated so the change survives the next boot.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/mnemon-sync-monitor/state` | Roots with existence and Markdown counts, store path, patch path, distillation status and coverage |
| GET | `/mnemon-sync-monitor/coverage` | Ledger report only: scanned / distilled / pending per root. Costs no model call |
| POST | `/mnemon-sync-monitor/roots` | Add `{root}`; 400 invalid, 409 duplicate |
| POST | `/mnemon-sync-monitor/roots/remove` | Remove `{root}`; 404 unknown |
| POST | `/mnemon-sync-monitor/rescan` | Reconcile all roots now |
| GET | `/mnemon-sync-monitor/models` | The composer's model catalog plus the current selection |
| POST | `/mnemon-sync-monitor/model` | Set the distillation model; body `{ value }`, where value is `JSON.stringify([provider, model])` or `null` to clear |
| POST | `/mnemon-sync-monitor/enabled` | Turn distillation on or off; body `{ enabled }` |
| POST | `/mnemon-sync-monitor/distill` | Run one distillation pass now |

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `roots` | `[]` | Absolute directories to watch. Empty disables the plugin. |
| `storeDirectory` | `~/.mnemon/documents` | Documents store to write into. |
| `debounceMs` | `800` | Quiet window before reconciling. |
| `minBytes` | `200` | Files smaller than this are ignored (Logseq empties are often <200 B). |
| `prune` | `false` | Archive store records whose source file disappeared. |
| `dryRun` | `false` | Detect and log without writing. |
| `limitBytes` | `33554432` | Active capacity ceiling (32 MiB). |
| `distill.enabled` | `false` | Master switch for the Memory Space distillation. |
| `distill.automatic` | `true` | Fire a pass from the watcher, not only from the manual route. |
| `distill.debounceMs` | `30000` | Quiet window before distilling. |
| `distill.maxFilesPerRun` | `10` | **Pending** notes distilled per pass. |
| `distill.maxInsightsPerFile` | `4` | Insights a single file may yield. |
| `distill.command` | empty | Shell command for the model call. |
| `distill.commandTimeoutMs` | `300000` | Ceiling for one model call. |
| `distillModel` | *unset* | `JSON.stringify([provider, model])`; unset means "follow the page default". |

## Distillation into Memory Spaces

The Documents layer is **lexical**. It matches substrings and Chinese bigrams, so
asking it with different words finds nothing: on a reference vault, "刚加进来的笔记搜不到"
matched 25 pages, all of them fund-certification notes, because `笔记` is a common
bigram. Memory Spaces do vector recall, but dsh-mnemon's own `idleReview` cannot write
there — its tool table has no `mnemon_remember`, and the `MEMORY.md → ARCHIVE_PERSONA`
route needs MEMORY.md near capacity first.

This plugin closes that gap. It can ask a model to distil a note into self-contained
conclusions and write them into Memory Spaces, where a reworded question actually finds
them.

### Configuration

```yaml
- id: mnemon-sync-monitor
  name: dsh-mnemon-sync-monitor
  config:
    enabled: true
    roots:
      - C:\Users\me\vault
    distill:
      enabled: true
      automatic: true
      debounceMs: 30000
      maxFilesPerRun: 10
      maxInsightsPerFile: 4
      command: 'node C:\path\to\distill-gateway.mjs'
    distillModel: '["workbuddy","hy4free"]'
```

`command` receives a JSON object with a `messages` array on stdin and must print the
completion text on stdout. It is a short-lived child process, so credentials and
retry policy stay out of the Host.

### Coverage is a set difference, not a timestamp

"Has this note been distilled?" is answered by a **content-hash ledger**, not by a
high-water mark. A watermark asks *what changed since last time?*, and that question
fails in two ways that both produced silently empty Memory Spaces:

| Question | Failure |
|---|---|
| "What changed since the last pass?" | a first run has no previous mark, so a freshly configured vault distilled **nothing, ever** |
| the same, with a budget | the mark advanced over files the budget skipped, so they were **never retried** |

The ledger instead answers the question a user actually has: **which documents have no
distilled content right now?** That is a set difference, and it cannot drift.

`~/.mnemon/documents/.distill/<sha256(root)>.json` holds one record per **content
hash** — the hash of the *cleaned* body, which is exactly the text handed to the model:

```json
{
  "version": 2,
  "entries": {
    "<sha256 of cleaned body>": {
      "rel": "Anno/CFA.md",
      "insights": ["8f221e6d-…", "8d9ea344-…"],
      "distilled": 2,
      "at": "2026-11-05T00:12:00.000Z"
    }
  }
}
```

One hash links a file on one side and the content nodes produced from it on the other.

| Event | Effect |
|---|---|
| Note edited | New hash, no entry → re-distilled |
| Note renamed or moved | Same hash → **not** re-distilled |
| Trailing-newline edit | Hash normalises whitespace → not re-distilled |
| Ledger lost or reset | Every note becomes pending → re-distilled; the CLI dedupes on content, so the cost is model calls only |
| A note failed to distil | **No entry is written** → the next pass retries it |

The last row is what makes the design self-healing rather than a one-shot marker: a
failure leaves the note pending, so nothing is silently dropped. A v1 watermark file
parses as an *empty* ledger, which means the first pass after upgrading re-checks every
note — deliberate, because when we cannot prove what was distilled, redoing it is the
safe answer.

### One model catalog, two surfaces

The settings page lists models from `GET /models`, which reads the **same**
`ctx.llm` registry that builds the composer's model list under the input box. There is
no second catalog, so the picker and the composer cannot disagree. The identity is the
composer's own encoding, `JSON.stringify([provider, model])`; the Host converts it back
to `provider/model` and passes it as `DISTILL_MODEL` to the command.

The plugin deliberately does **not** declare `inject: ['llm']`. That would make the
whole watcher fail to start on a profile without the service. It uses `ctx.get('llm')`
optionally and returns an empty list when unavailable, so the roots manager still works.

### Measure the model before trusting it

A distillation model has to answer **every** changed note. Measured on the same
4,000-character note, same prompt, same gateway:

| Model | Latency | Notes |
|---|---:|---|
| `workbuddy/hy4free` | 220 s | free tier; its default reasoning effort is `high` |
| `deepseek-account/deepseek-flash` | 5.6 s | 39× faster, equal or better output |

With a 180 s command timeout, a slow free model means **every long note times out and
contributes nothing** while the switch shows *on*. Free is not the same as usable: the
cost of the model is paid once per note, and the cost of a slow model is paid by
every note that never gets processed. Test with a realistic long note — a short one
hides the problem.

### What the model actually sees

Before the model is called, a note is cleaned: frontmatter is stripped and fenced
code blocks are dropped.

- **Frontmatter must be stripped on both line endings.** Matching only a bare LF
  delimiter means a Windows-saved Obsidian vault keeps its whole YAML block, and the
  YAML becomes indexed prose. Measured: 277 of 352 records in one vault carried a
  duplicated `title:`/`tags:` block, which also broke body-level dedupe — the same
  note hashed differently in a CRLF vault and an LF one.
- **Code blocks are dropped.** An Obsidian note can be almost entirely a Dataview
  query — template scaffolding with no knowledge in it. Distilling that produces a
  description of syntax, not a fact about anything.
- **A note that is only frontmatter** has no indexable text and is skipped.

### Limits worth knowing

- **8,000 UTF-8 bytes per insight, hard and silent.** The Host's store rejects more.
  A command that generates insights must clamp on `Buffer.byteLength` and never split a
  multi-byte character.
- **1,000 insights by default**, soft-deleted above that. `maxFilesPerRun` and
  `maxInsightsPerFile` keep a pass from flooding the ceiling.
- **The distilled text does not update Documents.** The two stores drift unless both run.
- **The distillation command is shell-interpreted.** Treat it as trusted
  configuration; it is not reachable from the HTTP route.

## Safety properties

These are enforced by tests in `test/sync.test.js`:

1. **Cross-root isolation.** Each record records its owning root in `sourcePaths[0]` as `<absolute-root>\u0000<relative>`. Pruning one root can never archive another root's documents.
2. **Lock interoperability.** Writes take `.index.lock` with `wx` exclusive create, retry every 20 ms, give up after 5 s, and steal a lock older than 30 s — identical to the Documents Source, so a running Host and this watcher never corrupt the index.
3. **Atomic index writes.** The index is written to a temporary file and renamed, matching the Source.
4. **Capacity ceiling.** Documents beyond `limitBytes` are skipped rather than failing the whole pass.
5. **Single-document ceiling.** Documents over 2 MiB are skipped.
6. **Profile writes preserve the file.** The patch writer edits only the lines it owns and keeps the file's own line endings, so a CRLF patch does not silently become mixed.

## Important operational note

dsh-mnemon pins Project Documents into a View **when the session starts** (the route description is literally *"Search only the project Documents pinned into this View"*). The watcher updates the store immediately, but **a running session will not see new documents until a new session starts.**

The same applies to the plugin's own code: it is loaded into the Host at startup, so a
change under `lib/` needs a Host restart, while `client.js` is picked up by the client
HMR watcher on refresh.

## Development

```sh
node --test "test/*.test.js"   # unit tests, no dependencies
node test/e2e.mjs              # end-to-end watcher test
node test/route.e2e.mjs        # REST route round trip
node test/live.mjs <kb-root>   # validate against a real knowledge base
```

No runtime dependencies. Node 22+ (uses `fs.watch` with `recursive`).

## Measured performance

Against a real 389-file Obsidian vault: a full import of 326 documents took **362 ms**.

## License

MIT
