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
node --test "test/*.test.js"   # 11 unit tests, no dependencies
node test/e2e.mjs              # end-to-end watcher test
node test/live.mjs             # validate against a real knowledge base
```

No runtime dependencies. Node 22+ (uses `fs.watch` with `recursive`).

## Measured performance

Against a real 389-file Obsidian vault: a full import of 326 documents took **362 ms**.

## License

MIT