# Changelog

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
