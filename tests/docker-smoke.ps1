[CmdletBinding()]
param(
  [ValidatePattern('^[a-z0-9][a-z0-9_-]*$')][string]$ProjectName = "emby-task-center-smoke",
  [ValidateRange(1, 65535)][int]$Port = 13000,
  [ValidatePattern('^[a-z0-9][a-z0-9._/:@-]*$')][string]$Image,
  [switch]$Keep
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot "compose.yaml"
$runId = [guid]::NewGuid().ToString("N")
$ProjectName = "$ProjectName-$runId"
$smokeImage = if ($Image) { $Image } else { "emby-task-center-smoke:$runId" }
$composeStarted = $false
$requiredFiles = @(
  $composeFile,
  (Join-Path $projectRoot "Dockerfile"),
  (Join-Path $projectRoot ".dockerignore"),
  (Join-Path $projectRoot ".env.example")
)

foreach ($file in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Docker smoke prerequisite missing: $file"
  }
}
foreach ($command in @("docker", "pnpm", "node")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command missing: $command" }
}

$systemTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$smokeRoot = Join-Path $systemTempRoot ("emby-task-center-smoke-" + $runId)
$dataPath = Join-Path $smokeRoot "data"
New-Item -ItemType Directory -Path $dataPath | Out-Null
$emptyEnvFile = Join-Path $smokeRoot "empty.env"
$overrideFile = Join-Path $smokeRoot "compose.smoke.json"
Set-Content -LiteralPath $emptyEnvFile -Value "# Isolated smoke environment; never load the project .env."
@{ services = @{ app = @{ image = $smokeImage } } } | ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath $overrideFile

$savedEnvironment = @{}
# Only deployment variables are passed; use the bootstrap database administrator.
$testEnvironment = @{
  APP_BIND_ADDRESS = "127.0.0.1"
  APP_PORT = "$Port"
  DATA_PATH = $dataPath
  TZ = "Asia/Shanghai"
}
$defaultAdminUsername = "admin"
$defaultAdminPassword = "admin123"

foreach ($name in $testEnvironment.Keys) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  [Environment]::SetEnvironmentVariable($name, $testEnvironment[$name], "Process")
}

function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & docker compose --env-file $emptyEnvFile --project-name $ProjectName `
    --file $composeFile --file $overrideFile @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Wait-ForHealth {
  $healthUrl = "http://127.0.0.1:$Port/health"
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200 -and $response.Content -match '"status"\s*:\s*"ok"') {
        Wait-ForContainerHealth
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  Invoke-Compose logs --no-color app
  throw "Health check did not become ready: $healthUrl"
}

function Wait-ForContainerHealth {
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  $lastStatus = "container_not_found"
  do {
    $containerId = (Invoke-Compose ps --quiet app | Out-String).Trim()
    if ($containerId) {
      $lastStatus = (& docker inspect --format "{{.State.Health.Status}}" $containerId 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and $lastStatus -eq "healthy") {
        return
      }
      if ($lastStatus -eq "unhealthy") {
        Invoke-Compose logs --no-color app
        throw "Container healthcheck reported unhealthy."
      }
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  Invoke-Compose logs --no-color app
  throw "Container healthcheck did not become healthy; last status: $lastStatus"
}

function New-AuthenticationSession {
  $body = @{ username = $defaultAdminUsername; password = $defaultAdminPassword } | ConvertTo-Json -Compress
  $baseUri = [Uri]"http://127.0.0.1:$Port/"
  $loginUri = [Uri]::new($baseUri, "api/auth/login")
  $response = Invoke-WebRequest -Uri $loginUri `
    -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 15
  if ($response.Headers["Set-Cookie"] -match '(?i)(?:^|;)\s*Secure(?:;|$)' -or
      $response.Headers["Strict-Transport-Security"]) {
    throw "Production image must allow HTTP login without Secure cookies or HSTS."
  }
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $session.Cookies.SetCookies($baseUri, ($response.Headers["Set-Cookie"] -split ";", 2)[0])
  return $session
}

function Assert-DockerContextSecretsExcluded {
  $dockerIgnoreRules = @(Get-Content -LiteralPath (Join-Path $projectRoot ".dockerignore"))
  $environmentExcludeIndex = [Array]::IndexOf($dockerIgnoreRules, "**/.env*")
  $exampleIncludeIndex = [Array]::IndexOf($dockerIgnoreRules, "!**/.env.example")
  if ($environmentExcludeIndex -lt 0) {
    throw "Docker context must recursively exclude environment files with **/.env*."
  }
  if ($exampleIncludeIndex -le $environmentExcludeIndex) {
    throw "Docker context must explicitly retain **/.env.example after excluding environment files."
  }
}

function Assert-StaticBuild {
  Push-Location $projectRoot
  try {
    Assert-DockerContextSecretsExcluded
    Invoke-Compose config --quiet
    $resolvedConfig = (Invoke-Compose config --format json | Out-String) | ConvertFrom-Json
    $publishedPort = @($resolvedConfig.services.app.ports)[0]
    if ($publishedPort.host_ip -ne "127.0.0.1") {
      throw "Compose app port must default to 127.0.0.1, got $($publishedPort.host_ip)."
    }
    $app = $resolvedConfig.services.app
    $mounts = @($app.volumes)
    if (-not $app.read_only -or $mounts.Count -ne 1 -or $mounts[0].target -ne "/data" -or
      $mounts[0].type -ne "bind" -or $app.image -ne $smokeImage -or
      [System.IO.Path]::GetFullPath($mounts[0].source) -ne [System.IO.Path]::GetFullPath($dataPath) -or
      -not (@($app.tmpfs) | Where-Object { $_ -match '^/tmp(:|$)' })) {
      throw "Compose must isolate the smoke image, bind only /data, use a read-only root and writable /tmp."
    }
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm build failed with exit code $LASTEXITCODE"
    }
    foreach ($entry in @("index", "scan-worker", "missing-scan-worker", "missing-root-worker", "public-library-worker")) {
      & node --check (Join-Path $projectRoot "dist/server/$entry.mjs")
      if ($LASTEXITCODE -ne 0) { throw "Compiled server entrypoint failed syntax check: $entry" }
    }
  } finally {
    Pop-Location
  }
}

$savedErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$daemonOutput = (& docker info 2>&1 | Out-String).Trim()
$daemonAvailable = $LASTEXITCODE -eq 0
$ErrorActionPreference = $savedErrorActionPreference

try {
  Assert-StaticBuild
  if (-not $daemonAvailable) {
    Write-Host "Docker daemon unavailable; static Compose validation and application build passed."
    Write-Host "Docker daemon evidence: $daemonOutput"
    exit 2
  }

  $existing = (& docker ps --all --quiet --filter "label=com.docker.compose.project=$ProjectName" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $existing) { throw "Unable to confirm an unused smoke project: $ProjectName" }
  $composeStarted = $true
  if ($Image) {
    & docker image inspect $Image --format '{{.Id}}'
    if ($LASTEXITCODE -ne 0) { throw "Prebuilt smoke image not found: $Image" }
  } else {
    Invoke-Compose build app
  }
  # Seed only this run's empty database before the application starts any background refresh.
  Invoke-Compose run --rm --no-deps app node --eval @"
const Database = require('better-sqlite3');
const database = new Database('/data/emby-task-center.db');
database.exec('CREATE TABLE IF NOT EXISTS trending_source_configs (source TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, ttl_minutes INTEGER NOT NULL DEFAULT 60, refresh_minutes INTEGER NOT NULL DEFAULT 30, updated_at TEXT NOT NULL)');
const insert = database.prepare('INSERT INTO trending_source_configs (source, enabled, updated_at) VALUES (?, 0, ?)');
for (const source of ['tmdb', 'imdb', 'douban']) insert.run(source, new Date().toISOString());
database.close();
"@
  Invoke-Compose up --detach --no-build
  Wait-ForHealth

  $spa = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 15
  if ($spa.StatusCode -ne 200 -or $spa.Content -notmatch '<div id="app"></div>') {
    throw "SPA check failed at http://127.0.0.1:$Port/"
  }

  Invoke-Compose exec --no-TTY app node --eval @"
const fs = require('node:fs');
for (const entry of ['index', 'scan-worker', 'missing-scan-worker', 'missing-root-worker', 'public-library-worker']) {
  if (!fs.statSync('/app/server/' + entry + '.mjs').isFile()) process.exit(1);
}
if (fs.existsSync('/media/strm')) throw new Error('Obsolete STRM mount present');
fs.writeFileSync('/tmp/docker-smoke-write.txt', 'temporary');
fs.writeFileSync('/data/docker-smoke-write.txt', 'persistent');
try { fs.writeFileSync('/app/docker-smoke-write.txt', 'forbidden'); process.exit(1); }
catch (error) { if (!['EACCES', 'EROFS'].includes(error.code)) throw error; }
fs.unlinkSync('/tmp/docker-smoke-write.txt');
fs.unlinkSync('/data/docker-smoke-write.txt');
"@

  Invoke-Compose exec --no-TTY app node --eval @"
const Database = require('better-sqlite3');
const database = new Database('/data/emby-task-center.db');
const timestamp = new Date().toISOString();
const media = database.prepare('INSERT INTO media_items (tmdb_id, media_type, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id').get(2147483000, 'movie', 'Docker Smoke Persistence', timestamp, timestamp);
database.prepare('INSERT INTO media_tasks (media_item_id, task_type, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(media.id, 'ingest', 'pending', 'docker-smoke-persistence', timestamp, timestamp);
database.close();
"@

  $session = New-AuthenticationSession
  $tasks = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/tasks" `
    -WebSession $session -TimeoutSec 15
  if ($tasks.tasks.title -notcontains "Docker Smoke Persistence") {
    throw "Authenticated task listing did not expose the seeded persistence fixture."
  }

  Invoke-Compose up --detach --force-recreate --no-deps app
  Wait-ForHealth
  $session = New-AuthenticationSession
  $tasks = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/tasks" `
    -WebSession $session -TimeoutSec 15
  if ($tasks.tasks.title -notcontains "Docker Smoke Persistence") {
    throw "SQLite persistence check failed after container recreation."
  }

  $logs = (Invoke-Compose logs --no-color app | Out-String)
  Write-Host $logs
  if ($logs -match 'request_failed|uncaught|unhandled') {
    throw "Application logs contain an unexpected runtime error."
  }
  Write-Host "Docker smoke passed: health, SPA, persistent SQLite, five server entries, read-only root and writable /data and /tmp."
} finally {
  try {
    if ($composeStarted -and -not $Keep) {
      Invoke-Compose down --volumes
      $composeStarted = $false
      if (-not $Image) { & docker image rm $smokeImage }
    }
    if ($Keep) {
      Write-Host "Kept smoke project: $ProjectName; image: $smokeImage; fixtures: $smokeRoot"
    }
  } finally {
    foreach ($name in $testEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
    # A failed down can leave containers using the fixture. Preserve it in that case.
    if (-not $Keep -and -not $composeStarted -and (Test-Path -LiteralPath $smokeRoot)) {
      $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
      $expectedSmokeRoot = Join-Path $systemTempRoot ("emby-task-center-smoke-" + $runId)
      if ($resolvedSmokeRoot -ne $expectedSmokeRoot -or
        -not $resolvedSmokeRoot.StartsWith($systemTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove smoke directory outside the system temp root: $resolvedSmokeRoot"
      }
      Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
    }
  }
}
