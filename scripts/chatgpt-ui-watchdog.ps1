param(
  [ValidateSet("run","enable","disable","status","once","inspect","selftest")]
  [string]$Action = "status",
  [ValidateSet("retry","continue","retry_then_continue")]
  [string]$Mode = "retry_then_continue",
  [int]$PollSeconds = 5,
  [int]$RetryGraceSeconds = 20,
  [int]$CooldownSeconds = 45,
  [string]$ResumeText = "Continue the active persistent goal from the last completed checkpoint. Use work_resume if needed, verify actual state before repeating side effects, and keep working after scheduling any follow-up."
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".webjjonku"
$configPath = Join-Path $stateDir "ui-watchdog.json"
$pidPath = Join-Path $stateDir "ui-watchdog.pid"
$logPath = Join-Path $stateDir "ui-watchdog.log"
$episodeLatchPath = Join-Path $stateDir "ui-watchdog-error-episode.latch"
$observationPath = Join-Path $stateDir "ui-watchdog-observation.json"
$sessionWatchPath = Join-Path $stateDir "ui-watchdog-session-watch.json"
$taskName = "ChatGPT-UI-Watchdog"
if ($Action -eq "selftest") {
  # Self-tests must never clear the live watchdog's persistent episode latch.
  $episodeLatchPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ui-watchdog-test-" + [guid]::NewGuid().ToString("N") + ".latch")
} elseif ($Action -notin @("status","inspect")) {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
}

function Read-Config {
  if (Test-Path $configPath) {
    try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json; if ([string]$cfg.mode -notin @("retry","continue","retry_then_continue")) { $cfg.mode = "retry_then_continue" }; return $cfg } catch {}
  }
  return [pscustomobject]@{
    enabled = $false
    mode = "retry_then_continue"
    pollSeconds = 5
    retryGraceSeconds = 20
    cooldownSeconds = 45
    resumeText = "Continue the previous task from the last completed step."
    updatedAt = $null
  }
}

function Write-Config([bool]$enabled, [string]$mode, [int]$poll, [int]$retryGrace, [int]$cooldown, [string]$resumeText) {
  if ($mode -notin @("retry","continue","retry_then_continue")) { $mode = "retry_then_continue" }
  $obj = [ordered]@{
    enabled = $enabled
    mode = $mode
    pollSeconds = [Math]::Max(2,$poll)
    retryGraceSeconds = [Math]::Max(5,$retryGrace)
    cooldownSeconds = [Math]::Max(10,$cooldown)
    resumeText = $resumeText
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $obj | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  return [pscustomobject]$obj
}

function Log([string]$message) {
  # Logging is diagnostic only. A transient file-share/AV lock must never kill recovery.
  try {
    $line = "$(Get-Date -Format o) $message"
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 -ErrorAction Stop
    try {
      $fi = Get-Item $logPath -ErrorAction Stop
      if ($fi.Length -gt 1048576) {
        $tail = Get-Content $logPath -Tail 1000 -ErrorAction Stop
        Set-Content -LiteralPath $logPath -Value $tail -Encoding UTF8 -ErrorAction Stop
      }
    } catch {}
  } catch {}
}

function Get-RunningPid {
  if (-not (Test-Path $pidPath)) { return $null }
  try {
    $p = [int](Get-Content $pidPath -Raw)
    if (Get-Process -Id $p -ErrorAction SilentlyContinue) { return $p }
  } catch {}
  return $null
}

function Test-EpisodeLatch { return (Test-Path $episodeLatchPath) }
function Get-EpisodeRecord {
  if (-not (Test-EpisodeLatch)) { return $null }
  try { return (Get-Content -LiteralPath $episodeLatchPath -Raw | ConvertFrom-Json) } catch {
    # Legacy/unreadable latches have unknown dispatch outcome. Never repeat them blindly.
    return [pscustomobject]@{action="unconfirmed";attemptedAt=$null;retryKey=$null}
  }
}
function Set-EpisodeLatch([string]$action="unconfirmed", [string]$retryKey="", [object]$attemptedAt=$null) {
  if (-not $attemptedAt) { $attemptedAt = Get-Date }
  $record = [ordered]@{action=$action;attemptedAt=([datetime]$attemptedAt).ToUniversalTime().ToString("o");retryKey=$retryKey}
  $tempPath = $episodeLatchPath + "." + $PID + ".tmp"
  $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $tempPath -Encoding ASCII
  Move-Item -LiteralPath $tempPath -Destination $episodeLatchPath -Force
}
function Clear-EpisodeLatch { Remove-Item $episodeLatchPath -Force -ErrorAction SilentlyContinue }
function Sync-EpisodeState([bool]$errorSeen, [hashtable]$memory, [object]$cfg=$null, [string]$errorText="") {
  $memory["retryFallbackReady"] = $false
  if (-not $errorSeen) {
    $memory.errorSince = $null
    $memory.retryAt = $null
    $memory.sendFailureAt = $null
    $memory.suppressedUntilClear = $false
    Clear-EpisodeLatch
    return $false
  }
  if ($memory.suppressedUntilClear -or (Test-EpisodeLatch)) {
    $record = Get-EpisodeRecord
    $memory["latchAction"] = if($record){[string]$record.action}else{"unconfirmed"}
    if ($cfg -and [string]$cfg.mode -eq "retry_then_continue" -and $record -and [string]$record.action -eq "retry") {
      try {
        $attemptedAt = [datetime]::Parse([string]$record.attemptedAt).ToUniversalTime()
        $waitSeconds = if (Test-IsStalledGenerationRecoveryText $errorText) { [Math]::Min(8,[Math]::Max(5,[int]$cfg.retryGraceSeconds)) } else { [Math]::Max([int]$cfg.retryGraceSeconds,[int]$cfg.cooldownSeconds) }
        if (((Get-Date).ToUniversalTime() - $attemptedAt).TotalSeconds -ge $waitSeconds) {
          $memory["retryFallbackReady"] = $true
          $memory["retryKey"] = [string]$record.retryKey
          $memory.errorSince = $attemptedAt
          $memory.retryAt = $attemptedAt
          $memory.suppressedUntilClear = $false
          return $false
        }
      } catch {}
    }
    $memory.suppressedUntilClear = $true
    return $true
  }
  return $false
}

function Test-RetryBlocksContinuation([object]$chat, [object]$errorElement, [hashtable]$memory) {
  if (-not (Test-HasAnyRetryActionNearError $chat $errorElement)) { return $false }
  if (-not $memory["retryFallbackReady"]) { return $true }
  $retry = Find-RetryButtonNearError $chat $errorElement
  # Only the same uniquely associated, already-invoked Retry can remain during fallback.
  return (-not $retry -or -not $memory["retryKey"] -or (Get-ElementRuntimeKey $retry) -ne [string]$memory["retryKey"])
}

function Write-WatchdogObservation([object]$decision, [hashtable]$memory) {
  try {
    $record = [ordered]@{observedAt=(Get-Date).ToUniversalTime().ToString("o");pid=$PID;detected=[bool]$decision.detected;action=[string]$decision.action;reason=[string]$decision.reason}
    $tempPath = $observationPath + "." + $PID + ".tmp"
    $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $tempPath -Encoding ASCII -ErrorAction Stop
    Move-Item -LiteralPath $tempPath -Destination $observationPath -Force -ErrorAction Stop
  } catch {}
  $key = ([string]$decision.detected) + ":" + [string]$decision.action + ":" + [string]$decision.reason
  if ($memory["observationKey"] -ne $key) {
    Log ("watch decision detected=" + [string]$decision.detected + " action=" + [string]$decision.action + " reason=" + [string]$decision.reason)
    $memory["observationKey"] = $key
  }
}

function Read-SessionWatch {
  if (Test-Path $sessionWatchPath) {
    try {
      $v=Get-Content -LiteralPath $sessionWatchPath -Raw | ConvertFrom-Json
      return [pscustomobject]@{
        pendingTitle=[string]$v.pendingTitle
        returnTitle=[string]$v.returnTitle
        pendingSince=$v.pendingSince
        clearSince=$v.clearSince
        resumeAfterStop=[bool]$v.resumeAfterStop
        stopRequestedAt=$v.stopRequestedAt
        stopAttempts=$(if($null -ne $v.stopAttempts){[int]$v.stopAttempts}else{0})
      }
    } catch {}
  }
  return [pscustomobject]@{pendingTitle="";returnTitle="";pendingSince=$null;clearSince=$null;resumeAfterStop=$false;stopRequestedAt=$null;stopAttempts=0}
}
function Write-SessionWatch([object]$state) {
  try {
    $temp=$sessionWatchPath+"."+$PID+".tmp"
    [ordered]@{
      pendingTitle=[string]$state.pendingTitle
      returnTitle=[string]$state.returnTitle
      pendingSince=$state.pendingSince
      clearSince=$state.clearSince
      resumeAfterStop=[bool]$state.resumeAfterStop
      stopRequestedAt=$state.stopRequestedAt
      stopAttempts=$(if($null -ne $state.stopAttempts){[int]$state.stopAttempts}else{0})
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $sessionWatchPath -Force
  } catch {}
}
function Clear-SessionWatch { Remove-Item -LiteralPath $sessionWatchPath -Force -ErrorAction SilentlyContinue }
function Get-ConversationTitle([object]$chat) {
  if(-not $chat){ return "" }
  try {
    $doc=Get-RootWebArea $chat
    if($doc){ return Normalize-RecoveryText ([string]$doc.Current.Name) }
  } catch {}
  return ""
}
function Find-SidebarConversationButton([object]$chat,[string]$title) {
  if(-not $chat -or -not $title){ return $null }
  $wanted=Normalize-RecoveryText $title
  $found=$null
  $count=0
  try {
    $all=$chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
    foreach($e in $all){
      try {
        if($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or -not $e.Current.IsEnabled -or $e.Current.IsOffscreen){ continue }
        if((Normalize-RecoveryText ([string]$e.Current.Name)) -ne $wanted){ continue }
        if(([string]$e.Current.ClassName) -notmatch '(?i)sidebar-item'){ continue }
        $count++
        if($count -gt 1){ return $null }
        $found=$e
      } catch {}
    }
  } catch {}
  if($count -ne 1 -or -not $found){ return $null }
  try {
    [void]$found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    return $found
  } catch { return $null }
}

function Invoke-ConversationByTitle([object]$chat,[string]$title) {
  $button=Find-SidebarConversationButton $chat $title
  if(-not $button){ return $false }
  try {
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return $true
  } catch { return $false }
}

function Get-ElementValue([object]$element) {
  try {
    $vp = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$vp.Current.Value
  } catch {
    try { return [string]$element.Current.Name } catch { return "" }
  }
}

function Get-ElementRect([object]$element) {
  if (-not $element) { return $null }
  try {
    $r = $element.Current.BoundingRectangle
    if ($r.Width -le 1 -or $r.Height -le 1) { return $null }
    return [pscustomobject]@{Left=$r.Left;Top=$r.Top;Right=$r.Right;Bottom=$r.Bottom;Width=$r.Width;Height=$r.Height}
  } catch { return $null }
}

function Test-RectIntersects([object]$a, [object]$b) {
  if (-not $a -or -not $b) { return $false }
  return ($a.Right -gt $b.Left -and $a.Left -lt $b.Right -and $a.Bottom -gt $b.Top -and $a.Top -lt $b.Bottom)
}

function Get-VisibleComposer([object]$chat) {
  $windowRect = Get-ElementRect $chat
  if (-not $windowRect) { return $null }
  $editCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
  $all = $chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,$editCondition)
  $best = $null
  $bestBottom = [double]::NegativeInfinity
  $minWidth = [Math]::Max(240.0, $windowRect.Width * 0.20)
  $minTop = $windowRect.Top + ($windowRect.Height * 0.45)
  foreach($e in $all) {
    try {
      if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -or -not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { continue }
      $r = Get-ElementRect $e
      if (-not $r -or -not (Test-RectIntersects $r $windowRect)) { continue }
      if ($r.Width -lt $minWidth -or $r.Bottom -lt $minTop) { continue }
      if ($r.Bottom -gt $bestBottom) { $best = $e; $bestBottom = $r.Bottom }
    } catch {}
  }
  return $best
}

function Normalize-RecoveryText([string]$name) {
  if (-not $name) { return "" }
  return (($name -replace '\s+',' ').Trim())
}

function Test-IsRecoveryErrorText([string]$name) {
  $name = Normalize-RecoveryText $name
  if (-not $name) { return $false }
  # Reuse the NAS partial fix: match complete normalized system labels only.
  return ($name -match '(?i)^(?:stream recovery polling timed out\.?|Resume stream unavailable\.?|A network error occurred\.?(?: Please check your connection and try again\.?)?|Please check your connection and try again\.?|Message delivery timed out\. Please try again\.?|Connection interrupted\. Waiting for (?:the )?complete answer\.?|\uC774 \uB300\uD654\uC5D0 ChatGPT\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4\.?|연결이 해제되었습니다\. 전체 답변을 기다리는 중입니다\.?|polling memory(?: timed out)?\.?|문제가 발생했습니다\.?(?: 다시 시도(?:해 주세요|하세요)?\.?)?)$'
) -or ($name -eq "연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.")
}

function Test-IsConnectionInterruptedText([string]$name) {
  $name = Normalize-RecoveryText $name
  return ($name -match '(?i)^Connection interrupted\. Waiting for (?:the )?complete answer\.?$') -or ($name -eq "연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.")
}

function Test-IsConversationUnavailableText([string]$name) {
  $name = Normalize-RecoveryText $name
  return $name -match '^\uC774 \uB300\uD654\uC5D0 ChatGPT\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4\.?$'
}

function Test-IsStalledGenerationRecoveryText([string]$name) {
  return (Test-IsConnectionInterruptedText $name) -or (Test-IsConversationUnavailableText $name)
}

function Test-IsPlatformReviewText([string]$name) {
  $name = Normalize-RecoveryText $name
  return $name -match '^(?:\uC751\uB2F5\uD558\uAE30 \uC804\uC5D0 \uC2DC\uC2A4\uD15C\uC5D0\uC11C \uC774 \uC694\uCCAD\uC744 \uCD94\uAC00\uB85C \uAC80\uD1A0\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4\.?|Before responding, the system is reviewing this request further\.?)$'
}

function Find-PlatformReviewNotice([object]$chat) {
  if (-not $chat) { return $null }
  $found=$null
  $count=0
  $chatKey=Get-ElementRuntimeKey $chat
  try {
    $all=$chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
    foreach($e in $all) {
      try {
        if($e.Current.IsOffscreen -or -not (Test-IsPlatformReviewText ([string]$e.Current.Name))) { continue }
        $blocked=$false
        $node=$e
        for($i=0;$i -lt 6 -and $node;$i++) {
          if($chatKey -and (Get-ElementRuntimeKey $node) -eq $chatKey){break}
          if(Test-IsChatContentElement $node){$blocked=$true;break}
          $node=Get-UiaParent $node
        }
        if($blocked){continue}
        $count++
        if($count -gt 1){return $null}
        $found=$e
      } catch {}
    }
  } catch {}
  if($count -eq 1){return $found}
  return $null
}

function Test-IsRetryActionName([string]$name) {
  return (Normalize-RecoveryText $name) -match '(?i)^(Retry|Try again|Regenerate|다시 시도|재시도|다시하기)$'
}

function Get-UiaParent([object]$element) {
  try { return [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element) } catch { return $null }
}

function Test-IsChatContentElement([object]$element) {
  try {
    $identity = ([string]$element.Current.AutomationId) + ' ' + ([string]$element.Current.ClassName)
    if ($identity -match '(?i)(markdown|code-block|codeblock|message-content|user-message|assistant-message|conversation-turn|chat-message)') { return $true }
    $name = Normalize-RecoveryText ([string]$element.Current.Name)
    return $name -match '(?i)^(You said|ChatGPT said|You|ChatGPT|사용자|나의 말|내가 말함|ChatGPT의 말):?$'
  } catch { return $true }
}

function Test-RecoveryScope([object]$scope, [object]$errorElement, [object]$chat) {
  if (-not $scope -or -not $errorElement -or -not $chat) { return $false }
  try {
    if ($scope.Current.ControlType -in @([System.Windows.Automation.ControlType]::Document,[System.Windows.Automation.ControlType]::Window,[System.Windows.Automation.ControlType]::Edit)) { return $false }
    if ((Get-ElementRuntimeKey $scope) -eq (Get-ElementRuntimeKey $chat)) { return $false }
    if (Test-IsChatContentElement $scope) { return $false }
    $all = $scope.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
    # A message body/footer or conversation container is never a retry surface.
    if ($all.Count -gt 32) { return $false }
    $foundError = $false
    foreach ($e in $all) {
      if ($e.Current.IsOffscreen) { continue }
      if (Test-IsChatContentElement $e) { return $false }
      if ($e.Current.ControlType -in @([System.Windows.Automation.ControlType]::Edit,[System.Windows.Automation.ControlType]::Document,[System.Windows.Automation.ControlType]::Hyperlink)) { return $false }
      $name = Normalize-RecoveryText ([string]$e.Current.Name)
      if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
        if (-not (Test-IsRetryActionName $name)) { return $false }
      } elseif ($name -and -not (Test-IsRecoveryErrorText $name) -and -not (Test-IsRetryActionName $name)) { return $false }
      if ((Get-ElementRuntimeKey $e) -eq (Get-ElementRuntimeKey $errorElement)) { $foundError = $true }
    }
    return $foundError
  } catch { return $false }
}

function Find-UniqueRetryButtonByGeometry([object]$chat, [object]$errorElement) {
  if (-not $chat -or -not $errorElement) { return $null }
  $er = Get-ElementRect $errorElement
  $wr = Get-ElementRect $chat
  if (-not $er -or -not $wr) { return $null }
  $matches = @()
  $all = $chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    try {
      if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or -not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { continue }
      if ($e.Current.ProcessId -ne $errorElement.Current.ProcessId) { continue }
      $name = Normalize-RecoveryText ([string]$e.Current.Name)
      if ($name -notin @("Retry","Try again","다시 시도","재시도","다시하기")) { continue }
      $r = Get-ElementRect $e
      if (-not $r -or -not (Test-RectIntersects $r $wr)) { continue }
      $xGap = [Math]::Max(0, [Math]::Max($er.Left - $r.Right, $r.Left - $er.Right))
      $yGap = [Math]::Max(0, [Math]::Max($er.Top - $r.Bottom, $r.Top - $er.Bottom))
      if ($xGap -gt 220 -or $yGap -gt 140) { continue }
      [void]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $matches += $e
    } catch {}
  }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Test-IsSafeGeometryRecoveryCandidate([object]$chat, [object]$errorElement) {
  if (-not $chat -or -not $errorElement) { return $false }
  $retry = Find-UniqueRetryButtonByGeometry $chat $errorElement
  if (-not $retry) { return $false }
  $retryKey = Get-ElementRuntimeKey $retry
  $chatKey = Get-ElementRuntimeKey $chat
  $scope = Get-UiaParent $errorElement
  for ($depth = 0; $scope -and $depth -lt 4; $depth++) {
    if ($chatKey -and (Get-ElementRuntimeKey $scope) -eq $chatKey) { break }
    if (Test-IsChatContentElement $scope) { return $false }
    $containsRetry = $false
    try {
      $all = $scope.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
      foreach ($e in $all) {
        if ($e.Current.IsOffscreen) { continue }
        if (Test-IsChatContentElement $e) { return $false }
        $type = $e.Current.ControlType
        if ($type -eq [System.Windows.Automation.ControlType]::Button) {
          $name = Normalize-RecoveryText ([string]$e.Current.Name)
          if ($name -notin @("Retry","Try again","다시 시도","재시도","다시하기")) { return $false }
        } elseif ($type -in @([System.Windows.Automation.ControlType]::Edit,[System.Windows.Automation.ControlType]::Document,[System.Windows.Automation.ControlType]::Hyperlink)) {
          return $false
        }
        if ($retryKey -and (Get-ElementRuntimeKey $e) -eq $retryKey) { $containsRetry = $true }
      }
    } catch { return $false }
    if ($containsRetry) { return $true }
    $scope = Get-UiaParent $scope
  }
  return $false
}

function Find-RecoveryError([object]$chat, [object]$edit) {
  if (-not $chat -or -not $edit) { return $null }
  $windowRect = Get-ElementRect $chat
  $composerRect = Get-ElementRect $edit
  if (-not $windowRect -or -not $composerRect) { return $null }
  $conditions = [System.Windows.Automation.OrCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Pane),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Group))
  $all = $chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,$conditions)
  $best = $null
  $bestGap = [double]::PositiveInfinity
  $fallback = @()
  foreach($e in $all) {
    try {
      $name = [string]$e.Current.Name
      if (-not (Test-IsRecoveryErrorText $name) -or $e.Current.IsOffscreen) { continue }
      $type = $e.Current.ControlType
      if ($type -notin @([System.Windows.Automation.ControlType]::Text,[System.Windows.Automation.ControlType]::Pane,[System.Windows.Automation.ControlType]::Group)) { continue }
      if ($e.Current.ProcessId -ne $chat.Current.ProcessId) { continue }
      $r = Get-ElementRect $e
      if (-not $r -or -not (Test-RectIntersects $r $windowRect)) { continue }
      if ($r.Top -gt ($composerRect.Bottom + 20)) { continue }
      $overlap = [Math]::Max(0.0, [Math]::Min($r.Right,$composerRect.Right) - [Math]::Max($r.Left,$composerRect.Left))
      if ($overlap -lt 40) { continue }
      $gap = [Math]::Max(0.0, $composerRect.Top - $r.Bottom)
      if ($gap -gt ($windowRect.Height * 0.80)) { continue }
      $scope = Get-UiaParent $e
      if ($type -eq [System.Windows.Automation.ControlType]::Text -and (Test-RecoveryScope $scope $e $chat)) {
        if ($gap -lt $bestGap) { $best=$e; $bestGap=$gap }
        continue
      }
      if (Test-IsSafeGeometryRecoveryCandidate $chat $e) { $fallback += $e }
    } catch {}
  }
  if ($best) { return $best }
  if ($fallback.Count -eq 1) { return $fallback[0] }
  return $null
}

function Find-RetryButtonNearError([object]$chat, [object]$errorElement) {
  if (-not $chat -or -not $errorElement) { return $null }
  $er = Get-ElementRect $errorElement
  $wr = Get-ElementRect $chat
  if (-not $er -or -not $wr) { return $null }
  $scope = Get-UiaParent $errorElement
  if ($scope -and (Test-RecoveryScope $scope $errorElement $chat)) {
    for ($depth = 0; $scope -and $depth -lt 4; $depth++) {
      if (-not (Test-RecoveryScope $scope $errorElement $chat)) { return $null }
      $matches = @()
      $all = $scope.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
      foreach ($e in $all) {
        try {
          if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or -not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { continue }
          if ($e.Current.ProcessId -ne $errorElement.Current.ProcessId -or -not (Test-IsRetryActionName ([string]$e.Current.Name))) { continue }
          $r = Get-ElementRect $e
          if (-not $r -or -not (Test-RectIntersects $r $wr)) { continue }
          $xGap = [Math]::Max(0, [Math]::Max($er.Left - $r.Right, $r.Left - $er.Right))
          $yGap = [Math]::Max(0, [Math]::Max($er.Top - $r.Bottom, $r.Top - $er.Bottom))
          if ($xGap -gt 160 -or $yGap -gt 100) { continue }
          [void]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $matches += $e
        } catch {}
      }
      if ($matches.Count -eq 1) { return $matches[0] }
      if ($matches.Count -gt 1) { return $null }
      $scope = Get-UiaParent $scope
    }
    return $null
  }
  if (Test-IsSafeGeometryRecoveryCandidate $chat $errorElement) {
    return (Find-UniqueRetryButtonByGeometry $chat $errorElement)
  }
  return $null
}

function Normalize-ComposerText([object]$edit,[string]$text) {
  $value=([string]$text).Trim()
  if(-not $value){ return "" }
  try {
    $name=Normalize-RecoveryText ([string]$edit.Current.Name)
    $class=[string]$edit.Current.ClassName
    if($class -match '(?i)ProseMirror' -and $name -and (Normalize-RecoveryText $value) -eq $name){
      return ""
    }
  } catch {}
  return $value
}

function Get-ComposerUserText([object]$edit) {
  if (-not $edit) { return "__unreadable_composer__" }
  try {
    $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return (Normalize-ComposerText $edit ([string]$value.Current.Value))
  } catch {
    try {
      $text = $edit.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      return (Normalize-ComposerText $edit ([string]$text.DocumentRange.GetText(2048)))
    } catch { return "__unreadable_composer__" }
  }
}

function Test-IsStopActionName([string]$name) { return $name -match '^(Stop|Stop generating|Stop response|\uC911\uC9C0|\uC0DD\uC131\u0020\uC911\uC9C0|\uC751\uB2F5\u0020\uC911\uC9C0)$' }
function Test-IsSendActionName([string]$name) { return $name -match '^(Send|Send message|Send prompt|Submit|\uBCF4\uB0B4\uAE30|\uC804\uC1A1|\uBA54\uC2DC\uC9C0\u0020\uBCF4\uB0B4\uAE30|\uBA54\uC2DC\uC9C0\u0020\uC804\uC1A1|\uD504\uB86C\uD504\uD2B8\u0020\uBCF4\uB0B4\uAE30)$' }
function Test-IsVoiceActionName([string]$name) { return $name -match '(?i)^(Voice|Start voice mode|Voice mode|Microphone|Mic|Record|Start recording|Dictation|Start dictation|\uC74C\uC131|\uC74C\uC131\u0020\uBAA8\uB4DC|\uC74C\uC131\u0020\uBAA8\uB4DC\u0020\uC2DC\uC791|\uB9C8\uC774\uD06C|\uB179\uC74C|\uBC1B\uC544\uC4F0\uAE30)$' }
function Test-IsStopAction([object]$button) {
  if (-not $button) { return $false }
  try { return (Test-IsStopActionName ([string]$button.Current.Name)) } catch { return $false }
}

function Find-ComposerActionButton([object]$chat, [object]$edit, [string]$kind) {
  if (-not $chat -or -not $edit) { return $null }
  $wr = Get-ElementRect $chat
  $cr = Get-ElementRect $edit
  if (-not $wr -or -not $cr) { return $null }
  $matches = @()
  $all = $chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    try {
      if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or -not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { continue }
      if ($e.Current.ProcessId -ne $chat.Current.ProcessId) { continue }
      $name = Normalize-RecoveryText ([string]$e.Current.Name)
      $ok = if ($kind -eq "send") { Test-IsSendActionName $name } elseif ($kind -eq "stop") { Test-IsStopActionName $name } else { $false }
      if (-not $ok) { continue }
      $r = Get-ElementRect $e
      if (-not $r -or -not (Test-RectIntersects $r $wr)) { continue }
      $xGap = [Math]::Max(0, [Math]::Max($cr.Left - $r.Right, $r.Left - $cr.Right))
      $yGap = [Math]::Max(0, [Math]::Max($cr.Top - $r.Bottom, $r.Top - $cr.Bottom))
      if ($xGap -gt 260 -or $yGap -gt 160) { continue }
      [void]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $matches += $e
    } catch {}
  }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Test-HasAnyRetryActionNearError([object]$chat, [object]$errorElement) {
  if (-not $chat -or -not $errorElement) { return $false }
  $er = Get-ElementRect $errorElement
  $wr = Get-ElementRect $chat
  if (-not $er -or -not $wr) { return $false }
  $all = $chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    try {
      if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or -not $e.Current.IsEnabled -or $e.Current.IsOffscreen) { continue }
      if ($e.Current.ProcessId -ne $errorElement.Current.ProcessId -or -not (Test-IsRetryActionName ([string]$e.Current.Name))) { continue }
      $r = Get-ElementRect $e
      if (-not $r -or -not (Test-RectIntersects $r $wr)) { continue }
      $xGap = [Math]::Max(0, [Math]::Max($er.Left - $r.Right, $r.Left - $er.Right))
      $yGap = [Math]::Max(0, [Math]::Max($er.Top - $r.Bottom, $r.Top - $er.Bottom))
      if ($xGap -le 220 -and $yGap -le 140) { return $true }
    } catch {}
  }
  return $false
}

function Clear-InjectedResume([object]$edit, [string]$resumeText) {
  try {
    if ((Get-ComposerUserText $edit) -eq $resumeText) {
      $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $vp.SetValue("")
    }
  } catch {}
}

function Get-ElementRuntimeKey([object]$element) {
  if (-not $element) { return "" }
  try { return (($element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join ".") } catch { return "" }
}

function Resolve-FreshRetryButton([object]$chat,[object]$edit,[object]$errorElement,[object]$oldRetry) {
  try {
    if(-not $chat -or -not $edit -or -not $errorElement -or -not $oldRetry){return $null}
    $freshChat=Get-ChatGPTMainWindow
    if(-not $freshChat){return $null}
    $oldHandle=[int]$chat.Current.NativeWindowHandle
    $newHandle=[int]$freshChat.Current.NativeWindowHandle
    if($oldHandle -gt 0 -and $newHandle -gt 0 -and $oldHandle -ne $newHandle){return $null}
    $oldTitle=Get-ConversationTitle $chat
    $newTitle=Get-ConversationTitle $freshChat
    if($oldTitle -and $newTitle -and $oldTitle -ne $newTitle){return $null}
    $freshEdit=Get-VisibleComposer $freshChat
    if(-not $freshEdit){return $null}
    $freshError=Find-RecoveryError $freshChat $freshEdit
    if(-not $freshError){return $null}
    if((Normalize-RecoveryText ([string]$freshError.Current.Name)) -ne (Normalize-RecoveryText ([string]$errorElement.Current.Name))){return $null}
    $freshRetry=Find-RetryButtonNearError $freshChat $freshError
    if(-not $freshRetry){return $null}
    $label=Normalize-RecoveryText ([string]$freshRetry.Current.Name)
    if(-not (Test-IsRetryActionName $label)){return $null}
    $r=Get-ElementRect $freshRetry
    $e=Get-ElementRect $freshError
    if(-not $r -or -not $e){return $null}
    $x=[math]::Max(0,[math]::Max($e.Left-$r.Right,$r.Left-$e.Right))
    $y=[math]::Max(0,[math]::Max($e.Top-$r.Bottom,$r.Top-$e.Bottom))
    if($x -gt 240 -or $y -gt 160){return $null}
    [void]$freshRetry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    return $freshRetry
  }catch{return $null}
}
function Test-RecoveryContextCurrent([object]$chat,[object]$edit,[object]$errorElement,[object]$retryButton) {
  return [bool](Resolve-FreshRetryButton $chat $edit $errorElement $retryButton)
}
. "$PSScriptRoot\chatgpt-ui-watchdog-textpattern.ps1"
. "$PSScriptRoot\chatgpt-ui-watchdog-ocr.ps1"

function Reset-WatchdogEpisode([hashtable]$memory, [string]$reason) {
  $memory.errorSince = $null
  $memory.retryAt = $null
  $memory.sendFailureAt = $null
  $memory.suppressedUntilClear = $false
  Clear-EpisodeLatch
  if ($reason) { Log $reason }
}

function Test-IsChatGptWindowHost([string]$processName, [string]$title) {
  # Only the installed Windows desktop app is managed.
  return ($processName -eq "ChatGPT")
}

function Test-IsEligibleChatGPTWindow([object]$w) {
  if (-not $w) { return $false }
  try {
    if (-not $w.Current.IsEnabled -or $w.Current.IsOffscreen) { return $false }
    $pidValue = [int]$w.Current.ProcessId
    if ($pidValue -le 0) { return $false }
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    $title = [string]$w.Current.Name
    if (-not $title) { $title = [string]$proc.MainWindowTitle }
    if (-not (Test-IsChatGptWindowHost ([string]$proc.ProcessName) $title)) { return $false }
    if ([string]$proc.ProcessName -eq "ChatGPT") {
      $r = Get-ElementRect $w
      return [bool]($r -and $r.Width -ge 480 -and $r.Height -ge 360)
    }
    # Browser tabs are ambiguous; continue requiring a matching visible composer.
    return [bool](Get-VisibleComposer $w)
  } catch { return $false }
}

function Get-ChatGPTMainWindow {
  try {
    if (-not ("WatchdogNativeMethods" -as [type])) {
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WatchdogNativeMethods {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
    }

    # Prefer the foreground ChatGPT window. This preserves the narrowest possible target.
    $foreground = [WatchdogNativeMethods]::GetForegroundWindow()
    if ($foreground -ne [IntPtr]::Zero) {
      try {
        $foregroundWindow = [System.Windows.Automation.AutomationElement]::FromHandle($foreground)
        if (Test-IsEligibleChatGPTWindow $foregroundWindow) { return $foregroundWindow }
      } catch {}
    }

    # If ChatGPT is backgrounded, UIA InvokePattern/ValuePattern can still operate without focus.
    # Fail closed unless exactly one eligible ChatGPT top-level window is visible.
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
    $eligible = @()
    foreach ($w in $wins) {
      if (Test-IsEligibleChatGPTWindow $w) { $eligible += $w }
    }
    if ($eligible.Count -eq 1) { return $eligible[0] }
  } catch {}
  return $null
}

function Invoke-ResumeAfterStoppedInterruption([object]$chat,[object]$edit,[object]$cfg,[string]$expectedTitle="") {
  if (-not $chat -or -not $edit) {
    return [pscustomobject]@{detected=$true;action="none";reason="post_stop_context_missing"}
  }
  if ($expectedTitle -and (Get-ConversationTitle $chat) -ne $expectedTitle) {
    return [pscustomobject]@{detected=$true;action="none";reason="post_stop_session_changed"}
  }
  if (Get-ComposerUserText $edit) {
    return [pscustomobject]@{detected=$true;action="none";reason="composer_has_user_draft_or_unreadable_value"}
  }
  if (Find-ComposerActionButton $chat $edit "stop") {
    return [pscustomobject]@{detected=$true;action="wait";reason="waiting_for_stop_after_connection_interrupt"}
  }
  $resumeText=([string]$cfg.resumeText).Trim()
  if(-not $resumeText){$resumeText="Continue the previous task from the last completed checkpoint. Verify actual state before repeating side effects."}
  $latched=$false
  try {
    $vp=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($resumeText)
    Start-Sleep -Milliseconds 180
    $afterChat=Get-ChatGPTMainWindow
    $afterEdit=Get-VisibleComposer $afterChat
    if(-not $afterChat -or -not $afterEdit -or (Get-ElementRuntimeKey $chat) -ne (Get-ElementRuntimeKey $afterChat) -or (Get-ElementRuntimeKey $edit) -ne (Get-ElementRuntimeKey $afterEdit)){
      Clear-InjectedResume $edit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="post_stop_context_changed"}
    }
    if($expectedTitle -and (Get-ConversationTitle $afterChat) -ne $expectedTitle){
      Clear-InjectedResume $afterEdit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="post_stop_session_changed"}
    }
    if((Get-ComposerUserText $afterEdit) -ne $resumeText){
      Clear-InjectedResume $afterEdit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="post_stop_composer_not_owned"}
    }
    if(Find-ComposerActionButton $afterChat $afterEdit "stop"){
      Clear-InjectedResume $afterEdit $resumeText
      return [pscustomobject]@{detected=$true;action="wait";reason="generation_restarted_before_post_stop_resume"}
    }
    $send=Find-ComposerActionButton $afterChat $afterEdit "send"
    if(-not $send){
      Clear-InjectedResume $afterEdit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="post_stop_send_control_not_found"}
    }
    $sendPattern=$send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    Set-EpisodeLatch "continue_unconfirmed" "" (Get-Date)
    $latched=$true
    $sendPattern.Invoke()
    Set-EpisodeLatch "continue" "" (Get-Date)
    Log "Connection interrupted generation was stopped; continuation submitted by UIA invoke."
    return [pscustomobject]@{detected=$true;action="continue";reason="connection_interrupted_stop_resume"}
  } catch {
    if(-not $latched){Clear-InjectedResume $edit $resumeText}
    Log ("Post-stop continuation failed or was unconfirmed: "+$_.Exception.Message)
    return [pscustomobject]@{detected=$true;action=$(if($latched){"continue_unconfirmed"}else{"continue_failed"});reason="post_stop_continue_failed_or_unconfirmed"}
  }
}
function Test-StableConversationChange([string]$title,[hashtable]$memory) {
  $title = Normalize-RecoveryText $title
  if(-not $title) { return $false }
  if(-not [string]$memory["stableConversationTitle"]) {
    $memory["stableConversationTitle"]=$title
    return $false
  }
  if($title -eq [string]$memory["stableConversationTitle"]) {
    $memory["candidateConversationTitle"]=$null
    $memory["candidateTitleObservations"]=0
    return $false
  }
  if($title -ne [string]$memory["candidateConversationTitle"]) {
    $memory["candidateConversationTitle"]=$title
    $memory["candidateTitleObservations"]=1
    return $false
  }
  $memory["candidateTitleObservations"]=[int]$memory["candidateTitleObservations"]+1
  if([int]$memory["candidateTitleObservations"] -lt 2) { return $false }
  $memory["stableConversationTitle"]=$title
  $memory["candidateConversationTitle"]=$null
  $memory["candidateTitleObservations"]=0
  return $true
}

function Invoke-WatchdogOnce([object]$cfg, [hashtable]$memory) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  $chat = Get-ChatGPTMainWindow
  if (-not $chat) { return [pscustomobject]@{detected=$false;action="none";reason="chatgpt_main_window_not_found"} }
  $edit = Get-VisibleComposer $chat
  if (-not $edit) { return [pscustomobject]@{detected=$false;action="none";reason="composer_not_found"} }
  $currentTitle = Get-ConversationTitle $chat
  $sessionWatch = Read-SessionWatch
  # Fail closed on a manual conversation switch: a pending response must never
  # continue in a different conversation. This clears state only, never navigates.
  if($currentTitle -and [string]$sessionWatch.pendingTitle -and $currentTitle -ne [string]$sessionWatch.pendingTitle) {
    Clear-SessionWatch
    $sessionWatch=Read-SessionWatch
    Log 'Pending session mismatch; preserving user-selected session and clearing navigation state.'
  }
  $stopActive = [bool](Find-ComposerActionButton $chat $edit "stop")
  if($stopActive -and $currentTitle){
    if([string]$sessionWatch.pendingTitle -ne $currentTitle){
      $sessionWatch.pendingTitle=$currentTitle
      $sessionWatch.pendingSince=(Get-Date).ToUniversalTime().ToString("o")
      $sessionWatch.returnTitle=""
    }
    $sessionWatch.clearSince=$null
    Write-SessionWatch $sessionWatch
  }
  # Do not treat volatile UIA composer runtime IDs as navigation.
  # Require two consecutive matching nonempty new conversation titles.
  $conversationChanged=Test-StableConversationChange $currentTitle $memory
  if($conversationChanged) {
    Reset-WatchdogEpisode $memory 'Confirmed conversation change; recovery episode state reset.'
    if([string]$sessionWatch.pendingTitle -and $currentTitle -ne [string]$sessionWatch.pendingTitle) {
      Clear-SessionWatch
      $sessionWatch=Read-SessionWatch
    }
  }

  $reviewNotice=Find-PlatformReviewNotice $chat
  if($reviewNotice) {
    if(-not $memory["platformReviewSeenAt"]) {
      $memory["platformReviewSeenAt"]=(Get-Date).ToUniversalTime().ToString("o")
      Log "Platform review notice detected; waiting without UI action."
    }
    return [pscustomobject]@{detected=$true;action="wait";reason="platform_review_in_progress"}
  }
  if($memory["platformReviewSeenAt"]) {
    Log "Platform review notice cleared; normal recovery detection resumed."
    $memory.Remove("platformReviewSeenAt")
  }

  $errorElement = Find-RecoveryError $chat $edit
  $textRecovery = $null
  $ocrRecovery = $null
  $recoverySource = "uia"
  if (-not $errorElement) {
    $now=Get-Date
    if(-not $memory["lastTextPatternScanAt"] -or ($now-$memory["lastTextPatternScanAt"]).TotalSeconds -ge 10) {
      $memory["lastTextPatternScanAt"]=$now
      $textRecovery = Find-TextPatternRecoveryCandidate $chat $edit
      if ($textRecovery) { $recoverySource = "textpattern" }
    }
  }
  if (-not $errorElement -and -not $textRecovery) {
    $now=Get-Date
    if(-not $memory["lastIdleOcrScanAt"] -or ($now-$memory["lastIdleOcrScanAt"]).TotalSeconds -ge 15) {
      $memory["lastIdleOcrScanAt"]=$now
      $ocrRecovery = Find-OcrRecoveryCandidate $chat
      if ($ocrRecovery) { $recoverySource = "ocr" }
    }
  }
  if (-not $errorElement -and -not $textRecovery -and -not $ocrRecovery) {
    if([bool]$sessionWatch.resumeAfterStop -and -not $stopActive -and (-not [string]$sessionWatch.pendingTitle -or $currentTitle -eq [string]$sessionWatch.pendingTitle)){
      $resumeResult=Invoke-ResumeAfterStoppedInterruption $chat $edit $cfg ([string]$sessionWatch.pendingTitle)
      if($resumeResult.action -in @("continue","continue_unconfirmed")){
        $sessionWatch.resumeAfterStop=$false
        $sessionWatch.stopRequestedAt=$null
        $sessionWatch.stopAttempts=0
        $sessionWatch.clearSince=$null
        Write-SessionWatch $sessionWatch
        return $resumeResult
      }
      if($resumeResult.reason -in @("composer_has_user_draft_or_unreadable_value","post_stop_context_changed","post_stop_session_changed","post_stop_composer_not_owned")){
        $sessionWatch.resumeAfterStop=$false
        $sessionWatch.stopRequestedAt=$null
        $sessionWatch.stopAttempts=0
        Write-SessionWatch $sessionWatch
      }
      if($resumeResult.action -ne "none" -or $resumeResult.reason -ne "post_stop_send_control_not_found"){ return $resumeResult }
    }
    $memory["errorKey"] = $null
    [void](Sync-EpisodeState $false $memory)
    if([string]$sessionWatch.pendingTitle -and $currentTitle -eq [string]$sessionWatch.pendingTitle -and -not $stopActive){
      if(-not $sessionWatch.clearSince){
        $sessionWatch.clearSince=(Get-Date).ToUniversalTime().ToString("o")
        Write-SessionWatch $sessionWatch
      } else {
        try {
          $clearAt=[datetime]::Parse([string]$sessionWatch.clearSince).ToUniversalTime()
          if(((Get-Date).ToUniversalTime()-$clearAt).TotalSeconds -ge 12){
            # Cleanup state only; never navigate away from the session the user is viewing.
            Clear-SessionWatch
          }
        } catch {}
      }
    }
    return [pscustomobject]@{detected=$false;action="none";reason="no_recovery_error_for_active_composer"}
  }
  if($currentTitle){
    if([string]$sessionWatch.pendingTitle -ne $currentTitle){
      $sessionWatch.pendingTitle=$currentTitle
      $sessionWatch.pendingSince=(Get-Date).ToUniversalTime().ToString("o")
    }
    $sessionWatch.clearSince=$null
    Write-SessionWatch $sessionWatch
  }
  if ($errorElement) {
    try { $errorText = [string]$errorElement.Current.Name } catch { $errorText = "" }
    $errorKey = Get-ElementRuntimeKey $errorElement
  } elseif ($textRecovery) {
    $errorText = [string]$textRecovery.Text
    $errorKey = [string]$textRecovery.Key
  } else {
    $errorText = [string]$ocrRecovery.Text
    $errorKey = [string]$ocrRecovery.Key
  }
  $previousErrorKey = [string]$memory["errorKey"]
  # A UI rerender may change the error runtime ID without ending the episode.
  # Only an observed clear or a different composer resets the persistent latch.
  if ($errorKey) { $memory["errorKey"] = $errorKey }

  if (Sync-EpisodeState $true $memory $cfg $errorText) {
    $reason = if([string]$memory["latchAction"] -eq "retry"){"waiting_for_retry_progress_or_cooldown"}elseif([string]$memory["latchAction"] -match "unconfirmed"){"dispatch_outcome_unconfirmed"}else{"already_resumed_for_current_error_episode"}
    return [pscustomobject]@{detected=$true;action="suppressed";reason=$reason}
  }

  $now = Get-Date
  if (-not $memory.errorSince) { $memory.errorSince = $now }
  if ($memory.lastActionAt -and (($now - $memory.lastActionAt).TotalSeconds -lt [int]$cfg.cooldownSeconds)) {
    return [pscustomobject]@{detected=$true;action="cooldown";reason="recent_action"}
  }

  if ($ocrRecovery -and [string]$cfg.mode -in @("retry","retry_then_continue")) {
    try {
      $retryKey = [string]$ocrRecovery.Key
      Set-EpisodeLatch "retry_unconfirmed" $retryKey $now
      $memory.suppressedUntilClear = $true
      $memory.retryAt = $now
      $memory.lastActionAt = $now
      [void](Invoke-OcrRecoveryRetry $ocrRecovery)
      Set-EpisodeLatch "retry" $retryKey $now
      Log ("Detected recovery error and unique Retry via OCR; dispatched without moving focus.")
      return [pscustomobject]@{detected=$true;action="retry";control=[string]$ocrRecovery.RetryLabel;source="ocr";error=$errorText}
    } catch {
      Log ("OCR recovery dispatch failed or was unconfirmed: " + $_.Exception.Message)
      return [pscustomobject]@{detected=$true;action="retry_unconfirmed";reason="ocr_retry_dispatch_failed";source="ocr"}
    }
  }

  # An exact associated Retry is safe to invoke without editing the composer, so try it
  # before applying the empty-composer guard used by continuation fallback.
  $retryButton = if($errorElement){ Find-RetryButtonNearError $chat $errorElement } elseif($textRecovery) { Find-TextPatternRetryButton $chat $textRecovery } else { $null }

  # Chromium may expose the error text through UIA/TextPattern while hiding the Retry button.
  # In that case use OCR only for the missing Retry, and require it to match the already-detected error kind.
  if (-not $retryButton -and [string]$cfg.mode -in @("retry","retry_then_continue")) {
    $ocrRetryRecovery = Find-OcrRecoveryCandidate $chat $errorText
    if ($ocrRetryRecovery) {
      try {
        $retryKey = [string]$ocrRetryRecovery.Key
        Set-EpisodeLatch "retry_unconfirmed" $retryKey $now
        $memory.suppressedUntilClear = $true
        $memory.retryAt = $now
        $memory.lastActionAt = $now
        [void](Invoke-OcrRecoveryRetry $ocrRetryRecovery)
        Set-EpisodeLatch "retry" $retryKey $now
        Log ("Detected recovery error via " + $recoverySource + " and dispatched hidden Retry via OCR without moving focus.")
        return [pscustomobject]@{detected=$true;action="retry";control=[string]$ocrRetryRecovery.RetryLabel;source="ocr";error=$errorText}
      } catch {
        Log ("OCR hidden Retry dispatch failed or was unconfirmed: " + $_.Exception.Message)
        return [pscustomobject]@{detected=$true;action="retry_unconfirmed";reason="ocr_hidden_retry_dispatch_failed";source="ocr"}
      }
    }
  }

  if ($retryButton -and -not $memory["retryFallbackReady"] -and [string]$cfg.mode -in @("retry","retry_then_continue")) {
    # Reacquire the live control immediately before InvokePattern. Runtime IDs
    # change on harmless React/Chromium rerenders; semantic identity is required.
    $retryButton = if($errorElement){ Resolve-FreshRetryButton $chat $edit $errorElement $retryButton } else { Resolve-FreshTextPatternRetryButton $chat $edit $textRecovery $retryButton }
    if (-not $retryButton) {
      return [pscustomobject]@{detected=$true;action="none";reason="recovery_context_changed"}
    }
    try {
      $label = Normalize-RecoveryText ([string]$retryButton.Current.Name)
      if (-not $label) { $label = "Retry" }
      $pat = $retryButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $retryKey = Get-ElementRuntimeKey $retryButton
      Set-EpisodeLatch "retry_unconfirmed" $retryKey $now
      $memory.suppressedUntilClear = $true
      $memory.retryAt = $now
      $memory.lastActionAt = $now
      $pat.Invoke()
      Set-EpisodeLatch "retry" $retryKey $now
      Log ('Detected associated recovery UI via ' + $recoverySource + '; invoked ' + $label)
      return [pscustomobject]@{detected=$true;action="retry";control=$label;source=$recoverySource;error=$errorText}
    } catch {
      Log ('Retry invocation unconfirmed; episode remains latched: ' + $_.Exception.Message)
      return [pscustomobject]@{detected=$true;action="retry_unconfirmed";reason="invoke_failed_or_unconfirmed"}
    }
  }

  # If any retry-like control is nearby but cannot be uniquely associated, fail closed.
  if ($errorElement -and (Test-RetryBlocksContinuation $chat $errorElement $memory)) {
    return [pscustomobject]@{detected=$true;action="none";reason="ambiguous_retry_control"}
  }
  if ([string]$cfg.mode -notin @("continue","retry_then_continue")) {
    return [pscustomobject]@{detected=$true;action="none";reason="associated_retry_control_not_found"}
  }
  $effectiveRetryGrace = if ($errorText -eq "연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.") { [Math]::Max(30,[int]$cfg.retryGraceSeconds) } elseif (Test-IsStalledGenerationRecoveryText $errorText) { [Math]::Min(8,[Math]::Max(5,[int]$cfg.retryGraceSeconds)) } else { [int]$cfg.retryGraceSeconds }
  if (($now - $memory.errorSince).TotalSeconds -lt $effectiveRetryGrace) {
    return [pscustomobject]@{detected=$true;action="wait";reason="waiting_for_retry_control"}
  }
  $stopButton=Find-ComposerActionButton $chat $edit "stop"
  if($stopButton -and (Test-IsStalledGenerationRecoveryText $errorText)){
    $lastStop=$null
    if($sessionWatch.stopRequestedAt){try{$lastStop=[datetime]::Parse([string]$sessionWatch.stopRequestedAt).ToUniversalTime()}catch{}}
    if($lastStop -and ((Get-Date).ToUniversalTime()-$lastStop).TotalSeconds -lt 8){
      return [pscustomobject]@{detected=$true;action="wait";reason="waiting_for_stop_after_connection_interrupt"}
    }
    if([int]$sessionWatch.stopAttempts -ge 2){
      return [pscustomobject]@{detected=$true;action="none";reason="connection_interrupt_stop_retry_limit"}
    }
    try {
      $currentChat=Get-ChatGPTMainWindow
      $currentEdit=Get-VisibleComposer $currentChat
      if(-not $currentChat -or -not $currentEdit -or (Get-ElementRuntimeKey $chat) -ne (Get-ElementRuntimeKey $currentChat) -or (Get-ElementRuntimeKey $edit) -ne (Get-ElementRuntimeKey $currentEdit)){
        return [pscustomobject]@{detected=$true;action="none";reason="stop_context_changed"}
      }
      $currentStop=Find-ComposerActionButton $currentChat $currentEdit "stop"
      if(-not $currentStop){return [pscustomobject]@{detected=$true;action="wait";reason="stop_disappeared_before_invoke"}}
      $sessionWatch.resumeAfterStop=$true
      $sessionWatch.stopRequestedAt=(Get-Date).ToUniversalTime().ToString("o")
      $sessionWatch.stopAttempts=([int]$sessionWatch.stopAttempts)+1
      Write-SessionWatch $sessionWatch
      $currentStop.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Log "Persistent Connection interrupted detected; invoked Stop via UIA and armed post-stop continuation."
      return [pscustomobject]@{detected=$true;action="stop";reason="connection_interrupted_stalled_generation"}
    } catch {
      Log ("Connection interrupted Stop invocation failed or was unconfirmed: "+$_.Exception.Message)
      return [pscustomobject]@{detected=$true;action="stop_unconfirmed";reason="connection_interrupt_stop_failed_or_unconfirmed"}
    }
  }
  if($stopButton){
    return [pscustomobject]@{detected=$true;action="none";reason="generation_still_active"}
  }

  # Stop/Retry actions above never edit the composer. Only continuation injection
  # requires an empty, readable composer, so preserve any real user draft here.
  if (Get-ComposerUserText $edit) {
    return [pscustomobject]@{detected=$true;action="none";reason="composer_has_user_draft_or_unreadable_value"}
  }

  # Re-read the foreground ChatGPT context immediately before injecting anything.
  $currentChat = Get-ChatGPTMainWindow
  $currentEdit = Get-VisibleComposer $currentChat
  if (-not $currentChat -or -not $currentEdit) {
    return [pscustomobject]@{detected=$true;action="none";reason="continuation_context_missing"}
  }
  if ((Get-ElementRuntimeKey $chat) -ne (Get-ElementRuntimeKey $currentChat) -or (Get-ElementRuntimeKey $edit) -ne (Get-ElementRuntimeKey $currentEdit)) {
    return [pscustomobject]@{detected=$true;action="none";reason="continuation_context_changed"}
  }
  if (Get-ComposerUserText $currentEdit) {
    return [pscustomobject]@{detected=$true;action="none";reason="composer_changed_before_continue"}
  }
  if ($errorElement) {
    $currentError = Find-RecoveryError $currentChat $currentEdit
    if (-not $currentError -or (Get-ElementRuntimeKey $errorElement) -ne (Get-ElementRuntimeKey $currentError)) {
      return [pscustomobject]@{detected=$true;action="none";reason="recovery_error_changed_before_continue"}
    }
    if (Test-RetryBlocksContinuation $currentChat $currentError $memory) {
      return [pscustomobject]@{detected=$true;action="none";reason="retry_control_appeared_before_continue"}
    }
  } else {
    $currentTextRecovery = Find-TextPatternRecoveryCandidate $currentChat $currentEdit
    if (-not $currentTextRecovery -or [string]$currentTextRecovery.Text -ne [string]$textRecovery.Text) {
      return [pscustomobject]@{detected=$true;action="none";reason="recovery_error_changed_before_continue"}
    }
    if (Find-TextPatternRetryButton $currentChat $currentTextRecovery) {
      return [pscustomobject]@{detected=$true;action="none";reason="retry_control_appeared_before_continue"}
    }
  }

  $resumeText = ([string]$cfg.resumeText).Trim()
  if (-not $resumeText) { $resumeText = "Continue the previous task from the last completed checkpoint. Verify actual state before repeating side effects." }
  $latched = $false
  try {
    $vp = $currentEdit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($resumeText)
    Start-Sleep -Milliseconds 180

    $afterChat = Get-ChatGPTMainWindow
    $afterEdit = Get-VisibleComposer $afterChat
    if (-not $afterChat -or -not $afterEdit -or (Get-ElementRuntimeKey $currentChat) -ne (Get-ElementRuntimeKey $afterChat) -or (Get-ElementRuntimeKey $currentEdit) -ne (Get-ElementRuntimeKey $afterEdit)) {
      Clear-InjectedResume $currentEdit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="context_changed_after_resume_injection"}
    }
    if ((Get-ComposerUserText $afterEdit) -ne $resumeText) {
      Clear-InjectedResume $afterEdit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="composer_not_owned_after_resume_injection"}
    }
    if (Find-ComposerActionButton $afterChat $afterEdit "stop") {
      Clear-InjectedResume $afterEdit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="generation_started_before_resume_send"}
    }
    $sendButton = Find-ComposerActionButton $afterChat $afterEdit "send"
    if (-not $sendButton) {
      Clear-InjectedResume $afterEdit $resumeText
      return [pscustomobject]@{detected=$true;action="none";reason="send_control_not_found"}
    }

    $sendPattern = $sendButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    Set-EpisodeLatch "continue_unconfirmed" "" $now
    $latched = $true
    $memory.suppressedUntilClear = $true
    $memory.lastActionAt = $now
    $sendPattern.Invoke()
    Set-EpisodeLatch "continue" "" $now
    Log ('Detected recovery UI without Retry; continuation submitted by UIA invoke.')
    return [pscustomobject]@{detected=$true;action="continue";reason="no_retry_control_uia_fallback";error=$errorText}
  } catch {
    if (-not $latched) { Clear-InjectedResume $currentEdit $resumeText }
    Log ('Continuation fallback failed or was unconfirmed: ' + $_.Exception.Message)
    return [pscustomobject]@{detected=$true;action=($(if($latched){"continue_unconfirmed"}else{"continue_failed"}));reason="uia_continue_failed_or_unconfirmed"}
  }
}

if ($Action -eq "selftest") {
  Clear-EpisodeLatch
  $m1 = @{errorSince=$null;retryAt=$null;lastActionAt=$null;sendFailureAt=$null;suppressedUntilClear=$false}
  $initialSuppressed = Sync-EpisodeState $true $m1
  Set-EpisodeLatch
  $m2 = @{errorSince=$null;retryAt=$null;lastActionAt=$null;sendFailureAt=$null;suppressedUntilClear=$false}
  $restartSuppressed = Sync-EpisodeState $true $m2
  [void](Sync-EpisodeState $false $m2)
  $clearedAfterRecovery = -not (Test-EpisodeLatch)
  $m3 = @{errorSince=$null;retryAt=$null;lastActionAt=$null;sendFailureAt=$null;suppressedUntilClear=$false}
  $newEpisodeSuppressed = Sync-EpisodeState $true $m3
  Clear-EpisodeLatch
  $stopNamesOk = (Test-IsStopActionName "Stop") -and (Test-IsStopActionName "Stop generating") -and (-not (Test-IsStopActionName "Send"))
  $voiceNamesOk = (Test-IsVoiceActionName "Voice") -and (Test-IsVoiceActionName "Microphone") -and (-not (Test-IsVoiceActionName "Send"))
  $sendNamesOk = (Test-IsSendActionName "Send") -and (Test-IsSendActionName "Send message") -and (-not (Test-IsSendActionName "Voice"))
  $recoveryTextOk = (Test-IsRecoveryErrorText "Message delivery timed out. Please try again.") -and (Test-IsRecoveryErrorText "Resume stream unavailable") -and (Test-IsRecoveryErrorText "Connection interrupted. Waiting for the complete answer") -and (Test-IsRecoveryErrorText "연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.") -and (-not (Test-IsRecoveryErrorText "Message delivery timed out. Please try again. 이거 떠서 멈춰있었어.")) -and (-not (Test-IsRecoveryErrorText "오류: Message delivery timed out. Please try again."))
  $windowHostOk = (Test-IsChatGptWindowHost "ChatGPT" "ChatGPT") -and (-not (Test-IsChatGptWindowHost "msedge" "My chat - ChatGPT - Microsoft Edge")) -and (-not (Test-IsChatGptWindowHost "chrome" "ChatGPT - Google Chrome")) -and (-not (Test-IsChatGptWindowHost "msedge" "Search results - Microsoft Edge")) -and (-not (Test-IsChatGptWindowHost "notepad" "ChatGPT notes"))
  $retryNamesOk = (Test-IsRetryActionName "Retry") -and (Test-IsRetryActionName "Try again") -and (Test-IsRetryActionName "다시하기") -and (-not (Test-IsRetryActionName "Message delivery timed out. Please try again."))
  $m4 = @{errorSince=$null;retryAt=$null;lastActionAt=$null;sendFailureAt=(Get-Date);suppressedUntilClear=$false}
  [void](Sync-EpisodeState $false $m4)
  $failureResetOk = -not $m4.sendFailureAt
  $testTitles=@{}
  $titleChecks=@(
    (Test-StableConversationChange "Job Application" $testTitles),
    (Test-StableConversationChange "Job Application" $testTitles),
    (Test-StableConversationChange "Other Thread" $testTitles),
    (Test-StableConversationChange "Job Application" $testTitles),
    (Test-StableConversationChange "Other Thread" $testTitles),
    (Test-StableConversationChange "Other Thread" $testTitles))
  $stableTitleOk=(-not $titleChecks[0]) -and (-not $titleChecks[1]) -and (-not $titleChecks[2]) -and (-not $titleChecks[3]) -and (-not $titleChecks[4]) -and $titleChecks[5]
  $ok = (-not $initialSuppressed) -and $restartSuppressed -and $clearedAfterRecovery -and (-not $newEpisodeSuppressed) -and $stopNamesOk -and $voiceNamesOk -and $sendNamesOk -and $recoveryTextOk -and $windowHostOk -and $retryNamesOk -and $failureResetOk -and $stableTitleOk
  [pscustomobject]@{
    ok=$ok
    initialSuppressed=$initialSuppressed
    restartSuppressed=$restartSuppressed
    clearedAfterRecovery=$clearedAfterRecovery
    newEpisodeSuppressed=$newEpisodeSuppressed
    stopNamesOk=$stopNamesOk
    voiceNamesOk=$voiceNamesOk
    sendNamesOk=$sendNamesOk
    recoveryTextOk=$recoveryTextOk
    windowHostOk=$windowHostOk
    retryNamesOk=$retryNamesOk
    failureResetOk=$failureResetOk
  } | ConvertTo-Json -Compress
  if (-not $ok) { exit 1 }
  exit 0
}

if ($Action -eq "enable") {
  $cfg = Write-Config $true $Mode $PollSeconds $RetryGraceSeconds $CooldownSeconds $ResumeText
  $script = $MyInvocation.MyCommand.Path
  $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $runningPid = Get-RunningPid
  if ($runningPid) {
    try { Stop-Process -Id $runningPid -Force -ErrorAction Stop } catch {}
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
  }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $stateDir "chatgpt-ui-watchdog-launcher.vbs") -Force -ErrorAction SilentlyContinue
  $arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '" -Action run'
  $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description "Recover ChatGPT desktop UI after visible recovery/network errors." | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 2
  [pscustomobject]@{enabled=$true;mode=$cfg.mode;pid=(Get-RunningPid);taskRegistered=$true;config=$configPath;log=$logPath} | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "disable") {
  $cfg = Read-Config
  Write-Config $false ([string]$cfg.mode) ([int]$cfg.pollSeconds) ([int]$cfg.retryGraceSeconds) ([int]$cfg.cooldownSeconds) ([string]$cfg.resumeText) | Out-Null
  $runningPid = Get-RunningPid
  if ($runningPid) { try { Stop-Process -Id $runningPid -Force -ErrorAction Stop } catch {} }
  Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $stateDir "chatgpt-ui-watchdog-launcher.vbs") -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{enabled=$false;pid=$null;taskRegistered=$false} | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "status") {
  $cfg = Read-Config
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  [pscustomobject]@{
    enabled = [bool]$cfg.enabled
    mode = [string]$cfg.mode
    pollSeconds = [int]$cfg.pollSeconds
    retryGraceSeconds = [int]$cfg.retryGraceSeconds
    cooldownSeconds = [int]$cfg.cooldownSeconds
    pid = Get-RunningPid
    taskRegistered = [bool]$task
    taskState = if($task){[string]$task.State}else{$null}
    log = $logPath
    observation = if (Test-Path $observationPath) { try { Get-Content -LiteralPath $observationPath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "inspect") {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $chat = Get-ChatGPTMainWindow
  $edit = Get-VisibleComposer $chat
  $errorElement = Find-RecoveryError $chat $edit
  $textRecovery = if(-not $errorElement){Find-TextPatternRecoveryCandidate $chat $edit}else{$null}
  $retry = if($errorElement){Find-RetryButtonNearError $chat $errorElement}elseif($textRecovery){Find-TextPatternRetryButton $chat $textRecovery}else{$null}
  $nearbyActions = @()
  if ($chat -and $errorElement) {
    try {
      $er = Get-ElementRect $errorElement
      $all = $chat.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
      foreach ($e in $all) {
        if ($nearbyActions.Count -ge 30) { break }
        try {
          if ($e.Current.IsOffscreen -or -not $e.Current.IsEnabled -or $e.Current.ProcessId -ne $errorElement.Current.ProcessId) { continue }
          $r = Get-ElementRect $e
          if (-not $r) { continue }
          $xGap = [Math]::Max(0,[Math]::Max($er.Left-$r.Right,$r.Left-$er.Right))
          $yGap = [Math]::Max(0,[Math]::Max($er.Top-$r.Bottom,$r.Top-$er.Bottom))
          if ($xGap -gt 320 -or $yGap -gt 180) { continue }
          $invokable = $false
          try { [void]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $invokable=$true } catch {}
          $name = Normalize-RecoveryText ([string]$e.Current.Name)
          if (-not $invokable -and -not (Test-IsRetryActionName $name)) { continue }
          $nearbyActions += [pscustomobject]@{
            name=$name
            type=[string]$e.Current.ControlType.ProgrammaticName
            automationId=[string]$e.Current.AutomationId
            className=[string]$e.Current.ClassName
            xGap=[int]$xGap
            yGap=[int]$yGap
            invokable=$invokable
          }
        } catch {}
      }
    } catch {}
  }
  # Read-only diagnostics deliberately omit chat/composer contents.
  [pscustomobject]@{
    foregroundChatGPT = [bool]$chat
    composerFound = [bool]$edit
    composerReadableAndEmpty = ($edit -and -not (Get-ComposerUserText $edit))
    recoverySurfaceFound = [bool]($errorElement -or $textRecovery)
    recoverySource = if($errorElement){"uia"}elseif($textRecovery){"textpattern"}else{$null}
    retryFound = [bool]$retry
    retryName = if ($retry) {[string]$retry.Current.Name} else {$null}
    nearbyActions = $nearbyActions
    action = "inspect_only"
  } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($Action -eq "once") {
  $cfg = Read-Config
  if (-not $cfg.resumeText) { $cfg.resumeText = $ResumeText }
  $memory = @{errorSince=$null;retryAt=$null;lastActionAt=$null;sendFailureAt=$null;suppressedUntilClear=$false}
  Invoke-WatchdogOnce $cfg $memory | ConvertTo-Json -Compress
  exit 0
}

function Test-NeedUiSnapshot([hashtable]$m) {
 $now=Get-Date
 if($m.errorSince -or $m.retryAt -or $m.suppressedUntilClear){return $true}
 if(-not $m['lastQuietScan']){$m['lastQuietScan']=$now}
 if(-not $m['nextLogLookup'] -or $now -ge $m['nextLogLookup']){
  $m['nextLogLookup']=$now.AddSeconds(60)
  try{
   $latest=Get-ChildItem "$env:LOCALAPPDATA\Codex\Logs" -Filter 'codex-desktop*' -File -Recurse -Depth 5 -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '-t0-'} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
   if($latest -and $latest.FullName -ne [string]$m['logSource']){
    $m['logSource']=$latest.FullName
    $m['logBytes']=[long]$latest.Length
    $m['lastReadUtc']=$now.ToUniversalTime()
   }
  }catch{}
 }
 $p=[string]$m['logSource']
 if($p -and (Test-Path -LiteralPath $p)){
  try{
   $fi=Get-Item -LiteralPath $p
   $size=[long]$m['logBytes']
   if($fi.Length -lt $size){
    $m['logBytes']=[long]$fi.Length
    $m['lastReadUtc']=$now.ToUniversalTime()
   }elseif($fi.Length -gt $size){
    $since=$m['lastReadUtc'];$signal='none'
    foreach($line in @(Get-Content -LiteralPath $p -Tail 90 -ErrorAction Stop)){
     if($line -notmatch '^(20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)'){continue}
     $dt=[datetime]::MinValue
     if(-not [datetime]::TryParse($Matches[1],[ref]$dt)){continue}
     if($since -and $dt.ToUniversalTime() -lt $since.AddSeconds(-1)){continue}
     # Differentiate actionable response failures from harmless background transport churn.
     if($line -match '(?i)message delivery timed out|resume stream unavailable|connection interrupted|stream recovery polling timed out'){$signal='strong';break}
     if($signal -eq 'none' -and $line -match '(?i)chatgpt_pubsub_transport_closed|chatgpt_pubsub_reconnect_scheduled|sa_server_request_failed|app_server_connection\.transport_closed'){$signal='weak'}
    }
    $m['logBytes']=[long]$fi.Length
    $m['lastReadUtc']=$now.ToUniversalTime()
    if($signal -eq 'strong'){
      if(-not $m['lastStrongSignalAt'] -or ($now-$m['lastStrongSignalAt']).TotalSeconds -ge 25){
        $m['lastStrongSignalAt']=$now
        $m['signalBudget']=3
        Log 'Strong recovery error signal; inspecting UI for actionable retry.'
      }
    }elseif($signal -eq 'weak'){
      if(-not $m['lastWeakSignalAt'] -or ($now-$m['lastWeakSignalAt']).TotalSeconds -ge 180){
        $m['lastWeakSignalAt']=$now
        $m['signalBudget']=1
        Log 'Background transport churn; one bounded UI inspection.'
      }
    }
   }
  }catch{}
 }
 if([int]$m['signalBudget'] -gt 0){$m['signalBudget']=[int]$m['signalBudget']-1;return $true}
 # Never enumerate the live ChatGPT UI just because a timer elapsed.
 # The 3-minute fallback UIA scan was correlated with browser-main jank
 # at 20:29:50 local time. Preserve scans for real recovery log signals
 # and an already active recovery episode.
 return $false
}

if ($Action -eq "run") {
  $mutexSuffix = ($env:USERNAME -replace '[^A-Za-z0-9_.-]','_')
  if (-not $mutexSuffix) { $mutexSuffix = 'user' }
  $runMutex = New-Object System.Threading.Mutex -ArgumentList $false,("Local\ChatGPT-UI-Watchdog-" + $mutexSuffix)
  $ownsRunMutex = $false
  try {
    try { $ownsRunMutex = $runMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsRunMutex = $true }
    if (-not $ownsRunMutex) { exit 0 }

    $PID | Set-Content -LiteralPath $pidPath -Encoding ASCII
    $memory = @{errorSince=$null;retryAt=$null;lastActionAt=$null;sendFailureAt=$null;suppressedUntilClear=$false}
    while ($true) {
      $cfg = Read-Config
      if (-not [bool]$cfg.enabled) { break }
      if(Test-NeedUiSnapshot $memory){
        try {
          $decision=Invoke-WatchdogOnce $cfg $memory
          Write-WatchdogObservation $decision $memory
        } catch {
          Log ('watch transient error: '+$_.Exception.Message)
          Start-Sleep -Milliseconds 250
          try {
            $decision=Invoke-WatchdogOnce $cfg $memory
            Write-WatchdogObservation $decision $memory
            Log 'watch transient error recovered on fresh UI snapshot.'
          } catch { Log ('watch error after fresh-snapshot retry: '+$_.Exception.Message) }
        }
      } else {
        $time=Get-Date
        if(-not $memory['lastQuietObservation'] -or ($time-$memory['lastQuietObservation']).TotalSeconds -ge 60){
          $memory['lastQuietObservation']=$time
          Write-WatchdogObservation ([pscustomobject]@{detected=$false;action='none';reason='quiet_no_uia'}) $memory
        }
      }
      Start-Sleep -Seconds ([Math]::Max(2,[int]$cfg.pollSeconds))
    }
  } finally {
    try {
      if (Test-Path $pidPath) {
        $pidOwner = (Get-Content -LiteralPath $pidPath -Raw -ErrorAction Stop).Trim()
        if ($pidOwner -eq [string]$PID) { Remove-Item $pidPath -Force -ErrorAction SilentlyContinue }
      }
    } catch {}
    if ($ownsRunMutex) { try { $runMutex.ReleaseMutex() } catch {} }
    if ($runMutex) { try { $runMutex.Dispose() } catch {} }
  }
}
