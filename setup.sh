#!/usr/bin/env bash
# setup.sh — install claude-diff per-project or globally
#
# Per-project (default):
#   bash setup.sh
#
# Global (all projects, all future sessions):
#   bash setup.sh --global

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false
PROJECT_DIR="$(pwd)"

for arg in "$@"; do
  case "$arg" in
    --global) GLOBAL=true ;;
    *)        PROJECT_DIR="$arg" ;;
  esac
done

# ── Colours ──────────────────────────────────────────────────────────────────
green="\033[32m"; yellow="\033[33m"; cyan="\033[36m"
bold="\033[1m"; dim="\033[2m"; reset="\033[0m"
ok()   { echo -e "  ${green}✓${reset}  $1"; }
info() { echo -e "  ${cyan}→${reset}  $1"; }
warn() { echo -e "  ${yellow}!${reset}  $1"; }

HOOK_SCRIPT="$SCRIPT_DIR/hooks/pre-save-hook.js"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# GLOBAL INSTALL  (~/.claude/settings.json)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if [ "$GLOBAL" = true ]; then
  echo -e "\n${bold}Installing claude-diff globally (~/.claude/)${reset}\n"

  GLOBAL_DIR="$HOME/.claude"
  GLOBAL_HOOKS_DIR="$GLOBAL_DIR/hooks"
  GLOBAL_SETTINGS="$GLOBAL_DIR/settings.json"
  GLOBAL_CLI="$GLOBAL_DIR/claude-diff.js"
  GLOBAL_HOOK="$GLOBAL_HOOKS_DIR/pre-save-hook.js"

  mkdir -p "$GLOBAL_HOOKS_DIR"

  # Copy files
  cp "$HOOK_SCRIPT"           "$GLOBAL_HOOK"
  cp "$SCRIPT_DIR/claude-diff.js" "$GLOBAL_CLI"
  chmod +x "$GLOBAL_HOOK"
  ok "Copied hook → $GLOBAL_HOOK"
  ok "Copied CLI  → $GLOBAL_CLI"

  # Register in ~/.claude/settings.json
  [ ! -f "$GLOBAL_SETTINGS" ] && echo '{}' > "$GLOBAL_SETTINGS"

  node - <<JSEOF
const fs = require("fs");
const file    = "$GLOBAL_SETTINGS";
const hook    = "$GLOBAL_HOOK";
const matcher = "Edit|Write|MultiEdit";
const command = 'node "' + hook + '"';

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

cfg.hooks = cfg.hooks || {};
cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];

const exists = cfg.hooks.PreToolUse.some(
  h => h.matcher === matcher && h.hooks?.some(hh => hh.command === command)
);

if (!exists) {
  cfg.hooks.PreToolUse.push({ matcher, hooks: [{ type: "command", command }] });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log("  registered");
} else {
  console.log("  already registered");
}
JSEOF

  ok "Hook registered in ~/.claude/settings.json (applies to all projects)"

  # Install claude-diff as a global CLI
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  CLI_LINK="$LOCAL_BIN/claude-diff"
  cat > "$CLI_LINK" <<EOF
#!/usr/bin/env bash
exec node "$GLOBAL_CLI" "\$@"
EOF
  chmod +x "$CLI_LINK"
  ok "Global CLI installed: $CLI_LINK"

  # Check PATH
  if ! echo "$PATH" | grep -q "$LOCAL_BIN"; then
    warn "$LOCAL_BIN is not in your PATH"
    echo -e "       Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo -e "       ${dim}export PATH=\"\$HOME/.local/bin:\$PATH\"${reset}"
  else
    ok "claude-diff is available in PATH"
  fi

  echo -e "\n${bold}Global install complete!${reset}"
  echo -e "  Every project will now snapshot files when Claude edits them."
  echo -e "  Run ${cyan}claude-diff help${reset} from any git project.\n"
  exit 0
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PER-PROJECT INSTALL  (.claude/settings.json in project)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${bold}Installing claude-diff in: $PROJECT_DIR${reset}\n"

PROJECT_CLAUDE_DIR="$PROJECT_DIR/.claude"
PROJECT_SETTINGS="$PROJECT_CLAUDE_DIR/settings.json"
DEST_HOOK="$PROJECT_CLAUDE_DIR/hooks/pre-save-hook.js"
DEST_CLI="$PROJECT_CLAUDE_DIR/claude-diff.js"
GITIGNORE="$PROJECT_DIR/.gitignore"

mkdir -p "$(dirname "$DEST_HOOK")"
cp "$HOOK_SCRIPT"               "$DEST_HOOK"
cp "$SCRIPT_DIR/claude-diff.js" "$DEST_CLI"
chmod +x "$DEST_HOOK"
ok "Copied hook → .claude/hooks/pre-save-hook.js"
ok "Copied CLI  → .claude/claude-diff.js"

# Register hook in project settings
[ ! -f "$PROJECT_SETTINGS" ] && echo '{}' > "$PROJECT_SETTINGS"

node - <<JSEOF
const fs = require("fs");
const file    = "$PROJECT_SETTINGS";
const hook    = "$DEST_HOOK";
const matcher = "Edit|Write|MultiEdit";
const command = 'node "' + hook + '"';

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

cfg.hooks = cfg.hooks || {};
cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];

const exists = cfg.hooks.PreToolUse.some(
  h => h.matcher === matcher && h.hooks?.some(hh => hh.command === command)
);

if (!exists) {
  cfg.hooks.PreToolUse.push({ matcher, hooks: [{ type: "command", command }] });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
JSEOF
ok "Hook registered in .claude/settings.json"

# .gitignore
ENTRY=".claude-diff/"
if [ -f "$GITIGNORE" ] && grep -qF "$ENTRY" "$GITIGNORE"; then
  ok ".gitignore already has .claude-diff/"
else
  printf "\n# claude-diff snapshots (local only)\n%s\n" "$ENTRY" >> "$GITIGNORE"
  ok "Added .claude-diff/ to .gitignore"
fi

# Convenience wrapper
WRAPPER="$PROJECT_DIR/claude-diff"
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
exec node "$(dirname "$0")/.claude/claude-diff.js" "$@"
EOF
chmod +x "$WRAPPER"
ok "Created ./claude-diff shortcut"

echo -e "\n${bold}Done!${reset}\n"
echo "  ${cyan}./claude-diff list${reset}         see what Claude changed"
echo "  ${cyan}./claude-diff stage${reset}        push to git index → IDE shows diffs"
echo "  ${cyan}./claude-diff show [file]${reset}  open VSCode diff"
echo "  ${cyan}./claude-diff revert --all${reset} undo everything"
echo ""
echo "  Tip: check in .claude/settings.json + .claude/hooks/ so teammates"
echo "       get the same hooks without running setup again."
echo ""
