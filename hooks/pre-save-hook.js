#!/usr/bin/env node
/**
 * claude-diff pre-save hook
 * Fires before Claude Code edits any file (PreToolUse: Edit|Write|MultiEdit).
 * Stores the original file content as a git blob object so you can diff/revert later.
 *
 * Works on macOS, Linux, and Windows (no bash, no Python required).
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const crypto  = require("crypto");
const { spawnSync } = require("child_process");

// ── Read tool-call JSON from stdin (cross-platform: read fd 0 directly) ─────
function readStdinSync() {
  const chunks = [];
  const buf    = Buffer.alloc(65536);
  while (true) {
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length); } catch { break; }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.slice(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let input = "";
try {
  input = readStdinSync();
} catch {
  process.exit(0);
}
if (!input.trim()) process.exit(0);

let toolCall;
try { toolCall = JSON.parse(input); } catch { process.exit(0); }

const toolInput = toolCall.tool_input || {};
const filePath  = toolInput.file_path || toolInput.path || "";
if (!filePath) process.exit(0);

// ── Resolve absolute path (cross-platform realpath) ──────────────────────────
const absPath = path.resolve(filePath);

// ── Locate git root (walk up from file's directory) ──────────────────────────
function findGitRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

const fileDir  = fs.existsSync(absPath) ? path.dirname(absPath) : process.cwd();
const gitRoot  = findGitRoot(fileDir) || process.cwd();
const storeDir = path.join(gitRoot, ".claude-diff");
const manifest = path.join(storeDir, "manifest.json");

fs.mkdirSync(path.join(storeDir, "backups"), { recursive: true });

// ── Load manifest ────────────────────────────────────────────────────────────
let entries = [];
try { entries = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch {}

// Already have a snapshot for this file? Don't overwrite — first = original.
if (entries.some(e => e.file === absPath)) process.exit(0);

const toolName   = toolCall.tool_name || "Edit";
const timestamp  = new Date().toISOString();
const fileExisted = fs.existsSync(absPath);
const relFile     = path.relative(gitRoot, absPath);

// ── Store content ─────────────────────────────────────────────────────────────
let blobHash = null;
let backupPath = null;
let fileMode = "100644";

if (fileExisted) {
  // Try git hash-object first
  const r = spawnSync("git", ["-C", gitRoot, "hash-object", "-w", absPath], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (r.status === 0 && r.stdout.trim()) {
    blobHash = r.stdout.trim();

    // Get file mode if tracked
    const modeResult = spawnSync(
      "git", ["-C", gitRoot, "ls-files", "--format=%(objectmode)", absPath],
      { encoding: "utf8", windowsHide: true }
    );
    if (modeResult.status === 0 && modeResult.stdout.trim()) {
      fileMode = modeResult.stdout.trim();
    }
  } else {
    // Fallback: plain file copy (non-git project, or git not installed)
    const id = crypto.randomBytes(6).toString("hex");
    backupPath = path.join(storeDir, "backups", `${Date.now()}_${id}`);
    fs.copyFileSync(absPath, backupPath);
  }
}

// ── Append to manifest ────────────────────────────────────────────────────────
entries.push({
  file:     absPath,
  rel:      relFile,
  existed:  fileExisted,
  tool:     toolName,
  ts:       timestamp,
  blob:     blobHash,
  mode:     fileMode,
  backup:   backupPath,
  git_root: gitRoot,
});

fs.writeFileSync(manifest, JSON.stringify(entries, null, 2));
process.exit(0);
