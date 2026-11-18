// Pure diff helpers for the panel (no DOM): aligning hunks into blocks and word-level diffs.
// Tested by src/diff.test.ts.

/** Splits text into lines without the final empty line. */
export function splitLines(text) {
  if (!text) return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/**
 * Turns the -U0 hunks git reports into an ordered list of items covering both files:
 *   { type: 'equal', l, r, n }                         n identical lines from index l / r
 *   { type: 'change', kind, l, ln, r, rn, hunk, index } a change block (a "difference")
 * `kind` is insert, delete or modify; l / r are 0-based indexes into the left / right lines.
 */
export function buildBlocks(leftText, rightText, hunks) {
  const L = splitLines(leftText)
  const R = splitLines(rightText)
  const items = []
  let li = 0
  let ri = 0
  let index = 0
  const sorted = [...hunks].sort((a, b) => a.newStart - b.newStart || a.oldStart - b.oldStart)
  for (const h of sorted) {
    // With a count of 0, git's start is the line *after which* the change sits.
    const oS = h.oldLines ? h.oldStart - 1 : h.oldStart
    const nS = h.newLines ? h.newStart - 1 : h.newStart
    const eq = Math.min(oS - li, nS - ri)
    if (eq > 0) items.push({ type: 'equal', l: li, r: ri, n: eq })
    const kind = h.oldLines === 0 ? 'insert' : h.newLines === 0 ? 'delete' : 'modify'
    items.push({ type: 'change', kind, l: oS, ln: h.oldLines, r: nS, rn: h.newLines, hunk: h, index: index++ })
    li = oS + h.oldLines
    ri = nS + h.newLines
  }
  const rest = Math.min(L.length - li, R.length - ri)
  if (rest > 0) items.push({ type: 'equal', l: li, r: ri, n: rest })
  return { L, R, items, count: index }
}

const TOKEN = /\n|[A-Za-z0-9_À-￿]+|[ \t]+|[^A-Za-z0-9_À-￿ \t\n]/g
const tokenize = (s) => s.match(TOKEN) ?? []
const MAX_CELLS = 400_000

/**
 * Word-level diff of two blocks of lines, highlighted inside a modified block.
 * Returns per-line segment lists for each side: [[{ text, changed }...] per line], or null when
 * the blocks are too large to compare.
 */
export function wordDiff(leftLines, rightLines) {
  const a = tokenize(leftLines.join('\n'))
  const b = tokenize(rightLines.join('\n'))
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null
  // LCS table, filled from the end so we can walk forward.
  const n = a.length
  const m = b.length
  const dp = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const outA = []
  const outB = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      outA.push({ text: a[i++], changed: false })
      outB.push({ text: b[j++], changed: false })
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      outB.push({ text: b[j++], changed: true })
    } else {
      outA.push({ text: a[i++], changed: true })
    }
  }
  return { left: toLines(outA, leftLines.length), right: toLines(outB, rightLines.length) }
}

/** Splits a token stream back into lines, merging neighbours with the same flag. */
function toLines(tokens, lineCount) {
  const lines = [[]]
  for (const t of tokens) {
    if (t.text === '\n') {
      lines.push([])
      continue
    }
    const line = lines[lines.length - 1]
    const last = line[line.length - 1]
    // Whitespace between two changed words stays inside the highlight.
    if (last && last.changed === t.changed) last.text += t.text
    else line.push({ ...t })
  }
  while (lines.length < lineCount) lines.push([])
  return lines.slice(0, Math.max(lineCount, 0))
}
