$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$statePath = Join-Path $projectRoot '.runtime\processes.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'No background service record.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.root -ne $projectRoot) { throw 'Process record belongs to another project.' }
foreach ($servicePid in @($state.children) + @($state.parent)) {
    $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $sameStart = [Math]::Abs(($process.StartTime.ToUniversalTime() - [DateTime]::Parse($state.startedAt).ToUniversalTime()).TotalSeconds) -lt 10
    if ($process.ProcessName -eq 'node' -and $sameStart) { Stop-Process -Id $servicePid -ErrorAction SilentlyContinue; Write-Output "Stopped project service: $servicePid" }
}
