# Changelog

## 0.1.0

Initial release.

- Real-time `fs.watch` monitoring of Markdown knowledge bases.
- Incremental reconciliation: create on new file, update on content-hash change, archive on delete.
- Interoperates with the dsh-mnemon Documents index lock and atomic-rename protocol.
- Cross-root isolation via explicit owning-root encoding in `sourcePaths[0]`.
- Capacity ceiling and single-document size ceiling enforced.
