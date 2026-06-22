#!/usr/bin/env pwsh
# Read-only environment check for installing Regimen on native Windows. It
# changes nothing. Run it before installing, or whenever capture does not fire,
# and send the output back when asking for install help.
#
# Run it (this form handles both the .\ requirement and the execution policy):
#   powershell -ExecutionPolicy Bypass -File .\check-windows-env.ps1

Write-Output "=== OS / shell ==="
Write-Output $PSVersionTable.PSVersion.ToString()
Write-Output $PSVersionTable.PSEdition
Write-Output ([System.Environment]::OSVersion.VersionString)
Write-Output "ExecutionPolicy: $(Get-ExecutionPolicy)"

Write-Output ""
Write-Output "=== tools on PATH ==="
foreach ($t in 'bun', 'git', 'node', 'npm', 'npx', 'jq', 'claude', 'codex', 'copilot', 'gemini', 'schtasks') {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  if ($c) { Write-Output ("{0,-9}: {1}" -f $t, $c.Source) }
  else { Write-Output ("{0,-9}: NOT FOUND" -f $t) }
}
if (Get-Command bun -ErrorAction SilentlyContinue) { Write-Output "bun version: $(bun --version)" }

Write-Output ""
Write-Output "=== harness config homes ==="
foreach ($h in @(
    @('claude', '.claude', 'CLAUDE_CONFIG_DIR'),
    @('codex', '.codex', 'CODEX_HOME'),
    @('copilot', '.copilot', 'COPILOT_HOME'),
    @('gemini', '.gemini', 'GEMINI_CONFIG_DIR')
  )) {
  $ov = [System.Environment]::GetEnvironmentVariable($h[2])
  $p = if ($ov) { $ov } else { Join-Path $env:USERPROFILE $h[1] }
  Write-Output ("{0,-8}: {1}  (exists: {2})  {3}={4}" -f $h[0], $p, (Test-Path $p), $h[2], $ov)
}

Write-Output ""
Write-Output "=== regimen state ==="
Write-Output "APPDATA: $env:APPDATA"
Write-Output "data dir exists: $(Test-Path (Join-Path $env:APPDATA 'regimen'))"
$task = schtasks /query /tn regimen-feedback /fo LIST 2>$null
if ($LASTEXITCODE -eq 0) { Write-Output ($task | Select-String 'TaskName|Status') }
else { Write-Output "regimen-feedback task: not registered" }
