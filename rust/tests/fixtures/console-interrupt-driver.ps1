param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$case = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IsolatedConsole {
    public delegate bool Handler(uint kind);
    public static Handler KeepAlive = kind => true;
    [DllImport("kernel32.dll", SetLastError=true, EntryPoint="SetConsoleCtrlHandler")]
    public static extern bool SetHandler(Handler callback, bool add);
    [DllImport("kernel32.dll", SetLastError=true, EntryPoint="SetConsoleCtrlHandler")]
    public static extern bool SetIgnore(IntPtr callback, bool ignore);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GenerateConsoleCtrlEvent(uint kind, uint group);
}
'@
# This driver owns a new hidden console, so group zero contains only this test
# driver, its worker and that worker's scratch children. Never attach to an
# existing user/coordinator console or broadcast to another console.
if (-not [IsolatedConsole]::SetIgnore([IntPtr]::Zero, $false)) { throw 'Cannot clear inherited Ctrl-C ignore flag' }
if (-not [IsolatedConsole]::SetHandler([IsolatedConsole]::KeepAlive, $true)) { throw 'Cannot protect isolated test driver' }
$worker = [Diagnostics.Process]::new()
$result = @{ signalSent = $false }
$started = $false
try {
    $worker.StartInfo.FileName = $case.binary
    $arguments = foreach ($argument in $case.arguments) {
        if ($argument.Contains('"') -or $argument.EndsWith('\')) { throw 'Unsupported quote in controlled test argv' }
        '"' + $argument + '"'
    }
    $worker.StartInfo.Arguments = $arguments -join ' '
    $worker.StartInfo.UseShellExecute = $false
    $worker.StartInfo.CreateNoWindow = $false
    $worker.StartInfo.RedirectStandardOutput = $true
    $worker.StartInfo.RedirectStandardError = $true
    foreach ($property in $case.environment.PSObject.Properties) { $worker.StartInfo.EnvironmentVariables[$property.Name] = [string]$property.Value }
    if (-not $worker.Start()) { throw 'Cannot start isolated worker' }
    $started = $true
    $stdout = $worker.StandardOutput.ReadToEndAsync()
    $stderr = $worker.StandardError.ReadToEndAsync()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    if ($case.ready) {
        while (-not (Test-Path -LiteralPath $case.ready)) {
            if ($worker.HasExited) { throw "Worker exited before verification: $($stderr.Result)" }
            if ($clock.Elapsed.TotalSeconds -gt 25) { throw 'Verification readiness timeout' }
            [Threading.Thread]::Sleep(20)
        }
    } else { [Threading.Thread]::Sleep(500) }
    if ($worker.HasExited) { throw 'Worker exited before its signal' }
    $result.pid = $worker.Id
    # CTRL_C_EVENT, rather than CTRL_BREAK, matches Python KeyboardInterrupt.
    $result.signalSent = [IsolatedConsole]::GenerateConsoleCtrlEvent(0, 0)
    if (-not $result.signalSent) { throw "Cannot signal isolated console: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    if (-not $worker.WaitForExit(25000)) { throw 'Worker did not exit after Ctrl-C' }
    $result.code = $worker.ExitCode
    $result.stdout = $stdout.Result
    $result.stderr = $stderr.Result
} catch {
    $result.driverError = $_.Exception.Message
} finally {
    if ($started -and -not $worker.HasExited) { $worker.Kill(); $worker.WaitForExit() }
    [IO.File]::WriteAllText($case.result, ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $worker.Dispose()
}
if ($result.driverError) { exit 2 }
