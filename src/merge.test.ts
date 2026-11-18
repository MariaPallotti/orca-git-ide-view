// The merge view's conflict parser (panel/merge.js).
import { assert, test } from 'orca/testing'
// @ts-expect-error plain JS module without typings
import { applyChoices, conflictCount, parseConflicts } from '../panel/merge.js'

const FILE = ['a', '<<<<<<< HEAD', 'mine', '=======', 'theirs', '>>>>>>> feature', 'b', '<<<<<<< HEAD', 'x', '||||||| base', 'orig', '=======', 'y', '>>>>>>> feature', 'c', ''].join('\n')

test('finds both conflicts, with labels and the diff3 base', () => {
  const s = parseConflicts(FILE)
  assert.equal(conflictCount(s), 2)
  const [first, second] = s.filter((x: { type: string }) => x.type === 'conflict')
  assert.equal(first.oursLabel, 'HEAD')
  assert.equal(first.theirsLabel, 'feature')
  assert.deepEqual(first.ours, ['mine'])
  assert.deepEqual(first.theirs, ['theirs'])
  assert.equal(first.base, null)
  assert.deepEqual(second.base, ['orig'])
})

test('applies choices and keeps undecided conflicts as they were', () => {
  const s = parseConflicts(FILE)
  assert.equal(applyChoices(s, {}), FILE)
  assert.equal(applyChoices(s, { 0: 'theirs', 1: 'ours-theirs' }), 'a\ntheirs\nb\nx\ny\nc\n')
})

test('keeps CRLF and ignores unterminated markers', () => {
  const crlf = 'a\r\n<<<<<<< HEAD\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> b\r\nz\r\n'
  const s = parseConflicts(crlf)
  assert.equal(applyChoices(s, { 0: 'ours' }), 'a\r\nmine\r\nz\r\n')
  assert.equal(conflictCount(parseConflicts('<<<<<<< HEAD\nno end\n')), 0)
})
