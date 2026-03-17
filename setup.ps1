# setup.ps1 — claude-diff installer for Windows
# Run from your project root: .\setup.ps1
# Global install:             .\setup.ps1 -Global

param(
  [switch]$Global,
  [string]$ProjectDir = (Get-Location).Path
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HookScript = Join-Path $ScriptDir "hooks\pre-save-hook.js"
$CliScript  = Join-Path $ScriptDir "claude-diff.js"

function Write-Ok($msg)   { Write-Host "  " -NoNewline; Write-Host "✓" -ForegroundColor Green -NoNewline; Write-Host "  $msg" }
function Write-Info($msg) { Write-Host "  " -NoNewline; Write-Host "→" -ForegroundColor Cyan  -NoNewline; Write-Host "  $msg" }

function Register-Hook($settingsFile, $hookPath) {
  $json = if (Test-Path $settingsFile) { Get-Content $settingsFile -Raw | ConvertFrom-Json } else { @{} }

  if (-not $json.hooks) { $json | Add-Member -NotePropertyName hooks -NotePropertyValue @{} }
  if (-not $json.hooks.PreToolUse) { $json.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @() }

  $matcher = "Edit|Write|MultiEdit"
  $command = "node `"$hookPath`""

  $exists = $json.hooks.PreToolUse | Where-Object {
    $_.matcher -eq $matcher -and ($_.hooks | Where-Object { $_.command -eq $command })
  }

  if (-not $exists) {
    $hookEntry = [PSCustomObject]@{
      matcher = $matcher
      hooks   = @([PSCustomObject]@{ type = "command"; command = $command })
    }
    $json.hooks.PreToolUse = @($json.hooks.PreToolUse) + $hookEntry
  }

  $json | ConvertTo-Json -Depth 10 | Set-Content $settingsFile
}

if ($Global) {
  Write-Host "`nInstalling claude-diff globally (~/.claude/)...`n" -ForegroundColor White

  $GlobalDir      = Join-Path $env:USERPROFILE ".claude"
  $GlobalHooksDir = Join-Path $GlobalDir "hooks"
  $GlobalSettings = Join-Path $GlobalDir "settings.json"
  $GlobalHook     = Join-Path $GlobalHooksDir "pre-save-hook.js"
  $GlobalCli      = Join-Path $GlobalDir "claude-diff.js"

  New-Item -ItemType Directory -Force -Path $GlobalHooksDir | Out-Null

  Copy-Item $HookScript $GlobalHook -Force
  Copy-Item $CliScript  $GlobalCli  -Force
  Write-Ok "Copied hook → $GlobalHook"
  Write-Ok "Copied CLI  → $GlobalCli"

  if (-not (Test-Path $GlobalSettings)) { '{}' | Set-Content $GlobalSettings }
  Register-Hook $GlobalSettings $GlobalHook
  Write-Ok "Hook registered in ~/.claude/settings.json"

  # Add to PATH via user environment
  $userPath  = [Environment]::GetEnvironmentVariable("PATH", "User")
  $localBin  = Join-Path $env:USERPROFILE "AppData\Local\Microsoft\WindowsApps"

  $wrapperDir = Join-Path $env:USERPROFILE ".local\bin"
  New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
  $wrapper = Join-Path $wrapperDir "claude-diff.cmd"
  "@echo off`nnode `"$GlobalCli`" %*" | Set-Content $wrapper
  Write-Ok "CLI wrapper: $wrapper"

  if ($userPath -notlike "*$wrapperDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$userPath;$wrapperDir", "User")
    Write-Info "Added $wrapperDir to user PATH (restart terminal to take effect)"
  }

  Write-Host "`nGlobal install complete! Run claude-diff from any project.`n" -ForegroundColor Green

} else {
  Write-Host "`nInstalling claude-diff in: $ProjectDir`n" -ForegroundColor White

  $ClaudeDir   = Join-Path $ProjectDir ".claude"
  $HooksDir    = Join-Path $ClaudeDir "hooks"
  $Settings    = Join-Path $ClaudeDir "settings.json"
  $DestHook    = Join-Path $HooksDir "pre-save-hook.js"
  $DestCli     = Join-Path $ClaudeDir "claude-diff.js"
  $Gitignore   = Join-Path $ProjectDir ".gitignore"

  New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null
  Copy-Item $HookScript $DestHook -Force
  Copy-Item $CliScript  $DestCli  -Force
  Write-Ok "Copied hook → .claude\hooks\pre-save-hook.js"
  Write-Ok "Copied CLI  → .claude\claude-diff.js"

  if (-not (Test-Path $Settings)) { '{}' | Set-Content $Settings }
  Register-Hook $Settings $DestHook
  Write-Ok "Hook registered in .claude\settings.json"

  $entry = ".claude-diff/"
  if (Test-Path $Gitignore) {
    if (-not (Select-String -Path $Gitignore -Pattern [regex]::Escape($entry) -Quiet)) {
      "`n# claude-diff snapshots`n$entry" | Add-Content $Gitignore
      Write-Ok "Added .claude-diff/ to .gitignore"
    } else {
      Write-Ok ".gitignore already has .claude-diff/"
    }
  } else {
    "# claude-diff snapshots`n$entry" | Set-Content $Gitignore
    Write-Ok "Created .gitignore"
  }

  # Convenience wrapper
  $Wrapper = Join-Path $ProjectDir "claude-diff.cmd"
  "@echo off`nnode `"$DestCli`" %*" | Set-Content $Wrapper
  Write-Ok "Created claude-diff.cmd shortcut"

  Write-Host ""
  Write-Host "  claude-diff list" -ForegroundColor Cyan
  Write-Host "  claude-diff stage"  -ForegroundColor Cyan
  Write-Host "  claude-diff revert --all" -ForegroundColor Cyan
  Write-Host ""
}
