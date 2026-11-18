// Conflict markers in a working file, for the merge view. Pure (no DOM); tested by
// src/merge.test.ts. Lines keep their own "\r", so a CRLF file is written back as CRLF.

const START = /^<{7}(?: (.*?))?\r?$/
const BASE = /^\|{7}(?: (.*?))?\r?$/
const SEP = /^={7}\r?$/
const END = /^>{7}(?: (.*?))?\r?$/

/**
 * Splits a file into text and conflict segments:
 *   { type: 'text', lines }
 *   { type: 'conflict', index, oursLabel, theirsLabel, ours, base, theirs, raw }
 * `ours` is the part between <<<<<<< and ======= (git's "ours"), `base` the diff3 part or null,
 * `raw` the original lines with the markers. Unterminated markers are left as text.
 */
export function parseConflicts(text) {
  const lines = text.split('\n')
  const segments = []
  let plain = []
  let index = 0
  const flush = () => {
    if (plain.length) segments.push({ type: 'text', lines: plain })
    plain = []
  }
  for (let i = 0; i < lines.length; i++) {
    const m = START.exec(lines[i])
    if (!m) {
      plain.push(lines[i])
      continue
    }
    // Find the end of this conflict; without one the markers are just text.
    let j = i + 1
    let baseAt = -1
    let sepAt = -1
    while (j < lines.length && !END.test(lines[j])) {
      if (sepAt === -1 && baseAt === -1 && BASE.test(lines[j])) baseAt = j
      else if (sepAt === -1 && SEP.test(lines[j])) sepAt = j
      j++
    }
    if (j >= lines.length || sepAt === -1) {
      plain.push(lines[i])
      continue
    }
    flush()
    const oursEnd = baseAt === -1 ? sepAt : baseAt
    segments.push({
      type: 'conflict',
      index: index++,
      oursLabel: m[1] ?? '',
      theirsLabel: END.exec(lines[j])[1] ?? '',
      ours: lines.slice(i + 1, oursEnd),
      base: baseAt === -1 ? null : lines.slice(baseAt + 1, sepAt),
      theirs: lines.slice(sepAt + 1, j),
      raw: lines.slice(i, j + 1)
    })
    i = j
  }
  flush()
  return segments
}

/**
 * Rebuilds the file. `choices[index]` is 'ours', 'theirs', 'ours-theirs', 'theirs-ours', or
 * undefined to keep that conflict with its markers.
 */
export function applyChoices(segments, choices) {
  const out = []
  for (const s of segments) {
    if (s.type === 'text') {
      out.push(...s.lines)
      continue
    }
    const c = choices[s.index]
    if (c === 'ours') out.push(...s.ours)
    else if (c === 'theirs') out.push(...s.theirs)
    else if (c === 'ours-theirs') out.push(...s.ours, ...s.theirs)
    else if (c === 'theirs-ours') out.push(...s.theirs, ...s.ours)
    else out.push(...s.raw)
  }
  return out.join('\n')
}

export const conflictCount = (segments) => segments.filter((s) => s.type === 'conflict').length
