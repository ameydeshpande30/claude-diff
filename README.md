# claude-diff

**Local undo for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) — review AI edits in your IDE before committing.**

No garbage commits. No throwaway branches. Your `git log` stays clean.

```
claude-diff stage   →   VSCode / IntelliJ shows Claude's edits as normal unstaged diffs
claude-diff revert  →   restore any file from before Claude touched it
git commit          →   only when YOU decide
```

## Platform support

| | macOS | Linux | Windows |
|---|---|---|---|
| Hook (pre-save-hook.js) | ✅ | ✅ | ✅ |
| CLI (claude-diff.js) | ✅ | ✅ | ✅ |
| Setup script | `setup.sh` | `setup.sh` | `setup.ps1` |
| git IDE integration | ✅ | ✅ | ✅ (with git for Windows) |

**Requirements:** Node.js ≥ 14, Git (optional but recommended)

---

## How it works

A `PreToolUse` hook fires **before** Claude edits any file. The original content is stored as a git blob object (`git hash-object -w`) — invisible in `git log`, automatically GC'd after ~2 weeks. A manifest in `.claude-diff/` maps file paths to blob hashes.

When you run `claude-diff stage`, the originals are pushed into git's staging area with `git update-index --cacheinfo`. Your IDE then shows Claude's changes as normal **unstaged diffs** in the git panel.

```
Claude edits file.ts
  └─ PreToolUse hook fires (Node.js — works on all platforms)
       └─ git hash-object -w  →  blob stored in .git/objects/
            └─ hash saved in .claude-diff/manifest.json  (gitignored)

claude-diff stage
  └─ git update-index --cacheinfo  →  original pushed into staging area
       └─ IDE git panel shows Claude's changes as unstaged diffs

Happy?  →  git add -p && git commit
Not?    →  claude-diff revert --all
```

---

## Install

### Global — works in every project automatically (recommended)

**macOS / Linux:**
```bash
git clone https://github.com/your-username/claude-diff
bash claude-diff/setup.sh --global
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/your-username/claude-diff
.\claude-diff\setup.ps1 -Global
```

Add `~/.local/bin` to your PATH if prompted.

### Per-project — shareable with your team

```bash
bash setup.sh          # macOS / Linux
.\setup.ps1            # Windows
```

Commit `.claude/settings.json` and `.claude/hooks/` so teammates get the same hooks automatically.

---

## Usage

```bash
claude-diff list              # see all files Claude has touched
claude-diff status            # git-status style summary
claude-diff diff              # unified diff of every changed file
claude-diff diff src/app.ts   # diff a single file

claude-diff stage             # push originals to git index → IDE shows diffs
claude-diff unstage           # undo the stage, restore index to HEAD
claude-diff show src/app.ts   # open VSCode / Cursor split-diff view

claude-diff revert src/app.ts # restore one file
claude-diff revert --all      # restore everything Claude changed
claude-diff clear             # wipe snapshot store + unstage
```

### Typical session

```bash
# 1. Let Claude do its thing…

# 2. See what changed
claude-diff list

# 3. Push to IDE — git panel shows all Claude's edits as unstaged diffs
claude-diff stage

# 4a. Happy → commit normally
git add -p
git commit -m "feat: ..."

# 4b. Not happy → nuke it
claude-diff revert --all
```

---

## IDE integration

After `claude-diff stage`, Claude's edits appear as **unstaged modifications**.

| IDE | Where to look |
|---|---|
| **VSCode** | Source Control (⌃⇧G / Ctrl+Shift+G) |
| **IntelliJ / WebStorm** | Git → Local Changes |
| **Neovim + fugitive** | `:Gstatus` or `:DiffviewOpen` |
| **Terminal** | `git diff` |

---

## Running tests

```bash
npm test
# or
node --test tests/
```

Tests use Node's built-in test runner (`node:test`) — no npm install needed. Requires Node ≥ 18.

---

## FAQ

**Does this work without git?**
Yes — falls back to plain file copies in `.claude-diff/backups/`. `stage` and `show` won't work, but `diff` and `revert` still do.

**Will the blobs fill up my repo?**
No. Git GC cleans them up automatically after ~2 weeks.

**Can I keep full history per file?**
Yes — in `hooks/pre-save-hook.js`, find the early-exit line `if (entries.some(...)) process.exit(0)` and remove it.

---

## License

MIT
