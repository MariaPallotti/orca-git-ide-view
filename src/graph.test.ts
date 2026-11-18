// The Log tab's graph layout (panel/graph.js).
import { assert, test } from 'orca/testing'
// @ts-expect-error plain JS module without typings
import { layoutGraph } from '../panel/graph.js'

test('a straight history stays in one lane', () => {
  const rows = layoutGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] }
  ])
  assert.deepEqual(rows.map((r: { col: number }) => r.col), [0, 0, 0])
  assert.deepEqual(rows[0].up, [])
  assert.deepEqual(rows[0].down, [[0, 0]])
  assert.deepEqual(rows[2].down, [])
})

test('a merge opens a second lane that joins back at the fork point', () => {
  //   m        merge of x into b
  //   |\
  //   | x
  //   b |
  //   |/
  //   a
  const rows = layoutGraph([
    { hash: 'm', parents: ['b', 'x'] },
    { hash: 'x', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] }
  ])
  assert.deepEqual(rows.map((r: { col: number }) => r.col), [0, 1, 0, 0])
  assert.deepEqual(rows[0].down, [[0, 0], [0, 1]])
  // b's lane continues, x's lane ends in a's dot.
  assert.deepEqual(rows[3].up, [[0, 0], [1, 0]])
  assert.equal(rows[1].width, 2)
})

test('two branch tips get their own lanes', () => {
  const rows = layoutGraph([
    { hash: 'f1', parents: ['a'] },
    { hash: 'f2', parents: ['a'] },
    { hash: 'a', parents: [] }
  ])
  assert.deepEqual(rows.map((r: { col: number }) => r.col), [0, 1, 0])
  // f2 bends into the lane already waiting for a.
  assert.deepEqual(rows[1].down, [[1, 0]])
  assert.deepEqual(rows[2].up, [[0, 0]])
})
