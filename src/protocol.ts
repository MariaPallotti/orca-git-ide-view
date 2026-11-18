// The panel <-> worker contract. The worker (src/worker.ts) imports these types; the HTML panel
// (panel/app.js) calls the same request names through window.orca.plugin.request.
export {}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export type ChangedFile = {
  /** Repo-relative path with forward slashes. */
  path: string
  /** Old path of a rename. */
  origPath?: string
  status: FileStatus
}

export type RepoInfo = {
  /** Absolute path of the working tree root. */
  root: string
  branch: string | null
  /** Workspace name shown in Orca. */
  name: string
}

export type Hunk = {
  /** 1-based first line on the left (old) side; with oldLines 0 it is the line *after* which the insertion happens. */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The `@@ ... @@` line, used to check that a revert targets the hunk the person saw. */
  header: string
}

export type DiffMode =
  /** HEAD vs the working tree (the default "local changes" diff). */
  | { kind: 'local' }
  /** A commit vs its first parent. */
  | { kind: 'commit'; rev: string }

export type DiffResult = {
  path: string
  leftTitle: string
  rightTitle: string
  binary: boolean
  /** Too large to show (over 2 MiB on either side). */
  tooLarge: boolean
  left: string
  right: string
  hunks: Hunk[]
  /** Hunks can be reverted (local mode on a tracked file). */
  canRevert: boolean
}

export type LogEntry = {
  hash: string
  short: string
  subject: string
  author: string
  date: number
  refs: string
  parents: string[]
}

export type LocalBranch = {
  name: string
  /** refs/heads/<name> */
  ref: string
  hash: string
  current: boolean
  upstream?: string
  /** The upstream was deleted on the remote. */
  gone?: boolean
  /** Commits to push / to pull. */
  ahead: number
  behind: number
}
export type RemoteBranch = { name: string; ref: string; hash: string; remote: string }
export type Branches = { current: string | null; local: LocalBranch[]; remote: RemoteBranch[] }

export type BranchOp =
  | { op: 'checkout' | 'checkoutRemote' | 'merge' | 'rebase' | 'push' | 'deleteRemote'; name: string }
  | { op: 'delete'; name: string; force?: boolean }
  | { op: 'create'; newName: string; from?: string; checkout: boolean }
  | { op: 'rename'; name: string; newName: string }
  | { op: 'update' | 'fetch' }
  /** Update one branch: the current one is pulled, another local one fast-forwarded, a remote one fetched. */
  | { op: 'updateBranch'; name: string; remote?: boolean }
export type BranchOpResult = {
  message: string
  /** A merge or rebase stopped on conflicts. */
  conflicts?: boolean
  /** `git branch -d` refused: the branch has commits not merged anywhere. */
  notMerged?: boolean
}

export type ShelfEntry ={ hash: string; ref: string; message: string; date: number }

/** A merge, rebase, cherry-pick or revert that stopped and waits for the person. */
export type Operation = {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'
  /** "Merging feature into main", "Rebasing feature onto 1a2b3c4d"... */
  title: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; command?: string }

declare module 'orca' {
  interface PluginRequests {
    /** `choices`: several workspaces share the focused one's name and branch and Orca could not
     *  say which is focused; `repo` is a guess and the panel lets the person pick. */
    'git.state': {
      output: Result<{ repo: RepoInfo | null; reason?: string; files: ChangedFile[]; operation?: Operation | null; choices?: { id: string; path: string; name: string }[] }>
    }
    'git.pickWorkspace': { input: { id: string }; output: Result<null> }
    /** Opens Orca's diff of a changed file (working tree) in a main-area tab. */
    'git.openDiffTab': { input: { path: string }; output: Result<null> }
    /** Takes one whole side of a conflicted file. `yours` is the branch you were on (in a rebase, your commit). */
    'git.resolveSide': { input: { path: string; side: 'yours' | 'theirs' }; output: Result<null> }
    /** Stages a conflicted file; refuses while it still has conflict markers unless `force`. */
    'git.markResolved': { input: { path: string; force?: boolean }; output: Result<null> }
    /** The working copy as it is on disk (line endings kept), for the merge view. */
    'git.readFile': { input: { path: string }; output: Result<string> }
    'git.writeFile': { input: { path: string; text: string }; output: Result<null> }
    'git.continueOp': { output: Result<null> }
    'git.abortOp': { output: Result<null> }
    'git.diff': { input: { path: string; origPath?: string; mode: DiffMode }; output: Result<DiffResult> }
    'git.revertHunk': { input: { path: string; header: string }; output: Result<null> }
    'git.rollback': { input: { files: ChangedFile[] }; output: Result<null> }
    'git.commit': {
      input: { files: ChangedFile[]; message: string; amend: boolean; push: boolean }
      output: Result<{ hash: string; pushed: boolean; pushError?: string }>
    }
    'git.lastMessage': { output: Result<string> }
    /** `ref` (refs/heads/x, refs/remotes/o/x or HEAD) shows one branch; otherwise `all` or HEAD. */
    'git.log': { input: { limit?: number; all?: boolean; ref?: string }; output: Result<LogEntry[]> }
    'git.branches': { output: Result<Branches> }
    'git.branchOp': { input: BranchOp; output: Result<BranchOpResult> }
    'git.commitFiles': { input: { rev: string }; output: Result<ChangedFile[]> }
    'git.commitMessage': { input: { rev: string }; output: Result<string> }
    'git.shelve': { input: { files: ChangedFile[]; message: string }; output: Result<null> }
    'git.shelf': { output: Result<ShelfEntry[]> }
    /** Files of a shelf entry; untracked ones carry `rev` = the stash's untracked-files commit. */
    'git.shelfFiles': { input: { hash: string }; output: Result<(ChangedFile & { rev: string })[]> }
    'git.unshelve': { input: { hash: string; drop: boolean }; output: Result<null> }
    'git.dropShelf': { input: { hash: string }; output: Result<null> }
    'git.openFile': { input: { path: string }; output: Result<null> }
    'git.ignore': { input: { path: string }; output: Result<null> }
  }
  interface PluginPanelEvents {
    /** Something changed in the repository (or the focused workspace changed): reload. */
    'git.changed': { reason: string; refs?: boolean }
    /** The focused workspace is changing to `name`: the panel shows that it is loading until the
     *  next `git.changed` (reason "workspace"). */
    'git.switching': { name: string }
    /** A git operation started, moved on (`text`: the git command or progress line, `percent` when
     *  git gives one), finished or failed: the panel's progress popup. */
    'git.progress': { id: number; title: string; state: 'start' | 'progress' | 'done' | 'error'; text?: string; percent?: number }
  }
}
