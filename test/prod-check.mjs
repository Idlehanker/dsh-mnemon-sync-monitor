import { planSync } from '../lib/index.js'
import { DocumentsStore } from '../lib/store.js'
const store = new DocumentsStore('C:\\Users\\hzuju\\.mnemon\\documents')
const roots = ['C:\\OneDrive\\iNote-OneDrive','C:\\Users\\hzuju\\LogseqGithub\\pages','C:\\Users\\hzuju\\LogseqGithub\\journals']
let c=0,u=0,a=0
for (const root of roots) {
  const plan = planSync({ root, index: store.readIndex(), minBytes: 200, prune: false })
  console.log(root.split('\\').slice(-2).join('\\') + '  create ' + plan.create.length + ' | update ' + plan.update.length + ' | archive ' + plan.archive.length)
  c+=plan.create.length; u+=plan.update.length; a+=plan.archive.length
}
console.log('TOTAL create ' + c + ' | update ' + u + ' | archive ' + a)
console.log(c === 0 ? 'PASS: no duplicates' : 'FAIL: would create ' + c)
