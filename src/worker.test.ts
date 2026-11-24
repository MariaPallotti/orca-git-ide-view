// Runs the worker against a real temporary Git repository, with Orca's host mocked so the
// focused workspace points at it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker.ts'
import * as g from './git.ts'

function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-git-ide-view-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(path.join(dir, 'b.txt'), 'bee\n')
  git('add', '.')
  git('commit', '-q', '-m', 'initial')
  return dir
}

/** Windows can hold the folder briefly after the worker's watcher closes. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {}
}

function hostFor(dir: string) {
  return mockHost({
    results: {
      'workspace.readContext': { branch: 'refs/heads/main', displayName: 'demo', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'ws1', kind: 'folder', name: 'demo', path: dir, branch: 'main', hostId: null }], truncated: false },
      'notifications.show': { delivered: true }
    }
  })
}

const ok = <T>(r: unknown): T => {
  const res = r as { ok: boolean; value?: T; error?: string }
  assert.ok(res.ok, res.error)
  return res.value as T
}

test('lists changes, diffs, reverts a block, commits and rolls back', async () => {
  const dir = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO changed\nthree\nfour\nfive\nsix\n')
    rmSync(path.join(dir, 'b.txt'))
    writeFileSync(path.join(dir, 'c.txt'), 'new file\n')

    worker = await mountWorker(main, { host: hostFor(dir) })

    const st = ok<{ repo: { branch: string }; files: { path: string; status: string }[] }>(await worker.request('git.state'))
    assert.equal(st.repo.branch, 'main')
    assert.deepEqual(
      st.files.map((f) => `${f.status}:${f.path}`),
      ['modified:a.txt', 'deleted:b.txt', 'untracked:c.txt']
    )

    const d = ok<{ hunks: { header: string; oldStart: number; newLines: number }[]; canRevert: boolean; left: string }>(
      await worker.request('git.diff', { path: 'a.txt', mode: { kind: 'local' } })
    )
    assert.equal(d.hunks.length, 2)
    assert.ok(d.canRevert)
    assert.equal(d.left, 'one\ntwo\nthree\nfour\nfive\n')

    const untracked = ok<{ hunks: { newLines: number }[]; canRevert: boolean }>(
      await worker.request('git.diff', { path: 'c.txt', mode: { kind: 'local' } })
    )
    assert.equal(untracked.hunks[0].newLines, 1)
    assert.equal(untracked.canRevert, false)

    // Revert only the first block (line 2): the appended "six" stays.
    ok(await worker.request('git.revertHunk', { path: 'a.txt', header: d.hunks[0].header }))
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\n')

    // Revert the remaining block (an insertion at the end).
    const d2 = ok<{ hunks: { header: string }[] }>(await worker.request('git.diff', { path: 'a.txt', mode: { kind: 'local' } }))
    assert.equal(d2.hunks.length, 1)
    ok(await worker.request('git.revertHunk', { path: 'a.txt', header: d2.hunks[0].header }))
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\n')

    // Commit only the deletion of b.txt; c.txt stays unversioned.
    const c = ok<{ hash: string; pushed: boolean }>(
      await worker.request('git.commit', { files: [{ path: 'b.txt', status: 'deleted' }], message: 'remove b\n\nbody', amend: false, push: false })
    )
    assert.ok(c.hash)
    const after = ok<{ files: { path: string; status: string }[] }>(await worker.request('git.state'))
    assert.deepEqual(after.files.map((f) => `${f.status}:${f.path}`), ['untracked:c.txt'])
    assert.equal(ok<string>(await worker.request('git.lastMessage')), 'remove b\n\nbody')

    const log = ok<{ subject: string }[]>(await worker.request('git.log', {}))
    assert.deepEqual(log.map((l) => l.subject), ['remove b', 'initial'])
    const files = ok<{ path: string; status: string }[]>(await worker.request('git.commitFiles', { rev: 'HEAD' }))
    assert.deepEqual(files, [{ path: 'b.txt', status: 'deleted' }])

    const commitDiff = ok<{ left: string; right: string; hunks: unknown[] }>(
      await worker.request('git.diff', { path: 'b.txt', mode: { kind: 'commit', rev: 'HEAD' } })
    )
    assert.equal(commitDiff.left, 'bee\n')
    assert.equal(commitDiff.right, '')
    assert.equal(commitDiff.hunks.length, 1)

    // Amend with no files only rewrites the message.
    ok(await worker.request('git.commit', { files: [], message: 'remove b (amended)', amend: true, push: false }))
    assert.equal(ok<string>(await worker.request('git.lastMessage')), 'remove b (amended)')

    ok(await worker.request('git.rollback', { files: [{ path: 'c.txt', status: 'untracked' }] }))
    assert.equal(existsSync(path.join(dir, 'c.txt')), false)
    assert.deepEqual(ok<{ files: unknown[] }>(await worker.request('git.state')).files, [])

  } finally {
    await worker?.deactivate()
    cleanup(dir)
  }
})

test('keeps CRLF line endings when reverting a block', async () => {
  const dir = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: dir })
    // HEAD has LF; the working copy uses CRLF, as on Windows with autocrlf.
    writeFileSync(path.join(dir, 'a.txt'), 'one\r\nXX\r\nthree\r\nfour\r\nYY\r\n')
    worker = await mountWorker(main, { host: hostFor(dir) })
    const d = ok<{ hunks: { header: string }[] }>(await worker.request('git.diff', { path: 'a.txt', mode: { kind: 'local' } }))
    assert.equal(d.hunks.length, 2)
    ok(await worker.request('git.revertHunk', { path: 'a.txt', header: d.hunks[1].header }))
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\r\nXX\r\nthree\r\nfour\r\nfive\r\n')
  } finally {
    await worker?.deactivate()
    cleanup(dir)
  }
})

test('explains when no workspace is focused', async () => {
  const host = mockHost({ results: { 'workspace.readContext': null } })
  const worker = await mountWorker(main, { host })
  const st = ok<{ repo: null; reason: string }>(await worker.request('git.state'))
  assert.equal(st.repo, null)
  assert.match(st.reason, /No workspace/)
  await worker.deactivate()
})

test('shelves selected files (untracked too), lists, shows and unshelves them', async () => {
  const dir = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'one\nchanged\nthree\nfour\nfive\n')
    writeFileSync(path.join(dir, 'b.txt'), 'bee changed\n')
    writeFileSync(path.join(dir, 'n.txt'), 'brand new\n')
    worker = await mountWorker(main, { host: hostFor(dir) })

    ok(await worker.request('git.shelve', {
      files: [{ path: 'a.txt', status: 'modified' }, { path: 'n.txt', status: 'untracked' }],
      message: 'wip a'
    }))
    // b.txt was not selected, so it stays in the working tree.
    const st = ok<{ files: { path: string }[] }>(await worker.request('git.state'))
    assert.deepEqual(st.files.map((f) => f.path), ['b.txt'])

    const shelf = ok<{ hash: string; message: string }[]>(await worker.request('git.shelf'))
    assert.equal(shelf.length, 1)
    assert.equal(shelf[0].message, 'wip a')

    const files = ok<{ path: string; status: string; rev: string }[]>(await worker.request('git.shelfFiles', { hash: shelf[0].hash }))
    assert.deepEqual(files.map((f) => `${f.status}:${f.path}`), ['modified:a.txt', 'added:n.txt'])
    const nDiff = ok<{ right: string }>(await worker.request('git.diff', { path: 'n.txt', mode: { kind: 'commit', rev: files[1].rev } }))
    assert.equal(nDiff.right, 'brand new\n')

    ok(await worker.request('git.unshelve', { hash: shelf[0].hash, drop: true }))
    assert.equal(readFileSync(path.join(dir, 'n.txt'), 'utf8'), 'brand new\n')
    assert.equal(ok<unknown[]>(await worker.request('git.shelf')).length, 0)

    const log = ok<{ parents: string[] }[]>(await worker.request('git.log', { all: true }))
    assert.deepEqual(log[0].parents, [])
  } finally {
    await worker?.deactivate()
    cleanup(dir)
  }
})

/** main and feature both change line 2 of a.txt; HEAD is left on `checkout`. */
function conflictRepo(checkout: string): string {
  const dir = makeRepo()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(path.join(dir, 'a.txt'), 'one\nFEATURE\nthree\nfour\nfive\n')
  git('commit', '-q', '-am', 'feature change')
  git('checkout', '-q', 'main')
  writeFileSync(path.join(dir, 'a.txt'), 'one\nMAIN\nthree\nfour\nfive\n')
  git('commit', '-q', '-am', 'main change')
  git('checkout', '-q', checkout)
  return dir
}

test('merge conflict: markers block Mark as Resolved, Accept Theirs and Continue finish the merge', async () => {
  const dir = conflictRepo('main')
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    try {
      execFileSync('git', ['merge', 'feature'], { cwd: dir, stdio: 'pipe' })
    } catch {}
    worker = await mountWorker(main, { host: hostFor(dir) })
    const st = ok<{ files: { path: string; status: string }[]; operation: { kind: string; title: string } }>(await worker.request('git.state'))
    assert.equal(st.operation.kind, 'merge')
    assert.match(st.operation.title, /^Merging branch 'feature'/)
    assert.deepEqual(st.files.map((f) => `${f.status}:${f.path}`), ['conflicted:a.txt'])

    const refused = (await worker.request('git.markResolved', { path: 'a.txt' })) as { ok: boolean; error: string }
    assert.equal(refused.ok, false)
    assert.match(refused.error, /conflict markers/)

    const text = ok<string>(await worker.request('git.readFile', { path: 'a.txt' }))
    assert.match(text, /<<<<<<< HEAD\nMAIN\n=======\nFEATURE\n>>>>>>> feature/)

    ok(await worker.request('git.resolveSide', { path: 'a.txt', side: 'theirs' }))
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\nFEATURE\nthree\nfour\nfive\n')
    ok(await worker.request('git.continueOp'))
    const after = ok<{ files: unknown[]; operation: unknown }>(await worker.request('git.state'))
    assert.equal(after.operation, null)
    const log = ok<{ parents: string[] }[]>(await worker.request('git.log', { all: false }))
    assert.equal(log[0].parents.length, 2)
  } finally {
    await worker?.deactivate()
    cleanup(dir)
  }
})

test('rebase conflict: "yours" is the commit being replayed; Abort restores the branch', async () => {
  const dir = conflictRepo('feature')
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    try {
      execFileSync('git', ['rebase', 'main'], { cwd: dir, stdio: 'pipe' })
    } catch {}
    worker = await mountWorker(main, { host: hostFor(dir) })
    const st = ok<{ operation: { kind: string; title: string } }>(await worker.request('git.state'))
    assert.equal(st.operation.kind, 'rebase')
    assert.match(st.operation.title, /^Rebasing feature onto /)

    // A merge view write keeps the conflict open until it is marked resolved.
    ok(await worker.request('git.writeFile', { path: 'a.txt', text: 'one\nBOTH\nthree\nfour\nfive\n' }))
    ok(await worker.request('git.resolveSide', { path: 'a.txt', side: 'yours' }))
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\nFEATURE\nthree\nfour\nfive\n')

    ok(await worker.request('git.abortOp'))
    const after = ok<{ operation: unknown; files: unknown[] }>(await worker.request('git.state'))
    assert.equal(after.operation, null)
    assert.deepEqual(after.files, [])
  } finally {
    await worker?.deactivate()
    cleanup(dir)
  }
})

test('branches: folders, ahead/behind, create, checkout, filter the log, merge with conflicts, delete', async () => {
  const dir = conflictRepo('main')
  const remote = mkdtempSync(path.join(os.tmpdir(), 'orca-git-ide-view-remote-'))
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' })
    git('remote', 'add', 'origin', remote)
    git('push', '-q', '-u', 'origin', 'main', 'feature')
    writeFileSync(path.join(dir, 'b.txt'), 'bee 2\n')
    git('commit', '-q', '-am', 'local only')

    worker = await mountWorker(main, { host: hostFor(dir) })
    type B = { current: string; local: { name: string; ref: string; current: boolean; ahead: number; upstream?: string }[]; remote: { name: string; remote: string }[] }
    let b = ok<B>(await worker.request('git.branches'))
    assert.equal(b.current, 'main')
    const mainB = b.local.find((x) => x.name === 'main')!
    assert.equal(mainB.current, true)
    assert.equal(mainB.upstream, 'origin/main')
    assert.equal(mainB.ahead, 1)
    assert.deepEqual(b.remote.map((x) => x.name).sort(), ['origin/feature', 'origin/main'])

    // A branch in a folder, created from feature without switching.
    ok(await worker.request('git.branchOp', { op: 'create', newName: 'fix/login', from: 'feature', checkout: false }))
    const bad = (await worker.request('git.branchOp', { op: 'create', newName: 'bad name', checkout: false })) as { ok: boolean; error: string }
    assert.equal(bad.ok, false)
    b = ok<B>(await worker.request('git.branches'))
    assert.ok(b.local.some((x) => x.name === 'fix/login' && x.ref === 'refs/heads/fix/login'))

    // The log of one branch only.
    const featureLog = ok<{ subject: string }[]>(await worker.request('git.log', { ref: 'refs/heads/fix/login' }))
    assert.deepEqual(featureLog.map((c) => c.subject), ['feature change', 'initial'])

    // Merging feature into main stops on the conflict and reports it instead of failing.
    const merged = ok<{ conflicts?: boolean }>(await worker.request('git.branchOp', { op: 'merge', name: 'feature' }))
    assert.equal(merged.conflicts, true)
    ok(await worker.request('git.abortOp'))

    // Checkout, then deleting an unmerged branch asks for force.
    ok(await worker.request('git.branchOp', { op: 'checkout', name: 'feature' }))
    assert.equal(ok<{ repo: { branch: string } }>(await worker.request('git.state')).repo.branch, 'feature')
    ok(await worker.request('git.branchOp', { op: 'checkout', name: 'main' }))
    git('branch', 'spare', 'feature')
    git('commit', '-q', '--allow-empty', '-m', 'x')
    const del = ok<{ notMerged?: boolean }>(await worker.request('git.branchOp', { op: 'delete', name: 'fix/login' }))
    assert.equal(del.notMerged, true)
    ok(await worker.request('git.branchOp', { op: 'delete', name: 'fix/login', force: true }))
    ok(await worker.request('git.branchOp', { op: 'rename', name: 'spare', newName: 'tmp/spare' }))
    b = ok<B>(await worker.request('git.branches'))
    assert.ok(!b.local.some((x) => x.name === 'fix/login'))
    assert.ok(b.local.some((x) => x.name === 'tmp/spare'))
  } finally {
    await worker?.deactivate()
    cleanup(dir)
    cleanup(remote)
  }
})

test('two workspaces with the same name and branch: offers a choice and follows it', async () => {
  const a = makeRepo()
  const b = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    writeFileSync(path.join(b, 'only-in-b.txt'), 'b\n')
    const host = mockHost({
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'wa', kind: 'worktree', name: 'main', path: a, branch: 'refs/heads/main', hostId: 'local' },
            { id: 'wb', kind: 'worktree', name: 'main', path: b, branch: 'refs/heads/main', hostId: 'local' }
          ],
          truncated: false
        }
      }
    })
    worker = await mountWorker(main, { host })
    type S = { repo: { root: string; name: string }; files: { path: string }[]; choices?: { id: string; name: string }[] }
    const st = ok<S>(await worker.request('git.state'))
    assert.deepEqual(st.choices?.map((c) => c.id), ['wa', 'wb'])
    assert.equal(st.repo.name, path.basename(a))
    ok(await worker.request('git.pickWorkspace', { id: 'wb' }))
    const after = ok<S>(await worker.request('git.state'))
    assert.equal(after.repo.name, path.basename(b))
    assert.deepEqual(after.files.map((f) => f.path), ['only-in-b.txt'])
  } finally {
    await worker?.deactivate()
    cleanup(a)
    cleanup(b)
  }
})

test('Update on a branch that is not checked out fast-forwards it from its upstream', async () => {
  const dir = makeRepo()
  const remote = mkdtempSync(path.join(os.tmpdir(), 'orca-git-ide-view-remote-'))
  const other = mkdtempSync(path.join(os.tmpdir(), 'orca-git-ide-view-other-'))
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' })
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'branch', 'feature')
    git(dir, 'push', '-q', '-u', 'origin', 'main', 'feature')
    // Someone else pushes to feature.
    execFileSync('git', ['clone', '-q', '-b', 'feature', remote, other], { stdio: 'pipe' })
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'user.email', 'other@example.invalid')
    writeFileSync(path.join(other, 'b.txt'), 'from other\n')
    git(other, 'commit', '-q', '-am', 'remote change')
    git(other, 'push', '-q')
    const remoteHead = git(other, 'rev-parse', 'HEAD')

    worker = await mountWorker(main, { host: hostFor(dir) })
    ok(await worker.request('git.branchOp', { op: 'updateBranch', name: 'feature' }))
    assert.equal(git(dir, 'rev-parse', 'feature'), remoteHead)
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
    ok(await worker.request('git.branchOp', { op: 'updateBranch', name: 'origin/main', remote: true }))
  } finally {
    await worker?.deactivate()
    cleanup(dir)
    cleanup(remote)
    cleanup(other)
  }
})

test('git operations report to the progress popup: start, each git step, done or error', async () => {
  const dir = makeRepo()
  const remote = mkdtempSync(path.join(os.tmpdir(), 'orca-git-ide-view-remote-'))
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' })
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dir, stdio: 'pipe' })
    worker = await mountWorker(main, { host: hostFor(dir) })
    ok(await worker.request('git.branchOp', { op: 'fetch' }))
    type P = { id: number; title: string; state: string; text?: string }
    const progress = worker.posts.filter((p) => p.event === 'git.progress').map((p) => p.payload as P)
    assert.equal(progress[0].state, 'start')
    assert.equal(progress[0].title, 'Fetching')
    assert.ok(progress.some((p) => p.state === 'progress' && /^git fetch --progress/.test(p.text ?? '')), JSON.stringify(progress))
    assert.equal(progress[progress.length - 1].state, 'done')

    const failed = (await worker.request('git.branchOp', { op: 'checkout', name: 'no-such-branch' })) as { ok: boolean }
    assert.equal(failed.ok, false)
    const last = worker.posts.filter((p) => p.event === 'git.progress').map((p) => p.payload as P).pop()!
    assert.equal(last.state, 'error')
    assert.match(last.title, /Checking out no-such-branch/)
  } finally {
    await worker?.deactivate()
    cleanup(dir)
    cleanup(remote)
  }
})

test('switching workspace tells the panel at once, then reloads it with the new repository', async () => {
  const a = makeRepo()
  const b = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    writeFileSync(path.join(b, 'only-in-b.txt'), 'b\n')
    const host = mockHost({
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'alpha', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'wa', kind: 'folder', name: 'alpha', path: a, branch: 'main', hostId: null },
            { id: 'wb', kind: 'folder', name: 'beta', path: b, branch: 'main', hostId: null }
          ],
          truncated: false
        }
      }
    })
    worker = await mountWorker(main, { host })
    type S = { repo: { root: string; name: string }; files: { path: string }[] }
    assert.equal(ok<S>(await worker.request('git.state')).repo.name, path.basename(a))

    const from = worker.posts.length
    await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'beta', terminals: [] } })
    const events = worker.posts.slice(from).filter((p) => p.event === 'git.switching' || p.event === 'git.changed')
    assert.deepEqual(events.map((p) => p.event), ['git.switching', 'git.changed'])
    assert.deepEqual(events[0].payload, { name: 'beta' })
    assert.equal((events[1].payload as { reason: string }).reason, 'workspace')
    const st = ok<S>(await worker.request('git.state'))
    assert.equal(st.repo.name, path.basename(b))
    assert.deepEqual(st.files.map((f) => f.path), ['only-in-b.txt'])

    // The same workspace again (its terminals changed, say): no loading screen.
    const again = worker.posts.length
    await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'beta', terminals: [] } })
    assert.ok(!worker.posts.slice(again).some((p) => p.event === 'git.switching'))
  } finally {
    await worker?.deactivate()
    cleanup(a)
    cleanup(b)
  }
})

test('branch name from the status snapshot: on a branch, detached, and in a repository with no commit', async () => {
  const dir = makeRepo()
  const empty = mkdtempSync(path.join(os.tmpdir(), 'orca-git-ide-view-'))
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: empty, stdio: 'pipe' })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim()
    type S = { repo: { branch: string | null } }
    worker = await mountWorker(main, { host: hostFor(dir) })
    assert.equal(ok<S>(await worker.request('git.state')).repo.branch, 'main')
    assert.equal(ok<{ current: string }>(await worker.request('git.branches')).current, 'main')

    git('checkout', '-q', '--detach')
    const short = git('rev-parse', '--short=7', 'HEAD')
    assert.equal(ok<S>(await worker.request('git.state')).repo.branch, `detached at ${short}`)
    assert.equal(ok<{ current: string }>(await worker.request('git.branches')).current, `detached at ${git('rev-parse', '--short', 'HEAD')}`)
    await worker.deactivate()

    worker = await mountWorker(main, { host: hostFor(empty) })
    assert.equal(ok<S>(await worker.request('git.state')).repo.branch, 'trunk')
    assert.deepEqual(ok(await worker.request('git.log', { limit: 400, ref: 'HEAD' })), [])
    assert.equal(ok<{ current: string }>(await worker.request('git.branches')).current, 'trunk')
  } finally {
    await worker?.deactivate()
    cleanup(dir)
    cleanup(empty)
  }
})

test('the Log and branches read at a switch are the ones the panel gets, and a change throws them away', async () => {
  const a = makeRepo()
  const b = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    const host = mockHost({
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'alpha', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'wa', kind: 'folder', name: 'alpha', path: a, branch: 'main', hostId: null },
            { id: 'wb', kind: 'folder', name: 'beta', path: b, branch: 'main', hostId: null }
          ],
          truncated: false
        }
      }
    })
    worker = await mountWorker(main, { host })
    ok(await worker.request('git.state'))
    await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'beta', terminals: [] } })
    type L = { subject: string }[]
    assert.deepEqual(ok<L>(await worker.request('git.log', { limit: 400, ref: 'HEAD' })).map((c) => c.subject), ['initial'])

    // A commit made after the switch: the next answers are read again, not the prefetched ones.
    writeFileSync(path.join(b, 'b.txt'), 'changed\n')
    execFileSync('git', ['commit', '-q', '-am', 'second'], { cwd: b, stdio: 'pipe' })
    ok(await worker.request('git.rollback', { files: [] })) // any change request checks the repository
    assert.deepEqual(ok<L>(await worker.request('git.log', { limit: 400, ref: 'HEAD' })).map((c) => c.subject), ['second', 'initial'])
  } finally {
    await worker?.deactivate()
    cleanup(a)
    cleanup(b)
  }
})

test('workspaces with the same name and branch: their terminals tell a switch from a terminal opening', async () => {
  const a = makeRepo()
  const b = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    const host = mockHost({
      results: {
        'workspace.readContext': { branch: 'develop', displayName: 'develop', terminals: [{ id: 'term_a1' }] },
        'workspace.list': {
          workspaces: [
            { id: 'wa', kind: 'worktree', name: 'develop', path: a, branch: 'refs/heads/develop', hostId: 'local' },
            { id: 'wb', kind: 'worktree', name: 'develop', path: b, branch: 'refs/heads/develop', hostId: 'local' }
          ],
          truncated: false
        }
      }
    })
    worker = await mountWorker(main, { host })
    ok(await worker.request('git.state'))
    const switches = () => worker!.posts.filter((p) => p.event === 'git.switching').length

    // A second terminal opens in the same workspace: no loading screen.
    await worker.emit('workspace.changed', { context: { branch: 'develop', displayName: 'develop', terminals: [{ id: 'term_a1' }, { id: 'term_a2' }] } })
    assert.equal(switches(), 0)

    // Another "develop" workspace, with terminals of its own: announced.
    await worker.emit('workspace.changed', { context: { branch: 'develop', displayName: 'develop', terminals: [{ id: 'term_b1' }] } })
    assert.equal(switches(), 1)
  } finally {
    await worker?.deactivate()
    cleanup(a)
    cleanup(b)
  }
})

test('diffs without a parent: a repository with no commit, and the root commit', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'orca-git-ide-view-'))
  const dir = makeRepo()
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty, stdio: 'pipe' })
    writeFileSync(path.join(empty, 'new.txt'), 'a\nb\n')
    execFileSync('git', ['add', 'new.txt'], { cwd: empty, stdio: 'pipe' })
    worker = await mountWorker(main, { host: hostFor(empty) })
    type D = { left: string; right: string; hunks: { newLines: number }[]; canRevert: boolean }
    const added = ok<D>(await worker.request('git.diff', { path: 'new.txt', mode: { kind: 'local' } }))
    assert.equal(added.left, '')
    assert.equal(added.right, 'a\nb\n')
    assert.deepEqual(added.hunks.map((h) => h.newLines), [2])
    assert.equal(added.canRevert, false)
    await worker.deactivate()

    worker = await mountWorker(main, { host: hostFor(dir) })
    const rootRev = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: dir }).toString().trim()
    const files = ok<{ path: string; status: string }[]>(await worker.request('git.commitFiles', { rev: rootRev }))
    assert.deepEqual(files.map((f) => `${f.status}:${f.path}`), ['added:a.txt', 'added:b.txt'])
    const first = ok<D & { leftTitle: string }>(await worker.request('git.diff', { path: 'a.txt', mode: { kind: 'commit', rev: rootRev } }))
    assert.equal(first.leftTitle, '(none)')
    assert.equal(first.left, '')
    assert.deepEqual(first.hunks.map((h) => h.newLines), [5])

    // A second commit: its diff is against the parent, and the commit's hash comes from git's output.
    writeFileSync(path.join(dir, 'b.txt'), 'bee\nsea\n')
    const c = ok<{ hash: string }>(await worker.request('git.commit', { files: [{ path: 'b.txt', status: 'modified' }], message: 'more', amend: false, push: false }))
    assert.equal(c.hash, execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim())
    const second = ok<D & { leftTitle: string }>(await worker.request('git.diff', { path: 'b.txt', mode: { kind: 'commit', rev: c.hash } }))
    assert.equal(second.left, 'bee\n')
    assert.equal(second.right, 'bee\nsea\n')
    assert.equal(second.leftTitle, rootRev.slice(0, 8))
  } finally {
    await worker?.deactivate()
    cleanup(empty)
    cleanup(dir)
  }
})

test('"staged only" read from a status the watcher already has, or from git', async () => {
  const dir = makeRepo()
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'staged\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, stdio: 'pipe' })
    writeFileSync(path.join(dir, 'b.txt'), 'unstaged\n')
    writeFileSync(path.join(dir, 'c d.txt'), 'untracked\n')
    const status = execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: dir }).toString()
    for (const [file, want] of [['a.txt', true], ['b.txt', false], ['c d.txt', false]] as const) {
      assert.equal(await g.onlyStaged(dir, file, status), want, `${file} from the status`)
      assert.equal(await g.onlyStaged(dir, file), want, `${file} from git`)
    }
  } finally {
    cleanup(dir)
  }
})
