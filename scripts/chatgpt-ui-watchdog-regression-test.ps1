$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$sourcePath = Join-Path $PSScriptRoot "chatgpt-ui-watchdog.ps1"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load declarations only. Never run the live script's configuration, task, or latch actions.
$definitions = $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)
foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }
. (Join-Path $PSScriptRoot "chatgpt-ui-watchdog-textpattern.ps1")
. (Join-Path $PSScriptRoot "chatgpt-ui-watchdog-ocr.ps1")
$episodeLatchPath = Join-Path ([System.IO.Path]::GetTempPath()) ("watchdog-regression-" + [guid]::NewGuid().ToString("N") + ".latch")
$sessionWatchPath = Join-Path ([System.IO.Path]::GetTempPath()) ("watchdog-session-regression-" + [guid]::NewGuid().ToString("N") + ".json")
$script:assertions = 0
$script:invocations = 0
$script:chatReads = 0
$script:replacementChat = $null
$script:conversationTitle = ""
function Get-ConversationTitle([object]$chat) { return [string]$script:conversationTitle }
$script:koRetry1=([string][char]0xB2E4)+([char]0xC2DC)+" "+([char]0xC2DC)+([char]0xB3C4)
$script:koRetry2=([string][char]0xC7AC)+([char]0xC2DC)+([char]0xB3C4)
$script:koRetry3=([string][char]0xB2E4)+([char]0xC2DC)+([char]0xD558)+([char]0xAE30)
function Assert([bool]$ok, [string]$message) {
  if (-not $ok) { throw "FAIL: $message" }
  $script:assertions++
}
function Log([string]$message) {}
function Get-UiaParent([object]$element) { return $element.Parent }
function Get-ChatGPTMainWindow {
  $script:chatReads++
  if ($script:replacementChat -and $script:chatReads -gt 1) { return $script:replacementChat }
  return $script:activeChat
}
function New-Element([int]$id, [string]$type, [string]$name, [int]$left, [int]$top, [int]$width, [int]$height) {
  $element = [pscustomobject]@{
    Key = $id; Parent = $null; Children = @(); Value = ""; ThrowInvoke = $false
    Current = [pscustomobject]@{
      Name = $name; AutomationId = ""; ClassName = ""; ProcessId = 1234
      ControlType = [System.Windows.Automation.ControlType]::$type
      IsEnabled = $true; IsOffscreen = $false
      BoundingRectangle = [pscustomobject]@{Left=$left;Top=$top;Right=($left+$width);Bottom=($top+$height);Width=$width;Height=$height}
    }
  }
  $element | Add-Member ScriptMethod GetRuntimeId { return @(42,$this.Key) }
  $element | Add-Member ScriptMethod FindAll {
    param($scope,$condition)
    $items = @($this)
    foreach ($child in $this.Children) { $items += $child.FindAll($scope,$condition) }
    return ,$items
  }
  $element | Add-Member ScriptMethod GetCurrentPattern {
    param($pattern)
    if ($this.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
      $owner=$this
      $valuePattern=[pscustomobject]@{Current=[pscustomobject]@{Value=$this.Value};Owner=$owner}
      $valuePattern | Add-Member ScriptMethod SetValue { param($value) $this.Owner.Value=[string]$value }
      return $valuePattern
    }
    if ($this.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { throw "Pattern unavailable" }
    $invoke = [pscustomobject]@{ThrowInvoke=$this.ThrowInvoke}
    $invoke | Add-Member ScriptMethod Invoke {
      $script:invocations++
      if ($this.ThrowInvoke) { throw "Invocation response lost" }
    }
    return $invoke
  }
  return $element
}
function Add-Child([object]$parent, [object]$child) { $child.Parent = $parent; $parent.Children += $child }
function New-Fixture {
  $chat = New-Element 1 Window "ChatGPT" 0 0 1000 900
  $panel = New-Element 2 Pane "" 200 680 650 80
  $error = New-Element 3 Text "Message delivery timed out. Please try again." 220 700 440 30
  $retry = New-Element 4 Button $script:koRetry3 680 700 100 30
  $edit = New-Element 5 Edit "Message" 200 800 650 80
  $send = New-Element 7 Button "Send" 860 805 70 60
  Add-Child $chat $panel; Add-Child $chat $edit; Add-Child $chat $send
  Add-Child $panel $error; Add-Child $panel $retry
  $script:activeChat=$chat; $script:chatReads=0; $script:replacementChat=$null
  return [pscustomobject]@{Chat=$chat;Panel=$panel;Error=$error;Retry=$retry;Edit=$edit;Send=$send}
}
function New-Memory { return @{errorSince=$null;retryAt=$null;lastActionAt=$null;sendFailureAt=$null;suppressedUntilClear=$false} }
$cfg = [pscustomobject]@{mode="retry_then_continue";cooldownSeconds=45;retryGraceSeconds=5;resumeText="Continue"}
try {
  $ocrGood=Select-OcrRecoveryPair @(
    [pscustomobject]@{text="Message delivery timed out. Please try again.";x=200;y=300;width=360;height=20},
    [pscustomobject]@{text="Retry";x=580;y=305;width=70;height=20}
  )
  Assert ($null -ne $ocrGood -and [string]$ocrGood.Retry.text -eq "Retry") "OCR unique nearby Retry pair"
  $ocrNoButton=Select-OcrRecoveryPair @(
    [pscustomobject]@{text="Message delivery timed out. Please try again.";x=200;y=300;width=360;height=20}
  )
  Assert ($null -eq $ocrNoButton) "OCR error text alone never acts"
  $ocrAmbiguous=Select-OcrRecoveryPair @(
    [pscustomobject]@{text="Message delivery timed out. Please try again.";x=200;y=300;width=360;height=20},
    [pscustomobject]@{text="Retry";x=580;y=305;width=70;height=20},
    [pscustomobject]@{text="Try again";x=590;y=330;width=90;height=20}
  )
  Assert ($null -eq $ocrAmbiguous) "OCR ambiguous retry controls fail closed"
  $rectRange=[pscustomobject]@{}
  $rectRange | Add-Member ScriptMethod GetBoundingRectangles {
    return ,([pscustomobject]@{X=10;Y=20;Width=30;Height=40})
  }
  $rectParsed=Get-TextRangeRect $rectRange
  Assert ($null -ne $rectParsed -and [int]$rectParsed.Left -eq 10 -and [int]$rectParsed.Top -eq 20 -and [int]$rectParsed.Width -eq 30 -and [int]$rectParsed.Height -eq 40) "TextPattern Rect object bounding rectangle"
  Assert (Test-IsRecoveryErrorText "Message delivery timed out. Please try again.") "exact system error"
  Assert (Test-IsRecoveryErrorText " Message delivery timed out. `r`n Please try again. ") "normalized system error"
  Assert (-not (Test-IsRecoveryErrorText '"Message delivery timed out. Please try again."')) "quoted error"
  Assert (-not (Test-IsRecoveryErrorText "Message delivery timed out. Please try again. this is quoted user text")) "extended user text"
  Assert (-not (Test-IsRecoveryErrorText "Error: Message delivery timed out. Please try again.")) "prefixed error"
  Assert (Test-IsPlatformReviewText "Before responding, the system is reviewing this request further.") "platform review label"
  Assert (-not (Test-IsPlatformReviewText '"Before responding, the system is reviewing this request further."')) "quoted platform review label"
  foreach ($label in @("Retry","Try again","Regenerate",$script:koRetry1,$script:koRetry2,$script:koRetry3)) { Assert (Test-IsRetryActionName $label) "retry label recognition" }
  Assert (-not (Test-IsRetryActionName "Copy")) "unrelated button name"
  $placeholderEdit=New-Element 88 Edit "Ask ChatGPT" 200 800 650 80
  $placeholderEdit.Current.ClassName="ProseMirror ProseMirror-focused"
  $placeholderEdit.Value="Ask ChatGPT"
  Assert ((Get-ComposerUserText $placeholderEdit) -eq "") "ProseMirror placeholder value is treated as empty composer"
  $placeholderEdit.Value="actual user draft"
  Assert ((Get-ComposerUserText $placeholderEdit) -eq "actual user draft") "real composer draft is preserved"
  $reviewFixture=New-Fixture
  $reviewFixture.Panel.Children=@()
  $reviewNotice=New-Element 89 Text "Before responding, the system is reviewing this request further." 260 680 520 30
  Add-Child $reviewFixture.Panel $reviewNotice
  $beforeReview=$script:invocations
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "wait" -and $r.reason -eq "platform_review_in_progress") "platform review waits without recovery action"
  Assert ($script:invocations -eq $beforeReview) "platform review never invokes Stop, Retry, Send, or sidebar controls"
  $reviewFixture.Panel.Current.AutomationId="user-message"
  Assert (-not (Find-PlatformReviewNotice $reviewFixture.Chat)) "quoted platform review text inside a chat message is ignored"
  $sidebarFixture=New-Fixture
  $thread=New-Element 90 Button "Native audio repair" 20 300 240 30
  $thread.Current.ClassName="sidebar-item"
  Add-Child $sidebarFixture.Chat $thread
  $sidebarFound=Find-SidebarConversationButton $sidebarFixture.Chat "Native audio repair"
  Assert ([bool]$sidebarFound) "unique sidebar conversation button selected"
  $thread2=New-Element 91 Button "Native audio repair" 20 340 240 30
  $thread2.Current.ClassName="sidebar-item"
  Add-Child $sidebarFixture.Chat $thread2
  Assert (-not (Find-SidebarConversationButton $sidebarFixture.Chat "Native audio repair")) "duplicate conversation titles fail closed"

  Clear-SessionWatch
  $f=New-Fixture
  $f.Panel.Children=@()
  $script:conversationTitle="Completed session"
  Write-SessionWatch ([pscustomobject]@{
    pendingTitle="Working session";returnTitle="";pendingSince=(Get-Date).ToUniversalTime().ToString("o")
    clearSince=$null;resumeAfterStop=$false;stopRequestedAt=$null;stopAttempts=0
  })
  $beforeSessionSwitch=$script:invocations
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($script:invocations -eq $beforeSessionSwitch) "manual conversation switch never invokes a sidebar thread"
  Assert (-not (Test-Path $sessionWatchPath)) "manual conversation switch clears pending navigation state"
  Assert ($r.reason -eq "no_recovery_error_for_active_composer") "manual conversation switch keeps the selected session active"
  $script:conversationTitle=""
  Clear-SessionWatch

  $f = New-Fixture
  Assert ([bool](Find-RecoveryError $f.Chat $f.Edit)) "real compact error surface"
  Assert ((Get-ElementRuntimeKey (Find-RetryButtonNearError $f.Chat $f.Error)) -eq "42.4") "associated retry selected"
  $f.Panel.Current.AutomationId="user-message"
  Assert (-not (Find-RecoveryError $f.Chat $f.Edit)) "exact quoted text inside user message"
  $f.Panel.Current.AutomationId="markdown"
  Assert (-not (Find-RecoveryError $f.Chat $f.Edit)) "exact quoted text in assistant markdown"
  $f = New-Fixture
  $f.Panel.Children=@($f.Error); $f.Retry.Parent=$f.Chat; $f.Chat.Children += $f.Retry
  Assert ([bool](Find-RecoveryError $f.Chat $f.Edit)) "buttonless recovery surface remains detectable"
  Assert (-not (Find-RetryButtonNearError $f.Chat $f.Error)) "nearby unrelated retry is not associated"
  Assert (Test-HasAnyRetryActionNearError $f.Chat $f.Error) "nearby retry blocks continuation fallback"
  $f = New-Fixture
  Add-Child $f.Panel (New-Element 6 Button "Copy" 800 700 30 30)
  Assert (-not (Find-RecoveryError $f.Chat $f.Edit)) "message footer with unrelated buttons"
  $f = New-Fixture
  Add-Child $f.Panel (New-Element 6 Button "Retry" 790 700 30 30)
  Assert ([bool](Find-RecoveryError $f.Chat $f.Edit)) "ambiguous retry surface still detected"
  Assert (-not (Find-RetryButtonNearError $f.Chat $f.Error)) "ambiguous retry is never invoked"
  Assert (Test-HasAnyRetryActionNearError $f.Chat $f.Error) "ambiguous retry blocks continuation fallback"

  Clear-EpisodeLatch
  $f = New-Fixture
  $f.Panel.Children=@($f.Error); $f.Retry.Parent=$null
  $continueCfg=[pscustomobject]@{mode="retry_then_continue";cooldownSeconds=45;retryGraceSeconds=5;resumeText="Continue from checkpoint"}
  $continueMemory=New-Memory; $continueMemory.errorSince=(Get-Date).AddSeconds(-10)
  $beforeContinue=$script:invocations
  $r=Invoke-WatchdogOnce $continueCfg $continueMemory
  Assert ($r.action -eq "continue") "buttonless recovery uses UIA continuation fallback"
  Assert ($script:invocations -eq ($beforeContinue+1)) "continuation invokes exactly one Send control"
  Assert ($f.Edit.Value -eq $continueCfg.resumeText) "continuation uses ValuePattern without focus typing"
  Assert (Test-EpisodeLatch) "continuation latches episode before Send invoke"
  Clear-EpisodeLatch
  $f = New-Fixture; $f.Retry.Current.ProcessId=9999
  Assert ([bool](Find-RecoveryError $f.Chat $f.Edit)) "different-process retry does not invalidate recovery surface"
  Assert (-not (Find-RetryButtonNearError $f.Chat $f.Error)) "different-process retry is never associated"
  Assert (-not (Test-HasAnyRetryActionNearError $f.Chat $f.Error)) "different-process retry does not block safe fallback"
  $f = New-Fixture; $f.Retry.Current.IsOffscreen=$true
  Assert ([bool](Find-RecoveryError $f.Chat $f.Edit)) "offscreen retry does not invalidate recovery surface"
  Assert (-not (Find-RetryButtonNearError $f.Chat $f.Error)) "offscreen retry is never associated"
  Assert (-not (Test-HasAnyRetryActionNearError $f.Chat $f.Error)) "offscreen retry does not block safe fallback"
  $f = New-Fixture; $f.Edit.Value="unfinished user draft"
  $before=$script:invocations; $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "retry" -and $script:invocations -eq ($before+1) -and $f.Edit.Value -eq "unfinished user draft") "associated retry invoked without modifying user draft"
  Clear-EpisodeLatch
  $f = New-Fixture; $script:replacementChat=New-Element 99 Window "Other session" 0 0 1000 900
  $before=$script:invocations; $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.reason -eq "recovery_context_changed" -and $script:invocations -eq $before) "foreground/session switch aborts retry"
  $f = New-Fixture; $memory=New-Memory
  $r=Invoke-WatchdogOnce $cfg $memory
  Assert ($r.action -eq "retry" -and $script:invocations -eq ($before+1)) "one retry invoked"
  $r=Invoke-WatchdogOnce $cfg $memory
  Assert ($r.action -eq "suppressed" -and $script:invocations -eq ($before+1)) "episode prevents duplicate retry"
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "suppressed") "persistent latch survives restart"
  $f.Error.Key=303
  $r=Invoke-WatchdogOnce $cfg $memory
  Assert ($r.action -eq "suppressed") "rerender does not reset latch"
  $f.Error.Current.Name="Everything is healthy"
  $r=Invoke-WatchdogOnce $cfg $memory
  Assert (-not (Test-EpisodeLatch)) "observed recovery clears latch"
  $f.Error.Current.Name="Message delivery timed out. Please try again."
  $r=Invoke-WatchdogOnce $cfg $memory
  Assert ($r.action -eq "cooldown") "cooldown survives episode clear"
  $f = New-Fixture; $f.Retry.ThrowInvoke=$true
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "retry_unconfirmed" -and (Test-EpisodeLatch)) "ambiguous invoke latched before dispatch"
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "suppressed") "ambiguous invocation never blindly repeated"

  Clear-EpisodeLatch
  $f=New-Fixture
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-90))
  $beforeFallback=$script:invocations
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "continue") "persisting error after returned Retry falls back after grace and cooldown"
  Assert ($script:invocations -eq ($beforeFallback+1)) "fallback sends once without invoking Retry again"
  Assert ((Get-EpisodeRecord).action -eq "continue") "Send dispatch has a separate durable latch"
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "suppressed" -and $script:invocations -eq ($beforeFallback+1)) "restart cannot duplicate fallback Send"

  Clear-EpisodeLatch
  $f=New-Fixture
  $f.Error.Current.Name="Connection interrupted. Waiting for the complete answer"
  $connectionCfg=[pscustomobject]@{mode="retry_then_continue";cooldownSeconds=45;retryGraceSeconds=20;resumeText="Continue from checkpoint"}
  $conversationUnavailable=[regex]::Unescape('\uC774 \uB300\uD654\uC5D0 ChatGPT\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4')
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-4))
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.action -eq "suppressed") "Connection interrupted still waits briefly after Retry"

  Clear-EpisodeLatch
  $f=New-Fixture
  $f.Error.Current.Name="Connection interrupted. Waiting for the complete answer"
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-9))
  $beforeConnectionFallback=$script:invocations
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.action -eq "continue") "stalled Connection interrupted escalates to Continue before delivery timeout"
  Assert ($script:invocations -eq ($beforeConnectionFallback+1)) "Connection interrupted escalation sends exactly once"

  Clear-EpisodeLatch
  Clear-SessionWatch
  $f=New-Fixture
  $f.Error.Current.Name="Connection interrupted. Waiting for the complete answer"
  $stop=New-Element 8 Button "Stop generating" 860 805 70 60
  Add-Child $f.Chat $stop
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-9))
  $beforeStopResume=$script:invocations
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.action -eq "stop" -and $script:invocations -eq ($beforeStopResume+1)) "stalled Connection interrupted invokes Stop once"
  $watch=Read-SessionWatch
  Assert ([bool]$watch.resumeAfterStop -and [int]$watch.stopAttempts -eq 1) "Stop arms durable post-stop continuation"
  $f.Chat.Children=@($f.Panel,$f.Edit,$f.Send)
  $f.Error.Current.Name="Everything is healthy"
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.action -eq "continue" -and $r.reason -eq "connection_interrupted_stop_resume") "cleared interruption after Stop resumes from checkpoint"
  Assert ($script:invocations -eq ($beforeStopResume+2)) "Stop plus resume dispatch exactly two UIA actions"
  Assert ($f.Edit.Value -eq $connectionCfg.resumeText) "post-stop resume uses ValuePattern without focus typing"
  $watch=Read-SessionWatch
  Assert (-not [bool]$watch.resumeAfterStop -and [int]$watch.stopAttempts -eq 0) "post-stop resume clears durable stop state"
  Clear-EpisodeLatch
  Clear-SessionWatch

  $f=New-Fixture
  $f.Error.Current.Name="Connection interrupted. Waiting for the complete answer"
  $f.Edit.Value="user draft"
  $stop=New-Element 8 Button "Stop generating" 860 805 70 60
  Add-Child $f.Chat $stop
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-9))
  $beforeDraftStop=$script:invocations
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.action -eq "stop" -and $script:invocations -eq ($beforeDraftStop+1)) "stalled transport Stop runs before draft guard"
  Assert ($f.Edit.Value -eq "user draft") "Stop preserves existing user draft"
  $f.Chat.Children=@($f.Panel,$f.Edit,$f.Send)
  $f.Error.Current.Name="Everything is healthy"
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.reason -eq "composer_has_user_draft_or_unreadable_value") "post-stop continuation refuses to overwrite user draft"
  Assert ($f.Edit.Value -eq "user draft" -and $script:invocations -eq ($beforeDraftStop+1)) "draft blocks Send after Stop without losing text"
  Clear-EpisodeLatch
  Clear-SessionWatch

  Assert (Test-IsRecoveryErrorText $conversationUnavailable) "conversation unavailable system error is recognized"
  Assert (Test-IsConversationUnavailableText $conversationUnavailable) "conversation unavailable classifier"
  Clear-EpisodeLatch
  Clear-SessionWatch
  $f=New-Fixture
  $f.Error.Current.Name=$conversationUnavailable
  $stop=New-Element 8 Button "Stop generating" 860 805 70 60
  Add-Child $f.Chat $stop
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-9))
  $beforeUnavailable=$script:invocations
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.action -eq "stop" -and $script:invocations -eq ($beforeUnavailable+1)) "conversation unavailable after Retry invokes Stop once"
  $f.Chat.Children=@($f.Panel,$f.Edit,$f.Send)
  $f.Error.Current.Name="Everything is healthy"
  $r=Invoke-WatchdogOnce $connectionCfg (New-Memory)
  Assert ($r.action -eq "continue" -and $script:invocations -eq ($beforeUnavailable+2)) "conversation unavailable Stop resumes from checkpoint"
  Clear-EpisodeLatch
  Clear-SessionWatch

  Clear-EpisodeLatch
  $f=New-Fixture
  Set-EpisodeLatch "retry_unconfirmed" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-90))
  $beforeBlocked=$script:invocations
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.action -eq "suppressed" -and $script:invocations -eq $beforeBlocked) "unknown Retry outcome never authorizes another dispatch"

  Clear-EpisodeLatch
  $f=New-Fixture
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-90))
  $retryOnly=[pscustomobject]@{mode="retry";cooldownSeconds=45;retryGraceSeconds=5;resumeText="Continue"}
  $r=Invoke-WatchdogOnce $retryOnly (New-Memory)
  Assert ($r.action -eq "suppressed" -and $script:invocations -eq $beforeBlocked) "retry-only mode never sends continuation"

  Clear-EpisodeLatch
  $f=New-Fixture; $f.Edit.Value="user draft"
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-90))
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.reason -eq "composer_has_user_draft_or_unreadable_value" -and $f.Edit.Value -eq "user draft" -and $script:invocations -eq $beforeBlocked) "aged Retry fallback still preserves user draft"

  Clear-EpisodeLatch
  $f=New-Fixture
  Add-Child $f.Chat (New-Element 8 Button "Stop generating" 860 805 70 60)
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-90))
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.reason -eq "generation_still_active" -and $script:invocations -eq $beforeBlocked) "actual generation after Retry blocks fallback"

  Clear-EpisodeLatch
  $f=New-Fixture
  Set-EpisodeLatch "retry" (Get-ElementRuntimeKey $f.Retry) ((Get-Date).AddSeconds(-90))
  Add-Child $f.Panel (New-Element 8 Button "Retry" 790 700 30 30)
  $r=Invoke-WatchdogOnce $cfg (New-Memory)
  Assert ($r.reason -eq "ambiguous_retry_control" -and $script:invocations -eq $beforeBlocked) "new/ambiguous Retry controls block fallback"

  $ocrGood=Select-OcrRecoveryPair @(
    [pscustomobject]@{text="Connection interrupted. Waiting for the complete answer";x=420;y=180;width=350;height=14},
    [pscustomobject]@{text="Retry";x=760;y=220;width=42;height=16}
  )
  Assert ($ocrGood -and $ocrGood.ErrorText -eq "Connection interrupted" -and $ocrGood.Retry.text -eq "Retry") "OCR recovery requires one spatially associated exact Retry"
  $ocrQuoted=Select-OcrRecoveryPair @(
    [pscustomobject]@{text="Connection interrupted. Waiting for the complete answer";x=420;y=180;width=350;height=14},
    [pscustomobject]@{text="I mentioned Retry in this sentence";x=500;y=220;width=260;height=16}
  )
  Assert (-not $ocrQuoted) "OCR recovery ignores Retry mentioned inside ordinary chat text"

  $ocrKorean=Select-OcrRecoveryPair @(
    [pscustomobject]@{text="Message delivery timed out. Please try again.";x=420;y=180;width=350;height=14},
    [pscustomobject]@{text=$script:koRetry3;x=760;y=220;width=56;height=16}
  )
  Assert ($ocrKorean -and $ocrKorean.Retry.text -eq $script:koRetry3) "OCR recovery recognizes Korean Retry labels"

  $observationPath=$episodeLatchPath+'.observation.json'
  Write-WatchdogObservation $r (New-Memory)
  $observation=Get-Content -LiteralPath $observationPath -Raw | ConvertFrom-Json
  Assert ($observation.reason -eq "ambiguous_retry_control" -and $observation.observedAt) "blocked decision has a timestamp and reason"
  Assert ((Get-Content -LiteralPath $observationPath -Raw) -notmatch 'user draft|Continue|Message delivery') "observation omits chat/composer contents"
  $source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
  Assert ($source -notmatch 'SendKeys|Set-Clipboard|desktop_type|desktop_clipboard') "no focus typing or clipboard continuation path"
  Assert ($source -match '\.SetValue\(' -and $source -match 'no_retry_control_uia_fallback') "UIA-only no-retry continuation path present"
  Assert ($source -match 'System\.Threading\.Mutex' -and $source -match 'WaitOne\(0\)') "watchdog run uses process-level single-instance mutex"
  Assert ($source -match '\$pidOwner -eq \[string\]\$PID') "watchdog only removes its own pid file"
  Assert ($source -match 'Test-IsEligibleChatGPTWindow' -and $source -match 'TreeScope\]::Children' -and $source -match '\$eligible\.Count -eq 1') "background recovery requires one unique eligible ChatGPT window"
  Assert ($source -match '\$ocrRecovery = Find-OcrRecoveryCandidate \$chat' -and $source -match 'source="ocr"') "OCR is a first-class recovery source when UIA/TextPattern miss the error"
  Assert ($source -notmatch 'pending_session_reopened|pending_session_cleared_and_previous_restored') "watchdog never auto-navigates between conversations"
  Assert ($source -match 'platform_review_in_progress' -and $source -match 'waiting without UI action') "platform review is telemetry-only until a real transport error appears"
  Assert ($source -match '\\uC751\\uB2F5') "Korean platform review label is matched without source-encoding dependence"
  Assert ($source -match 'preserving user-selected session and clearing navigation state') "manual conversation selection wins over pending recovery state"
  Assert ($source -match 'connection_interrupted_stalled_generation' -and $source -match 'connection_interrupted_stop_resume') "stalled transport errors use the verified Stop-to-resume path"
  Assert ($source -match 'Test-IsConversationUnavailableText' -and $source -match 'Test-IsStalledGenerationRecoveryText') "conversation unavailable is in the stalled-generation classifier"
  [pscustomobject]@{ok=$true;assertions=$script:assertions;liveUiActions=0;isolatedLatch=$true} | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $episodeLatchPath -Force -ErrorAction SilentlyContinue
  if($observationPath){Remove-Item -LiteralPath $observationPath -Force -ErrorAction SilentlyContinue}
}
