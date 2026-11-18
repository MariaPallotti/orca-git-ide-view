// Worker: finds the focused workspace's repository, runs git for the panel and tells the panel
// when the repository changes (a terminal, an agent or the editor touched it).
import { execFile } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import * as g from './git.ts'
import type { BranchOp, RepoInfo, Result } from './protocol.ts'

type Context = { branch: string; displayName: string; terminals?: { id: string }[] } | null
type Choice = { id: string; path: string; name: string }
type Focus = {
  repo: RepoInfo | null
  workspaceId: string | null
  reason?: string
  /** Set when several workspaces match the focused one and none of its terminals told them apart. */
  choices?: Choice[]
  choiceKey?: string
  /** "name\0branch" of the Orca context this was resolved from. */
  contextKey?: string
  /** Handles of that context's terminals. */
  terminals?: string[]
}

/**
 * Whether Orca's context now names another workspace than `f`. The name and branch are not
 * enough: Orca names workspaces after their branch, so several repositories on "develop" share
 * both. Their terminals tell them apart: opening or closing one keeps the others, while another
 * workspace has none of them.
 */
function isOtherWorkspace(f: Focus, ctx: Context): boolean {
  if (contextKey(ctx) !== f.contextKey) return true
  const before = f.terminals ?? []
  const now = (ctx?.terminals ?? []).map((t) => t.id)
  return before.length > 0 && now.length > 0 && !now.some((id) => before.includes(id))
}

const contextKey = (ctx: Context) => (ctx ? `${ctx.displayName}\0${stripRef(ctx.branch)}` : '')

const stripRef = (b: string | null | undefined) => (b ?? '').replace(/^refs\/heads\//, '')
const samePath = (p: string) => {
  const r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** Orca's own CLI, next to the app the worker runs in (Orca.exe / Orca.app / orca). */
function orcaCli(): string | null {
  const dir = path.dirname(process.execPath)
  const candidates =
    process.platform === 'win32'
      ? [path.join(dir, 'resources', 'bin', 'orca.exe')]
      : process.platform === 'darwin'
        ? [path.join(dir, '..', 'Resources', 'bin', 'orca')]
        : [path.join(dir, 'resources', 'bin', 'orca')]
  return candidates.find((c) => existsSync(c)) ?? null
}

/** The worker runs with a trimmed environment; the CLI finds the running Orca through the
 *  per-user folders, so they are put back from the home folder when missing. */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const home = os.homedir()
  if (process.platform === 'win32') {
    env.USERPROFILE ??= home
    env.APPDATA ??= path.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA ??= path.join(home, 'AppData', 'Local')
  } else env.HOME ??= home
  return env
}

/** Runs Orca's CLI and returns its JSON answer; throws with its message when it fails. */
function runCli(args: string[]): Promise<unknown> {
  const cli = orcaCli()
  if (!cli) return Promise.reject(new Error("Orca's command line tool was not found next to the app."))
  return new Promise((resolve, reject) =>
    execFile(cli, args, { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: cliEnv() }, (err, stdout, stderr) => {
      let parsed: { ok?: boolean; error?: { message?: string } | string } | null = null
      try {
        parsed = JSON.parse(stdout)
      } catch {}
      if (err || !parsed || parsed.ok === false) {
        const e = parsed?.error
        reject(new Error((typeof e === 'string' ? e : e?.message) || stderr.trim() || stdout.trim() || (err as Error)?.message || 'orca failed'))
      } else resolve(parsed)
    })
  )
}

/** The folders of the given terminals (by their `term_…` handles), from `orca terminal list --json`. */
async function terminalFolders(terminals: { id: string }[]): Promise<Set<string>> {
  const out = new Set<string>()
  const cli = terminals.length ? orcaCli() : null
  if (!cli) return out
  const ids = terminals.map((t) => t.id)
  // The CLI takes one to three seconds to answer, and lists every terminal of every workspace:
  // one call tells the folders of all of them, and a terminal keeps its folder.
  if (ids.some((id) => !terminalPaths.has(id))) {
    const json = await new Promise<string>((resolve) =>
      execFile(cli, ['terminal', 'list', '--json'], { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: cliEnv() }, (err, stdout) => resolve(err ? '' : stdout))
    )
    try {
      const list = (JSON.parse(json) as { result?: { terminals?: { handle?: string; worktreePath?: string }[] } }).result?.terminals ?? []
      for (const t of list) if (t.handle && t.worktreePath) terminalPaths.set(t.handle, samePath(t.worktreePath))
      // Handles the CLI does not know (another host's terminals) are not asked about again.
      for (const id of ids) if (!terminalPaths.has(id)) terminalPaths.set(id, '')
    } catch {}
  }
  for (const id of ids) {
    const p = terminalPaths.get(id)
    if (p) out.add(p)
  }
  return out
}
/** Terminal handle → its folder ('' when the CLI does not know it). */
const terminalPaths = new Map<string, string>()

let watchers: FSWatcher[] = []
let timer: ReturnType<typeof setTimeout> | undefined

export default function activate(orca: OrcaWorkerApi): void {
  let focus: Focus | null = null
  let watchedRoot: string | null = null
  let lastFiles = ''
  let lastRefs = ''

  const log = (m: string) => {
    try {
      orca.log(m)
    } catch {}
  }

  // Workspaces the person picked by hand when Orca's context could not tell them apart,
  // keyed by "name\0branch".
  const picked = new Map<string, string>()

  async function resolve(context?: Context): Promise<Focus> {
    let ctx: Context
    try {
      ctx = context === undefined ? await orca.host.call('workspace.readContext', {}) : context
    } catch (e) {
      log(`resolve failed: ${(e as Error).message}`)
      return { repo: null, workspaceId: null, reason: (e as Error).message }
    }
    const f = await resolveFrom(ctx)
    return { ...f, contextKey: contextKey(ctx), terminals: (ctx?.terminals ?? []).map((t) => t.id) }
  }

  async function resolveFrom(ctx: Context): Promise<Focus> {
    try {
      if (!ctx) return { repo: null, workspaceId: null, reason: 'No workspace is focused in Orca.' }
      if (!orca.host.has('workspace.list')) return { repo: null, workspaceId: null, reason: 'This Orca is too old: update to 1.4.248 or newer.' }
      const { workspaces } = await orca.host.call('workspace.list', {})
      const local = workspaces.filter((w) => w.hostId === null || w.hostId === undefined || w.hostId === 'local')
      const byName = local.filter((w) => w.name === ctx.displayName)
      const sameBranch = byName.filter((w) => stripRef(w.branch) === stripRef(ctx.branch))
      let candidates = sameBranch.length ? sameBranch : byName
      if (!candidates.length) candidates = local.filter((w) => w.branch && stripRef(w.branch) === stripRef(ctx.branch))
      if (!candidates.length) return { repo: null, workspaceId: null, reason: `Could not find the folder of workspace "${ctx.displayName}".` }

      // Orca names workspaces after their branch, so several repositories on "develop" share a
      // name. The context only names the focused workspace's terminals; Orca's CLI knows their folders.
      let match = candidates.length === 1 ? candidates[0] : undefined
      let choices: Choice[] | undefined
      if (!match) {
        const termPaths = await terminalFolders(ctx.terminals ?? [])
        match = candidates.find((w) => termPaths.has(samePath(w.path)))
        const key = `${ctx.displayName}\0${stripRef(ctx.branch)}`
        if (!match) match = candidates.find((w) => w.id === picked.get(key))
        if (!match && focus?.workspaceId) match = candidates.find((w) => w.id === focus?.workspaceId)
        if (!match) {
          match = candidates[0]
          choices = candidates.map((w) => ({ id: w.id, path: w.path, name: path.basename(w.path) }))
        }
      }
      const root = await g.toplevel(match.path)
      if (!root) return { repo: null, workspaceId: match.id, reason: `"${ctx.displayName}" is not a Git repository.` }
      return {
        // The branch comes with the first snapshot (git.state), not from a command of its own.
        repo: { root, name: path.basename(root), branch: null },
        workspaceId: match.id,
        ...(choices ? { choices, choiceKey: `${ctx.displayName}\0${stripRef(ctx.branch)}` } : {})
      }
    } catch (e) {
      log(`resolve failed: ${(e as Error).message}`)
      return { repo: null, workspaceId: null, reason: (e as Error).message }
    }
  }

  async function ensureFocus(): Promise<Focus> {
    if (!focus) {
      focus = await resolve()
      prefetch()
      await rewatch()
    }
    return focus
  }

  // ---- prefetch ----------------------------------------------------------
  // As soon as the repository is known, everything the panel asks for on a (re)load starts at
  // once and side by side, instead of one request after the other once the panel hears about it.

  const PREFETCH_TTL_MS = 5000
  type Prefetched = {
    root: string
    at: number
    snapshot?: Promise<g.Snapshot>
    operation?: Promise<Awaited<ReturnType<typeof g.operation>>>
    branches?: Promise<Awaited<ReturnType<typeof g.branches>>>
    /** The Log of HEAD, 400 commits: what the panel shows first in a repository. */
    log?: Promise<Awaited<ReturnType<typeof g.log>>>
  }
  let prefetched: Prefetched | null = null

  function prefetch(): void {
    const root = focus?.repo?.root
    if (!root) {
      prefetched = null
      return
    }
    const quiet = <T>(p: Promise<T>) => (p.catch(() => {}), p)
    const entry: Prefetched = {
      root,
      at: Date.now(),
      snapshot: quiet(g.snapshot(root)),
      operation: quiet(g.operation(root)),
      branches: quiet(g.branches(root)),
      log: quiet(g.log(root, 400, true, 'HEAD'))
    }
    prefetched = entry
    // The watcher compares against this snapshot, so it does not report the switch a second time.
    entry.snapshot!.then(
      (s) => {
        if (watchedRoot === root && !lastFiles) {
          lastFiles = s.fingerprint.files
          lastRefs = s.fingerprint.refs
        }
      },
      () => {}
    )
  }

  /** The prefetched answer for `root`, once; undefined when there is none or it is too old. */
  function take<K extends 'snapshot' | 'operation' | 'branches' | 'log'>(key: K, root: string): Prefetched[K] | undefined {
    const p = prefetched
    if (!p || p.root !== root || Date.now() - p.at > PREFETCH_TTL_MS) return undefined
    const v = p[key]
    delete p[key]
    return v
  }

  function requireRoot(f: Focus): string {
    if (!f.repo) throw new Error(f.reason ?? 'No Git repository.')
    return f.repo.root
  }

  // ---- change detection --------------------------------------------------

  async function rewatch(): Promise<void> {
    const root = focus?.repo?.root ?? null
    if (root === watchedRoot) return
    for (const w of watchers) w.close()
    watchers = []
    watchedRoot = root
    lastFiles = ''
    lastRefs = ''
    if (!root) return
    const dirs = new Set([root])
    try {
      const gd = await g.gitDir(root)
      if (!gd.startsWith(root + path.sep)) dirs.add(gd) // worktrees keep their git dir elsewhere
    } catch {}
    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: true }, (_type, file) => {
          const f = String(file ?? '').replace(/\\/g, '/')
          if (/(^|\/)\.git\/(objects|logs)\/|(^|\/)(objects|logs)\/|index\.lock$/.test(f)) return
          clearTimeout(timer)
          timer = setTimeout(() => void checkChanged('fs'), 400)
        })
        w.on('error', (e) => log(`watch error: ${e.message}`))
        watchers.push(w)
      } catch (e) {
        log(`watch ${dir} failed: ${(e as Error).message}`)
      }
    }
  }

  async function checkChanged(reason: string): Promise<void> {
    const root = focus?.repo?.root
    if (!root) return
    try {
      const snap = await g.snapshot(root)
      const fp = snap.fingerprint
      const refs = fp.refs !== lastRefs
      if (!refs && fp.files === lastFiles) return
      lastFiles = fp.files
      lastRefs = fp.refs
      prefetched = null // the repository moved on: answers read before are out of date
      if (focus?.repo?.root === root) focus.repo.branch = snap.branch
      orca.panels.post('git.changed', { reason, refs })
    } catch (e) {
      log(`fingerprint failed: ${(e as Error).message}`)
    }
  }

  // The focused workspace, as Orca's context names it, so a switch is told to the panel at once:
  // finding the new repository (workspace list, terminal folders) can take a moment, and until
  // then the panel would go on showing the previous project.
  let switchSeq = 0
  orca.events.on('workspace.changed', async ({ context }) => {
    const before = focus?.repo?.root
    const switching = !!focus && isOtherWorkspace(focus, context)
    const seq = ++switchSeq
    if (switching) orca.panels.post('git.switching', { name: context?.displayName ?? '' })
    const next = await resolve(context)
    if (seq !== switchSeq) return // a newer switch is already on its way
    focus = next
    const moved = focus.repo?.root !== before
    if (moved) prefetch()
    // After a "switching" the panel waits for this, even when the repository turned out the same.
    // It goes before the watcher is set up: the panel's requests are already being answered.
    if (switching || moved) orca.panels.post('git.changed', { reason: 'workspace', refs: true })
    await rewatch()
  })

  orca.commands.register('git.refresh', async () => {
    focus = null
    await ensureFocus()
    orca.panels.post('git.changed', { reason: 'refresh', refs: true })
    return 'Git changes refreshed'
  })

  // ---- progress popup ----------------------------------------------------

  let opSeq = 0
  /**
   * Runs a git operation and reports it to the panel's progress popup: its title, each git
   * command and progress line, a percentage when git gives one, and how it ended.
   */
  async function tracked<T>(title: string, fn: () => Promise<T>): Promise<T> {
    const id = ++opSeq
    const post = (p: { state: 'start' | 'progress' | 'done' | 'error'; text?: string; percent?: number }) => {
      try {
        orca.panels.post('git.progress', { id, title, ...p })
      } catch {}
    }
    post({ state: 'start' })
    let lastAt = 0
    let lastPercent = -1
    const sink = (line: string) => {
      const pct = /(\d{1,3})%/.exec(line) ?? null
      const step = /\((\d+)\/(\d+)\)/.exec(line) // "Rebasing (2/5)"
      const percent = pct ? Number(pct[1]) : step ? Math.round((Number(step[1]) / Number(step[2])) * 100) : undefined
      const now = Date.now()
      // git can print hundreds of lines a second; the popup needs a few.
      if (now - lastAt < 80 && (percent === undefined || percent === lastPercent)) return
      lastAt = now
      if (percent !== undefined) lastPercent = percent
      post({ state: 'progress', text: line.slice(0, 300), ...(percent !== undefined ? { percent } : {}) })
    }
    try {
      const r = await g.progress.run(sink, fn)
      post({ state: 'done' })
      return r
    } catch (e) {
      post({ state: 'error', text: (e as Error).message.split('\n')[0].slice(0, 300) })
      throw e
    }
  }

  const BRANCH_TITLES: Record<string, (op: BranchOp) => string> = {
    checkout: (o) => `Checking out ${'name' in o ? o.name : ''}`,
    checkoutRemote: (o) => `Checking out ${'name' in o ? o.name : ''}`,
    create: (o) => `Creating branch ${'newName' in o ? o.newName : ''}`,
    rename: (o) => `Renaming ${'name' in o ? o.name : ''}`,
    delete: (o) => `Deleting ${'name' in o ? o.name : ''}`,
    deleteRemote: (o) => `Deleting ${'name' in o ? o.name : ''} on the remote`,
    merge: (o) => `Merging ${'name' in o ? o.name : ''}`,
    rebase: (o) => `Rebasing onto ${'name' in o ? o.name : ''}`,
    push: (o) => `Pushing ${'name' in o ? o.name : ''}`,
    update: () => 'Updating (pull)',
    updateBranch: (o) => `Updating ${'name' in o ? o.name : ''}`,
    fetch: () => 'Fetching'
  }

  /** A palette command: runs git on the focused repository and reports with a notification. */
  function remoteCommand(id: string, title: string, fn: (root: string) => Promise<string>) {
    orca.commands.register(id, async () => {
      try {
        const f = await ensureFocus()
        const msg = await tracked(title.replace(/^Git: /, ''), () => fn(requireRoot(f)))
        await checkChanged(id)
        void orca.host.call('notifications.show', { title, body: msg }).catch(() => {})
        return msg
      } catch (e) {
        const msg = (e as Error).message
        void orca.host.call('notifications.show', { title: `${title} failed`, body: msg.slice(0, 1000) }).catch(() => {})
        return `${title} failed: ${msg}`
      }
    })
  }
  remoteCommand('git.push', 'Git: Push', async (root) => {
    await g.push(root)
    return 'Pushed.'
  })
  remoteCommand('git.fetch', 'Git: Fetch', async (root) => {
    await g.fetchAll(root)
    orca.panels.post('git.changed', { reason: 'fetch', refs: true })
    return 'Fetched all remotes.'
  })
  remoteCommand('git.updateProject', 'Git: Update Project', async (root) => (await g.updateProject(root)) || 'Project updated.')

  // ---- panel requests ----------------------------------------------------

  /** Runs `fn` with the repository root and wraps the answer in a Result. */
  async function wrap<T>(fn: (root: string, f: Focus) => Promise<T>): Promise<Result<T>> {
    try {
      const f = await ensureFocus()
      return { ok: true, value: await fn(requireRoot(f), f) }
    } catch (e) {
      const err = e as Error & { command?: string }
      // Orca only carries plain JSON: no key may be undefined.
      return { ok: false, error: err.message, ...(err.command ? { command: err.command } : {}) }
    }
  }

  orca.panels.handle('git.state', async () => {
    try {
      const f = await ensureFocus()
      if (!f.repo) return { ok: true, value: { repo: null, reason: f.reason, files: [] } }
      const root = f.repo.root
      const [snap, operation] = await Promise.all([take('snapshot', root) ?? g.snapshot(root), take('operation', root) ?? g.operation(root)])
      f.repo.branch = snap.branch
      lastFiles = snap.fingerprint.files
      lastRefs = snap.fingerprint.refs
      return { ok: true, value: { repo: f.repo, files: snap.files, operation, ...(f.choices ? { choices: f.choices } : {}) } }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /** The person chose which of several same-named workspaces is the focused one. */
  orca.panels.handle('git.pickWorkspace', async ({ id }) => {
    try {
      const key = focus?.choiceKey
      if (key) picked.set(key, id)
      focus = await resolve()
      prefetch()
      await rewatch()
      orca.panels.post('git.changed', { reason: 'pick', refs: true })
      return { ok: true, value: null }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /** Opens Orca's own diff of a changed file in a tab of the main area (full width, like an IDE's diff window). */
  orca.panels.handle('git.openDiffTab', ({ path: p }) =>
    wrap(async (root) => {
      const staged = await g.onlyStaged(root, p)
      await runCli(['file', 'diff', path.join(root, p), '--worktree', `path:${root}`, '--focus', '--json', ...(staged ? ['--staged'] : [])])
      return null
    })
  )

  orca.panels.handle('git.diff', ({ path: p, origPath, mode }) => wrap((root) => g.diff(root, p, origPath, mode)))

  orca.panels.handle('git.revertHunk', ({ path: p, header }) =>
    wrap(async (root) => {
      await g.revertHunk(root, p, header)
      await checkChanged('revert')
      return null
    })
  )

  orca.panels.handle('git.rollback', ({ files }) =>
    wrap(async (root) => {
      await tracked('Rolling back', () => g.rollback(root, files))
      await checkChanged('rollback')
      return null
    })
  )

  orca.panels.handle('git.commit', ({ files, message, amend, push }) =>
    wrap(async (root) => {
      const hash = await tracked(amend ? 'Amending commit' : 'Committing', () => g.commit(root, files, message, amend))
      let pushed = false
      let pushError: string | undefined
      if (push) {
        try {
          await tracked('Pushing', () => g.push(root))
          pushed = true
        } catch (e) {
          pushError = (e as Error).message
        }
      }
      await checkChanged('commit')
      const body = push ? (pushed ? 'Committed and pushed.' : `Committed, but push failed: ${pushError}`) : 'Committed.'
      void orca.host.call('notifications.show', { title: `Git: ${hash}`, body }).catch(() => {})
      return { hash, pushed, ...(pushError ? { pushError } : {}) }
    })
  )

  orca.panels.handle('git.lastMessage', () => wrap((root) => g.lastMessage(root)))
  orca.panels.handle('git.log', ({ limit, all, ref }) =>
    wrap((root) => (limit === 400 && ref === 'HEAD' ? take('log', root) : undefined) ?? g.log(root, limit, all ?? true, ref))
  )
  orca.panels.handle('git.branches', () => wrap((root) => take('branches', root) ?? g.branches(root)))
  orca.panels.handle('git.branchOp', (op) =>
    wrap(async (root) => {
      const res = await tracked((BRANCH_TITLES[op.op] ?? (() => 'Git'))(op), () => g.branchOp(root, op))
      await checkChanged(`branch:${op.op}`)
      return res
    })
  )
  orca.panels.handle('git.commitFiles', ({ rev }) => wrap((root) => g.commitFiles(root, rev)))
  orca.panels.handle('git.commitMessage', ({ rev }) => wrap((root) => g.commitMessage(root, rev)))

  /** Runs a change and tells open panels, so a second panel stays in step. */
  const mutate = <I>(name: string, fn: (root: string, input: I) => Promise<void>) =>
    orca.panels.handle(name as never, ((input: I) =>
      wrap(async (root) => {
        await fn(root, input)
        await checkChanged(name)
        return null
      })) as never)

  mutate<{ path: string; side: 'yours' | 'theirs' }>('git.resolveSide', (root, { path: p, side }) => g.resolveSide(root, p, side))
  mutate<{ path: string; force?: boolean }>('git.markResolved', (root, { path: p, force }) => g.markResolved(root, p, force))
  mutate<{ path: string; text: string }>('git.writeFile', (root, { path: p, text }) => g.writeText(root, p, text))
  mutate<undefined>('git.continueOp', (root) => tracked('Continuing', () => g.continueOp(root)))
  mutate<undefined>('git.abortOp', (root) => tracked('Aborting', () => g.abortOp(root)))
  orca.panels.handle('git.readFile', ({ path: p }) => wrap((root) => g.readText(root, p)))

  orca.panels.handle('git.shelve', ({ files, message }) =>
    wrap(async (root) => {
      await tracked('Shelving changes', () => g.shelve(root, files, message))
      await checkChanged('shelve')
      return null
    })
  )
  orca.panels.handle('git.shelf', () => wrap((root) => g.shelf(root)))
  orca.panels.handle('git.shelfFiles', ({ hash }) => wrap((root) => g.shelfFiles(root, hash)))
  orca.panels.handle('git.unshelve', ({ hash, drop }) =>
    wrap(async (root) => {
      await tracked(drop ? 'Unshelving' : 'Applying shelved changes', () => g.unshelve(root, hash, drop))
      await checkChanged('unshelve')
      return null
    })
  )
  orca.panels.handle('git.dropShelf', ({ hash }) =>
    wrap(async (root) => {
      await g.dropShelf(root, hash)
      orca.panels.post('git.changed', { reason: 'shelf', refs: true })
      return null
    })
  )

  orca.panels.handle('git.openFile', ({ path: p }) =>
    wrap(async (root, f) => {
      if (!f.workspaceId || !orca.host.has('editor.open')) throw new Error('This Orca cannot open files from a plugin.')
      await orca.host.call('editor.open', { workspaceId: f.workspaceId, path: path.join(root, p) })
      return null
    })
  )

  orca.panels.handle('git.ignore', ({ path: p }) =>
    wrap(async (root) => {
      await g.addToGitignore(root, p)
      await checkChanged('ignore')
      return null
    })
  )
}

export function deactivate(): void {
  clearTimeout(timer)
  for (const w of watchers) w.close()
  watchers = []
}
