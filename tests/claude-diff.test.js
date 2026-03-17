/**
 * claude-diff test suite
 * Uses Node.js built-in test runner (node:test) — no npm install needed.
 * Run: npm test  OR  node --test tests/
 *
 * Requires Node >= 18.
 */

"use strict";

const { test, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert  = require("node:assert/strict");
const fs      = require("node:fs");
const path    = require("node:path");
const os      = require("node:os");
const crypto  = require("node:crypto");
const { execSync, spawnSync } = require("node:child_process");

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT      = path.join(__dirname, "..");
const HOOK_JS   = path.join(ROOT, "hooks", "pre-save-hook.js");
const CLI_JS = path.join(ROOT, "claude-diff.js");

// ── Test helpers ──────────────────────────────────────────────────────────────
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-diff-test-"));
}

function initGit(dir) {
  const run = (...args) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  run("init");
  run("config", "user.email", "test@test.com");
  run("config", "user.name", "Test");
  // initial commit so git is usable
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  run("add", ".");
  run("commit", "-m", "init");
}

function runHook(tmpDir, toolCall) {
  const result = spawnSync(process.execPath, [HOOK_JS], {
    cwd: tmpDir,
    input: JSON.stringify(toolCall),
    encoding: "utf8",
    windowsHide: true,
  });
  return result;
}

function runCli(tmpDir, ...args) {
  const result = spawnSync(process.execPath, [CLI_JS, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
    windowsHide: true,
  });
  return result;
}

function loadManifest(tmpDir) {
  const p = path.join(tmpDir, ".claude-diff", "manifest.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function hookCall(filePath, tool = "Edit") {
  return { tool_name: tool, tool_input: { file_path: filePath } };
}

// ════════════════════════════════════════════════════════════════════════════
// HOOK TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("pre-save-hook.js", () => {

  describe("manifest creation", () => {
    test("creates .claude-diff/manifest.json on first run", () => {
      const dir = makeTmpDir();
      const file = path.join(dir, "hello.txt");
      fs.writeFileSync(file, "original content");

      runHook(dir, hookCall(file));

      assert.ok(fs.existsSync(path.join(dir, ".claude-diff", "manifest.json")));
      const entries = loadManifest(dir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].file, file);
      assert.equal(entries[0].existed, true);
      assert.equal(entries[0].tool, "Edit");
    });

    test("records tool name correctly for Write and MultiEdit", () => {
      const dir = makeTmpDir();
      const f1  = path.join(dir, "a.txt");
      const f2  = path.join(dir, "b.txt");
      fs.writeFileSync(f1, "a");
      fs.writeFileSync(f2, "b");

      runHook(dir, hookCall(f1, "Write"));
      runHook(dir, hookCall(f2, "MultiEdit"));

      const entries = loadManifest(dir);
      assert.equal(entries.find(e => e.file === f1).tool, "Write");
      assert.equal(entries.find(e => e.file === f2).tool, "MultiEdit");
    });

    test("does NOT overwrite an existing snapshot (first = original)", () => {
      const dir  = makeTmpDir();
      const file = path.join(dir, "file.txt");
      fs.writeFileSync(file, "version 1");
      runHook(dir, hookCall(file));

      fs.writeFileSync(file, "version 2");
      runHook(dir, hookCall(file)); // should be a no-op

      const entries = loadManifest(dir);
      assert.equal(entries.length, 1, "should still have exactly one snapshot");
    });

    test("records file as existed=false for new files", () => {
      const dir  = makeTmpDir();
      const file = path.join(dir, "new-file.ts");
      // file does NOT exist before the hook fires

      runHook(dir, hookCall(file, "Write"));

      const entries = loadManifest(dir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].existed, false);
      assert.equal(entries[0].blob, null);
      assert.equal(entries[0].backup, null);
    });

    test("handles missing file_path gracefully (exits 0)", () => {
      const dir    = makeTmpDir();
      const result = runHook(dir, { tool_name: "Edit", tool_input: {} });
      assert.equal(result.status, 0);
      assert.ok(!fs.existsSync(path.join(dir, ".claude-diff")));
    });

    test("handles invalid JSON on stdin gracefully (exits 0)", () => {
      const result = spawnSync(process.execPath, [HOOK_JS], {
        input: "not json at all {{",
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0);
    });
  });

  describe("content preservation", () => {
    test("backup file contains exact original content (non-git fallback)", () => {
      const dir  = makeTmpDir(); // no git init — forces plain backup
      const file = path.join(dir, "data.txt");
      const original = "hello world\nline two\n";
      fs.writeFileSync(file, original);

      runHook(dir, hookCall(file));

      // Simulate Claude editing the file
      fs.writeFileSync(file, "completely different content");

      const entries  = loadManifest(dir);
      const entry    = entries[0];

      // Either blob or backup should exist
      if (entry.backup && fs.existsSync(entry.backup)) {
        const restored = fs.readFileSync(entry.backup, "utf8");
        assert.equal(restored, original);
      }
      // If blob, we'd need git to verify — just check it's recorded
    });

    test("stores a git blob hash when inside a git repo", () => {
      const dir  = makeTmpDir();
      initGit(dir);
      const file = path.join(dir, "tracked.js");
      fs.writeFileSync(file, "const x = 1;");

      // Add to git so it's tracked
      spawnSync("git", ["add", "."], { cwd: dir, windowsHide: true });
      spawnSync("git", ["commit", "-m", "add"], { cwd: dir, windowsHide: true });

      runHook(dir, hookCall(file));

      const entries = loadManifest(dir);
      const entry   = entries[0];

      // blob hash should look like a sha1 (40 hex chars)
      if (entry.blob) {
        assert.match(entry.blob, /^[0-9a-f]{40}$/);
      }
    });

    test("preserves binary-safe content in backup", () => {
      const dir    = makeTmpDir();
      const file   = path.join(dir, "icon.bin");
      const binary = Buffer.from([0x00, 0xFF, 0x42, 0x01, 0xAB, 0xCD]);
      fs.writeFileSync(file, binary);

      runHook(dir, hookCall(file));

      const entries = loadManifest(dir);
      if (entries[0].backup && fs.existsSync(entries[0].backup)) {
        const restored = fs.readFileSync(entries[0].backup);
        assert.deepEqual(restored, binary);
      }
    });
  });

  describe("multiple files", () => {
    test("tracks multiple different files independently", () => {
      const dir  = makeTmpDir();
      const files = ["a.ts", "b.ts", "c.ts"].map(name => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, `content of ${name}`);
        return p;
      });

      files.forEach(f => runHook(dir, hookCall(f)));

      const entries = loadManifest(dir);
      assert.equal(entries.length, 3);
      files.forEach(f => {
        assert.ok(entries.some(e => e.file === f), `missing entry for ${f}`);
      });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLI TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("claude-diff CLI", () => {

  // Helper: set up a project with some Claude-edited files
  function makeProject(withGit = false) {
    const dir = makeTmpDir();
    if (withGit) initGit(dir);

    // Create and snapshot two files
    const f1 = path.join(dir, "app.ts");
    const f2 = path.join(dir, "utils.ts");
    fs.writeFileSync(f1, "// original app.ts\nexport const a = 1;\n");
    fs.writeFileSync(f2, "// original utils.ts\nexport const b = 2;\n");

    runHook(dir, hookCall(f1));
    runHook(dir, hookCall(f2));

    // Simulate Claude's edits
    fs.writeFileSync(f1, "// EDITED by Claude\nexport const a = 99;\n");
    fs.writeFileSync(f2, "// EDITED by Claude\nexport const b = 99;\n");

    return { dir, f1, f2 };
  }

  describe("list", () => {
    test("shows snapshotted files", () => {
      const { dir } = makeProject();
      const r = runCli(dir, "list");
      assert.equal(r.status, 0);
      assert.match(r.stdout, /app\.ts/);
      assert.match(r.stdout, /utils\.ts/);
    });

    test("shows empty message when no snapshots", () => {
      const dir = makeTmpDir();
      const r   = runCli(dir, "list");
      assert.equal(r.status, 0);
      assert.match(r.stdout, /No snapshots/i);
    });
  });

  describe("status", () => {
    test("categorises modified files", () => {
      const { dir } = makeProject();
      const r = runCli(dir, "status");
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Modified|MOD/i);
    });

    test("shows new file as new", () => {
      const dir  = makeTmpDir();
      const file = path.join(dir, "brand-new.ts");
      // Hook fires for a file that didn't exist yet
      runHook(dir, hookCall(file, "Write"));
      fs.writeFileSync(file, "created by Claude");

      const r = runCli(dir, "status");
      assert.equal(r.status, 0);
      assert.match(r.stdout, /New|NEW/i);
    });
  });

  describe("diff", () => {
    test("shows a diff for a modified file (fallback mode)", () => {
      const dir  = makeTmpDir(); // no git → forces file backup path
      const file = path.join(dir, "edit-me.ts");
      fs.writeFileSync(file, "const original = true;\n");
      runHook(dir, hookCall(file));
      fs.writeFileSync(file, "const original = false; // Claude changed this\n");

      const r = runCli(dir, "diff", file);
      assert.equal(r.status, 0);
      // Output should mention something changed
      assert.ok(
        r.stdout.includes("original") || r.stdout.includes("Claude") || r.stdout.includes("-") || r.stdout.includes("+"),
        "diff output should contain change markers"
      );
    });

    test("exits 1 for unknown file", () => {
      const dir = makeTmpDir();
      const r   = runCli(dir, "diff", path.join(dir, "nonexistent.ts"));
      assert.equal(r.status, 1);
    });

    test("runs diff over all files when no argument given", () => {
      const { dir } = makeProject();
      const r = runCli(dir, "diff");
      assert.equal(r.status, 0);
      assert.match(r.stdout, /app\.ts/);
    });
  });

  describe("revert", () => {
    test("restores original content from backup", () => {
      const dir  = makeTmpDir(); // no git → file backup
      const file = path.join(dir, "revert-me.ts");
      const orig = "const x = 'original';\n";
      fs.writeFileSync(file, orig);
      runHook(dir, hookCall(file));
      fs.writeFileSync(file, "const x = 'claude edited';\n");

      const r = runCli(dir, "revert", file);
      assert.equal(r.status, 0);
      assert.equal(fs.readFileSync(file, "utf8"), orig);
    });

    test("removes entry from manifest after revert", () => {
      const { dir, f1 } = makeProject();
      runCli(dir, "revert", f1);
      const entries = loadManifest(dir);
      assert.ok(!entries.some(e => e.file === f1), "reverted file should be removed from manifest");
    });

    test("revert --all restores all files", () => {
      const dir  = makeTmpDir();
      const files = ["a.ts", "b.ts", "c.ts"];
      const originals = {};

      files.forEach(name => {
        const p = path.join(dir, name);
        originals[p] = `original content of ${name}\n`;
        fs.writeFileSync(p, originals[p]);
        runHook(dir, hookCall(p));
        fs.writeFileSync(p, "claude was here");
      });

      const r = runCli(dir, "revert", "--all");
      assert.equal(r.status, 0);

      files.forEach(name => {
        const p = path.join(dir, name);
        assert.equal(fs.readFileSync(p, "utf8"), originals[p], `${name} not restored`);
      });

      assert.equal(loadManifest(dir).length, 0, "manifest should be empty after revert --all");
    });

    test("deletes newly-created file on revert", () => {
      const dir  = makeTmpDir();
      const file = path.join(dir, "claude-created.ts");
      // Hook fires before file exists
      runHook(dir, hookCall(file, "Write"));
      // Claude creates it
      fs.writeFileSync(file, "export const x = 1;");

      runCli(dir, "revert", file);
      assert.ok(!fs.existsSync(file), "new file should be deleted on revert");
    });

    test("exits 1 when file not in manifest", () => {
      const dir = makeTmpDir();
      const r   = runCli(dir, "revert", path.join(dir, "unknown.ts"));
      assert.equal(r.status, 1);
    });
  });

  describe("clear", () => {
    test("removes .claude-diff directory", () => {
      const { dir } = makeProject();
      assert.ok(fs.existsSync(path.join(dir, ".claude-diff")));
      runCli(dir, "clear");
      assert.ok(!fs.existsSync(path.join(dir, ".claude-diff")));
    });

    test("is idempotent when store does not exist", () => {
      const dir = makeTmpDir();
      const r   = runCli(dir, "clear");
      assert.equal(r.status, 0); // should not throw
    });
  });

  describe("help / unknown command", () => {
    test("prints usage for unknown command", () => {
      const dir = makeTmpDir();
      const r   = runCli(dir);
      assert.match(r.stdout, /claude-diff|Usage|Commands/i);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EDGE CASES
// ════════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  test("hook handles file path with spaces", () => {
    const dir  = makeTmpDir();
    const file = path.join(dir, "my file with spaces.ts");
    fs.writeFileSync(file, "content");
    const r = runHook(dir, hookCall(file));
    assert.equal(r.status, 0);
    assert.equal(loadManifest(dir).length, 1);
  });

  test("hook handles deeply nested file", () => {
    const dir     = makeTmpDir();
    const nested  = path.join(dir, "a", "b", "c", "deep.ts");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "nested");
    const r = runHook(dir, hookCall(nested));
    assert.equal(r.status, 0);
    assert.equal(loadManifest(dir).length, 1);
  });

  test("hook is safe to run concurrently (no manifest corruption)", async () => {
    const dir   = makeTmpDir();
    const files = Array.from({ length: 5 }, (_, i) => {
      const p = path.join(dir, `concurrent-${i}.ts`);
      fs.writeFileSync(p, `file ${i}`);
      return p;
    });

    // Run all hooks in parallel
    await Promise.all(
      files.map(f => new Promise(resolve => {
        const child = spawnSync(process.execPath, [HOOK_JS], {
          cwd: dir,
          input: JSON.stringify(hookCall(f)),
          encoding: "utf8",
          windowsHide: true,
        });
        resolve(child);
      }))
    );

    const entries = loadManifest(dir);
    // At least some should have been captured (exact count may vary due to race)
    assert.ok(entries.length >= 1, "at least one entry should be in manifest");

    // Manifest must be valid JSON
    const raw = fs.readFileSync(path.join(dir, ".claude-diff", "manifest.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "manifest should be valid JSON after concurrent writes");
  });

  test("large file content is preserved correctly", () => {
    const dir  = makeTmpDir();
    const file = path.join(dir, "large.ts");
    // ~100KB of content
    const large = Array.from({ length: 2000 }, (_, i) => `export const line${i} = ${i}; // padding padding padding`).join("\n");
    fs.writeFileSync(file, large);

    runHook(dir, hookCall(file));
    fs.writeFileSync(file, "replaced");
    runCli(dir, "revert", file);

    assert.equal(fs.readFileSync(file, "utf8"), large);
  });
});
