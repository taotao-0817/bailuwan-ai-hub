$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$runtimeDirectory = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$statePath = Join-Path $runtimeDirectory 'processes.json'
$listenPort = if ($env:PORT) { $env:PORT } else { '8788' }
$environmentPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $environmentPath) {
    foreach ($line in Get-Content -LiteralPath $environmentPath) { if ($line -match '^PORT=(\d+)$') { $listenPort = $Matches[1] } }
}
$serviceUrl = 'http://127.0.0.1:' + $listenPort
try {
    $health = Invoke-RestMethod -Uri ($serviceUrl + '/api/health') -TimeoutSec 2
    if ($health.ok -and $health.mode -eq 'simulation' -and $health.database -eq 'sqlite') { Write-Output "Already online: $serviceUrl"; exit 0 }
} catch { }
if (Test-Path -LiteralPath $statePath) {
    $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $runningProcess = Get-Process -Id $previous.parent -ErrorAction SilentlyContinue
    $sameStart = $runningProcess -and ([Math]::Abs(($runningProcess.StartTime.ToUniversalTime() - [DateTime]::Parse($previous.startedAt).ToUniversalTime()).TotalSeconds) -lt 10)
    if ($previous.root -eq $projectRoot -and $runningProcess.ProcessName -eq 'node' -and $sameStart) {
        Write-Output "Already running: $($previous.url)"
        exit 0
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) {
    throw 'Build is missing. Run npm install and npm run build first.'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$entryPath = Join-Path $projectRoot 'scripts\start.mjs'
$arguments = @('--env-file-if-exists=.env', ('"' + $entryPath + '"'))
$process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'server.log') -RedirectStandardError (Join-Path $runtimeDirectory 'server-error.log')
Write-Output "Background service started. Process: $($process.Id). Logs: $runtimeDirectory"
Write-Output $serviceUrl
