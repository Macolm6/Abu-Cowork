param([int]$ApplicationProcessId, [string]$Button, [switch]$Press)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QuitDialogInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ApplicationProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$observedNames = @()
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    $observedNames = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name })
    $target = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Button))
    if ($null -eq $target) { continue }
    $names = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name })
    if ($Press) {
      $bounds = $target.Current.BoundingRectangle
      if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Native button has no clickable bounds' }
      if (-not [QuitDialogInput]::SetCursorPos([int]($bounds.Left + $bounds.Width / 2), [int]($bounds.Top + $bounds.Height / 2))) { throw 'Cannot move the pointer to the native button' }
      [QuitDialogInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
      [QuitDialogInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    }
    @{ button = $Button; pressed = [bool]$Press; names = $names } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw "Native exit dialog button unavailable: $Button; observed: $($observedNames | ConvertTo-Json -Compress)"
