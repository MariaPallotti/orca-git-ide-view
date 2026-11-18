// The panel's pure diff helpers (panel/diff.js).
import { assert, test } from 'orca/testing'
// @ts-expect-error plain JS module without typings
import { buildBlocks, wordDiff } from '../panel/diff.js'

const h = (oldStart: number, oldLines: number, newStart: number, newLines: number) => ({ oldStart, oldLines, newStart, newLines, header: '' })

test('aligns modify, insert and delete blocks with the equal lines around them', () => {
  const left = 'a\nb\nc\nd\ne\n'
  const right = 'a\nB\nc\nd\nnew\ne\n'
  // b -> B (modify line 2), insert "new" after line 4, nothing deleted.
  const { items, count } = buildBlocks(left, right, [h(2, 1, 2, 1), h(4, 0, 5, 1)])
  assert.equal(count, 2)
  assert.deepEqual(
    items.map((i: { type: string; kind?: string; n?: number }) => (i.type === 'equal' ? `=${i.n}` : i.kind)),
    ['=1', 'modify', '=2', 'insert', '=1']
  )
})

test('handles a deletion at the end and an untracked file', () => {
  const del = buildBlocks('a\nb\nc\n', 'a\n', [h(2, 2, 1, 0)])
  assert.deepEqual(
    del.items.map((i: { type: string; kind?: string }) => i.kind ?? i.type),
    ['equal', 'delete']
  )
  const added = buildBlocks('', 'x\ny\n', [h(0, 0, 1, 2)])
  assert.equal(added.items.length, 1)
  assert.equal(added.items[0].kind, 'insert')
})

test('highlights only the changed words', () => {
  const w = wordDiff(['const total = 1;'], ['const sum = 1;'])
  assert.deepEqual(w.left[0], [
    { text: 'const ', changed: false },
    { text: 'total', changed: true },
    { text: ' = 1;', changed: false }
  ])
  assert.deepEqual(w.right[0][1], { text: 'sum', changed: true })
})
