// IDE-style Git tool window for Orca's right sidebar. All git work runs in the worker
// (src/worker.ts); this file only draws and asks.
import { buildBlocks, wordDiff } from './diff.js'
import { fileIcon } from './fileicons.js'
import { fillerSvg, layoutGraph, rowSvg } from './graph.js'
import { applyChoices, parseConflicts } from './merge.js'

const orca = window.orca
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key)
      return v == null ? fallback : JSON.parse(v)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Worker channel

let busyCount = 0
async function request(name, input, timeoutMs = 30_000) {
  // Orca only passes plain JSON to the worker and refuses anything else ("input: invalid input"),
  // such as a key set to undefined (origPath of a file that was not renamed).
  if (input !== undefined) input = JSON.parse(JSON.stringify(input))
  busyCount++
  document.body.classList.add('busy')
  try {
    let res
    if (orca?.plugin?.request) res = await orca.plugin.request(name, input, { timeoutMs })
    else res = (await orca.host.call('plugin.request', { name, input, timeoutMs })).output
    if (!res || res.ok !== true) {
      const err = new Error(res?.error || 'The worker did not answer.')
      err.command = res?.command
      throw err
    }
    return res.value
  } finally {
    if (--busyCount === 0) document.body.classList.remove('busy')
  }
}

async function attempt(title, fn) {
  try {
    return await fn()
  } catch (e) {
    await dialog({ title, body: `<div>${esc(e.message)}</div>${e.command ? `<code>${esc(e.command)}</code>` : ''}`, ok: 'Close', cancel: null })
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Small UI pieces: toast, dialog, context menu

let toastTimer
function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600)
}

/**
 * A modal. Resolves true / false, or, with `input` (the initial text), the typed text / null.
 */
let lastDialogCheck = false
function dialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false, input, check }) {
  return new Promise((resolve) => {
    const root = $('dialog')
    const field =
      (input === undefined ? '' : `<input type="text" id="dlg-input" value="${esc(input)}" />`) +
      (check ? `<label class="check dlg-check"><input type="checkbox" id="dlg-check" ${check.checked ? 'checked' : ''} /> ${esc(check.label)}</label>` : '')
    root.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2><div class="body">${body}${field}</div>
      <div class="actions">${cancel ? `<button data-r="0">${esc(cancel)}</button>` : ''}
      <button class="primary" data-r="1" ${danger ? 'style="background:var(--danger)"' : ''}>${esc(ok)}</button></div></div>`
    root.hidden = false
    const done = (v) => {
      const text = $('dlg-input')?.value
      lastDialogCheck = !!$('dlg-check')?.checked
      root.hidden = true
      root.innerHTML = ''
      document.removeEventListener('keydown', onKey, true)
      resolve(input === undefined ? v : v ? text : null)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        done(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        done(true)
      }
    }
    document.addEventListener('keydown', onKey, true)
    root.onclick = (e) => {
      if (e.target === root) return done(false)
      const b = e.target.closest('button[data-r]')
      if (b) done(b.dataset.r === '1')
    }
    const inputEl = $('dlg-input')
    if (inputEl) {
      inputEl.focus()
      inputEl.select()
    } else root.querySelector('.primary').focus()
  })
}

function showMenu(x, y, items) {
  const m = $('menu')
  m.innerHTML = items
    .map((it, i) => (it === '-' ? '<hr />' : `<button role="menuitem" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`))
    .join('')
  m.hidden = false
  const r = m.getBoundingClientRect()
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`
  m.onclick = (e) => {
    const b = e.target.closest('button[data-i]')
    if (!b) return
    hideMenu()
    items[Number(b.dataset.i)].run()
  }
  m.querySelector('button:not([disabled])')?.focus()
}
const hideMenu = () => ($('menu').hidden = true)
document.addEventListener('mousedown', (e) => {
  if (!$('menu').hidden && !e.target.closest('#menu')) hideMenu()
})

// ---------------------------------------------------------------------------
// State

const state = {
  tab: 'commit',
  view: 'commit', // commit | log | diff
  repo: null,
  reason: null,
  files: [],
  known: new Set(), // paths seen before, so new changes get checked by default
  checked: new Set(),
  collapsed: new Set(store.get('collapsed', [])),
  groupByDir: store.get('groupByDir', true),
  selected: null, // node key
  rows: [], // visible tree rows
  log: [],
  logOpen: null, // hash of the commit whose files are shown
  logFiles: [],
  logMessage: '',
  graph: null,
  logRef: 'HEAD', // the Log's branch filter: 'HEAD' (default), a full ref, or null for every branch
  branches: null,
  shelf: null,
  shelfOpen: null,
  shelfFiles: [],
  diff: null, // see openDiff
  merge: null, // see openMerge
  operation: null
}

// ---------------------------------------------------------------------------
// Loading

let loading = null
let reloadAgain = false
/** Reads the state again. A call during a reload runs another one after it (the repository may
 *  have changed meanwhile), and the promise settles once the latest one is in. */
function reload() {
  if (loading) {
    reloadAgain = true
    return loading
  }
  loading = (async () => {
    try {
      do {
        reloadAgain = false
        await reloadOnce()
      } while (reloadAgain)
    } finally {
      loading = null
    }
  })()
  return loading
}

async function reloadOnce() {
  try {
    const value = await request('git.state')
    applyState(value)
  } catch (e) {
    state.repo = null
    state.reason = e.message
    state.files = []
  }
  renderHeader()
  renderTree()
  // The Log (and a Shelf tab opened before the repository was known) fills now.
  if (state.repo && !logUi.loaded) void loadLogPane()
  if (state.view === 'shelf' && state.repo && state.shelf === null) void loadShelf()
  if (state.view === 'diff' && state.diff?.source === 'local') await refreshDiff()
  if (switchUi.active && !switchUi.byWorker) void Promise.resolve(logLoading).finally(endSwitch)
}

function applyState({ repo, reason, files, operation, choices }) {
  const repoChanged = state.repo?.root !== repo?.root
  if (repoChanged) remember() // the project being left, to show it at once when it comes back
  state.choices = choices ?? null
  state.operation = operation ?? null
  state.repo = repo
  state.reason = reason ?? null
  state.files = files
  if (repoChanged) {
    // A diff or merge view belongs to the previous repository.
    if (state.view === 'diff' || state.view === 'merge') {
      state.diff = null
      state.merge = null
      showView(state.tab)
    }
    state.known = new Set()
    state.checked = new Set()
    state.log = []
    state.graph = null
    state.logOpen = null
    state.logRef = 'HEAD'
    state.branches = null
    logUi.loaded = false
    state.shelf = null
    state.shelfOpen = null
    $('message').value = repo ? store.get(`msg:${repo.root}`, '') : ''
    $('amend').checked = false
    // Orca did not announce the switch (or the panel just noticed): say so while the Log loads.
    // A project seen before shows its last Log straight away instead, and refreshes it behind.
    if (repo) {
      if (restore(repo.root)) endSwitch()
      else beginSwitch(repo.name, switchUi.byWorker)
    }
  }
  const present = new Set(files.map((f) => f.path))
  for (const f of files) {
    if (!state.known.has(f.path) && f.status !== 'untracked' && f.status !== 'conflicted') state.checked.add(f.path)
    state.known.add(f.path)
  }
  for (const p of [...state.checked]) if (!present.has(p)) state.checked.delete(p)
  for (const p of [...state.known]) if (!present.has(p)) state.known.delete(p)
}

// ---------------------------------------------------------------------------
// Projects seen before: their Log, branches and ticked files, shown at once when they come back
// while the panel reads them again.

const REMEMBER_MAX = 8
const seen = new Map() // root -> what remember() kept

function remember() {
  const root = state.repo?.root
  if (!root || !state.graph) return
  seen.delete(root) // most recent last
  seen.set(root, { log: state.log, graph: state.graph, branches: state.branches, logRef: state.logRef, known: new Set(state.known), checked: new Set(state.checked) })
  while (seen.size > REMEMBER_MAX) seen.delete(seen.keys().next().value)
}

/** Puts back what a project showed last time; false when it was not seen before. */
function restore(root) {
  const r = seen.get(root)
  if (!r) return false
  state.log = r.log
  state.graph = r.graph
  state.branches = r.branches
  state.logRef = r.logRef
  state.known = new Set(r.known)
  state.checked = new Set(r.checked)
  renderBranches()
  renderLog()
  return true
}

function renderHeader() {
  const repo = state.repo
  $('branch').textContent = repo ? `${repo.name} · ${repo.branch ?? ''}` : ''
  $('branch').title = repo ? `${repo.root}\nBranch: ${repo.branch ?? ''}` : ''
  $('branch').hidden = !repo
  const banner = $('banner')
  if (repo && state.choices?.length) {
    // Several workspaces share this name and branch and Orca did not say which one is focused.
    banner.hidden = false
    banner.innerHTML = `<label class="pick">Several workspaces match. Repository:
      <select id="pick-workspace">${state.choices
        .map((c) => `<option value="${esc(c.id)}" title="${esc(c.path)}" ${c.path.replace(/\\/g, '/').toLowerCase() === repo.root.replace(/\\/g, '/').toLowerCase() ? 'selected' : ''}>${esc(c.name)}</option>`)
        .join('')}</select></label>`
    $('pick-workspace').onchange = async () => {
      await attempt('Could not switch the repository', () => request('git.pickWorkspace', { id: $('pick-workspace').value }))
      await reload()
    }
  } else {
    banner.hidden = !!repo
    banner.textContent = repo ? '' : state.reason || 'Open a workspace with a Git repository.'
  }
  renderOpBar()
}

// ---------------------------------------------------------------------------
// Changes tree

const GROUPS = [
  { id: 'conflicts', title: 'Merge Conflicts', test: (f) => f.status === 'conflicted' },
  { id: 'changes', title: 'Changes', test: (f) => f.status !== 'untracked' && f.status !== 'conflicted' },
  { id: 'unversioned', title: 'Unversioned Files', test: (f) => f.status === 'untracked' }
]
// Outline folder icons; they take the theme's text colour through currentColor.
const svgIcon = (d) =>
  `<svg class="folder" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`
const FOLDER_SVG = svgIcon('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z')
const FOLDER_OPEN_SVG = svgIcon('m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2')

/** Builds the nested node list: groups > (compacted) directories > files. */
function buildTree() {
  const out = []
  for (const g of GROUPS) {
    const files = state.files.filter(g.test)
    if (!files.length && g.id !== 'changes') continue
    const group = { key: `g:${g.id}`, kind: 'group', title: g.title, files, children: [] }
    if (state.groupByDir) {
      const root = { children: new Map(), files: [] }
      for (const f of files) {
        let node = root
        for (const part of dirName(f.path).split('/').filter(Boolean)) {
          if (!node.children.has(part)) node.children.set(part, { children: new Map(), files: [] })
          node = node.children.get(part)
        }
        node.files.push(f)
      }
      const toNodes = (node, prefix) => {
        const dirs = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        const res = []
        for (let [name, child] of dirs) {
          let full = prefix ? `${prefix}/${name}` : name
          // Compact chains of single directories (src/main/java).
          while (child.files.length === 0 && child.children.size === 1) {
            const [n2, c2] = [...child.children.entries()][0]
            name = `${name}/${n2}`
            full = `${full}/${n2}`
            child = c2
          }
          const kids = toNodes(child, full)
          res.push({ key: `d:${g.id}:${full}`, kind: 'dir', title: name, files: kids.flatMap((k) => k.files), children: kids })
        }
        for (const f of node.files.sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)))) res.push(fileNode(f))
        return res
      }
      group.children = toNodes(root, '')
    } else {
      group.children = files.map(fileNode)
    }
    out.push(group)
  }
  return out
}
const fileNode = (f) => ({ key: `f:${f.path}`, kind: 'file', file: f, files: [f], children: [] })

function renderTree() {
  const el = $('tree')
  const tree = state.repo ? buildTree() : []
  state.rows = []
  const html = []
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      state.rows.push(n)
      const open = n.kind !== 'file' && !state.collapsed.has(n.key)
      const checkedCount = n.files.filter((f) => state.checked.has(f.path)).length
      const all = n.files.length > 0 && checkedCount === n.files.length
      const some = checkedCount > 0 && !all
      const cls = ['node', n.kind, n.key === state.selected ? 'selected' : '', n.kind === 'file' ? `st-${n.file.status}` : ''].join(' ')
      const pad = 4 + depth * 16
      if (n.kind === 'file') {
        const f = n.file
        const extra = state.groupByDir ? (f.origPath ? `← ${f.origPath}` : '') : [dirName(f.path), f.origPath ? `← ${f.origPath}` : ''].filter(Boolean).join('  ')
        html.push(`<div class="${cls}" data-key="${esc(n.key)}" role="treeitem" style="padding-left:${pad}px" title="${esc(f.path)} (${f.status})">
          <span class="twisty"></span><input type="checkbox" ${all ? 'checked' : ''} ${f.status === 'conflicted' ? 'disabled' : ''} tabindex="-1" aria-label="Include ${esc(f.path)}" />
          <span class="icon file-icon">${fileIcon(f.path)}</span><span class="name">${esc(baseName(f.path))}</span>${extra ? `<span class="dir">${esc(extra)}</span>` : ''}</div>`)
      } else {
        html.push(`<div class="${cls}" data-key="${esc(n.key)}" role="treeitem" aria-expanded="${open}" style="padding-left:${pad}px">
          <span class="twisty">${n.children.length ? (open ? '▾' : '▸') : ''}</span><input type="checkbox" ${all ? 'checked' : ''} ${n.files.every((f) => f.status === 'conflicted') ? 'disabled' : ''} data-some="${some}" tabindex="-1" aria-label="Include ${esc(n.title)}" />
          <span class="icon">${n.kind === 'group' ? '' : open ? FOLDER_OPEN_SVG : FOLDER_SVG}</span><span class="name">${esc(n.title)}</span><span class="count">${n.files.length} ${n.files.length === 1 ? 'file' : 'files'}</span></div>`)
        if (open) walk(n.children, depth + 1)
      }
    }
  }
  walk(tree, 0)
  if (!state.repo) el.innerHTML = ''
  else if (!state.files.length) el.innerHTML = '<div class="empty">No changes</div>'
  else el.innerHTML = html.join('')
  for (const cb of el.querySelectorAll('input[data-some="true"]')) cb.indeterminate = true
  if (state.files.length && state.selected && !state.rows.some((r) => r.key === state.selected)) state.selected = null
  renderSummary()
}

function renderSummary() {
  const n = state.files.filter((f) => state.checked.has(f.path)).length
  const amend = $('amend').checked
  $('summary').textContent = state.files.length ? `${n} of ${state.files.length} selected` : ''
  // During a rebase, cherry-pick or revert git moves on with Continue, not with a commit.
  const blocked = state.operation && state.operation.kind !== 'merge'
  const can = !!state.repo && (n > 0 || amend) && !blocked
  $('commit').disabled = !can
  $('commit-push').disabled = !can
  $('commit').textContent = amend ? 'Amend Commit' : 'Commit'
  $('commit-push').textContent = amend ? 'Amend Commit and Push…' : 'Commit and Push…'
}

const nodeByKey = (key) => state.rows.find((r) => r.key === key)
const selectedNode = () => (state.selected ? nodeByKey(state.selected) : null)
const selectedFiles = () => selectedNode()?.files ?? []

function select(key, scroll = true) {
  state.selected = key
  for (const el of $('tree').querySelectorAll('.node.selected')) el.classList.remove('selected')
  const el = $('tree').querySelector(`.node[data-key="${CSS.escape(key)}"]`)
  el?.classList.add('selected')
  if (scroll) el?.scrollIntoView({ block: 'nearest' })
}

function toggleChecked(node) {
  // Conflicted files cannot be committed until they are resolved.
  const files = node.files.filter((f) => f.status !== 'conflicted')
  if (!files.length) return toast('Resolve the conflict first')
  const all = files.every((f) => state.checked.has(f.path))
  for (const f of files) all ? state.checked.delete(f.path) : state.checked.add(f.path)
  renderTree()
}

function toggleOpen(node, open) {
  if (node.kind === 'file') return
  const isOpen = !state.collapsed.has(node.key)
  if (open === isOpen) return
  isOpen ? state.collapsed.add(node.key) : state.collapsed.delete(node.key)
  store.set('collapsed', [...state.collapsed])
  renderTree()
}

$('tree').addEventListener('click', (e) => {
  const row = e.target.closest('.node')
  if (!row) return
  const node = nodeByKey(row.dataset.key)
  if (!node) return
  select(node.key, false)
  $('tree').focus()
  if (e.target.matches('input[type="checkbox"]')) toggleChecked(node)
  else if (e.target.closest('.twisty')) toggleOpen(node, state.collapsed.has(node.key))
})
$('tree').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.node')
  if (!row || e.target.matches('input')) return
  const node = nodeByKey(row.dataset.key)
  if (node?.kind === 'file') openLocalDiff(node.file)
  else if (node) toggleOpen(node, state.collapsed.has(node.key))
})
$('tree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.node')
  if (!row) return
  e.preventDefault()
  select(row.dataset.key, false)
  const node = selectedNode()
  const file = node?.kind === 'file' ? node.file : null
  if (file?.status === 'conflicted') {
    const y = sideLabel('yours')
    const t = sideLabel('theirs')
    return showMenu(e.clientX, e.clientY, [
      { label: 'Merge…', key: 'Enter', run: () => openMerge(file) },
      { label: `Accept Yours (${y})`, run: () => acceptSide(file.path, 'yours') },
      { label: `Accept Theirs (${t})`, run: () => acceptSide(file.path, 'theirs') },
      { label: 'Mark as Resolved', run: () => markResolved(file.path) },
      '-',
      { label: 'Jump to Source', key: 'F4', run: () => jumpToSource(file.path) },
      { label: 'Copy Path', run: () => copy(file.path) }
    ])
  }
  showMenu(e.clientX, e.clientY, [
    { label: 'Show Diff', key: 'Ctrl+D', disabled: !node?.files.length, run: () => openLocalDiff(file ?? node.files[0]) },
    { label: 'Show Diff in Panel', disabled: !node?.files.length, run: () => openPanelDiff(file ?? node.files[0]) },
    { label: 'Jump to Source', key: 'F4', disabled: !file || file.status === 'deleted', run: () => jumpToSource(file.path) },
    '-',
    { label: 'Rollback…', key: 'Ctrl+Alt+Z', disabled: !node?.files.length, run: () => rollback(node.files) },
    { label: 'Add to .gitignore', disabled: !file || file.status !== 'untracked', run: () => ignore(file.path) },
    '-',
    { label: 'Copy Path', disabled: !file, run: () => copy(file.path) }
  ])
})
$('tree').addEventListener('keydown', (e) => {
  const rows = state.rows
  if (!rows.length) return
  const i = Math.max(0, rows.findIndex((r) => r.key === state.selected))
  const node = rows[i]
  const go = (j) => {
    e.preventDefault()
    select(rows[Math.max(0, Math.min(rows.length - 1, j))].key)
  }
  if (e.key === 'ArrowDown') go(state.selected ? i + 1 : 0)
  else if (e.key === 'ArrowUp') go(i - 1)
  else if (e.key === 'Home') go(0)
  else if (e.key === 'End') go(rows.length - 1)
  else if (e.key === 'ArrowRight' && node.kind !== 'file') {
    e.preventDefault()
    toggleOpen(node, true)
  } else if (e.key === 'ArrowLeft' && node.kind !== 'file') {
    e.preventDefault()
    toggleOpen(node, false)
  } else if (e.key === ' ') {
    e.preventDefault()
    toggleChecked(node)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (node.kind === 'file') openLocalDiff(node.file)
    else toggleOpen(node, state.collapsed.has(node.key))
  } else if (e.key === 'F4' && node.kind === 'file') {
    e.preventDefault()
    jumpToSource(node.file.path)
  }
})

// ---------------------------------------------------------------------------
// Actions

async function rollback(files) {
  files = files.filter((f) => f.status !== 'conflicted')
  if (!files.length) return toast('Nothing to roll back')
  const deletes = files.filter((f) => f.status === 'untracked' || f.status === 'added' || f.status === 'renamed')
  const ok = await dialog({
    title: `Rollback ${files.length} ${files.length === 1 ? 'file' : 'files'}`,
    body: `<div>Local changes will be discarded and the files restored to HEAD.</div>
      <ul>${files.map((f) => `<li>${esc(f.path)}${deletes.includes(f) ? ' <b>(will be deleted)</b>' : ''}</li>`).join('')}</ul>`,
    ok: 'Rollback',
    danger: true
  })
  if (!ok) return
  if ((await attempt('Rollback failed', () => request('git.rollback', { files }))) !== undefined) {
    toast('Rolled back')
    await reload()
  }
}

async function ignore(p) {
  if ((await attempt('Could not update .gitignore', () => request('git.ignore', { path: p }))) !== undefined) {
    toast(`Added /${p} to .gitignore`)
    await reload()
  }
}

async function jumpToSource(p) {
  await attempt('Could not open the file', () => request('git.openFile', { path: p }))
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied')
  } catch {
    toast('Clipboard is not available here')
  }
}

async function commit(push) {
  const files = state.files.filter((f) => state.checked.has(f.path))
  const message = $('message').value
  const amend = $('amend').checked
  if (!message.trim()) {
    toast('Enter a commit message')
    $('message').focus()
    return
  }
  if (!files.length && !amend) return toast('Select files to commit')
  const res = await attempt('Commit failed', () => request('git.commit', { files, message, amend, push }, push ? 120_000 : 60_000))
  if (!res) return
  $('message').value = ''
  $('amend').checked = false
  if (state.repo) store.set(`msg:${state.repo.root}`, '')
  if (push && !res.pushed) {
    await dialog({ title: `Committed ${res.hash}, push failed`, body: esc(res.pushError ?? ''), ok: 'Close', cancel: null })
  } else {
    toast(push ? `Committed and pushed ${res.hash}` : `Committed ${res.hash}`)
  }
  await reload()
}

$('commit').onclick = () => commit(false)
$('commit-push').onclick = () => commit(true)
$('message').addEventListener('input', () => {
  if (state.repo) store.set(`msg:${state.repo.root}`, $('message').value)
})
$('message').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    commit(e.altKey)
  }
})
$('amend').addEventListener('change', async () => {
  renderSummary()
  // Amend ticked on an empty box fills in the previous message.
  if ($('amend').checked && !$('message').value.trim()) {
    const last = await attempt('Could not read the last commit', () => request('git.lastMessage'))
    if (last) $('message').value = last
  }
})

for (const b of document.querySelectorAll('#commit-top .toolbar .tb')) {
  b.addEventListener('click', () => {
    const act = b.dataset.act
    const node = selectedNode()
    if (act === 'refresh') reload()
    else if (act === 'rollback') rollback(node ? node.files : state.files.filter((f) => state.checked.has(f.path)))
    else if (act === 'shelve') shelve()
    else if (act === 'diff') {
      const f = node?.files[0] ?? state.files[0]
      if (f) openLocalDiff(f)
    } else if (act === 'group') {
      state.groupByDir = !state.groupByDir
      store.set('groupByDir', state.groupByDir)
      b.setAttribute('aria-pressed', String(state.groupByDir))
      renderTree()
    } else if (act === 'expand') {
      state.collapsed.clear()
      store.set('collapsed', [])
      renderTree()
    } else if (act === 'collapse') {
      for (const r of state.rows) if (r.kind === 'dir') state.collapsed.add(r.key)
      store.set('collapsed', [...state.collapsed])
      renderTree()
    }
  })
}
document.querySelector('[data-act="group"]').setAttribute('aria-pressed', String(state.groupByDir))

// ---------------------------------------------------------------------------
// Log, docked under the changes as an IDE's Git tool window: branches on the left (grouped by
// folder: feature/, origin/...), the history with its graph on the right.

const GRAPH_MAX_LANES = 12
const ROW_H = 26

const svgMulti = (inner) =>
  `<svg class="folder" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
const BRANCH_SVG = svgMulti('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>')
const HEAD_SVG = svgMulti('<circle cx="12" cy="12" r="4"/><line x1="1.05" x2="7" y1="12" y2="12"/><line x1="17.01" x2="22.96" y1="12" y2="12"/>')
const PANEL_CLOSE_SVG = svgMulti('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/><path d="m15 8-3 3-3-3"/>')
const PANEL_OPEN_SVG = svgMulti('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/><path d="m9 10 3-3 3 3"/>')
const CLOUD_SVG =svgMulti('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>')

const logUi = {
  height: store.get('logHeight', null), // px; null = CSS default
  hidden: store.get('logHidden', false),
  branchesWidth: store.get('branchesWidth', null),
  showBranches: store.get('showBranches', true),
  collapsed: new Set(store.get('branchCollapsed', ['b:g:remote'])),
  selected: null, // branch tree row key
  rows: [],
  loaded: false
}

async function loadLog() {
  if (!state.repo) return renderLog()
  const ref = state.logRef
  const entries = await attempt('Could not read the log', () => request('git.log', ref ? { limit: 400, ref } : { limit: 400, all: true }))
  state.log = entries ?? []
  state.graph = layoutGraph(state.log)
  if (state.logOpen && !state.log.some((c) => c.hash === state.logOpen)) state.logOpen = null
  renderLog()
}

async function loadBranches() {
  if (!state.repo) {
    state.branches = null
    return renderBranches()
  }
  state.branches = (await request('git.branches').catch(() => null)) ?? { current: null, local: [], remote: [] }
  // A filtered branch that disappeared (deleted, renamed) falls back to every branch.
  if (state.logRef && state.logRef !== 'HEAD' && ![...state.branches.local, ...state.branches.remote].some((b) => b.ref === state.logRef)) state.logRef = 'HEAD'
  renderBranches()
}

/** Loads the branches and the history together (when the Log is visible). */
let logLoading = null
function loadLogPane() {
  if (logUi.hidden || !state.repo) {
    logUi.loaded = false
    return Promise.resolve()
  }
  logUi.loaded = true
  const p = (async () => {
    try {
      // Side by side: each is a git command of its own in the worker.
      const ref = state.logRef
      await Promise.all([loadBranches(), loadLog()])
      // The filtered branch was gone (loadBranches fell back to HEAD): read that history.
      if (state.logRef !== ref) await loadLog()
      remember()
    } finally {
      if (logLoading === p) logLoading = null
    }
  })()
  logLoading = p
  return p
}

/** Branch and tag labels of a commit; past two, the rest go into "+N" (all of them in its tooltip). */
function refBadges(refs) {
  const list = (refs || '')
    .split(', ')
    .filter((r) => r && !/^[^ ]+\/HEAD$/.test(r)) // origin/HEAD only repeats another label
  if (!list.length) return ''
  const badge = (r) => {
    const kind = r.startsWith('HEAD') ? 'head' : r.startsWith('tag: ') ? 'tag' : state.branches?.remote.some((b) => b.name === r) ? 'remote' : ''
    return `<span class="ref ${kind}">${esc(r.replace('HEAD -> ', '').replace('tag: ', '🏷 '))}</span>`
  }
  const shown = list.slice(0, 2).map(badge).join('')
  const more = list.length > 2 ? `<span class="ref more" title="${esc(list.slice(2).join('\n'))}">+${list.length - 2}</span>` : ''
  return `<span class="refs">${shown}${more}</span>`
}

const fileRows = (files) =>
  files
    .map((f) => `<div class="node file st-${f.status}" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="icon file-icon">${fileIcon(f.path)}</span><span class="name">${esc(baseName(f.path))}</span><span class="dir">${esc(dirName(f.path))}</span></div>`)
    .join('')

function shortDate(ms) {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit', month: 'short', day: 'numeric' })
}

function renderLog() {
  renderRefChip()
  if (!state.repo) return void ($('log').innerHTML = '')
  const q = $('log-filter').value.trim().toLowerCase()
  // The graph only makes sense for the unfiltered history.
  const showGraph = !q
  const items = state.log
    .map((c, i) => ({ c, g: state.graph?.[i] }))
    .filter(({ c }) => !q || `${c.subject} ${c.author} ${c.short} ${c.hash} ${c.refs}`.toLowerCase().includes(q))
  if (!items.length) return void ($('log').innerHTML = '<div class="empty">No commits</div>')
  $('log').innerHTML = items
    .map(({ c, g }) => {
      const open = state.logOpen === c.hash
      const graph = showGraph && g ? rowSvg(g, { maxWidth: GRAPH_MAX_LANES, h: ROW_H }) : ''
      const merge = c.parents.length > 1 ? ` · merge of ${c.parents.map((p) => p.slice(0, 8)).join(', ')}` : ''
      const details = open
        ? `<div class="commit-details">${showGraph && g ? fillerSvg(g, { maxWidth: GRAPH_MAX_LANES, width: Math.min(g.width, GRAPH_MAX_LANES) }) : ''}
            <div class="content"><div class="body">${esc(state.logMessage)}</div>
            <div class="info">${esc(c.hash)} · ${esc(c.author)} · ${new Date(c.date).toLocaleString()}${merge}</div>
            <div class="commit-files">${fileRows(state.logFiles)}</div></div></div>`
        : ''
      return `<div class="commit-row line ${open ? 'open' : ''}" data-hash="${c.hash}" title="${esc(`${c.subject}\n${c.short} · ${c.author} · ${new Date(c.date).toLocaleString()}`)}">${graph}
        <span class="subject">${refBadges(c.refs)}<span class="msg">${esc(c.subject)}</span></span>
        <span class="author">${esc(c.author)}</span><span class="date">${shortDate(c.date)}</span><span class="hash">${esc(c.short)}</span></div>${details}`
    })
    .join('')
}

/** The Branch filter of the Log toolbar: the current branch, every branch, or any local or remote one. */
const refLabel = (ref) => {
  if (ref === 'HEAD') return `Current branch${state.branches?.current ? ` (${state.branches.current})` : ''}`
  if (!ref) return 'All branches'
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

function renderRefChip() {
  const label = refLabel(state.logRef)
  $('log-branch').innerHTML = `<span class="label">${esc(label)}</span><span class="caret">▾</span>`
  $('log-branch').title = `Branch: ${label}`
  if (!$('branch-popup').hidden) renderBranchPopup()
}

// The Branch popup: Current / All, then Local and Remote sections that open and close.
const popupOpen = { local: store.get('popupLocal', true), remote: store.get('popupRemote', false) }

function renderBranchPopup() {
  const pop = $('branch-popup')
  const b = state.branches ?? { local: [], remote: [] }
  const q = ($('branch-search')?.value ?? '').trim().toLowerCase()
  const item = (ref, label, extra = '') =>
    `<button class="bp-item ${ref === (state.logRef ?? '') ? 'active' : ''}" data-ref="${esc(ref)}" role="option" title="${esc(label)}">${extra}<span class="name">${esc(label)}</span></button>`
  const section = (id, title, list) => {
    const hits = list.filter((x) => !q || x.name.toLowerCase().includes(q))
    // While searching, every section with matches is open.
    const open = q ? hits.length > 0 : popupOpen[id]
    return `<button class="bp-group" data-group="${id}" aria-expanded="${open}"><span class="twisty">${open ? '▾' : '▸'}</span>${title}<span class="count">${hits.length}</span></button>
      ${open ? hits.map((x) => item(x.ref, x.name, x.current ? '<span class="cur" title="Current branch">●</span>' : '')).join('') || '<div class="bp-empty">No branches</div>' : ''}`
  }
  const search = $('branch-search')
  const keep = search ? { v: search.value, s: search.selectionStart } : null
  pop.innerHTML = `<input id="branch-search" type="search" placeholder="Search branches" />
    <div class="bp-list" role="listbox">
      ${q ? '' : item('HEAD', refLabel('HEAD')) + item('', 'All branches')}
      ${section('local', 'Local', b.local)}
      ${b.remote.length ? section('remote', 'Remote', b.remote) : ''}
    </div>`
  const s = $('branch-search')
  if (keep) {
    s.value = keep.v
    s.setSelectionRange(keep.s, keep.s)
  }
  s.focus()
}

function openBranchPopup() {
  const pop = $('branch-popup')
  pop.hidden = false
  pop.innerHTML = ''
  renderBranchPopup()
  const r = $('log-branch').getBoundingClientRect()
  const w = Math.min(320, innerWidth - 8)
  pop.style.width = `${w}px`
  pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 4))}px`
  // Opens upwards when there is more room above (the Log sits at the bottom of the panel).
  const below = innerHeight - r.bottom - 8
  const above = r.top - 8
  if (below >= 260 || below >= above) {
    pop.style.top = `${r.bottom + 2}px`
    pop.style.bottom = ''
    pop.style.maxHeight = `${below}px`
  } else {
    pop.style.top = ''
    pop.style.bottom = `${innerHeight - r.top + 2}px`
    pop.style.maxHeight = `${above}px`
  }
}
const closeBranchPopup = () => {
  $('branch-popup').hidden = true
  $('branch-popup').innerHTML = ''
}

$('log-branch').addEventListener('click', () => ($('branch-popup').hidden ? openBranchPopup() : closeBranchPopup()))
$('branch-popup').addEventListener('input', (e) => {
  if (e.target.id === 'branch-search') renderBranchPopup()
})
$('branch-popup').addEventListener('click', (e) => {
  const g = e.target.closest('[data-group]')
  if (g) {
    const id = g.dataset.group
    popupOpen[id] = !popupOpen[id]
    store.set(id === 'local' ? 'popupLocal' : 'popupRemote', popupOpen[id])
    if ($('branch-search').value) $('branch-search').value = ''
    return renderBranchPopup()
  }
  const it = e.target.closest('[data-ref]')
  if (!it) return
  closeBranchPopup()
  setLogRef(it.dataset.ref || null)
})
$('branch-popup').addEventListener('keydown', (e) => {
  const items = [...$('branch-popup').querySelectorAll('.bp-group, .bp-item')]
  const i = items.indexOf(document.activeElement)
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeBranchPopup()
    $('log-branch').focus()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  } else if (e.key === 'Enter' && e.target.id === 'branch-search') {
    // Enter in the search box picks the first match.
    e.preventDefault()
    $('branch-popup').querySelector('.bp-item')?.click()
  }
})
document.addEventListener('mousedown', (e) => {
  if (!$('branch-popup').hidden && !e.target.closest('#branch-popup, #log-branch')) closeBranchPopup()
})

function setLogRef(ref) {
  if (ref === state.logRef) return
  state.logRef = ref
  state.logOpen = null
  renderBranches()
  loadLog()
}

$('log').addEventListener('click', async (e) => {
  const fileEl = e.target.closest('[data-file]')
  if (fileEl) {
    const list = state.logFiles
    const i = list.findIndex((f) => f.path === fileEl.dataset.file)
    const c = state.log.find((x) => x.hash === state.logOpen)
    return openDiff({ source: 'commit', rev: state.logOpen, list, index: i, label: c ? `${c.short} ${c.subject}` : '' })
  }
  const row = e.target.closest('.commit-row')
  if (!row) return
  if (state.logOpen === row.dataset.hash) {
    state.logOpen = null
    return renderLog()
  }
  const rev = row.dataset.hash
  const res = await attempt('Could not read the commit', () => Promise.all([request('git.commitFiles', { rev }), request('git.commitMessage', { rev })]))
  if (!res) return
  state.logOpen = rev
  state.logFiles = res[0]
  state.logMessage = res[1]
  renderLog()
})
$('log').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.commit-row')
  if (!row) return
  e.preventDefault()
  const c = state.log.find((x) => x.hash === row.dataset.hash)
  if (!c) return
  showMenu(e.clientX, e.clientY, [
    { label: 'New Branch from Here…', run: () => newBranch(c.hash, c.short) },
    { label: 'Checkout Revision', run: () => checkoutRevision(c) },
    '-',
    { label: 'Copy Revision Number', run: () => copy(c.hash) },
    { label: 'Copy Subject', run: () => copy(c.subject) }
  ])
})
// Each keystroke would redraw the whole Log: wait until typing pauses.
let logFilterTimer
$('log-filter').addEventListener('input', () => {
  clearTimeout(logFilterTimer)
  logFilterTimer = setTimeout(renderLog, 120)
})

// ---- branches tree ---------------------------------------------------------

/** Nests branch names by their folders: feature/a, feature/b -> feature > a, b. */
function folderize(items, keyPrefix, nameOf, leaf) {
  const root = { dirs: new Map(), leaves: [] }
  for (const it of items) {
    const parts = nameOf(it).split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), leaves: [] })
      node = node.dirs.get(part)
    }
    node.leaves.push({ it, title: parts[parts.length - 1] })
  }
  const toNodes = (node, prefix) => [
    ...[...node.dirs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, child]) => {
        const full = prefix ? `${prefix}/${name}` : name
        const children = toNodes(child, full)
        return { key: `${keyPrefix}${full}`, kind: 'folder', title: name, children, count: countLeaves(children) }
      }),
    ...node.leaves.sort((a, b) => a.title.localeCompare(b.title)).map(({ it, title }) => leaf(it, title))
  ]
  return toNodes(root, '')
}
const countLeaves = (nodes) => nodes.reduce((n, x) => n + (x.kind === 'folder' ? x.count : 1), 0)

function buildBranchTree() {
  const b = state.branches
  if (!b) return []
  const local = folderize(b.local, 'b:d:local:', (x) => x.name, (x, title) => ({ key: `b:l:${x.name}`, kind: 'local', title, branch: x, children: [] }))
  // Remote branches: one folder per remote, then their own folders.
  const remotes = [...new Set(b.remote.map((x) => x.remote))].sort()
  const remote = remotes.map((r) => {
    const children = folderize(
      b.remote.filter((x) => x.remote === r),
      `b:d:remote:${r}/`,
      (x) => x.name.slice(r.length + 1),
      (x, title) => ({ key: `b:r:${x.name}`, kind: 'remote', title, branch: x, children: [] })
    )
    return { key: `b:d:remote:${r}`, kind: 'folder', title: r, icon: CLOUD_SVG, children, count: countLeaves(children) }
  })
  return [
    { key: 'b:head', kind: 'head', title: 'HEAD', children: [] },
    { key: 'b:g:local', kind: 'group', title: 'Local', children: local, count: b.local.length },
    ...(b.remote.length ? [{ key: 'b:g:remote', kind: 'group', title: 'Remote', children: remote, count: b.remote.length }] : [])
  ]
}

const branchRef = (n) => (n.kind === 'head' ? 'HEAD' : n.branch?.ref ?? null)

function renderBranches() {
  const el = $('branches')
  if (!state.repo || !state.branches) return void (el.innerHTML = '')
  logUi.rows = []
  const html = []
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      logUi.rows.push(n)
      const isLeaf = !n.children.length && n.kind !== 'group' && n.kind !== 'folder'
      const open = !isLeaf && !logUi.collapsed.has(n.key)
      const ref = branchRef(n)
      const filtered = ref && ref === state.logRef
      const cls = ['node', `b-${n.kind}`, n.key === logUi.selected ? 'selected' : '', filtered ? 'filtered' : '', n.branch?.current ? 'current' : ''].join(' ')
      let icon = ''
      if (n.kind === 'folder') icon = n.icon ?? (open ? FOLDER_OPEN_SVG : FOLDER_SVG)
      else if (n.kind === 'head') icon = HEAD_SVG
      else if (n.kind === 'local' || n.kind === 'remote') icon = BRANCH_SVG
      let extra = ''
      if (n.kind === 'local') {
        const x = n.branch
        if (x.ahead) extra += `<span class="track ahead" title="${x.ahead} commit${x.ahead === 1 ? '' : 's'} to push">↑${x.ahead}</span>`
        if (x.behind) extra += `<span class="track behind" title="${x.behind} commit${x.behind === 1 ? '' : 's'} to pull">↓${x.behind}</span>`
        if (x.gone) extra += '<span class="track gone" title="The upstream branch was deleted">gone</span>'
      } else if (n.kind === 'head') extra = `<span class="dir">${esc(state.branches.current ?? 'detached')}</span>`
      else if (n.kind === 'group' || n.kind === 'folder') extra = `<span class="count">${n.count}</span>`
      const title = n.branch ? `${n.branch.name}${n.branch.upstream ? ` → ${n.branch.upstream}` : ''}` : n.kind === 'head' ? 'HEAD (Current Branch)' : n.title
      html.push(`<div class="${cls}" data-key="${esc(n.key)}" role="treeitem" ${isLeaf ? '' : `aria-expanded="${open}"`} style="padding-left:${4 + depth * 14}px" title="${esc(title)}">
        <span class="twisty">${isLeaf ? '' : open ? '▾' : '▸'}</span><span class="icon">${icon}</span><span class="name">${esc(n.title)}</span>${extra}</div>`)
      if (open) walk(n.children, depth + 1)
    }
  }
  walk(buildBranchTree(), 0)
  el.innerHTML = html.join('')
}

const branchNode = (key) => logUi.rows.find((r) => r.key === key)

function toggleBranchNode(n) {
  logUi.collapsed.has(n.key) ? logUi.collapsed.delete(n.key) : logUi.collapsed.add(n.key)
  store.set('branchCollapsed', [...logUi.collapsed])
  renderBranches()
}

$('branches').addEventListener('click', (e) => {
  const row = e.target.closest('.node')
  const n = row && branchNode(row.dataset.key)
  if (!n) return
  logUi.selected = n.key
  $('branches').focus()
  const ref = branchRef(n)
  // A branch filters the history to it (the Branch selector shows which).
  if (ref) return setLogRef(ref)
  if (e.target.closest('.twisty') || n.kind === 'group' || n.kind === 'folder') return toggleBranchNode(n)
  renderBranches()
})
$('branches').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.node')
  const n = row && branchNode(row.dataset.key)
  // Double-click on a branch checks it out (after asking).
  if (n?.kind === 'local' && !n.branch.current) checkoutBranch(n.branch.name)
  else if (n?.kind === 'remote') checkoutRemote(n.branch.name)
})
$('branches').addEventListener('keydown', (e) => {
  const rows = logUi.rows
  if (!rows.length) return
  const i = Math.max(0, rows.findIndex((r) => r.key === logUi.selected))
  const n = rows[i]
  const go = (j) => {
    e.preventDefault()
    logUi.selected = rows[Math.max(0, Math.min(rows.length - 1, j))].key
    renderBranches()
    $('branches').querySelector('.node.selected')?.scrollIntoView({ block: 'nearest' })
  }
  if (e.key === 'ArrowDown') go(logUi.selected ? i + 1 : 0)
  else if (e.key === 'ArrowUp') go(i - 1)
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && n.children.length) {
    e.preventDefault()
    if (logUi.collapsed.has(n.key) === (e.key === 'ArrowRight')) toggleBranchNode(n)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const ref = branchRef(n)
    if (ref) setLogRef(ref)
    else if (n.children.length) toggleBranchNode(n)
  }
})
$('branches').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.node')
  const n = row && branchNode(row.dataset.key)
  if (!n) return
  e.preventDefault()
  logUi.selected = n.key
  renderBranches()
  const cur = state.branches?.current ?? 'HEAD'
  const updateLabel = (x) => (x?.upstream ? 'Update (Pull)' : 'Update (Pull): no upstream branch')
  const FETCH = { label: 'Fetch', run: () => runBranchOp({ op: 'fetch' }, 'Fetch failed') }
  const showInLog = (ref) => (state.logRef === ref ? { label: 'Show All Branches', run: () => setLogRef(null) } : { label: 'Show in Log', run: () => setLogRef(ref) })
  if (n.kind === 'group' || n.kind === 'folder') {
    const open = !logUi.collapsed.has(n.key)
    return showMenu(e.clientX, e.clientY, [
      { label: open ? 'Collapse' : 'Expand', run: () => toggleBranchNode(n) },
      { label: 'New Branch…', run: () => newBranch() },
      FETCH
    ])
  }
  const curBranch = state.branches?.local.find((x) => x.current)
  if (n.kind === 'head')
    return showMenu(e.clientX, e.clientY, [
      showInLog('HEAD'),
      { label: 'New Branch…', run: () => newBranch() },
      '-',
      FETCH,
      { label: updateLabel(curBranch), disabled: !curBranch?.upstream, run: () => runBranchOp({ op: 'update' }, 'Update failed') },
      { label: 'Push…', disabled: !curBranch, run: () => pushBranch(curBranch) }
    ])
  const b = n.branch
  if (n.kind === 'local' && b.current) {
    return showMenu(e.clientX, e.clientY, [
      { label: `New Branch from '${b.name}'…`, run: () => newBranch(b.name) },
      '-',
      FETCH,
      { label: updateLabel(b), disabled: !b.upstream, run: () => runBranchOp({ op: 'update' }, 'Update failed') },
      { label: 'Push…', run: () => pushBranch(b) },
      '-',
      { label: 'Rename…', run: () => renameBranch(b.name) },
      '-',
      showInLog(b.ref),
      { label: 'Copy Branch Name', run: () => copy(b.name) }
    ])
  }
  if (n.kind === 'local') {
    return showMenu(e.clientX, e.clientY, [
      { label: 'Checkout', run: () => checkoutBranch(b.name) },
      { label: `New Branch from '${b.name}'…`, run: () => newBranch(b.name) },
      '-',
      { label: `Rebase '${cur}' onto '${b.name}'`, run: () => rebaseOnto(b.name) },
      { label: `Merge '${b.name}' into '${cur}'`, run: () => mergeInto(b.name) },
      '-',
      FETCH,
      { label: updateLabel(b), disabled: !b.upstream, run: () => runBranchOp({ op: 'updateBranch', name: b.name }, 'Update failed') },
      { label: 'Push…', run: () => pushBranch(b) },
      { label: 'Rename…', run: () => renameBranch(b.name) },
      { label: 'Delete', run: () => deleteBranch(b.name) },
      '-',
      showInLog(b.ref),
      { label: 'Copy Branch Name', run: () => copy(b.name) }
    ])
  }
  showMenu(e.clientX, e.clientY, [
    { label: 'Checkout', run: () => checkoutRemote(b.name) },
    { label: `New Branch from '${b.name}'…`, run: () => newBranch(b.name) },
    '-',
    { label: `Rebase '${cur}' onto '${b.name}'`, run: () => rebaseOnto(b.name) },
    { label: `Merge '${b.name}' into '${cur}'`, run: () => mergeInto(b.name) },
    '-',
    FETCH,
    { label: 'Update (Fetch this branch)', run: () => runBranchOp({ op: 'updateBranch', name: b.name, remote: true }, 'Update failed') },
    { label: 'Delete', run: () => deleteRemote(b.name) },
    '-',
    showInLog(b.ref),
    { label: 'Copy Branch Name', run: () => copy(b.name) }
  ])
})

// ---- branch actions ----------------------------------------------------------

async function runBranchOp(op, failTitle) {
  const res = await attempt(failTitle, () => request('git.branchOp', op, 200_000))
  if (!res) return undefined
  if (res.conflicts) {
    await dialog({ title: 'Conflicts', body: `${esc(res.message)}<br />The conflicted files are in <b>Merge Conflicts</b>, and the bar at the top has Continue and Abort.`, ok: 'Close', cancel: null })
  } else if (!res.notMerged) toast(res.message)
  await reload()
  await loadLogPane()
  return res
}

const dirtyNote = () => (state.files.some((f) => f.status !== 'untracked') ? '<div class="muted" style="margin-top:6px">You have local changes; git keeps them when they do not clash with the other branch, and refuses otherwise.</div>' : '')

async function checkoutBranch(name) {
  const ok = await dialog({ title: `Checkout ${name}?`, body: `Switch the working tree to <b>${esc(name)}</b>.${dirtyNote()}`, ok: 'Checkout' })
  if (ok) await runBranchOp({ op: 'checkout', name }, 'Checkout failed')
}

async function checkoutRemote(name) {
  const local = name.slice(name.indexOf('/') + 1)
  const exists = state.branches?.local.some((b) => b.name === local)
  const ok = await dialog({
    title: `Checkout ${name}?`,
    body: exists ? `Switch to the local branch <b>${esc(local)}</b>.${dirtyNote()}` : `Create the local branch <b>${esc(local)}</b> tracking <b>${esc(name)}</b> and switch to it.${dirtyNote()}`,
    ok: 'Checkout'
  })
  if (ok) await runBranchOp({ op: 'checkoutRemote', name }, 'Checkout failed')
}

async function checkoutRevision(c) {
  const ok = await dialog({ title: `Checkout ${c.short}?`, body: `The working tree moves to <b>${esc(c.short)}</b> ${esc(c.subject)} in detached HEAD (no branch).${dirtyNote()}`, ok: 'Checkout' })
  if (ok) await runBranchOp({ op: 'checkout', name: c.hash }, 'Checkout failed')
}

async function newBranch(from, label) {
  const name = await dialog({
    title: from ? `New Branch from '${label ?? from}'` : 'New Branch',
    body: '<div>Name of the new branch:</div>',
    ok: 'Create',
    input: '',
    check: { label: 'Checkout branch', checked: true }
  })
  if (name === null || !name.trim()) return
  await runBranchOp({ op: 'create', newName: name.trim(), from, checkout: lastDialogCheck }, 'Could not create the branch')
}

async function renameBranch(name) {
  const newName = await dialog({ title: `Rename ${name}`, body: '<div>New name:</div>', ok: 'Rename', input: name })
  if (newName === null || !newName.trim() || newName.trim() === name) return
  await runBranchOp({ op: 'rename', name, newName: newName.trim() }, 'Could not rename the branch')
}

async function deleteBranch(name) {
  const ok = await dialog({ title: `Delete ${name}?`, body: `The local branch <b>${esc(name)}</b> is deleted.`, ok: 'Delete', danger: true })
  if (!ok) return
  const res = await runBranchOp({ op: 'delete', name }, 'Could not delete the branch')
  if (!res?.notMerged) return
  const force = await dialog({ title: `${name} is not fully merged`, body: `<b>${esc(name)}</b> has commits that are not merged into any other branch. Delete it anyway? Those commits are lost.`, ok: 'Delete Anyway', danger: true })
  if (force) await runBranchOp({ op: 'delete', name, force: true }, 'Could not delete the branch')
}

async function deleteRemote(name) {
  const ok = await dialog({ title: `Delete ${name}?`, body: `The branch is deleted <b>on the remote</b> (<code>git push ${esc(name.split('/')[0])} --delete ${esc(name.slice(name.indexOf('/') + 1))}</code>) for everyone.`, ok: 'Delete', danger: true })
  if (ok) await runBranchOp({ op: 'deleteRemote', name }, 'Could not delete the remote branch')
}

async function mergeInto(name) {
  const cur = state.branches?.current ?? 'HEAD'
  const ok = await dialog({ title: `Merge ${name} into ${cur}?`, body: `<code>git merge --no-edit ${esc(name)}</code>`, ok: 'Merge' })
  if (ok) await runBranchOp({ op: 'merge', name }, 'Merge failed')
}

async function rebaseOnto(name) {
  const cur = state.branches?.current ?? 'HEAD'
  const ok = await dialog({ title: `Rebase ${cur} onto ${name}?`, body: `Your commits on <b>${esc(cur)}</b> are replayed on top of <b>${esc(name)}</b>.<br /><code>git rebase ${esc(name)}</code>`, ok: 'Rebase' })
  if (ok) await runBranchOp({ op: 'rebase', name }, 'Rebase failed')
}

async function pushBranch(b) {
  const where = b.upstream ?? `origin/${b.name}`
  const ok = await dialog({ title: `Push ${b.name}`, body: b.ahead || !b.upstream ? `Push <b>${esc(b.name)}</b> to <b>${esc(where)}</b>${b.ahead ? ` (${b.ahead} commit${b.ahead === 1 ? '' : 's'})` : ''}.` : `<b>${esc(b.name)}</b> has nothing new to push to <b>${esc(where)}</b>. Push anyway?`, ok: 'Push' })
  if (ok) await runBranchOp({ op: 'push', name: b.name }, 'Push failed')
}

// ---- pane layout: hide/show, splitters ---------------------------------------

function applyLogLayout() {
  const pane = $('log-pane')
  pane.classList.toggle('collapsed', logUi.hidden)
  $('log-splitter').hidden = logUi.hidden
  pane.style.height = logUi.hidden ? '' : logUi.height ? `${logUi.height}px` : ''
  const toggle = document.querySelector('[data-act="log-toggle"]')
  // A bottom-panel icon: arrow down hides the Log, arrow up brings it back.
  toggle.innerHTML = logUi.hidden ? PANEL_OPEN_SVG : PANEL_CLOSE_SVG
  toggle.title = logUi.hidden ? 'Show Log' : 'Hide Log'
  toggle.setAttribute('aria-label', toggle.title)
  toggle.setAttribute('aria-expanded', String(!logUi.hidden))
  $('branches-pane').hidden = !logUi.showBranches
  $('branch-splitter').hidden = !logUi.showBranches
  $('branches-pane').style.width = logUi.branchesWidth ? `${logUi.branchesWidth}px` : ''
  document.querySelector('[data-act="branches-toggle"]').setAttribute('aria-pressed', String(logUi.showBranches))
}

function dragSplitter(handle, onMove, onEnd) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    const move = (ev) => onMove(ev)
    const up = () => {
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      onEnd()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

dragSplitter(
  $('log-splitter'),
  (e) => {
    const view = $('commit-view').getBoundingClientRect()
    logUi.height = Math.round(clamp(view.bottom - e.clientY, 90, view.height - 150))
    $('log-pane').style.height = `${logUi.height}px`
  },
  () => store.set('logHeight', logUi.height)
)
dragSplitter(
  $('branch-splitter'),
  (e) => {
    const body = $('log-pane').querySelector('.log-body').getBoundingClientRect()
    logUi.branchesWidth = Math.round(clamp(e.clientX - body.left, 90, body.width - 140))
    $('branches-pane').style.width = `${logUi.branchesWidth}px`
  },
  () => store.set('branchesWidth', logUi.branchesWidth)
)
// Keyboard resizing for the splitters.
$('log-splitter').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  e.preventDefault()
  const view = $('commit-view').getBoundingClientRect()
  logUi.height = Math.round(clamp(($('log-pane').getBoundingClientRect().height || 200) + (e.key === 'ArrowUp' ? 20 : -20), 90, view.height - 150))
  store.set('logHeight', logUi.height)
  applyLogLayout()
})
$('branch-splitter').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const body = $('log-pane').querySelector('.log-body').getBoundingClientRect()
  logUi.branchesWidth = Math.round(clamp($('branches-pane').getBoundingClientRect().width + (e.key === 'ArrowRight' ? 20 : -20), 90, body.width - 140))
  store.set('branchesWidth', logUi.branchesWidth)
  applyLogLayout()
})

for (const b of document.querySelectorAll('#log-pane .toolbar .tb')) {
  b.addEventListener('click', () => {
    const act = b.dataset.act
    if (act === 'log-toggle') {
      logUi.hidden = !logUi.hidden
      store.set('logHidden', logUi.hidden)
      applyLogLayout()
      if (!logUi.hidden && !logUi.loaded) loadLogPane()
    } else if (act === 'branches-toggle') {
      logUi.showBranches = !logUi.showBranches
      store.set('showBranches', logUi.showBranches)
      applyLogLayout()
    } else if (act === 'log-refresh') loadLogPane()
    else if (act === 'log-fetch') runBranchOp({ op: 'fetch' }, 'Fetch failed')
  })
}
document.querySelector('[data-act="branches-toggle"]').innerHTML = BRANCH_SVG
applyLogLayout()

// ---------------------------------------------------------------------------
// Shelf (shelved changes, kept as git stashes)

async function shelve() {
  const checked = state.files.filter((f) => state.checked.has(f.path))
  const files = (checked.length ? checked : selectedFiles()).filter((f) => f.status !== 'conflicted')
  if (!files.length) return toast('Select the files to shelve')
  const message = await dialog({
    title: `Shelve ${files.length} ${files.length === 1 ? 'file' : 'files'}`,
    body: `<ul>${files.map((f) => `<li>${esc(f.path)}</li>`).join('')}</ul><div style="margin-top:8px">The changes are removed from the working tree and kept in the Shelf.</div>`,
    ok: 'Shelve',
    input: $('message').value.split('\n')[0] || 'Shelved changes'
  })
  if (message === null) return
  if ((await attempt('Could not shelve', () => request('git.shelve', { files, message }))) === undefined) return
  toast('Changes shelved')
  state.shelf = null
  await reload()
}

async function loadShelf() {
  if (!state.repo) return renderShelf()
  state.shelf = (await attempt('Could not read the shelf', () => request('git.shelf'))) ?? []
  renderShelf()
}

function renderShelf() {
  const el = $('shelf')
  if (!state.repo) return void (el.innerHTML = '')
  const list = state.shelf ?? []
  if (!list.length) return void (el.innerHTML = '<div class="empty">Nothing shelved.<br />Use ⤓ Shelve in the Commit tab to put changes aside.</div>')
  el.innerHTML = list
    .map((s) => {
      const open = state.shelfOpen === s.hash
      const files = open ? `<div class="commit-details"><div class="content"><div class="commit-files">${fileRows(state.shelfFiles)}</div></div></div>` : ''
      return `<div class="commit-row shelf-row ${open ? 'open' : ''}" data-shelf="${s.hash}">
        <div class="text"><div class="subject">${esc(s.message)}</div><div class="meta"><span>${esc(s.ref)}</span><span>${new Date(s.date).toLocaleString()}</span></div></div>
        <div class="actions">
          <button class="tb" data-shelf-act="unshelve" title="Unshelve (apply and remove from the Shelf)">⤒</button>
          <button class="tb" data-shelf-act="apply" title="Apply and keep in the Shelf">⎘</button>
          <button class="tb" data-shelf-act="drop" title="Delete">🗑</button>
        </div></div>${files}`
    })
    .join('')
}

$('shelf').addEventListener('click', async (e) => {
  const fileEl = e.target.closest('[data-file]')
  if (fileEl) {
    const list = state.shelfFiles
    const i = list.findIndex((f) => f.path === fileEl.dataset.file)
    const s = state.shelf.find((x) => x.hash === state.shelfOpen)
    return openDiff({ source: 'commit', rev: state.shelfOpen, list, index: i, label: s ? `Shelf: ${s.message}` : '' })
  }
  const row = e.target.closest('[data-shelf]')
  if (!row) return
  const hash = row.dataset.shelf
  const act = e.target.closest('[data-shelf-act]')?.dataset.shelfAct
  if (act === 'drop') {
    const ok = await dialog({ title: 'Delete shelved changes?', body: 'The shelved changes are lost.', ok: 'Delete', danger: true })
    if (!ok) return
    if ((await attempt('Could not delete', () => request('git.dropShelf', { hash }))) === undefined) return
    toast('Deleted')
    return loadShelf()
  }
  if (act === 'unshelve' || act === 'apply') {
    const drop = act === 'unshelve'
    if ((await attempt('Could not unshelve', () => request('git.unshelve', { hash, drop }))) === undefined) return
    toast(drop ? 'Unshelved' : 'Applied')
    await reload()
    return loadShelf()
  }
  if (state.shelfOpen === hash) {
    state.shelfOpen = null
    return renderShelf()
  }
  const files = await attempt('Could not read the shelf entry', () => request('git.shelfFiles', { hash }))
  if (!files) return
  state.shelfOpen = hash
  state.shelfFiles = files
  renderShelf()
})
document.querySelector('[data-act="shelf-refresh"]').onclick = loadShelf

// ---------------------------------------------------------------------------
// Diff viewer

const CONTEXT = 3
let diffMode = store.get('diffMode', null)

/** A local change opens in Orca's diff tab (full width); the panel viewer is the fallback. */
async function openLocalDiff(file) {
  if (file.status === 'conflicted') return openMerge(file)
  try {
    await request('git.openDiffTab', { path: file.path })
  } catch (e) {
    toast(`Diff tab unavailable (${e.message}); showing it here`)
    return openPanelDiff(file)
  }
}

function openPanelDiff(file) {
  if (file.status === 'conflicted') return openMerge(file)
  const list = state.files.filter((f) => f.status !== 'conflicted')
  const index = Math.max(0, list.findIndex((f) => f.path === file.path))
  return openDiff({ source: 'local', list, index })
}

async function openDiff({ source, rev, list, index, label }) {
  const file = list[index]
  if (!file) return
  // Shelf files carry their own commit (untracked files live in the stash's third parent).
  const mode = source === 'local' ? { kind: 'local' } : { kind: 'commit', rev: file.rev ?? rev }
  const result = await attempt('Could not show the diff', () => request('git.diff', { path: file.path, origPath: file.origPath, mode }))
  if (!result) return
  state.diff = { source, rev, list, index, label, file, result, current: 0, unfolded: new Set() }
  showView('diff')
  renderDiff()
  $('diff').scrollTop = 0
  $('diff').focus()
  // Start on the first difference.
  if (result.hunks.length) gotoChange(0, false)
}

async function refreshDiff() {
  const d = state.diff
  if (!d) return
  const still = state.files.find((f) => f.path === d.file.path)
  if (!still) {
    toast(`${d.file.path} has no changes any more`)
    return closeDiff()
  }
  const result = await request('git.diff', { path: still.path, origPath: still.origPath, mode: { kind: 'local' } }).catch(() => null)
  if (!result) return
  const top = $('diff').scrollTop
  d.list = state.files.filter((f) => f.status !== 'conflicted')
  d.index = Math.max(0, d.list.findIndex((f) => f.path === still.path))
  d.file = still
  d.result = result
  d.current = Math.min(d.current, Math.max(0, result.hunks.length - 1))
  renderDiff()
  $('diff').scrollTop = top
}

function closeDiff() {
  state.diff = null
  showView(state.tab)
  if (state.tab === 'commit') $('tree').focus()
}

function viewerMode() {
  return diffMode ?? (document.body.clientWidth >= 640 ? 'split' : 'unified')
}

function lineHtml(segments, fallback, cls) {
  if (!segments) return esc(fallback)
  return segments.map((s) => (s.changed ? `<span class="${cls}">${esc(s.text)}</span>` : esc(s.text))).join('')
}

function renderDiff() {
  const d = state.diff
  const r = d.result
  const mode = viewerMode()
  $('diff-mode').value = mode
  const titleEl = $('diff-title')
  titleEl.className = `diff-title ${mode === 'unified' ? 'unified' : ''}`
  const name = `${d.file.path}${d.file.origPath ? `  ←  ${d.file.origPath}` : ''}`
  const head = `<div class="file" title="${esc(name)}">${esc(name)}${d.label ? ` <span class="muted">· ${esc(d.label)}</span>` : ''}</div>`
  titleEl.innerHTML = mode === 'split' ? `${head}<div>${esc(r.leftTitle)}</div><div>${esc(r.rightTitle)}</div>` : `${head}<div>${esc(r.leftTitle)} → ${esc(r.rightTitle)}</div>`

  const count = r.hunks.length
  $('diff-count').textContent = r.binary || r.tooLarge ? '' : count ? `${Math.min(d.current + 1, count)} of ${count} difference${count === 1 ? '' : 's'}` : 'Contents are identical'
  for (const [act, dis] of [
    ['prev-change', d.current <= 0 && d.index <= 0],
    ['next-change', d.current >= count - 1 && d.index >= d.list.length - 1],
    ['prev-file', d.index <= 0],
    ['next-file', d.index >= d.list.length - 1],
    ['open', d.source !== 'local' || d.file.status === 'deleted']
  ])
    document.querySelector(`#diff-view [data-act="${act}"]`).disabled = dis

  const el = $('diff')
  if (r.binary) return void (el.innerHTML = '<div class="notice">Binary files differ</div>')
  if (r.tooLarge) return void (el.innerHTML = '<div class="notice">The file is too large to compare</div>')

  const { L, R, items } = buildBlocks(r.left, r.right, r.hunks)
  const rows = []
  const lastIndex = items.length - 1
  items.forEach((it, idx) => {
    if (it.type === 'equal') {
      const key = `${it.l}:${it.r}`
      const head = idx === 0 ? 0 : CONTEXT
      const tail = idx === lastIndex ? 0 : CONTEXT
      const fold = r.hunks.length && !d.unfolded.has(key) && it.n > head + tail + 1
      const show = (k) => !fold || k < head || k >= it.n - tail
      for (let k = 0; k < it.n; k++) {
        if (!show(k)) {
          if (k === head) rows.push(foldRow(key, it.n - head - tail, mode))
          continue
        }
        rows.push(equalRow(it.l + k, it.r + k, L[it.l + k], mode))
      }
      return
    }
    rows.push(...changeRows(it, L, R, mode, r.canRevert && d.source === 'local', idx === d.current))
  })
  if (!rows.length) return void (el.innerHTML = '<div class="notice">Contents are identical</div>')
  const cols =
    mode === 'split'
      ? '<colgroup><col class="c-ln"><col><col class="c-gutter"><col class="c-ln"><col></colgroup>'
      : '<colgroup><col class="c-ln"><col class="c-ln"><col class="c-sign" style="width:22px"><col></colgroup>'
  el.innerHTML = `<table>${cols}<tbody>${rows.join('')}</tbody></table>`
  markCurrent()
}

function equalRow(l, r, text, mode) {
  if (mode === 'split') return `<tr><td class="ln">${l + 1}</td><td class="code l">${esc(text)}</td><td class="gutter"></td><td class="ln">${r + 1}</td><td class="code r">${esc(text)}</td></tr>`
  return `<tr><td class="ln">${l + 1}</td><td class="ln">${r + 1}</td><td class="sign"></td><td class="code u">${esc(text)}</td></tr>`
}

function foldRow(key, n, mode) {
  return `<tr class="fold" data-fold="${key}"><td colspan="${mode === 'split' ? 5 : 4}">⋯ ${n} unchanged line${n === 1 ? '' : 's'} (click to expand)</td></tr>`
}

function changeRows(it, L, R, mode, canRevert) {
  const left = L.slice(it.l, it.l + it.ln)
  const right = R.slice(it.r, it.r + it.rn)
  const words = it.kind === 'modify' ? wordDiff(left, right) : null
  const revertBtn = canRevert ? `<button class="revert" data-revert="${it.index}" title="Revert this change (restore HEAD lines)">»</button>` : ''
  const rows = []
  if (mode === 'split') {
    const n = Math.max(it.ln, it.rn)
    for (let k = 0; k < n; k++) {
      const cls = [it.kind, k === 0 ? 'block-start' : '', k === n - 1 ? 'block-end' : ''].join(' ')
      const hasL = k < it.ln
      const hasR = k < it.rn
      rows.push(`<tr class="${cls}" data-block="${it.index}">
        <td class="ln">${hasL ? it.l + k + 1 : ''}</td><td class="code l ${hasL ? '' : 'filler'}">${hasL ? lineHtml(words?.left[k], left[k], 'w-mod') : ''}</td>
        <td class="gutter">${k === 0 ? revertBtn : ''}</td>
        <td class="ln">${hasR ? it.r + k + 1 : ''}</td><td class="code r ${hasR ? '' : 'filler'}">${hasR ? lineHtml(words?.right[k], right[k], 'w-mod') : ''}</td></tr>`)
    }
    // A pure deletion or insertion of nothing visible still needs a marker row.
    if (n === 0) rows.push(`<tr class="${it.kind} block-start block-end" data-block="${it.index}"><td colspan="5"></td></tr>`)
  } else {
    const total = it.ln + it.rn
    let k = 0
    left.forEach((line, i) => {
      const cls = ['u-del', it.kind, k === 0 ? 'block-start' : '', k === total - 1 ? 'block-end' : ''].join(' ')
      rows.push(`<tr class="${cls}" data-block="${it.index}"><td class="ln">${it.l + i + 1}</td><td class="ln"></td><td class="sign">${k === 0 && revertBtn ? revertBtn : '−'}</td><td class="code u">${lineHtml(words?.left[i], line, 'w-del')}</td></tr>`)
      k++
    })
    right.forEach((line, i) => {
      const cls = ['u-add', it.kind, k === 0 ? 'block-start' : '', k === total - 1 ? 'block-end' : ''].join(' ')
      rows.push(`<tr class="${cls}" data-block="${it.index}"><td class="ln"></td><td class="ln">${it.r + i + 1}</td><td class="sign">${k === 0 && revertBtn ? revertBtn : '+'}</td><td class="code u">${lineHtml(words?.right[i], line, 'w-ins')}</td></tr>`)
      k++
    })
  }
  return rows
}

function markCurrent() {
  for (const tr of $('diff').querySelectorAll('tr.current')) tr.classList.remove('current')
  for (const tr of $('diff').querySelectorAll(`tr[data-block="${state.diff.current}"]`)) tr.classList.add('current')
}

function gotoChange(i, smooth = true) {
  const d = state.diff
  d.current = i
  const count = d.result.hunks.length
  $('diff-count').textContent = count ? `${i + 1} of ${count} difference${count === 1 ? '' : 's'}` : ''
  markCurrent()
  const first = $('diff').querySelector(`tr[data-block="${i}"]`)
  first?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
  renderDiffButtons()
}

function renderDiffButtons() {
  const d = state.diff
  const count = d.result.hunks.length
  document.querySelector('#diff-view [data-act="prev-change"]').disabled = d.current <= 0 && d.index <= 0
  document.querySelector('#diff-view [data-act="next-change"]').disabled = d.current >= count - 1 && d.index >= d.list.length - 1
}

/** F7: next difference; past the last one, the next file. */
async function nextChange(dir) {
  const d = state.diff
  const count = d.result.hunks.length
  const target = d.current + dir
  if (target >= 0 && target < count) return gotoChange(target)
  const ni = d.index + dir
  if (ni < 0 || ni >= d.list.length) return toast(dir > 0 ? 'Last difference' : 'First difference')
  await openDiff({ ...d, index: ni })
  if (dir < 0 && state.diff.result.hunks.length) gotoChange(state.diff.result.hunks.length - 1, false)
}

async function revertBlock(index) {
  const d = state.diff
  const hunk = d.result.hunks[index]
  if (!hunk) return
  if ((await attempt('Could not revert the change', () => request('git.revertHunk', { path: d.file.path, header: hunk.header }))) === undefined) return
  toast('Change reverted')
  await reload()
}

$('diff').addEventListener('click', (e) => {
  const rb = e.target.closest('[data-revert]')
  if (rb) return revertBlock(Number(rb.dataset.revert))
  const fold = e.target.closest('tr.fold')
  if (fold) {
    state.diff.unfolded.add(fold.dataset.fold)
    const top = $('diff').scrollTop
    renderDiff()
    $('diff').scrollTop = top
    return
  }
  const tr = e.target.closest('tr[data-block]')
  if (tr) {
    state.diff.current = Number(tr.dataset.block)
    markCurrent()
    renderDiffButtons()
    const count = state.diff.result.hunks.length
    $('diff-count').textContent = `${state.diff.current + 1} of ${count} difference${count === 1 ? '' : 's'}`
  }
})
$('diff-mode').addEventListener('change', () => {
  diffMode = $('diff-mode').value
  store.set('diffMode', diffMode)
  renderDiff()
  gotoChange(state.diff.current, false)
})
for (const b of document.querySelectorAll('#diff-view .toolbar .tb')) {
  b.addEventListener('click', () => {
    const d = state.diff
    if (!d) return
    const act = b.dataset.act
    if (act === 'back') closeDiff()
    else if (act === 'prev-change') nextChange(-1)
    else if (act === 'next-change') nextChange(1)
    else if (act === 'prev-file') openDiff({ ...d, index: d.index - 1 })
    else if (act === 'next-file') openDiff({ ...d, index: d.index + 1 })
    else if (act === 'open') jumpToSource(d.file.path)
  })
}

// ---------------------------------------------------------------------------
// Conflicts: operation bar, Accept Yours / Theirs, merge view

/**
 * "Yours" is the branch you were on. In a rebase that is the commit being replayed,
 * which git puts in its "theirs" slot.
 */
const isRebase = () => state.operation?.kind === 'rebase'
const gitSide = (side) => ((side === 'yours') === !isRebase() ? 'ours' : 'theirs')

/** A readable name for a side: the branch or commit it comes from. */
function sideLabel(side, segment) {
  const g = gitSide(side)
  const fromMarker = segment ? (g === 'ours' ? segment.oursLabel : segment.theirsLabel) : ''
  return fromMarker || (g === 'ours' ? 'HEAD' : 'incoming')
}

function renderOpBar() {
  const op = state.repo ? state.operation : null
  $('op-bar').hidden = !op
  if (!op) return
  const conflicts = state.files.filter((f) => f.status === 'conflicted').length
  $('op-title').textContent = `${op.title}${conflicts ? ` — ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : ' — conflicts resolved'}`
  $('op-resolve').hidden = !conflicts
  $('op-continue').disabled = conflicts > 0
  $('op-continue').title = conflicts ? 'Resolve every conflict first' : `Continue the ${op.kind}`
}

$('op-resolve').onclick = () => {
  const f = state.files.find((x) => x.status === 'conflicted')
  if (f) openMerge(f)
}
$('op-continue').onclick = async () => {
  const op = state.operation
  if (!op) return
  if ((await attempt(`Could not continue the ${op.kind}`, () => request('git.continueOp', undefined, 180_000))) === undefined) return
  toast(`${op.kind[0].toUpperCase()}${op.kind.slice(1)} continued`)
  await reload()
}
$('op-abort').onclick = async () => {
  const op = state.operation
  if (!op) return
  const ok = await dialog({
    title: `Abort the ${op.kind}?`,
    body: `${esc(op.title)}.<br />The branch goes back to where it was before the ${op.kind}; conflict resolutions made so far are lost.`,
    ok: 'Abort',
    danger: true
  })
  if (!ok) return
  if ((await attempt(`Could not abort the ${op.kind}`, () => request('git.abortOp'))) === undefined) return
  toast(`${op.kind[0].toUpperCase()}${op.kind.slice(1)} aborted`)
  closeMerge(false)
  await reload()
}

async function acceptSide(p, side) {
  if ((await attempt('Could not resolve the conflict', () => request('git.resolveSide', { path: p, side }))) === undefined) return
  toast(`${p}: accepted ${side}`)
  await reload()
}

async function markResolved(p) {
  try {
    await request('git.markResolved', { path: p })
  } catch (e) {
    if (!/conflict markers/.test(e.message)) return attempt('Could not mark as resolved', () => Promise.reject(e))
    const force = await dialog({ title: 'Conflict markers left', body: `${esc(p)} still contains conflict markers. Mark it as resolved anyway?`, ok: 'Mark as Resolved' })
    if (!force) return
    if ((await attempt('Could not mark as resolved', () => request('git.markResolved', { path: p, force: true }))) === undefined) return
  }
  toast(`${p} marked as resolved`)
  await reload()
}

// The merge view keeps the file as read from disk, the parsed segments and a choice per conflict.
async function openMerge(file) {
  const text = await attempt('Could not read the file', () => request('git.readFile', { path: file.path }))
  if (text === undefined) return
  const segments = parseConflicts(text)
  const count = segments.filter((s) => s.type === 'conflict').length
  if (!count) {
    // Nothing left to merge by hand: offer to stage it.
    const ok = await dialog({ title: 'No conflict markers', body: `${esc(file.path)} has no conflict markers left. Mark it as resolved?`, ok: 'Mark as Resolved' })
    if (ok) await markResolved(file.path)
    return
  }
  state.merge = { file, text, segments, choices: {}, current: 0, unfolded: new Set() }
  showView('merge')
  renderMerge()
  $('merge').scrollTop = 0
  $('merge').focus()
}

function closeMerge(show = true) {
  state.merge = null
  if (show) {
    showView(state.tab)
    if (state.tab === 'commit') $('tree').focus()
  } else if (state.view === 'merge') showView(state.tab)
}

function choiceLabel(c, conflict) {
  const name = (g) => (g === gitSide('yours') ? `Yours (${sideLabel('yours', conflict)})` : `Theirs (${sideLabel('theirs', conflict)})`)
  if (c === 'ours' || c === 'theirs') return name(c)
  const [a, b] = c.split('-')
  return `Both: ${name(a).split(' ')[0]} then ${name(b).split(' ')[0]}`
}

const pre = (lines) => (lines.length ? `<pre>${lines.map((l) => esc(l.replace(/\r$/, ''))).join('\n')}</pre>` : '<pre class="empty-side">(empty)</pre>')

/** Lines of one side with the words that differ from the other side highlighted. */
function sideHtml(lines, other, cls) {
  const w = wordDiff(lines.map((l) => l.replace(/\r$/, '')), other.map((l) => l.replace(/\r$/, '')))
  if (!w || !lines.length) return pre(lines)
  return `<pre>${w.left.map((segs, i) => lineHtml(segs, lines[i], cls)).join('\n')}</pre>`
}

function renderMerge() {
  const m = state.merge
  const conflicts = m.segments.filter((s) => s.type === 'conflict')
  const open = conflicts.filter((c) => m.choices[c.index] === undefined).length
  $('merge-title').innerHTML = `<div class="file" title="${esc(m.file.path)}">${esc(m.file.path)}${state.operation ? ` <span class="muted">· ${esc(state.operation.title)}</span>` : ''}</div>`
  $('merge-count').textContent = open ? `${open} of ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} left` : 'All conflicts resolved'
  const two = document.body.clientWidth >= 560
  const yoursG = gitSide('yours')
  const html = []
  m.segments.forEach((seg, si) => {
    if (seg.type === 'text') {
      const lines = si === m.segments.length - 1 && seg.lines[seg.lines.length - 1] === '' ? seg.lines.slice(0, -1) : seg.lines
      const head = si === 0 ? 0 : CONTEXT
      const tail = si === m.segments.length - 1 ? 0 : CONTEXT
      const key = String(si)
      if (!m.unfolded.has(key) && lines.length > head + tail + 1) {
        if (head) html.push(`<div class="ctx">${lines.slice(0, head).map((l) => esc(l.replace(/\r$/, ''))).join('\n')}</div>`)
        html.push(`<div class="fold" data-unfold="${key}">⋯ ${lines.length - head - tail} unchanged lines (click to expand)</div>`)
        if (tail) html.push(`<div class="ctx">${lines.slice(-tail).map((l) => esc(l.replace(/\r$/, ''))).join('\n')}</div>`)
      } else if (lines.length) {
        html.push(`<div class="ctx">${lines.map((l) => esc(l.replace(/\r$/, ''))).join('\n')}</div>`)
      }
      return
    }
    const c = seg
    const choice = m.choices[c.index]
    const yours = yoursG === 'ours' ? c.ours : c.theirs
    const theirs = yoursG === 'ours' ? c.theirs : c.ours
    const cls = ['conflict', choice ? 'resolved' : '', c.index === m.current ? 'current' : ''].join(' ')
    if (choice) {
      const result = choice === 'ours' ? c.ours : choice === 'theirs' ? c.theirs : choice === 'ours-theirs' ? [...c.ours, ...c.theirs] : [...c.theirs, ...c.ours]
      html.push(`<div class="${cls}" data-conflict="${c.index}">
        <div class="conflict-head"><span class="label">✓ ${esc(choiceLabel(choice, c))}</span><button data-choose="undo">Undo</button></div>
        <div class="result">${pre(result)}</div></div>`)
      return
    }
    const y = esc(sideLabel('yours', c))
    const t = esc(sideLabel('theirs', c))
    const both = `${yoursG}-${yoursG === 'ours' ? 'theirs' : 'ours'}`
    const bothRev = both.split('-').reverse().join('-')
    html.push(`<div class="${cls}" data-conflict="${c.index}">
      <div class="conflict-head"><span class="label">Conflict ${c.index + 1}</span>
        <button data-choose="${yoursG}" title="Keep your lines">Accept Yours</button>
        <button data-choose="${yoursG === 'ours' ? 'theirs' : 'ours'}" title="Keep the incoming lines">Accept Theirs</button>
        <button data-choose="${both}" title="Your lines, then theirs">Both ↓</button>
        <button data-choose="${bothRev}" title="Their lines, then yours">Both ↑</button></div>
      <div class="sides ${two ? 'two' : ''}">
        <div class="side yours"><div class="side-title">Yours · ${y}</div>${sideHtml(yours, theirs, 'w-mod')}</div>
        <div class="side theirs"><div class="side-title">Theirs · ${t}</div>${sideHtml(theirs, yours, 'w-ins')}</div>
      </div>
      ${c.base ? `<details class="side base"><summary class="side-title">Base (common ancestor)</summary>${pre(c.base)}</details>` : ''}
    </div>`)
  })
  $('merge').innerHTML = html.join('')
}

function gotoConflict(dir) {
  const m = state.merge
  const n = m.segments.filter((s) => s.type === 'conflict').length
  // Prefer unresolved conflicts.
  for (let step = 1; step <= n; step++) {
    const i = (((m.current + dir * step) % n) + n) % n
    if (m.choices[i] === undefined || step === n) {
      m.current = i
      break
    }
  }
  renderMerge()
  $('merge').querySelector(`[data-conflict="${m.current}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function chooseAll(side) {
  const m = state.merge
  const g = gitSide(side)
  for (const s of m.segments) if (s.type === 'conflict' && m.choices[s.index] === undefined) m.choices[s.index] = g
  renderMerge()
}

async function applyMerge() {
  const m = state.merge
  // Someone (an agent, the editor) may have changed the file while the view was open.
  const now = await attempt('Could not read the file', () => request('git.readFile', { path: m.file.path }))
  if (now === undefined) return
  if (now !== m.text) {
    await dialog({ title: 'The file changed', body: `${esc(m.file.path)} changed on disk since the merge view opened. It is reloaded; make your choices again.`, ok: 'Reload', cancel: null })
    return openMerge(m.file)
  }
  const text = applyChoices(m.segments, m.choices)
  const left = m.segments.filter((s) => s.type === 'conflict' && m.choices[s.index] === undefined).length
  if ((await attempt('Could not save the file', () => request('git.writeFile', { path: m.file.path, text }))) === undefined) return
  if (left) {
    toast(`Saved; ${left} conflict${left === 1 ? '' : 's'} left`)
    m.text = text
    m.segments = parseConflicts(text)
    m.choices = {}
    m.current = 0
    renderMerge()
    return
  }
  if ((await attempt('Could not mark as resolved', () => request('git.markResolved', { path: m.file.path }))) === undefined) return
  toast(`${m.file.path} resolved`)
  await reload()
  // Go on with the next conflicted file, or back to the list.
  const next = state.files.find((f) => f.status === 'conflicted')
  if (next) return openMerge(next)
  closeMerge()
}

$('merge').addEventListener('click', (e) => {
  const m = state.merge
  if (!m) return
  const unfold = e.target.closest('[data-unfold]')
  if (unfold) {
    m.unfolded.add(unfold.dataset.unfold)
    const top = $('merge').scrollTop
    renderMerge()
    $('merge').scrollTop = top
    return
  }
  const box = e.target.closest('[data-conflict]')
  if (!box) return
  const index = Number(box.dataset.conflict)
  m.current = index
  const choose = e.target.closest('[data-choose]')?.dataset.choose
  if (choose === 'undo') delete m.choices[index]
  else if (choose) m.choices[index] = choose
  const top = $('merge').scrollTop
  renderMerge()
  $('merge').scrollTop = top
})

for (const b of document.querySelectorAll('#merge-view .toolbar button')) {
  b.addEventListener('click', () => {
    if (!state.merge) return
    const act = b.dataset.act
    if (act === 'm-back') closeMerge()
    else if (act === 'm-prev') gotoConflict(-1)
    else if (act === 'm-next') gotoConflict(1)
    else if (act === 'm-all-yours') chooseAll('yours')
    else if (act === 'm-all-theirs') chooseAll('theirs')
    else if (act === 'm-apply') applyMerge()
    else if (act === 'm-open') jumpToSource(state.merge.file.path)
  })
}

// ---------------------------------------------------------------------------
// Views and global keys

function showView(view) {
  state.view = view
  $('commit-view').hidden = view !== 'commit'
  $('shelf-view').hidden = view !== 'shelf'
  $('diff-view').hidden = view !== 'diff'
  $('merge-view').hidden = view !== 'merge'
}

for (const b of document.querySelectorAll('#tabs [role="tab"]')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab
    for (const t of document.querySelectorAll('#tabs [role="tab"]')) t.setAttribute('aria-selected', String(t === b))
    state.diff = null
    showView(state.tab)
    if (state.tab === 'shelf') loadShelf()
  })
}

document.addEventListener('keydown', (e) => {
  if (!$('dialog').hidden) return
  if (!$('menu').hidden && e.key === 'Escape') return hideMenu()
  const ctrl = e.ctrlKey || e.metaKey
  if (state.view === 'merge') {
    if (e.key === 'F7') {
      e.preventDefault()
      gotoConflict(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeMerge()
    } else if (e.key === 'F4') {
      e.preventDefault()
      jumpToSource(state.merge.file.path)
    } else if (ctrl && e.key === 'Enter') {
      e.preventDefault()
      applyMerge()
    }
    return
  }
  if (state.view === 'diff') {
    if (e.key === 'F7') {
      e.preventDefault()
      nextChange(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeDiff()
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const ni = state.diff.index + (e.key === 'ArrowLeft' ? -1 : 1)
      if (ni >= 0 && ni < state.diff.list.length) openDiff({ ...state.diff, index: ni })
    } else if (e.key === 'F4' && state.diff.source === 'local') {
      e.preventDefault()
      jumpToSource(state.diff.file.path)
    }
    return
  }
  if (state.view !== 'commit') return
  if (ctrl && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    const f = selectedFiles()[0] ?? state.files[0]
    if (f) openLocalDiff(f)
  } else if (ctrl && e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    const files = selectedFiles()
    rollback(files.length ? files : state.files.filter((f) => state.checked.has(f.path)))
  } else if (ctrl && e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    commit(true)
  }
})

// ---------------------------------------------------------------------------
// Start

let reloadTimer
// ---------------------------------------------------------------------------
// Progress popup for background tasks: one card per running git operation, at the
// bottom, with the current git step and a bar (a percentage when git gives one, moving otherwise).

const ops = new Map() // id -> { title, text, percent, state, shown, timer, el }
const SHOW_AFTER_MS = 250 // instant operations do not flash a popup

function renderOp(op) {
  if (!op.el) {
    op.el = document.createElement('div')
    op.el.className = 'progress-card'
    $('progress').appendChild(op.el)
  }
  const pct = op.state === 'done' ? 100 : op.percent
  const icon = op.state === 'done' ? '✓' : op.state === 'error' ? '✕' : ''
  op.el.className = `progress-card ${op.state}`
  op.el.innerHTML = `<div class="progress-head"><span class="progress-title">${icon ? `<b>${icon}</b> ` : ''}${esc(op.title)}${op.state === 'start' || op.state === 'progress' ? '…' : ''}</span>${pct !== undefined && op.state !== 'error' ? `<span class="progress-pct">${pct}%</span>` : ''}</div>
    <div class="progress-text" title="${esc(op.text ?? '')}">${esc(op.text ?? (op.state === 'done' ? 'Done' : 'Starting'))}</div>
    <div class="progress-bar ${pct === undefined && op.state !== 'error' ? 'indeterminate' : ''}"><i style="width:${pct ?? 100}%"></i></div>`
}

function removeOp(id) {
  const op = ops.get(id)
  if (!op) return
  op.el?.classList.add('leaving')
  setTimeout(() => op.el?.remove(), 200)
  ops.delete(id)
}

orca?.plugin?.on?.('git.progress', (e) => {
  if (!e || typeof e.id !== 'number') return
  let op = ops.get(e.id)
  if (!op) {
    if (e.state !== 'start') return
    op = { title: e.title, state: 'start', shown: false }
    ops.set(e.id, op)
    op.timer = setTimeout(() => {
      op.shown = true
      renderOp(op)
    }, SHOW_AFTER_MS)
    return
  }
  op.state = e.state
  if (e.text) op.text = e.text
  if (e.state === 'progress') op.percent = e.percent ?? (e.text && /^git /.test(e.text) ? undefined : op.percent)
  if (e.state === 'done' || e.state === 'error') {
    clearTimeout(op.timer)
    if (!op.shown) return void ops.delete(e.id) // finished before the popup was due
    renderOp(op)
    setTimeout(() => removeOp(e.id), e.state === 'error' ? 5000 : 1500)
    return
  }
  if (op.shown) renderOp(op)
})

// ---------------------------------------------------------------------------
// Loading screen while the panel moves to another project

const SWITCH_SHOW_AFTER_MS = 80 // a switch that is over by then does not flash
const SWITCH_MIN_SHOWN_MS = 350 // once shown, long enough to be read
const SWITCH_GIVE_UP_MS = 30_000
const switchUi = { active: false, byWorker: false, shownAt: 0, showTimer: 0, hideTimer: 0, giveUp: 0 }

/** `byWorker`: the worker announced the switch, and its next "git.changed" ends it; otherwise the
 *  reload that found the new repository ends it once the Log is in. */
function beginSwitch(name, byWorker = false) {
  switchUi.byWorker = byWorker
  const el = $('switching')
  $('switching-title').textContent = name ? `Loading ${name}…` : 'Loading repository…'
  clearTimeout(switchUi.hideTimer)
  clearTimeout(switchUi.giveUp)
  switchUi.giveUp = setTimeout(endSwitch, SWITCH_GIVE_UP_MS)
  if (switchUi.active) return
  switchUi.active = true
  hideMenu()
  $('branch-popup').hidden = true
  switchUi.showTimer = setTimeout(() => {
    switchUi.shownAt = Date.now()
    el.hidden = false
    requestAnimationFrame(() => el.classList.add('shown'))
  }, SWITCH_SHOW_AFTER_MS)
}

function endSwitch() {
  if (!switchUi.active) return
  switchUi.active = false
  switchUi.byWorker = false
  clearTimeout(switchUi.showTimer)
  clearTimeout(switchUi.giveUp)
  const el = $('switching')
  if (el.hidden) return
  const wait = Math.max(0, SWITCH_MIN_SHOWN_MS - (Date.now() - switchUi.shownAt))
  switchUi.hideTimer = setTimeout(() => {
    el.classList.remove('shown')
    switchUi.hideTimer = setTimeout(() => (el.hidden = true), 150)
  }, wait)
}

let refsChanged = false
orca?.plugin?.on?.('git.changed', (e) => {
  // Commits, checkouts, new branches and fetches change refs: the Log reloads only then.
  if (e?.refs !== false) refsChanged = true
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(async () => {
    await reload()
    if (refsChanged) {
      refsChanged = false
      // A repository switch already started the Log in reload(): wait for that one.
      await (logLoading ?? loadLogPane())
      if (state.tab === 'shelf') await loadShelf()
    }
    endSwitch()
  }, e?.reason === 'workspace' ? 0 : 150)
})

// The focused workspace is changing: cover the old project at once, since finding and reading
// the new one can take a moment and the panel would otherwise look as if nothing happened.
orca?.plugin?.on?.('git.switching', (e) => beginSwitch(e?.name ?? '', true))

window.addEventListener('focus', () => reload())
beginSwitch('')
reload()
