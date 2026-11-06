param([Parameter(Mandatory=$true)][string]$Driver,[Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
# A separate hidden console isolates CTRL_C_EVENT from the test runner/user.
$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$Driver+'"'),('"'+$Config+'"'))
$driverProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
$driverProcess.WaitForExit()
exit $driverProcess.ExitCode
