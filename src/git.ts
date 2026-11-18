// Git layer: every function takes the working tree root. Failures throw GitError carrying git's
// own message, which the panel shows verbatim.
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BranchOp, BranchOpResult, Branches, ChangedFile, DiffMode, DiffResult, Hunk, LogEntry, Operation, ShelfEntry } from './protocol.ts'

export class GitError extends Error {
  command: string
  constructor(args: string[], message: string) {
    super(message)
    this.name = 'GitError'
    this.command = `git ${args.join(' ')}`
  }
}

type RunOptions = { input?: string; allowFail?: boolean; timeoutMs?: number; readOnly?: boolean }
type RunResult = { stdout: string; stderr: string; code: number }

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_SIDE = 2 * 1024 * 1024

/**
 * While an operation runs inside `progress.run(sink, fn)`, every git command it starts reports to
 * `sink`: first the command itself, then each progress line git writes ("Receiving objects: 45%").
 */
export const progress = new AsyncLocalStorage<(line: string) => void>()
// Network commands only print their progress when asked to (stderr is not a terminal).
const WANTS_PROGRESS = new Set(['fetch', 'pull', 'push'])

export function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const sink = opts.readOnly ? undefined : progress.getStore()
  if (sink) {
    if (WANTS_PROGRESS.has(args[0])) args = [args[0], '--progress', ...args.slice(1)]
    sink(`git ${args.join(' ')}`)
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          LC_ALL: 'C',
          // Reads must not take .git/index.lock, or a commit started at the same time fails.
          ...(opts.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {})
        }
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0
        if (error && (code === -1 || !opts.allowFail)) {
          reject(new GitError(args, (stderr || stdout || error.message).trim()))
          return
        }
        resolve({ stdout, stderr, code })
      }
    )
    if (sink) {
      // git redraws progress with \r; each piece is one step.
      let rest = ''
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const parts = (rest + chunk.toString()).split(/[\r\n]+/)
        rest = parts.pop() ?? ''
        for (const line of parts) if (line.trim()) sink(line.trim())
      })
    }
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

const read = async (cwd: string, args: string[]) => (await git(cwd, args, { readOnly: true })).stdout

// Starting git costs a few hundred milliseconds on Windows, so answers that do not change while a
// folder stays a repository are kept: switching back to a project does not ask again.
const toplevels = new Map<string, string>()
const gitDirs = new Map<string, string>()

export async function toplevel(dir: string): Promise<string | null> {
  const known = toplevels.get(dir)
  if (known && (await exists(known))) return known
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true, readOnly: true }).catch(() => null)
  if (!r || r.code !== 0) return null
  const root = path.resolve(r.stdout.trim())
  toplevels.set(dir, root)
  return root
}

export async function gitDir(root: string): Promise<string> {
  const known = gitDirs.get(root)
  if (known && (await exists(known))) return known
  const gd = path.resolve(root, (await read(root, ['rev-parse', '--absolute-git-dir'])).trim())
  gitDirs.set(root, gd)
  return gd
}

export async function currentBranch(root: string): Promise<string | null> {
  const r = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true, readOnly: true })
  if (r.code === 0) return r.stdout.trim()
  const h = await git(root, ['rev-parse', '--short', 'HEAD'], { allowFail: true, readOnly: true })
  return h.code === 0 ? `detached at ${h.stdout.trim()}` : null
}

async function hasHead(root: string): Promise<boolean> {
  return (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true, readOnly: true })).code === 0
}

// ---------------------------------------------------------------------------
// Status

/** Parses `git status --porcelain=v2 -z`. */
export function parseStatus(out: string): ChangedFile[] {
  const parts = out.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line || line[0] === '#') continue // "# branch.*" headers of --branch
    const kind = line[0]
    if (kind === '?') {
      files.push({ path: line.slice(2), status: 'untracked' })
    } else if (kind === 'u') {
      files.push({ path: line.split(' ').slice(10).join(' '), status: 'conflicted' })
    } else if (kind === '1' || kind === '2') {
      const fields = line.split(' ')
      const xy = fields[1]
      if (kind === '2') {
        const p = fields.slice(9).join(' ')
        files.push({ path: p, origPath: parts[++i], status: 'renamed' })
        continue
      }
      const p = fields.slice(8).join(' ')
      const [x, y] = xy
      if (x === 'A' && y === 'D') continue // added then deleted again: nothing to commit
      const status = x === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : 'modified'
      files.push({ path: p, status })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function status(root: string): Promise<ChangedFile[]> {
  return parseStatus(await read(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']))
}

export type Snapshot = {
  files: ChangedFile[]
  branch: string | null
  /** Tells whether the panel needs to reload: `refs` changes with commits, checkouts, new or
   *  deleted branches and fetches (the Log reloads); `files` with the working tree. */
  fingerprint: { files: string; refs: string }
}

/**
 * Changes, current branch and fingerprint from two git commands run side by side: `status
 * --branch` also names the branch and HEAD's commit, so no separate symbolic-ref / rev-parse.
 */
export async function snapshot(root: string): Promise<Snapshot> {
  const [out, refs] = await Promise.all([
    read(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
    read(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash'])
  ])
  let head = ''
  let oid = ''
  for (const part of out.split('\0')) {
    if (!part.startsWith('# branch.')) continue
    if (part.startsWith('# branch.head ')) head = part.slice(14)
    else if (part.startsWith('# branch.oid ')) oid = part.slice(13)
  }
  const born = oid !== '' && oid !== '(initial)'
  const branch = head && head !== '(detached)' ? head : born ? `detached at ${oid.slice(0, 7)}` : null
  return { files: parseStatus(out), branch, fingerprint: { files: out, refs: `${head} ${oid}\n${refs}` } }
}

export async function fingerprint(root: string): Promise<{ files: string; refs: string }> {
  return (await snapshot(root)).fingerprint
}

// ---------------------------------------------------------------------------
// Diff

/** Parses the `@@ -a,b +c,d @@` headers of a unified diff made with -U0. */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(patch))) {
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      header: m[0].replace(/\r$/, '')
    })
  }
  return hunks
}

const isBinary = (s: string) => s.slice(0, 8000).includes('\0')
const normalize = (s: string) => s.replace(/\r\n/g, '\n')
const countLines = (s: string) => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0))

async function blob(root: string, spec: string): Promise<string | null> {
  const r = await git(root, ['cat-file', '-p', spec], { allowFail: true, readOnly: true })
  return r.code === 0 ? r.stdout : null
}

async function readDisk(root: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

export async function diff(root: string, file: string, origPath: string | undefined, mode: DiffMode): Promise<DiffResult> {
  const leftPath = origPath || file
  let left: string | null
  let right: string | null
  let leftTitle: string
  let rightTitle: string
  let diffArgs: string[]
  let canRevert = false

  if (mode.kind === 'local') {
    const head = await hasHead(root)
    left = head ? await blob(root, `HEAD:${leftPath}`) : null
    right = await readDisk(root, file)
    leftTitle = 'HEAD'
    rightTitle = 'Your version'
    diffArgs = ['diff', '-U0', '--no-ext-diff', '-M', head ? 'HEAD' : EMPTY_TREE, '--', ...(origPath ? [origPath] : []), file]
    canRevert = left !== null && right !== null
  } else {
    const parentR = await git(root, ['rev-parse', '-q', '--verify', `${mode.rev}^`], { allowFail: true, readOnly: true })
    const parent = parentR.code === 0 ? parentR.stdout.trim() : EMPTY_TREE
    left = parent === EMPTY_TREE ? null : await blob(root, `${parent}:${leftPath}`)
    right = await blob(root, `${mode.rev}:${file}`)
    leftTitle = parent === EMPTY_TREE ? '(none)' : parent.slice(0, 8)
    rightTitle = mode.rev.slice(0, 8)
    diffArgs = ['diff', '-U0', '--no-ext-diff', '-M', parent, mode.rev, '--', ...(origPath ? [origPath] : []), file]
  }

  const base = { path: file, leftTitle, rightTitle, hunks: [] as Hunk[] }
  const l = left ?? ''
  const r = right ?? ''
  if (l.length > MAX_SIDE || r.length > MAX_SIDE) return { ...base, binary: false, tooLarge: true, left: '', right: '', canRevert: false }
  if (isBinary(l) || isBinary(r)) return { ...base, binary: true, tooLarge: false, left: '', right: '', canRevert: false }

  let hunks: Hunk[]
  const tracked = (await git(root, ['ls-files', '--error-unmatch', '--', file], { allowFail: true, readOnly: true })).code === 0
  if (mode.kind === 'local' && !tracked && left === null) {
    // Untracked: git diff does not see it; it is one inserted block.
    const n = countLines(normalize(r))
    hunks = n ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: n, header: `@@ -0,0 +1,${n} @@` }] : []
  } else {
    hunks = parseHunks((await git(root, diffArgs, { allowFail: true, readOnly: true })).stdout)
  }
  return { ...base, binary: false, tooLarge: false, left: normalize(l), right: normalize(r), hunks, canRevert }
}

/**
 * Reverts one change block in the working tree, with the ">>" arrow: the hunk's lines
 * on disk are replaced by the HEAD lines. Line endings of the file are kept.
 */
export async function revertHunk(root: string, file: string, header: string): Promise<void> {
  const current = await diff(root, file, undefined, { kind: 'local' })
  const hunk = current.hunks.find((h) => h.header === header)
  if (!hunk) throw new GitError(['diff'], 'The file changed since the diff was shown. Reload the diff and try again.')
  if (!current.canRevert) throw new GitError(['diff'], 'Only changes in files that exist in HEAD and on disk can be reverted block by block.')
  const raw = (await readDisk(root, file)) ?? ''
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const split = (s: string) => {
    const lines = s.split('\n')
    if (s.endsWith('\n')) lines.pop()
    return lines
  }
  const leftLines = split(current.left)
  const rightLines = split(current.right)
  const oldBlock = leftLines.slice(hunk.oldLines ? hunk.oldStart - 1 : 0, hunk.oldLines ? hunk.oldStart - 1 + hunk.oldLines : 0)
  // With newLines 0, newStart is the line *after which* lines were deleted.
  const at = hunk.newLines ? hunk.newStart - 1 : hunk.newStart
  rightLines.splice(at, hunk.newLines, ...oldBlock)
  const rightLen = split(current.right).length
  const lastTouched = hunk.newLines ? hunk.newStart + hunk.newLines - 1 : hunk.newStart
  // When the block reaches the end of the file, the final newline comes from HEAD too.
  const endsWithNewline = lastTouched >= rightLen ? current.left.endsWith('\n') : current.right.endsWith('\n')
  const text = rightLines.join(eol) + (rightLines.length && endsWithNewline ? eol : '')
  await fs.writeFile(path.join(root, file), text, 'utf8')
}

// ---------------------------------------------------------------------------
// Rollback, commit, push

export async function rollback(root: string, files: ChangedFile[]): Promise<void> {
  const head = await hasHead(root)
  const remove = async (rel: string) => fs.rm(path.join(root, rel), { force: true })
  for (const f of files) {
    switch (f.status) {
      case 'untracked':
        await remove(f.path)
        break
      case 'added':
        await git(root, ['rm', '--cached', '-f', '-q', '--ignore-unmatch', '--', f.path])
        await remove(f.path)
        break
      case 'renamed':
        await git(root, ['rm', '--cached', '-f', '-q', '--ignore-unmatch', '--', f.path])
        await remove(f.path)
        if (f.origPath && head) await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.origPath])
        break
      case 'conflicted':
        throw new GitError(['restore'], `${f.path} has a merge conflict; resolve it first.`)
      default:
        if (!head) throw new GitError(['restore'], 'The repository has no commits yet.')
        await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.path])
    }
  }
}

export async function commit(
  root: string,
  files: ChangedFile[],
  message: string,
  amend: boolean
): Promise<string> {
  if (!message.trim()) throw new GitError(['commit'], 'Enter a commit message.')
  if (!files.length && !amend) throw new GitError(['commit'], 'Select at least one file to commit.')
  if (files.some((f) => f.status === 'conflicted')) throw new GitError(['commit'], 'Resolve the merge conflicts before committing.')
  const op = await operation(root)
  if (op && op.kind !== 'merge') throw new GitError(['commit'], `${op.title}: use Continue in the banner instead of Commit.`)
  const paths = [...new Set(files.flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path])))]
  if (paths.length) await git(root, ['add', '-A', '--', ...paths])
  if (op?.kind === 'merge') {
    // Git refuses a partial commit while merging: the merge commit takes everything staged.
    if (amend) throw new GitError(['commit'], 'You cannot amend while a merge is in progress.')
    await git(root, ['commit', '-F', '-'], { input: message })
    return (await read(root, ['rev-parse', '--short', 'HEAD'])).trim()
  }
  // --only commits exactly the selected paths, whatever else is staged (the IDE semantics).
  const args = ['commit', '-F', '-', '--only', ...(amend ? ['--amend'] : []), '--', ...paths]
  await git(root, args, { input: message })
  return (await read(root, ['rev-parse', '--short', 'HEAD'])).trim()
}

export async function push(root: string): Promise<void> {
  const r = await git(root, ['push'], { allowFail: true, timeoutMs: 180_000 })
  if (r.code === 0) return
  if (/no upstream|has no upstream branch/i.test(r.stderr)) {
    await git(root, ['push', '-u', 'origin', 'HEAD'], { timeoutMs: 180_000 })
    return
  }
  throw new GitError(['push'], (r.stderr || r.stdout).trim())
}

export async function lastMessage(root: string): Promise<string> {
  if (!(await hasHead(root))) return ''
  return (await read(root, ['log', '-1', '--format=%B'])).replace(/\s+$/, '')
}

// ---------------------------------------------------------------------------
// Log

/** History of every branch (`all`), of HEAD, or of one ref (`refs/heads/x`, `refs/remotes/origin/x`). */
export async function log(root: string, limit = 200, all = true, ref?: string): Promise<LogEntry[]> {
  if (ref && !/^(HEAD|refs\/(heads|remotes|tags)\/\S+)$/.test(ref)) throw new GitError(['log', ref], `Not a branch: ${ref}`)
  const scope = ref ? [ref] : all ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD']
  const args = ['log', '--topo-order', `-n${limit}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%D%x1f%P%x1e', ...scope, '--']
  // Run straight away; only a failure asks whether there is a commit at all (a new repository).
  const r = await git(root, args, { allowFail: true, readOnly: true })
  if (r.code !== 0) {
    if (!(await hasHead(root))) return []
    throw new GitError(args, (r.stderr || r.stdout).trim())
  }
  return r.stdout
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [hash, short, subject, author, at, refs, parents] = s.split('\x1f')
      return { hash, short, subject, author, date: Number(at) * 1000, refs, parents: parents ? parents.split(' ') : [] }
    })
}

export async function commitMessage(root: string, rev: string): Promise<string> {
  return (await read(root, ['show', '-s', '--format=%B', rev])).replace(/\s+$/, '')
}

// ---------------------------------------------------------------------------
// Shelf (shelved changes, kept as git stashes so the terminal sees them too)

export async function shelve(root: string, files: ChangedFile[], message: string): Promise<void> {
  if (!files.length) throw new GitError(['stash'], 'Select the files to shelve.')
  const paths = [...new Set(files.flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path])))]
  // Untracked files are only stashed once git knows the paths, hence --include-untracked.
  await git(root, ['stash', 'push', '--include-untracked', '-m', message.trim() || 'Shelved changes', '--', ...paths])
}

export async function shelf(root: string): Promise<ShelfEntry[]> {
  const out = await read(root, ['stash', 'list', '--format=%H%x1f%gd%x1f%gs%x1f%at'])
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, ref, message, at] = l.split('\x1f')
      return { hash, ref, message: message.replace(/^On [^:]+: /, ''), date: Number(at) * 1000 }
    })
}

/** stash@{n} for a stash commit, looked up now because the indexes shift. */
async function stashRef(root: string, hash: string): Promise<string> {
  const entry = (await shelf(root)).find((s) => s.hash === hash)
  if (!entry) throw new GitError(['stash'], 'That shelf entry no longer exists.')
  return entry.ref
}

export async function shelfFiles(root: string, hash: string): Promise<(ChangedFile & { rev: string })[]> {
  const tracked = (await commitFiles(root, hash)).map((f) => ({ ...f, rev: hash }))
  const u = await git(root, ['rev-parse', '-q', '--verify', `${hash}^3`], { allowFail: true, readOnly: true })
  if (u.code !== 0) return tracked
  const untrackedRev = u.stdout.trim()
  const untracked = (await commitFiles(root, untrackedRev)).map((f) => ({ ...f, status: 'added' as const, rev: untrackedRev }))
  return [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path))
}

export async function unshelve(root: string, hash: string, drop: boolean): Promise<void> {
  const ref = await stashRef(root, hash)
  await git(root, ['stash', drop ? 'pop' : 'apply', ref])
}

export async function dropShelf(root: string, hash: string): Promise<void> {
  await git(root, ['stash', 'drop', await stashRef(root, hash)])
}

// ---------------------------------------------------------------------------
// Remote operations for the command palette

export async function fetchAll(root: string): Promise<void> {
  await git(root, ['fetch', '--all', '--prune'], { timeoutMs: 180_000 })
}

/** "Update Project": pull with rebase, keeping local changes. */
export async function updateProject(root: string): Promise<string> {
  const r = await git(root, ['pull', '--rebase', '--autostash'], { timeoutMs: 180_000 })
  return (r.stdout || r.stderr).trim().split('\n').pop() ?? ''
}

export async function commitFiles(root: string, rev: string): Promise<ChangedFile[]> {
  // Against the first parent, so merges (and stashes, which are merges) list their changes too.
  const parentR = await git(root, ['rev-parse', '-q', '--verify', `${rev}^`], { allowFail: true, readOnly: true })
  const parent = parentR.code === 0 ? parentR.stdout.trim() : EMPTY_TREE
  const out = await read(root, ['diff', '--name-status', '-M', '-z', '--no-ext-diff', parent, rev, '--'])
  const parts = out.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    if (code[0] === 'R' || code[0] === 'C') {
      const origPath = parts[++i]
      files.push({ path: parts[++i], origPath, status: 'renamed' })
    } else {
      const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
      files.push({ path: parts[++i], status })
    }
  }
  return files
}

export async function addToGitignore(root: string, rel: string): Promise<void> {
  const file = path.join(root, '.gitignore')
  const existing = (await fs.readFile(file, 'utf8').catch(() => '')) as string
  const sep = existing && !existing.endsWith('\n') ? '\n' : ''
  await fs.writeFile(file, `${existing}${sep}/${rel}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Merge, rebase, cherry-pick and revert in progress; conflicts

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  )
const firstLine = async (p: string) => ((await fs.readFile(p, 'utf8').catch(() => '')) as string).split('\n')[0].trim()

export async function operation(root: string): Promise<Operation | null> {
  const gd = await gitDir(root)
  if (await exists(path.join(gd, 'MERGE_HEAD'))) {
    const msg = await firstLine(path.join(gd, 'MERGE_MSG'))
    return { kind: 'merge', title: msg.replace(/^Merge /, 'Merging ') || 'Merging' }
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    if (await exists(path.join(gd, dir))) {
      const head = (await firstLine(path.join(gd, dir, 'head-name'))).replace(/^refs\/heads\//, '')
      const onto = (await firstLine(path.join(gd, dir, 'onto'))).slice(0, 8)
      return { kind: 'rebase', title: `Rebasing ${head || 'HEAD'}${onto ? ` onto ${onto}` : ''}` }
    }
  }
  if (await exists(path.join(gd, 'CHERRY_PICK_HEAD'))) {
    return { kind: 'cherry-pick', title: `Cherry-picking ${(await firstLine(path.join(gd, 'CHERRY_PICK_HEAD'))).slice(0, 8)}` }
  }
  if (await exists(path.join(gd, 'REVERT_HEAD'))) {
    return { kind: 'revert', title: `Reverting ${(await firstLine(path.join(gd, 'REVERT_HEAD'))).slice(0, 8)}` }
  }
  return null
}

/**
 * Accept Yours / Accept Theirs for a whole file. In a rebase git's "ours" is the upstream being
 * rebased onto, so "yours" (the commit being replayed) is git's "theirs", as IDEs show it.
 */
export async function resolveSide(root: string, file: string, side: 'yours' | 'theirs'): Promise<void> {
  const op = await operation(root)
  const gitSide = (side === 'yours') === (op?.kind !== 'rebase') ? 'ours' : 'theirs'
  const stages = (await read(root, ['ls-files', '-u', '--', file]))
    .split('\n')
    .filter(Boolean)
    .map((l) => Number(l.split(/\s+/)[2]))
  if (!stages.length) throw new GitError(['checkout'], `${file} has no conflict.`)
  const wanted = gitSide === 'ours' ? 2 : 3
  if (!stages.includes(wanted)) {
    // That side deleted the file: accepting it means deleting it.
    await git(root, ['rm', '-q', '-f', '--', file])
    return
  }
  await git(root, ['checkout', `--${gitSide}`, '--', file])
  await git(root, ['add', '--', file])
}

export const CONFLICT_MARKER = /^(<{7}|>{7})( |\r?$)/m

export async function markResolved(root: string, file: string, force = false): Promise<void> {
  const text = await readDisk(root, file)
  if (text !== null && !force && CONFLICT_MARKER.test(text)) {
    const e = new GitError(['add'], `${file} still contains conflict markers.`) as GitError & { code: string }
    e.code = 'conflict'
    throw e
  }
  await git(root, ['add', '-A', '--', file])
}

export async function readText(root: string, file: string): Promise<string> {
  const t = await readDisk(root, file)
  if (t === null) throw new GitError(['show'], `${file} does not exist in the working tree.`)
  return t
}

export async function writeText(root: string, file: string, text: string): Promise<void> {
  const full = path.resolve(root, file)
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new GitError(['write'], 'Path outside the repository.')
  await fs.writeFile(full, text, 'utf8')
}

const OP_COMMAND: Record<Operation['kind'], string> = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }

export async function continueOp(root: string): Promise<void> {
  const op = await operation(root)
  if (!op) throw new GitError(['status'], 'No merge, rebase, cherry-pick or revert is in progress.')
  const unmerged = (await status(root)).filter((f) => f.status === 'conflicted')
  if (unmerged.length) throw new GitError([OP_COMMAND[op.kind], '--continue'], `Resolve the conflicts first: ${unmerged.map((f) => f.path).join(', ')}`)
  // GIT_EDITOR=true (set in git()) keeps git's prepared message.
  await git(root, [OP_COMMAND[op.kind], '--continue'], { timeoutMs: 180_000 })
}

export async function abortOp(root: string): Promise<void> {
  const op = await operation(root)
  if (!op) throw new GitError(['status'], 'No merge, rebase, cherry-pick or revert is in progress.')
  await git(root, [OP_COMMAND[op.kind], '--abort'])
}

// ---------------------------------------------------------------------------
// Branches (the Log's branches pane)

export async function branches(root: string): Promise<Branches> {
  const out = await read(root, [
    'for-each-ref',
    '--format=%(refname)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(symref)',
    'refs/heads',
    'refs/remotes'
  ])
  const res: Branches = { current: null, local: [], remote: [] }
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, hash, upstream, track, head, symref] = line.split('\x1f')
    if (symref) continue // refs/remotes/origin/HEAD
    if (ref.startsWith('refs/heads/')) {
      res.local.push({
        name: ref.slice(11),
        ref,
        hash,
        current: head === '*',
        ...(upstream ? { upstream } : {}),
        ...(track === 'gone' ? { gone: true } : {}),
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
      })
    } else {
      const name = ref.slice(13)
      res.remote.push({ name, ref, hash, remote: name.split('/')[0] })
    }
  }
  // %(HEAD) marks the checked-out branch; only a detached or unborn HEAD needs another command.
  res.current = res.local.find((b) => b.current)?.name ?? (await currentBranch(root))
  return res
}

async function checkName(root: string, name: string): Promise<void> {
  const r = await git(root, ['check-ref-format', '--branch', name], { allowFail: true, readOnly: true })
  if (r.code !== 0 || name.startsWith('-')) throw new GitError(['check-ref-format', '--branch', name], `"${name}" is not a valid branch name.`)
}

/** A merge or rebase that stops on conflicts is not an error: the operation bar takes over. */
async function mayConflict(root: string, args: string[]): Promise<BranchOpResult> {
  const r = await git(root, args, { allowFail: true, timeoutMs: 180_000 })
  if (r.code === 0) return { message: (r.stdout || r.stderr).trim().split('\n').pop() ?? '' }
  if (await operation(root)) return { message: 'Stopped on conflicts: resolve them, then Continue.', conflicts: true }
  throw new GitError(args, (r.stderr || r.stdout).trim())
}

async function remoteOf(root: string, branch: string): Promise<string> {
  const r = await git(root, ['config', '--get', `branch.${branch}.remote`], { allowFail: true, readOnly: true })
  return r.stdout.trim() || 'origin'
}

function assertRef(s: string): void {
  if (!s || s.startsWith('-') || /\s/.test(s)) throw new GitError([], `Not a branch: ${s}`)
}

export async function branchOp(root: string, op: BranchOp): Promise<BranchOpResult> {
  switch (op.op) {
    case 'checkout':
      assertRef(op.name)
      await git(root, ['checkout', op.name, '--'])
      return { message: `Checked out ${op.name}` }
    case 'checkoutRemote': {
      // origin/feature/x -> the local feature/x, created to track it when missing.
      assertRef(op.name)
      const local = op.name.slice(op.name.indexOf('/') + 1)
      const exists = (await git(root, ['show-ref', '--verify', '-q', `refs/heads/${local}`], { allowFail: true, readOnly: true })).code === 0
      await git(root, exists ? ['checkout', local, '--'] : ['checkout', '--track', op.name, '--'])
      return { message: `Checked out ${local}` }
    }
    case 'create': {
      await checkName(root, op.newName)
      const from = op.from || 'HEAD'
      assertRef(from)
      await git(root, op.checkout ? ['checkout', '-b', op.newName, from, '--'] : ['branch', op.newName, from])
      return { message: op.checkout ? `Created and checked out ${op.newName}` : `Created ${op.newName}` }
    }
    case 'rename':
      assertRef(op.name)
      await checkName(root, op.newName)
      await git(root, ['branch', '-m', op.name, op.newName])
      return { message: `Renamed ${op.name} to ${op.newName}` }
    case 'delete': {
      assertRef(op.name)
      const r = await git(root, ['branch', op.force ? '-D' : '-d', op.name], { allowFail: true })
      if (r.code === 0) return { message: `Deleted ${op.name}` }
      if (/not fully merged/.test(r.stderr)) return { message: r.stderr.trim(), notMerged: true }
      throw new GitError(['branch', '-d', op.name], (r.stderr || r.stdout).trim())
    }
    case 'deleteRemote': {
      assertRef(op.name)
      const i = op.name.indexOf('/')
      await git(root, ['push', op.name.slice(0, i), '--delete', op.name.slice(i + 1)], { timeoutMs: 180_000 })
      return { message: `Deleted ${op.name}` }
    }
    case 'merge':
      assertRef(op.name)
      return mayConflict(root, ['merge', '--no-edit', op.name])
    case 'rebase':
      assertRef(op.name)
      return mayConflict(root, ['rebase', op.name])
    case 'push': {
      assertRef(op.name)
      const remote = await remoteOf(root, op.name)
      await git(root, ['push', '-u', remote, `refs/heads/${op.name}:refs/heads/${op.name}`], { timeoutMs: 180_000 })
      return { message: `Pushed ${op.name} to ${remote}` }
    }
    case 'update':
      return { message: (await updateProject(root)) || 'Updated' }
    case 'updateBranch': {
      assertRef(op.name)
      if (op.remote) {
        // origin/feature/x: fetch just that branch.
        const i = op.name.indexOf('/')
        await git(root, ['fetch', op.name.slice(0, i), op.name.slice(i + 1)], { timeoutMs: 180_000 })
        return { message: `Fetched ${op.name}` }
      }
      if ((await currentBranch(root)) === op.name) return { message: (await updateProject(root)) || 'Updated' }
      // Another local branch: fast-forward it to its upstream without checking it out.
      const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${op.name}@{upstream}`], { allowFail: true, readOnly: true })
      const upstream = up.stdout.trim()
      if (up.code !== 0 || !upstream.includes('/')) throw new GitError(['rev-parse', `${op.name}@{upstream}`], `${op.name} has no upstream branch to update from.`)
      const remote = await remoteOf(root, op.name)
      const remoteBranch = upstream.slice(remote.length + 1)
      const r = await git(root, ['fetch', remote, `refs/heads/${remoteBranch}:refs/heads/${op.name}`], { allowFail: true, timeoutMs: 180_000 })
      if (r.code === 0) return { message: `Updated ${op.name} from ${upstream}` }
      if (/non-fast-forward|rejected/.test(r.stderr))
        throw new GitError(['fetch'], `${op.name} and ${upstream} have both moved on, so it cannot be fast-forwarded. Check it out and use Update there to rebase it.`)
      throw new GitError(['fetch', remote], (r.stderr || r.stdout).trim())
    }
    case 'fetch':
      await fetchAll(root)
      return { message: 'Fetched all remotes' }
  }
}

/** True when the file's changes are all staged (Orca's diff tab then needs --staged to show them). */
export async function onlyStaged(root: string, file: string): Promise<boolean> {
  const out = await read(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', file])
  const line = out.split('\0')[0] ?? ''
  if (line[0] !== '1' && line[0] !== '2') return false
  const [x, y] = line.split(' ')[1]
  return x !== '.' && y === '.'
}
