[CmdletBinding()]
param(
  [string]$EnvFile,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$deployRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$remoteUrl = 'https://github.com/Zihan-li-1/saveflow-demo.git'
$composeFiles = @('-f', 'compose.yaml', '-f', 'compose.postgres.yaml')
$project = 'saveflow-local-check'
$webUrl = 'http://localhost:4300'

function Fail([string]$Message) { throw "SaveFlow deployment stopped: $Message" }
function Run([string]$File, [string[]]$CommandArgs) {
  & $File @CommandArgs
  if ($LASTEXITCODE -ne 0) { Fail "$File $($CommandArgs -join ' ') failed with exit code $LASTEXITCODE" }
}
function Compose([string[]]$ComposeArgs) { Run 'docker' (@('compose', '--project-name', $project) + $composeFiles + $ComposeArgs) }

Set-Location $deployRoot
if ([string]::IsNullOrWhiteSpace($EnvFile)) { $EnvFile = Join-Path $deployRoot '.env.local' }
if (-not (Test-Path $EnvFile)) {
  $fallback = Join-Path $deployRoot '..\saveflow-demo\.env.local'
  if (Test-Path $fallback) { $EnvFile = (Resolve-Path $fallback).Path }
  else { Fail "env file not found: $EnvFile" }
}

$actualRemote = (git remote get-url origin).Trim()
if ($actualRemote -ne $remoteUrl) { Fail "origin is '$actualRemote', expected '$remoteUrl'" }
$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
  Write-Warning 'Deployment directory has uncommitted changes. No fetch, reset, build, migration, or restart was performed.'
  $dirty | ForEach-Object { Write-Output "  $_" }
  Fail 'commit or stash local changes, then rerun this command'
}

Run 'git' @('fetch', '--prune', 'origin', 'main')
$githubSha = (git rev-parse 'origin/main').Trim()
if ($githubSha -notmatch '^[0-9a-f]{40}$') { Fail "invalid origin/main SHA: $githubSha" }
$localBefore = (git rev-parse HEAD).Trim()
Run 'git' @('merge', '--no-edit', 'origin/main')
$deploymentSha = (git rev-parse HEAD).Trim()

$portOwners = @(docker ps --format '{{.Names}} {{.Ports}}' | Where-Object { $_ -match '0\.0\.0\.0:4300|127\.0\.0\.1:4300' })
if ($portOwners.Count -gt 0 -and ($portOwners -notmatch 'saveflow-local-check-web-1')) { Fail "port 4300 is occupied by: $($portOwners -join '; ')" }
$env:SAVEFLOW_GIT_SHA = $githubSha
Compose @('--env-file', $EnvFile, 'build', '--build-arg', "SAVEFLOW_GIT_SHA=$githubSha", '--build-arg', 'SAVEFLOW_GIT_DIRTY=false', 'web')
Compose @('--env-file', $EnvFile, 'up', '-d', 'pilot-db')
Compose @('--env-file', $EnvFile, 'run', '--rm', 'pilot-migrate')
Compose @('--env-file', $EnvFile, 'up', '-d', 'web', 'mcp', 'bridge')

$required = @('saveflow-local-check-pilot-db-1', 'saveflow-local-check-web-1', 'saveflow-local-check-mcp-1', 'saveflow-local-check-bridge-1')
$ps = @()
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  $ps = @(docker compose --project-name $project @composeFiles --env-file $EnvFile ps --format json | ConvertFrom-Json)
  $ready = $true
  foreach ($name in $required) {
    $item = @($ps | Where-Object { $_.Name -eq $name })
    if ($item.Count -ne 1 -or $item[0].State -ne 'running' -or $item[0].Health -notin @('healthy', '')) { $ready = $false }
  }
  if ($ready) { break }
  Start-Sleep -Seconds 2
}
foreach ($name in $required) {
  $item = @($ps | Where-Object { $_.Name -eq $name })
  if ($item.Count -ne 1 -or $item[0].State -ne 'running' -or $item[0].Health -notin @('healthy', '')) { Fail "container is not healthy: $name" }
}
$health = Invoke-RestMethod "$webUrl/healthz"
$version = Invoke-RestMethod "$webUrl/version"
$labels = docker inspect --format '{{json .Config.Labels}}' 'saveflow-local-check-web-1' | ConvertFrom-Json
$imageSha = [string]$labels.'org.openai.saveflow.git-sha'
$imageDirty = [string]$labels.'org.openai.saveflow.git-dirty'
if ($health.ok -ne $true -or $version.gitSha -ne $githubSha -or $version.gitDirty -ne 'false' -or $imageSha -ne $githubSha -or $imageDirty -ne 'false') { Fail "version/health mismatch: GitHub=$githubSha web=$($version.gitSha) dirty=$($version.gitDirty) image=$imageSha imageDirty=$imageDirty" }

Write-Output "Deployment succeeded"
Write-Output "URL: $webUrl"
Write-Output "GitHub main: $githubSha"
Write-Output "Deployment tree commit: $deploymentSha"
Write-Output "Running Web image: $imageSha"
Write-Output "Working tree dirty: $($version.gitDirty)"
Write-Output 'Status: healthy; all three SHAs match'
if (-not $NoBrowser) { Start-Process $webUrl }
