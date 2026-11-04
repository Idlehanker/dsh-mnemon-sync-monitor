# dsh-mnemon-sync-monitor

Real-time file watcher that keeps [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) Project Documents in sync with local Markdown knowledge bases.

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

Optionally, the same change can also be **distilled into Memory Spaces**, which is the
only layer that answers by meaning rather than by wording. See
[Distillation into Memory Spaces](#distillation-into-memory-spaces).

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
```

Restart DSH. The plugin reconciles each root once at startup, then follows changes.


## Settings page

The bundle ships a Client half: a **Settings → 知识库同步** page listing every watched root.

| Action | Effect |
|---|---|
| See roots | Each row shows the path, whether it exists, and its Markdown count |
| Add | Validates the path is an existing directory, then starts watching it immediately |
| Remove | Stops watching; documents already synced stay in the store |
| Rescan | Runs one reconciliation pass over every watched root now |
| **Distillation switch** | Turns the Memory Space distillation on or off, live |
| **Distillation model** | Picks which model distils changed notes |

Both distillation controls take effect immediately — no restart. The switch also clears a
debounce timer that was already scheduled, so a pass never fires after you switch it off.
The model list is the **same catalog the main composer renders under its input box**,
read from the one `ctx.llm` registry, so the two can never disagree about which models
exist. Selecting a model writes it into the plugin's row and survives a restart; choosing
"follow the page default" clears it.

The page writes through the Host route `/mnemon-sync-monitor`, which owns the connection trust fence. Edits are persisted into the plugin's own row in the profile `cordis.patch.yml`, and **every other line of that file is preserved byte for byte** — the writer replaces only the `roots:` sequence rather than re-serializing the YAML, so comments and neighbouring rows survive.

Adding or removing a root takes effect without a restart: the watcher is attached or detached live. The configuration file is still updated so the change survives the next boot.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/mnemon-sync-monitor/state` | Roots with existence and Markdown counts, store path, patch path, distillation status |
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
| `distill.maxFilesPerRun` | `10` | Files distilled per pass. |
| `distill.maxInsightsPerFile` | `4` | Insights a single file may yield. |
| `distill.command` | `""` | Shell command for the model call. |
| `distillModel` | *unset* | `JSON.stringify([provider, model])`; unset means "follow the page default". |

## Distillation into Memory Spaces

The Documents layer is **lexical**. It matches substrings and Chinese bigrams, so
asking it with different words finds nothing: on a reference vault, "刚加进来的笔记搜不到"
matched 25 pages, all of them fund-certification notes, because `笔记` is a common
bigram. Memory Spaces do vector recall, but dsh-mnemon's own `idleReview` cannot write
there — its tool table has no `mnemon_remember`, and the `MEMORY.md → ARCHIVE_PERSONA`
route needs MEMORY.md near capacity first.

This plugin closes that gap. When a note changes, it can ask a model to distil the note
into self-contained conclusions and write them into Memory Spaces, where a reworded
question actually finds them.

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

`command` receives `{"messages":[...]}` on stdin and must print the completion text on
stdout. It is a short-lived child process, so credentials and retry policy stay out of
the Host.

### One model catalog, two surfaces

The settings page lists models from `GET /models`, which reads the **same**
`ctx.llm` registry that builds the composer's model list under the input box. There is
no second catalog, so the picker and the composer cannot disagree. The identity is the
composer's own encoding, `JSON.stringify([provider, model])`; the Host converts it back
to `provider/model` and passes it as `DISTILL_MODEL` to the command.

The plugin deliberately does **not** declare `inject: ['llm']`. That would make the
whole watcher fail to start on a profile without the service. It uses `ctx.get('llm')`
optionally and returns an empty list when unavailable, so the roots manager still works.

### Change detection: git first, mtime as the fallback

A root that is a git repository is diffed against the last recorded commit. A root that
is not is scanned by mtime high-water mark.

`describeRoot(root)` is the single decision point and returns
`{ strategy, commit, dirty, reason }`. Git is an **optimisation, not an assumption** —
two real failures demote a root to mtime, and the reason is logged:

- a **dirty work tree**, where `HEAD` does not describe the files on disk
- a **failing git probe**, e.g. `fatal: mmap failed` against OneDrive placeholders

Sub-directory roots are filtered against `git rev-parse --show-toplevel`, so one root
never distils another root's files.

### Limits worth knowing

- **8,000 UTF-8 bytes per insight, hard and silent.** The Host's store rejects more.
  A command that generates insights must clamp on `Buffer.byteLength` and never split a
  multi-byte character.
- **1,000 insights by default**, soft-deleted above that. `maxFilesPerRun` and
  `maxInsightsPerFile` keep a pass from flooding the ceiling.
- **The distilled text does not update Documents.** The two stores drift unless both run.

## Safety properties

These are enforced by tests in `test/sync.test.js`:

1. **Cross-root isolation.** Each record records its owning root in `sourcePaths[0]` as `<absolute-root>\u0000<relative>`. Pruning one root can never archive another root's documents.
2. **Lock interoperability.** Writes take `.index.lock` with `wx` exclusive create, retry every 20 ms, give up after 5 s, and steal a lock older than 30 s — identical to the Documents Source, so a running Host and this watcher never corrupt the index.
3. **Atomic index writes.** The index is written to a temporary file and renamed, matching the Source.
4. **Capacity ceiling.** Documents beyond `limitBytes` are skipped rather than failing the whole pass.
5. **Single-document ceiling.** Documents over 2 MiB are skipped.

## Important operational note

dsh-mnemon pins Project Documents into a View **when the session starts** (the route description is literally *"Search only the project Documents pinned into this View"*). The watcher updates the store immediately, but **a running session will not see new documents until a new session starts.**

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