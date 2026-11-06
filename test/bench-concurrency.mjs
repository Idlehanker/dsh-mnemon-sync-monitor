// Measure the pass wall clock at different worker counts.
// Run: node test/bench-concurrency.mjs
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runDistillPass } from '../lib/distill.js'

const NOTES = 24
/** Simulated model latency, in ms. Real calls measure 7-25 s; scaled to keep this fast. */
const LATENCY = 200

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'bench-concurrency-'))
  const vault = join(base, 'vault')
  mkdirSync(vault, { recursive: true })
  for (let index = 0; index < NOTES; index += 1) {
    writeFileSync(join(vault, 'n' + index + '.md'),
      '# N' + index + '\n\n' + '字'.repeat(200), 'utf8')
  }
  return { base, vault, store: join(base, 'store') }
}

/** Answers after LATENCY ms with one distinct claim per note, so nothing dedupes away. */
function slowComplete() {
  let n = 0
  return async () => {
    const id = (n += 1)
    await new Promise((resolve) => setTimeout(resolve, LATENCY))
    return JSON.stringify({
      insights: [{ content: '第 ' + id + ' 篇笔记得出的、足够长且互不相同的结论内容。', category: 'fact', importance: 3 }],
    })
  }
}

const results = []
for (const concurrency of [1, 2, 3, 4, 6, 8]) {
  const box = sandbox()
  const started = process.hrtime.bigint()
  const report = await runDistillPass({
    roots: [box.vault],
    store: box.store,
    complete: slowComplete(),
    maxFilesPerRun: NOTES,
    concurrency,
  })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  results.push({ concurrency, ms, files: report.files })
  rmSync(box.base, { recursive: true, force: true })
}

const serial = results[0].ms
console.log('notes=' + NOTES + ' simulated latency=' + LATENCY + 'ms\n')
console.log('workers   wall clock   speed-up   files')
for (const row of results) {
  const speedup = serial / row.ms
  console.log(
    String(row.concurrency).padEnd(9) +
    (row.ms.toFixed(0) + ' ms').padEnd(13) +
    (speedup.toFixed(2) + 'x').padEnd(11) +
    row.files,
  )
}

// The claim that matters: more workers really do finish sooner, up to the bound,
// and every note still gets processed exactly once at every setting.
const failed = []
if (results.some((row) => row.files !== NOTES)) failed.push('a run did not process every note')
if (!(results[3].ms < serial * 0.5)) failed.push('concurrency 4 was not at least 2x faster than serial')
if (!(results[5].ms < results[2].ms)) failed.push('concurrency 8 was not faster than 3')
if (failed.length > 0) {
  console.error('\nFAIL: ' + failed.join('; '))
  process.exitCode = 1
} else {
  console.log('\nOK: parallelism reduces the wall clock and no note is lost')
}
