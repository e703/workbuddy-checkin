# Register scheduled task for WorkBuddy API check-in (daily 00:05)
$ErrorActionPreference = 'Stop'

$node = 'C:\Program Files\nodejs\node.exe'
$script = 'C:\Sources\workbuddy-checkin\scripts\api_checkin.mjs'
$workdir = 'C:\Sources\workbuddy-checkin\scripts'
$taskName = 'WorkBuddyDailyCheckin'

# remove old task if exists (wait until deletion completes - it is async)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 15; $i++) {
    if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ""{0}" "{1}" >> "{2}\checkin.log" 2>&1"' -f $node, $script, $workdir) -WorkingDirectory $workdir
$trigger = New-ScheduledTaskTrigger -Daily -At '00:05'
# 60 min execution limit: script has built-in 5-35 min random jitter (anti risk-control) + request time
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 60)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'WorkBuddy daily check-in via API (Buddy gas station), lock-screen safe'

$t = Get-ScheduledTask -TaskName $taskName
Write-Host ('Registered: ' + $t.TaskName + ' | State: ' + $t.State + ' | LogonType: ' + $t.Principal.LogonType)
Write-Host ('Trigger: ' + ($t.Triggers | ForEach-Object { $_.StartBoundary }))
