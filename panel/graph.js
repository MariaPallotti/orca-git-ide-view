// Commit graph layout for the Log tab: one lane per line of history, a dot
// per commit and edges that bend into the lane of a parent. Pure (no DOM); tested by
// src/graph.test.ts.

/**
 * @param commits [{ hash, parents: string[] }] in topological order, newest first.
 * @returns per commit: { col, width, up: [[fromLane, toLane]], down: [[fromLane, toLane]] }
 *   `up` edges run from the top of the row to its middle, `down` edges from the middle to the
 *   bottom; a lane equal to `col` at the middle means the commit's dot.
 */
export function layoutGraph(commits) {
  const lanes = [] // lanes[i] = hash expected next in lane i, or null
  const rows = []
  for (const c of commits) {
    let col = lanes.indexOf(c.hash)
    const up = []
    if (col === -1) {
      col = freeLane(lanes)
      lanes[col] = c.hash
    } else {
      up.push([col, col])
    }
    // Other lanes waiting for this commit converge into its dot (a branch point seen from above).
    for (let i = 0; i < lanes.length; i++) {
      if (i === col) continue
      if (lanes[i] === c.hash) {
        up.push([i, col])
        lanes[i] = null
      } else if (lanes[i] !== null && lanes[i] !== undefined) {
        up.push([i, i])
      }
    }

    const fromDot = new Set()
    lanes[col] = null
    c.parents.forEach((p, n) => {
      const existing = lanes.indexOf(p)
      if (n === 0 && (existing === -1 || existing > col)) {
        // The first parent keeps this lane; a lane further right that also waits for it will
        // converge into it when the parent's row comes.
        lanes[col] = p
        fromDot.add(col)
      } else if (existing !== -1) {
        fromDot.add(existing) // joins a lane that already waits for this parent
      } else {
        const slot = freeLane(lanes, col + 1)
        lanes[slot] = p
        fromDot.add(slot)
      }
    })
    const down = []
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null || lanes[i] === undefined) continue
      down.push(fromDot.has(i) ? [col, i] : [i, i])
    }
    while (lanes.length && (lanes[lanes.length - 1] === null || lanes[lanes.length - 1] === undefined)) lanes.pop()

    const width = Math.max(col + 1, ...up.flat().map((x) => x + 1), ...down.flat().map((x) => x + 1))
    rows.push({ col, width, up, down })
  }
  return rows
}

function freeLane(lanes, from = 0) {
  for (let i = from; i < lanes.length; i++) if (lanes[i] === null || lanes[i] === undefined) return i
  for (let i = 0; i < from && i < lanes.length; i++) if (lanes[i] === null || lanes[i] === undefined) return i
  lanes.push(null)
  return lanes.length - 1
}

const COLORS = ['#3574f0', '#e06c75', '#5fb865', '#c678dd', '#e5a43a', '#56b6c2', '#d19a66', '#98a2b3']
export const laneColor = (i) => COLORS[i % COLORS.length]

/** SVG for one row. `lane` px per lane, `h` row height. */
export function rowSvg(row, { lane = 12, h = 38, maxWidth = Infinity } = {}) {
  const lanes = Math.min(row.width, maxWidth)
  const w = lanes * lane + 4
  const x = (i) => i * lane + lane / 2 + 2
  const mid = h / 2
  const parts = []
  const line = (x1, y1, x2, y2, color) =>
    parts.push(
      x1 === x2
        ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6"/>`
        : `<path d="M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.6"/>`
    )
  for (const [a, b] of row.up) if (a < maxWidth && b < maxWidth) line(x(a), 0, x(b), mid, laneColor(a === b ? a : a))
  for (const [a, b] of row.down) if (a < maxWidth && b < maxWidth) line(x(a), mid, x(b), h, laneColor(b))
  if (row.col < maxWidth) parts.push(`<circle cx="${x(row.col)}" cy="${mid}" r="3.6" fill="${laneColor(row.col)}" stroke="var(--bg)" stroke-width="1.2"/>`)
  return `<svg class="graph" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${parts.join('')}</svg>`
}

/** Straight lines that keep the lanes going past an expanded commit's details (CSS, so they
 *  stretch to whatever height the details take). */
export function fillerSvg(row, { lane = 12, maxWidth = Infinity, width } = {}) {
  const w = (width ?? Math.min(row.width, maxWidth)) * lane + 4
  const x = (i) => i * lane + lane / 2 + 2
  const lines = row.down
    .map(([, b]) => b)
    .filter((b, i, all) => b < maxWidth && all.indexOf(b) === i)
    .map((b) => `<i style="left:${x(b) - 0.8}px;background:${laneColor(b)}"></i>`)
  return `<div class="graph-filler" style="width:${w}px" aria-hidden="true">${lines.join('')}</div>`
}
