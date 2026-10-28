# QORGAN: stops the windows started by start-demo.bat / start-*.bat from THIS project folder.
# Windows are found by their command line (the .bat path), not by title: npm changes window titles.
# Order: sensor (the broker then reports it offline), server, broker. First a normal close, then forced.
#   stop-demo.ps1 -Root <folder>                 stop everything
#   stop-demo.ps1 -Root <folder> -Check sensor   exit 0 if that part is running (used by start-demo.bat)
param([Parameter(Mandatory = $true)][string]$Root, [string]$Check = '')

# taskkill writes to stderr when a child cannot be closed gently; that must not abort the script.
$ErrorActionPreference = 'Continue'
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$parts = @(
  @{ Name = 'sensor'; Bat = 'start-sensor.bat' },
  @{ Name = 'server'; Bat = 'start-qorgan.bat' },
  @{ Name = 'broker'; Bat = 'start-broker.bat' }
)

# Callers wrap the result in @(): PowerShell unrolls a one-item array, and a CimInstance has no .Count.
function Find-Windows([string]$bat) {
  $path = ($Root + $bat).ToLowerInvariant()
  @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($path) })
}

if ($Check) {
  $part = $parts | Where-Object { $_.Name -eq $Check }
  if (-not $part) { exit 2 }
  if (@(Find-Windows $part.Bat).Count -gt 0) { exit 0 } else { exit 1 }
}

foreach ($part in $parts) {
  $found = @(Find-Windows $part.Bat)
  if ($found.Count -eq 0) { Write-Output ("  {0}: not running" -f $part.Name); continue }
  foreach ($p in $found) { & cmd.exe /c "taskkill /PID $($p.ProcessId) /T >nul 2>nul" }
  Start-Sleep -Seconds 3
  foreach ($p in @(Find-Windows $part.Bat)) { & cmd.exe /c "taskkill /PID $($p.ProcessId) /T /F >nul 2>nul" }
  if (@(Find-Windows $part.Bat).Count -eq 0) { Write-Output ("  {0}: stopped" -f $part.Name) }
  else { Write-Output ("  {0}: STILL RUNNING - close its window by hand" -f $part.Name) }
}
