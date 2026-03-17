#!/usr/bin/env node
// claude-diff — local undo + IDE integration for Claude Code file changes
// Usage: claude-diff [list|status|diff|stage|unstage|revert|show|clear] [file]

const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const { spawnSync, execSync } = require("child_process");

// ─── Locate project root (git root or cwd) ──────────────────────────────────
function findProjectRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

const PROJECT_ROOT = findProjectRoot();
const STORE_DIR    = path.join(PROJECT_ROOT, ".claude-diff");
const MANIFEST     = path.join(STORE_DIR, "manifest.json");

// ─── Colours ────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", blue: "\x1b[34m", gray: "\x1b[90m", magenta: "\x1b[35m",
};
const col  = (color, t) => `${c[color]}${t}${c.reset}`;
const bold = t => col("bold", t);

// ─── Git helpers ─────────────────────────────────────────────────────────────
function git(...args) {
  const r = spawnSync("git", ["-C", PROJECT_ROOT, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function hasGit() {
  return git("rev-parse", "--git-dir").ok;
}

// Restore a blob from git object store to a temp file, return its path
function blobToTempFile(blobHash, origPath) {
  const tmp = path.join(os.tmpdir(), `claude-diff-${blobHash.slice(0, 8)}-${path.basename(origPath)}`);
  const r = git("cat-file", "blob", blobHash);
  if (!r.ok) return null;
  fs.writeFileSync(tmp, r.stdout);
  return tmp;
}

// ─── Manifest I/O ────────────────────────────────────────────────────────────
function load() {
  if (!fs.existsSync(MANIFEST)) return [];
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return []; }
}
function save(entries) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(entries, null, 2));
}

function rel(abs) { return path.relative(PROJECT_ROOT, abs) || abs; }

function resolveAbs(arg) {
  if (!arg) return null;
  return path.resolve(process.cwd(), arg);
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function entryForFile(entries, fileArg) {
  const abs = resolveAbs(fileArg);
  const e = entries.find(e => e.file === abs);
  if (!e) { console.error(col("red", `No snapshot for: ${fileArg}`)); process.exit(1); }
  return e;
}

// ─── list ────────────────────────────────────────────────────────────────────
function cmdList() {
  const entries = load();
  if (!entries.length) { console.log(col("dim", "\nNo snapshots yet.\n")); return; }

  console.log(bold(`\n  Claude Code changes  (${entries.length} file${entries.length > 1 ? "s" : ""})\n`));
  for (const e of entries) {
    const exists = fs.existsSync(e.file);
    let tag;
    if (!e.existed)       tag = col("green",  " NEW ");
    else if (!exists)     tag = col("red",    " DEL ");
    else                  tag = col("cyan",   " MOD ");

    const blobInfo = e.blob ? col("gray", `[blob:${e.blob.slice(0,7)}]`) : col("yellow", "[no-git]");
    console.log(`  ${tag} ${bold(e.rel || rel(e.file))}  ${col("gray", fmtTime(e.ts))}  ${blobInfo}`);
  }
  console.log();
  console.log(col("dim", "  claude-diff diff [file]     diff original → current"));
  console.log(col("dim", "  claude-diff stage           push to git index → IDE shows diffs"));
  console.log(col("dim", "  claude-diff show [file]     open VSCode diff view"));
  console.log(col("dim", "  claude-diff revert [file]   restore file"));
  console.log();
}

// ─── status ──────────────────────────────────────────────────────────────────
function cmdStatus() {
  const entries = load();
  if (!entries.length) { console.log(col("dim", "\nNothing tracked by claude-diff.\n")); return; }

  const newF = entries.filter(e => !e.existed);
  const modF = entries.filter(e => e.existed && fs.existsSync(e.file));
  const delF = entries.filter(e => e.existed && !fs.existsSync(e.file));

  console.log(bold("\nClaude Code — changes summary\n"));
  if (newF.length) { console.log(col("green",  "  New files:")); newF.forEach(e => console.log(col("green",  `    + ${e.rel || rel(e.file)}`))); }
  if (modF.length) { console.log(col("cyan",   "  Modified:")); modF.forEach(e => console.log(col("cyan",   `    ~ ${e.rel || rel(e.file)}`))); }
  if (delF.length) { console.log(col("red",    "  Deleted after snapshot:")); delF.forEach(e => console.log(col("red", `    - ${e.rel || rel(e.file)}`))); }
  console.log();

  // Check if staged
  const r = git("diff", "--name-only", "--cached");
  if (r.ok && r.stdout) {
    console.log(col("yellow", "  Tip: git index has staged content — run 'claude-diff unstage' to clear it\n"));
  }
}

// ─── diff ─────────────────────────────────────────────────────────────────────
function cmdDiff(fileArg) {
  const entries = load();
  const targets = fileArg ? [entryForFile(entries, fileArg)] : entries;
  if (!targets.length) { console.log(col("dim", "Nothing to diff.")); return; }

  for (const e of targets) {
    console.log(bold(`\n─── ${e.rel || rel(e.file)} ───`));

    if (!e.existed) {
      console.log(col("green", "  (new file created by Claude)"));
      if (fs.existsSync(e.file)) {
        fs.readFileSync(e.file, "utf8").split("\n").forEach(l => console.log(col("green", `  + ${l}`)));
      }
      continue;
    }

    if (!fs.existsSync(e.file)) {
      console.log(col("red", "  (file deleted after snapshot)"));
      continue;
    }

    if (e.blob && hasGit()) {
      // git diff between blob and working file — proper unified diff
      const r = spawnSync("git", [
        "-C", PROJECT_ROOT,
        "diff", "--color=always",
        `--src-prefix=original/`, `--dst-prefix=claude/`,
        e.blob, "--", e.file,
      ], { encoding: "utf8" });
      process.stdout.write(r.stdout || col("dim", "  (no changes)\n"));
    } else if (e.backup && fs.existsSync(e.backup)) {
      // Fallback: system diff
      const r = spawnSync("diff", ["--color=always", "-u",
        "--label", `original/${e.rel || rel(e.file)}`,
        "--label", `claude/${e.rel || rel(e.file)}`,
        e.backup, e.file,
      ], { encoding: "utf8" });
      process.stdout.write(r.stdout || col("dim", "  (no changes)\n"));
    } else {
      console.log(col("yellow", "  (no backup available — file was not in git)"));
    }
  }
  console.log();
}

// ─── stage — push pre-Claude originals into git index ────────────────────────
// After this, `git diff` and your IDE show Claude's edits as unstaged changes.
function cmdStage(fileArg) {
  if (!hasGit()) { console.error(col("red", "Not a git repo.")); process.exit(1); }

  const entries = load();
  const targets = fileArg ? [entryForFile(entries, fileArg)] : entries.filter(e => e.existed && e.blob);

  if (!targets.length) {
    console.log(col("dim", "No staged-able entries (need files with git blobs)."));
    return;
  }

  console.log(bold("\nStaging pre-Claude originals into git index…\n"));
  let count = 0;

  for (const e of targets) {
    if (!e.existed || !e.blob) {
      // New file created by Claude — remove from index so it shows as untracked
      const r = git("rm", "--cached", "--force", "--quiet", "--", e.file);
      if (r.ok) {
        console.log(col("yellow", `  removed from index  ${e.rel || rel(e.file)}  (Claude created this)`));
        count++;
      }
      continue;
    }

    const relFile = e.rel || rel(e.file);
    const mode    = e.mode || "100644";

    // git update-index --cacheinfo puts blob into index WITHOUT writing to working tree
    const r = git("update-index", "--add", "--cacheinfo", `${mode},${e.blob},${relFile}`);
    if (r.ok) {
      console.log(col("green", `  staged  ${relFile}`));
      count++;
    } else {
      console.log(col("yellow", `  skip    ${relFile}  (${r.stderr || "not tracked"})`));
    }
  }

  console.log();
  if (count > 0) {
    console.log(col("green", `  ${count} file(s) staged. Your IDE git panel now shows Claude's changes.`));
    console.log(col("dim",   "  The working tree is untouched — Claude's edits are still there."));
    console.log(col("dim",   "  When happy: git add -p && git commit"));
    console.log(col("dim",   "  To undo:    claude-diff revert <file>  or  git checkout -- <file>"));
    console.log(col("dim",   "  To unstage: claude-diff unstage\n"));
  }
}

// ─── unstage — restore git index to HEAD (undo stage) ────────────────────────
function cmdUnstage(fileArg) {
  if (!hasGit()) { console.error(col("red", "Not a git repo.")); process.exit(1); }

  if (fileArg) {
    const r = git("reset", "HEAD", "--", resolveAbs(fileArg));
    if (r.ok) console.log(col("cyan", `Unstaged: ${fileArg}`));
    else console.error(col("red", r.stderr));
  } else {
    const entries = load();
    for (const e of entries) {
      git("reset", "HEAD", "--quiet", "--", e.file);
    }
    console.log(col("cyan", "Restored git index to HEAD for all claude-diff tracked files."));
  }
  console.log();
}

// ─── show — open VSCode diff view ────────────────────────────────────────────
function cmdShow(fileArg) {
  const entries = load();
  const targets = fileArg ? [entryForFile(entries, fileArg)] : entries.filter(e => e.existed);

  if (!targets.length) { console.log(col("dim", "Nothing to show.")); return; }

  for (const e of targets) {
    if (!e.existed || !fs.existsSync(e.file)) continue;

    let originalPath = null;

    if (e.blob && hasGit()) {
      originalPath = blobToTempFile(e.blob, e.file);
    } else if (e.backup && fs.existsSync(e.backup)) {
      originalPath = e.backup;
    }

    if (!originalPath) {
      console.log(col("yellow", `  Skipping ${rel(e.file)} — no original available`));
      continue;
    }

    // Try VSCode
    const vscode = spawnSync("code", ["--diff", originalPath, e.file], { encoding: "utf8" });
    if (vscode.error) {
      // Try cursor
      const cursor = spawnSync("cursor", ["--diff", originalPath, e.file], { encoding: "utf8" });
      if (cursor.error) {
        console.log(col("yellow", `  Couldn't open IDE diff. Try:`));
        console.log(`    code --diff "${originalPath}" "${e.file}"`);
        console.log(`    cursor --diff "${originalPath}" "${e.file}"`);
      } else {
        console.log(col("green", `  Opened in Cursor: ${rel(e.file)}`));
      }
    } else {
      console.log(col("green", `  Opened in VSCode: ${rel(e.file)}`));
    }
  }
}

// ─── revert ──────────────────────────────────────────────────────────────────
function cmdRevert(fileArg, all) {
  const entries = load();

  const targets = all ? entries : [entryForFile(entries, fileArg)];
  if (!targets.length) { console.log(col("dim", "Nothing to revert.")); return; }

  console.log(bold(`\nReverting ${targets.length} file(s)…\n`));
  const reverted = [];

  for (const e of targets) {
    const relFile = e.rel || rel(e.file);

    if (!e.existed) {
      if (fs.existsSync(e.file)) { fs.unlinkSync(e.file); console.log(col("red", `  DEL  ${relFile}`)); }
      else console.log(col("gray", `  ---  ${relFile}  (already gone)`));
      reverted.push(e.file);
      continue;
    }

    if (e.blob && hasGit()) {
      // Restore directly from git object store
      const r = git("cat-file", "blob", e.blob);
      if (r.ok) {
        fs.writeFileSync(e.file, r.stdout);
        console.log(col("cyan", `  OK   ${relFile}`));
        reverted.push(e.file);
        continue;
      }
    }

    if (e.backup && fs.existsSync(e.backup)) {
      fs.copyFileSync(e.backup, e.file);
      console.log(col("cyan", `  OK   ${relFile}  (from file backup)`));
      reverted.push(e.file);
      continue;
    }

    console.log(col("yellow", `  ???  ${relFile}  (no backup found)`));
  }

  // Remove reverted entries from manifest
  const remaining = entries.filter(e => !reverted.includes(e.file));
  save(remaining);

  console.log();
  if (all) console.log(col("green", "All files restored.\n"));
}

// ─── clear ────────────────────────────────────────────────────────────────────
function cmdClear() {
  // Also unstage if staged
  if (hasGit()) {
    const entries = load();
    for (const e of entries) git("reset", "HEAD", "--quiet", "--", e.file);
  }
  if (fs.existsSync(STORE_DIR)) {
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
    console.log(col("green", "Snapshot store cleared.\n"));
  } else {
    console.log(col("dim", "Nothing to clear."));
  }
}

// ─── help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
  ${bold("claude-diff")}  v2  —  local undo + IDE integration for Claude Code

  ${bold("Commands:")}
    list                  Show all snapshotted files
    status                Git-status style summary
    diff  [file]          Unified diff: original → current
    stage [file]          Push originals into git index
                          → IDE git panel shows Claude's edits as unstaged diffs
    unstage [file]        Restore git index to HEAD
    show  [file]          Open VSCode / Cursor diff view
    revert <file>         Restore one file from snapshot
    revert --all          Restore all files
    clear                 Wipe store + unstage

  ${bold("Typical workflow:")}
    1. Claude edits files  →  hook auto-snapshots originals
    2. ${col("cyan", "claude-diff stage")}         →  your IDE git panel lights up
    3. Review in IDE, then:
       ${col("green", "git add -p && git commit")}    keep Claude's changes (clean commit)
       ${col("red",   "claude-diff revert --all")}    throw everything away

  ${bold("Setup:")}
    bash setup.sh          per-project
    bash setup.sh --global install hook globally (~/.claude/)
`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────
const [,, cmd, arg1] = process.argv;
const isAll = arg1 === "--all";

switch (cmd) {
  case "list":    cmdList();                                          break;
  case "status":  cmdStatus();                                        break;
  case "diff":    cmdDiff(arg1);                                      break;
  case "stage":   cmdStage(arg1);                                     break;
  case "unstage": cmdUnstage(arg1);                                   break;
  case "show":    cmdShow(arg1);                                      break;
  case "revert":  cmdRevert(!isAll ? arg1 : null, isAll);            break;
  case "clear":   cmdClear();                                         break;
  default:        printHelp();                                         break;
}
