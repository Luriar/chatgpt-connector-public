function Get-RootWebArea([object]$chat) {
  if (-not $chat) { return $null }
  try {
    $cond=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,"RootWebArea")
    $doc=$chat.FindFirst([System.Windows.Automation.TreeScope]::Subtree,$cond)
    if ($doc -and $doc.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $doc }
  } catch {}
  return $null
}
function Get-TextRangeRect([object]$range) {
  if (-not $range) { return $null }
  try { $raw=$range.GetBoundingRectangles() } catch { return $null }

  $items=New-Object System.Collections.ArrayList
  foreach($item in @($raw)) {
    if($item -is [System.Array]) {
      foreach($sub in $item) { [void]$items.Add($sub) }
    } else {
      [void]$items.Add($item)
    }
  }

  foreach($r in @($items)) {
    try {
      $widthProp=$r.PSObject.Properties["Width"]
      $heightProp=$r.PSObject.Properties["Height"]
      if(-not $widthProp -or -not $heightProp){ continue }
      $w=[double]$widthProp.Value
      $h=[double]$heightProp.Value
      if($w -le 1 -or $h -le 1){ continue }

      $xProp=$r.PSObject.Properties["X"]
      $yProp=$r.PSObject.Properties["Y"]
      $leftProp=$r.PSObject.Properties["Left"]
      $topProp=$r.PSObject.Properties["Top"]
      $l=[double]$(if($xProp){$xProp.Value}else{$leftProp.Value})
      $t=[double]$(if($yProp){$yProp.Value}else{$topProp.Value})
      return [pscustomobject]@{Left=$l;Top=$t;Right=($l+$w);Bottom=($t+$h);Width=$w;Height=$h}
    } catch {}
  }

  $nums=New-Object System.Collections.ArrayList
  foreach($item in @($items)) {
    try { [void]$nums.Add([double]$item) } catch {}
  }
  for($i=0;$i+3 -lt $nums.Count;$i+=4) {
    $l=[double]$nums[$i]; $t=[double]$nums[$i+1]
    $w=[double]$nums[$i+2]; $h=[double]$nums[$i+3]
    if($w -le 1 -or $h -le 1){ continue }
    return [pscustomobject]@{Left=$l;Top=$t;Right=($l+$w);Bottom=($t+$h);Width=$w;Height=$h}
  }
  return $null
}
function Test-TextRangeIsQuotedChat([object]$range,[object]$chat,[string]$expected) {
  if (-not $range -or -not $chat) { return $true }
  try { $e=$range.GetEnclosingElement() } catch { return $true }
  $chatKey=Get-ElementRuntimeKey $chat
  $expected=Normalize-RecoveryText $expected
  for($depth=0;$e -and $depth -lt 7;$depth++) {
    try {
      $identity=(([string]$e.Current.AutomationId)+' '+([string]$e.Current.ClassName)).Trim()
      if ($identity -match '(?i)(user-message|user_message|markdown|code-block|codeblock)') { return $true }
      $name=Normalize-RecoveryText ([string]$e.Current.Name)
      if ($name -and $name -ne $expected -and $name -like ('*'+$expected+'*')) { return $true }
      if ($chatKey -and (Get-ElementRuntimeKey $e) -eq $chatKey) { break }
    } catch { return $true }
    $e=Get-UiaParent $e
  }
  return $false
}
function Find-TextPatternRecoveryCandidate([object]$chat,[object]$edit) {
  if (-not $chat -or -not $edit) { return $null }
  $wr=Get-ElementRect $chat; $cr=Get-ElementRect $edit
  if (-not $wr -or -not $cr) { return $null }
  $doc=Get-RootWebArea $chat
  if (-not $doc) { return $null }
  try {
    $tp=$doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $visible=@($tp.GetVisibleRanges())
    try { $full=$tp.DocumentRange; if ($full) { $visible += $full } } catch {}
  } catch { return $null }
  $phrases=@("Message delivery timed out. Please try again.","Connection interrupted. Waiting for the complete answer","Connection interrupted. Waiting for complete answer","연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.","Resume stream unavailable","A network error occurred. Please check your connection and try again.","Please check your connection and try again.","stream recovery polling timed out","문제가 발생했습니다. 다시 시도해 주세요.","문제가 발생했습니다. 다시 시도하세요.")
  $best=$null; $bestGap=[double]::PositiveInfinity
  foreach($vr in $visible) {
    foreach($phrase in $phrases) {
      try { $cursor=$vr.Clone() } catch { continue }
      for($n=0;$n -lt 12;$n++) {
        try { $m=$cursor.FindText($phrase,$false,$false) } catch { $m=$null }
        if (-not $m) { break }
        $r=Get-TextRangeRect $m
        if ($r -and (Test-RectIntersects $r $wr) -and $r.Top -le ($cr.Bottom+20)) {
          $overlap=[Math]::Max(0.0,[Math]::Min($r.Right,$cr.Right)-[Math]::Max($r.Left,$cr.Left))
          $gap=[Math]::Max(0.0,$cr.Top-$r.Bottom)
          if ($overlap -ge 40 -and $gap -le ($wr.Height*0.80) -and -not (Test-TextRangeIsQuotedChat $m $chat $phrase)) {
            if ($gap -lt $bestGap) {
              $bestGap=$gap
              $best=[pscustomobject]@{Source="textpattern";Text=$phrase;Range=$m;Rect=$r;Key=("tp:"+$phrase+":"+([Math]::Round($r.Left))+":"+([Math]::Round($r.Top)))}
            }
          }
        }
        try { $cursor.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::Start,$m,[System.Windows.Automation.TextPatternRangeEndpoint]::End) } catch { break }
      }
    }
  }
  return $best
}
function Find-TextPatternRetryButton([object]$chat,[object]$recovery) {
  if (-not $chat -or -not $recovery -or -not $recovery.Rect) { return $null }
  $doc=Get-RootWebArea $chat
  if (-not $doc) { return $null }
  try {
    $tp=$doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $visible=@($tp.GetVisibleRanges())
    try { $full=$tp.DocumentRange; if ($full) { $visible += $full } } catch {}
  } catch { return $null }
  $labels=@("Retry","Try again","다시 시도","재시도","다시하기")
  $found=@{}
  foreach($vr in $visible) {
    foreach($label in $labels) {
      try { $cursor=$vr.Clone() } catch { continue }
      for($n=0;$n -lt 12;$n++) {
        try { $m=$cursor.FindText($label,$false,$false) } catch { $m=$null }
        if (-not $m) { break }
        $r=Get-TextRangeRect $m
        if ($r) {
          $er=$recovery.Rect
          $x=[Math]::Max(0,[Math]::Max($er.Left-$r.Right,$r.Left-$er.Right))
          $y=[Math]::Max(0,[Math]::Max($er.Top-$r.Bottom,$r.Top-$er.Bottom))
          if ($x -le 240 -and $y -le 160 -and -not (Test-TextRangeIsQuotedChat $m $chat $label)) {
            try { $e=$m.GetEnclosingElement() } catch { $e=$null }
            for($depth=0;$e -and $depth -lt 6;$depth++) {
              try {
                if ($e.Current.ProcessId -eq $chat.Current.ProcessId -and $e.Current.IsEnabled -and -not $e.Current.IsOffscreen) {
                  [void]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                  $key=Get-ElementRuntimeKey $e
                  if ($key) { $found[$key]=$e }
                  break
                }
              } catch {}
              $e=Get-UiaParent $e
            }
          }
        }
        try { $cursor.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::Start,$m,[System.Windows.Automation.TextPatternRangeEndpoint]::End) } catch { break }
      }
    }
  }
  if ($found.Count -eq 1) { return @($found.Values)[0] }
  return $null
}
function Resolve-FreshTextPatternRetryButton([object]$chat,[object]$edit,[object]$recovery,[object]$retryButton) {
  try {
    if(-not $chat -or -not $edit -or -not $recovery -or -not $retryButton){return $null}
    $freshChat=Get-ChatGPTMainWindow
    if(-not $freshChat){return $null}
    $h1=[int]$chat.Current.NativeWindowHandle
    $h2=[int]$freshChat.Current.NativeWindowHandle
    if($h1 -gt 0 -and $h2 -gt 0 -and $h1 -ne $h2){return $null}
    $t1=Get-ConversationTitle $chat
    $t2=Get-ConversationTitle $freshChat
    if($t1 -and $t2 -and $t1 -ne $t2){return $null}
    $freshEdit=Get-VisibleComposer $freshChat
    if(-not $freshEdit){return $null}
    $freshRecovery=Find-TextPatternRecoveryCandidate $freshChat $freshEdit
    if(-not $freshRecovery -or [string]$freshRecovery.Text -ne [string]$recovery.Text){return $null}
    $freshRetry=Find-TextPatternRetryButton $freshChat $freshRecovery
    if(-not $freshRetry){return $null}
    $a=Get-ElementRect $freshRetry
    $b=$freshRecovery.Rect
    if(-not $a -or -not $b){return $null}
    $x=[math]::Max(0,[math]::Max($b.Left-$a.Right,$a.Left-$b.Right))
    $y=[math]::Max(0,[math]::Max($b.Top-$a.Bottom,$a.Top-$b.Bottom))
    if($x -gt 240 -or $y -gt 160){return $null}
    [void]$freshRetry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    return $freshRetry
  }catch{return $null}
}
function Test-TextPatternRecoveryContextCurrent([object]$chat,[object]$edit,[object]$recovery,[object]$retryButton) {
  return [bool](Resolve-FreshTextPatternRetryButton $chat $edit $recovery $retryButton)
}
