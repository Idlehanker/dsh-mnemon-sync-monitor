# Changelog

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
