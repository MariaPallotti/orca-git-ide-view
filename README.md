# Git IDE View for Orca

An IDE-style Git tool window for Orca's right sidebar.

- **Commit**: changes tree with checkboxes (grouped by directory, status colours, "Unversioned Files"), commit message, **Commit** / **Commit and Push…**, **Amend**, Rollback, Shelve, Add to .gitignore, Jump to Source. Only the ticked files are committed (`git commit --only`).
- **Diff of a local change** (double-click, Enter, Ctrl+D): opens in a tab of Orca's main area, with Orca's own diff viewer, so it can take the whole window. "Show Diff in Panel" (right-click) keeps it in the sidebar.
- **Panel diff viewer** (Log and Shelf diffs, and "Show Diff in Panel"): side-by-side or unified, word-level highlights, collapsed unchanged regions, **F7 / Shift+F7** between differences (continues into the next file), **»** reverts one change block (line endings are kept).
- **Log**, docked under the changes, as in a desktop IDE's Git tool window (drag the divider to resize it, ▾ to hide it):
  - **Branches** on the left: HEAD, Local and Remote, grouped by folder (`feature/`, `origin/`…), with ↑ commits to push and ↓ to pull. Click a branch to show only its history (click it again, or ✕, for all branches); double-click to check it out. Right-click: Checkout, New Branch from…, Rebase current onto…, Merge into current, Push, Update, Rename, Delete (and Delete on the remote for remote branches).
  - **History** on the right: the branch graph, one line per commit (subject, author, date, hash), filter, commit details with files and their diffs; right-click a commit for New Branch from Here, Checkout Revision, Copy.
- **Shelf**: shelve on top of `git stash` (untracked files included): unshelve, apply, delete, and diff of each shelved file.
- **Conflicts**: a bar shows a merge, rebase, cherry-pick or revert in progress with **Continue** / **Abort**. Conflicted files get **Accept Yours / Accept Theirs / Mark as Resolved** (in a rebase, "yours" is your commit) and a **Merge** view: every conflict block with both sides (and the base, for diff3), word highlights, Accept Yours / Theirs / Both per block, All Yours / All Theirs, and **Apply**, which saves the file and stages it once no conflict is left.
- **Command palette**: `Git: Update Project` (pull --rebase --autostash), `Git: Push`, `Git: Fetch`, `Git: Refresh Changes`.

The panel refreshes by itself when a terminal, an agent or the editor changes the repository. When you focus another workspace, a loading screen ("Loading <project>…") covers the panel until that project's changes, branches and history are in.

## Keys

| Where  | Key                  | Action                     |
| ------ | -------------------- | -------------------------- |
| Commit | Ctrl+D / Enter       | Show diff                  |
| Commit | Space                | Include / exclude          |
| Commit | Ctrl+Alt+Z           | Rollback                   |
| Commit | Ctrl+Enter           | Commit                     |
| Commit | Ctrl+Alt+K           | Commit and Push            |
| Diff   | F7 / Shift+F7        | Next / previous difference |
| Diff   | Alt+← / Alt+→        | Previous / next file       |
| Diff   | F4                   | Jump to source             |
| Diff   | Esc                  | Back                       |
| Merge  | F7 / Shift+F7        | Next / previous conflict   |
| Merge  | Ctrl+Enter           | Apply                      |

## Layout

- `src/worker.ts`: finds the focused workspace's repository (`workspace.readContext` + `workspace.list`), answers the panel and watches the repository.
- `src/git.ts`: every git operation.
- `panel/`: the HTML panel (`app.js`), diff alignment and word diff (`diff.js`), graph layout (`graph.js`).
- `src/*.test.ts`: `orca plugin test .` (the worker tests run real git in a temporary repository).

## Develop

```sh
orca plugin validate .
orca plugin test .
orca plugin dev watch .    # loads this folder into Orca and reloads on save
```
