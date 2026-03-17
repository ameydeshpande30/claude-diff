# Contributing

Thanks for wanting to help! claude-diff is intentionally small — Bash + Node, no dependencies.

## Structure

```
hooks/pre-save-hook.sh   ←  runs before every Claude file edit (Bash + Python 3)
claude-diff.js           ←  CLI (Node.js, no npm deps)
setup.sh                 ←  installer (Bash)
```

## Running locally

No build step. Just:

```bash
# Test the CLI against a real project
cd /your/test/project
node /path/to/claude-diff/claude-diff.js list

# Test the hook manually (pipe a fake tool call JSON)
echo '{"tool_name":"Edit","tool_input":{"file_path":"./test.txt"}}' \
  | bash hooks/pre-save-hook.sh
```

## Guidelines

- Keep it dependency-free (no npm packages in the CLI, no pip packages in the hook)
- Bash must stay POSIX-compatible enough for macOS + Linux
- The hook must be fast — it runs on every single file edit

## Issues & PRs

Open an issue first for anything bigger than a typo fix, so we can discuss before you invest time in a PR.
