import { readRoots, writeRoots } from './lib/persist.js'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PATCH = 'C:\\Users\\hzuju\\.dsh\\profiles\\desktop\\cordis.patch.yml'
const b = mkdtempSync(join(tmpdir(), 'diff-'))
const copy = join(b, 'p.yml')
copyFileSync(PATCH, copy)
const before = readFileSync(copy, 'utf8')
writeRoots(copy, readRoots(copy))
const after = readFileSync(copy, 'utf8')
const bl = before.split('\n'), al = after.split('\n')
console.log('lines before/after:', bl.length, al.length)
console.log('\n=== first differing lines ===')
let shown = 0
for (let i = 0; i < Math.max(bl.length, al.length) && shown < 6; i++) {
  if (bl[i] !== al[i]) {
    console.log('L' + i + ' BEFORE: ' + JSON.stringify(bl[i]))
    console.log('L' + i + ' AFTER : ' + JSON.stringify(al[i]))
    console.log('')
    shown++
  }
}
