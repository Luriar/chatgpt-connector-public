# OCR-only fallback for recovery surfaces that Chromium does not expose through UIA/TextPattern.
# Safety rule: never act on an error string alone. A unique Retry/Try again line must be
# spatially associated with one known recovery error.

function Select-OcrRecoveryPair([object[]]$lines) {
  $errors=@("Message delivery timed out","Connection interrupted","연결이 해제되었습니다","Resume stream unavailable")
  $retryLabels=@("Retry","Try again","다시 시도","재시도","다시하기")
  $pairs=@()
  foreach($line in @($lines)) {
    $text=([string]$line.text).Trim()
    $err=$errors | Where-Object { $text.IndexOf($_,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
    if(-not $err){ continue }
    $near=@($lines | Where-Object {
      $label=([string]$_.text).Trim()
      ($retryLabels -contains $label) -and
      ([Math]::Abs(([double]$_.y)-([double]$line.y)) -le 220) -and
      ([Math]::Abs(([double]$_.x)-([double]$line.x)) -le 650)
    })
    if($near.Count -eq 1){
      $pairs += [pscustomobject]@{Error=$line;Retry=$near[0];ErrorText=$err}
    }
  }
  if($pairs.Count -eq 1){ return $pairs[0] }
  return $null
}

function Initialize-WatchdogOcr {
  if("WjkOcrNative" -as [type]){ return }
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WjkOcrNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr hWndParent, POINT point, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
}

function Await-WatchdogWinRt($op,[Type]$type) {
  $m=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethodDefinition
  } | Select-Object -First 1).MakeGenericMethod($type)
  $task=$m.Invoke($null,@($op))
  [void]$task.Wait()
  return $task.Result
}

function Find-OcrRecoveryCandidate([object]$chat, [string]$expectedError="") {
  if(-not $chat){ return $null }
  try {
    Initialize-WatchdogOcr
    $hwnd=[IntPtr][int64]$chat.Current.NativeWindowHandle
    if($hwnd -eq [IntPtr]::Zero){ return $null }

    $rect=New-Object WjkOcrNative+RECT
    if(-not [WjkOcrNative]::GetWindowRect($hwnd,[ref]$rect)){ return $null }
    $w=$rect.Right-$rect.Left; $h=$rect.Bottom-$rect.Top
    if($w -lt 100 -or $h -lt 100){ return $null }

    $bmp=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g=[System.Drawing.Graphics]::FromImage($bmp)
    $hdc=$g.GetHdc()
    try { $captured=[WjkOcrNative]::PrintWindow($hwnd,$hdc,2) }
    finally { $g.ReleaseHdc($hdc); $g.Dispose() }
    if(-not $captured){ $bmp.Dispose(); return $null }

    $scale=[Math]::Min(1.0,1800.0/[Math]::Max($w,$h))
    if($scale -lt 1.0){
      $sw=[int][Math]::Round($w*$scale); $sh=[int][Math]::Round($h*$scale)
      $small=New-Object System.Drawing.Bitmap($sw,$sh)
      $sg=[System.Drawing.Graphics]::FromImage($small)
      $sg.DrawImage($bmp,0,0,$sw,$sh); $sg.Dispose(); $bmp.Dispose(); $bmp=$small
    }

    $tmp=Join-Path $env:TEMP ("wjk-watchdog-ocr-"+$PID+".png")
    $bmp.Save($tmp,[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

    $null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
    $null=[Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
    $null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]

    $file=Await-WatchdogWinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream=Await-WatchdogWinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder=Await-WatchdogWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software=Await-WatchdogWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if(-not $engine){ return $null }
    $result=Await-WatchdogWinRt ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])

    $lines=New-Object System.Collections.ArrayList
    foreach($line in $result.Lines){
      $words=@($line.Words); if($words.Count -eq 0){ continue }
      $left=($words|%{$_.BoundingRect.X}|Measure-Object -Minimum).Minimum
      $top=($words|%{$_.BoundingRect.Y}|Measure-Object -Minimum).Minimum
      $right=($words|%{$_.BoundingRect.X+$_.BoundingRect.Width}|Measure-Object -Maximum).Maximum
      $bottom=($words|%{$_.BoundingRect.Y+$_.BoundingRect.Height}|Measure-Object -Maximum).Maximum
      [void]$lines.Add([pscustomobject]@{
        text=[string]$line.Text
        x=[int][Math]::Round($left/$scale)
        y=[int][Math]::Round($top/$scale)
        width=[int][Math]::Round(($right-$left)/$scale)
        height=[int][Math]::Round(($bottom-$top)/$scale)
      })
      for($wi=0;$wi -lt $words.Count;$wi++){
        $word=$words[$wi]
        [void]$lines.Add([pscustomobject]@{
          text=[string]$word.Text
          x=[int][Math]::Round($word.BoundingRect.X/$scale)
          y=[int][Math]::Round($word.BoundingRect.Y/$scale)
          width=[int][Math]::Round($word.BoundingRect.Width/$scale)
          height=[int][Math]::Round($word.BoundingRect.Height/$scale)
        })
        if($wi+1 -lt $words.Count){
          $w2=$words[$wi+1]
          $bigram=([string]$word.Text+" "+[string]$w2.Text).Trim()
          if($retryLabels -contains $bigram){
            $bx=[Math]::Min($word.BoundingRect.X,$w2.BoundingRect.X)
            $by=[Math]::Min($word.BoundingRect.Y,$w2.BoundingRect.Y)
            $br=[Math]::Max($word.BoundingRect.X+$word.BoundingRect.Width,$w2.BoundingRect.X+$w2.BoundingRect.Width)
            $bb=[Math]::Max($word.BoundingRect.Y+$word.BoundingRect.Height,$w2.BoundingRect.Y+$w2.BoundingRect.Height)
            [void]$lines.Add([pscustomobject]@{
              text=$bigram
              x=[int][Math]::Round($bx/$scale)
              y=[int][Math]::Round($by/$scale)
              width=[int][Math]::Round(($br-$bx)/$scale)
              height=[int][Math]::Round(($bb-$by)/$scale)
            })
          }
        }
      }
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    $pair=Select-OcrRecoveryPair @($lines)
    if(-not $pair){ return $null }
    if($expectedError){
      $expected=[string]$expectedError
      $kind=[string]$pair.ErrorText
      if($expected.IndexOf($kind,[System.StringComparison]::OrdinalIgnoreCase) -lt 0 -and $kind.IndexOf($expected,[System.StringComparison]::OrdinalIgnoreCase) -lt 0){
        return $null
      }
    }
    $retry=$pair.Retry
    return [pscustomobject]@{
      Text=[string]$pair.Error.text
      ErrorKind=[string]$pair.ErrorText
      Key=("ocr:"+[string]$pair.ErrorText+":"+[string]$retry.text+":"+[string]$retry.x+":"+[string]$retry.y)
      RetryLabel=[string]$retry.text
      RetryX=[int]$retry.x
      RetryY=[int]$retry.y
      RetryWidth=[int]$retry.width
      RetryHeight=[int]$retry.height
      WindowLeft=[int]$rect.Left
      WindowTop=[int]$rect.Top
      Hwnd=$hwnd
    }
  } catch {
    return $null
  }
}

function Invoke-OcrRecoveryRetry([object]$candidate) {
  if(-not $candidate -or -not $candidate.Hwnd){ throw "OCR retry candidate missing" }
  Initialize-WatchdogOcr
  $sx=[int]$candidate.WindowLeft+[int]$candidate.RetryX+[int]([Math]::Max(1,[int]$candidate.RetryWidth)/2)
  $sy=[int]$candidate.WindowTop+[int]$candidate.RetryY+[int]([Math]::Max(1,[int]$candidate.RetryHeight)/2)

  $target=[IntPtr]$candidate.Hwnd
  for($depth=0;$depth -lt 8;$depth++){
    $client=New-Object WjkOcrNative+POINT
    $client.X=$sx; $client.Y=$sy
    if(-not [WjkOcrNative]::ScreenToClient($target,[ref]$client)){ break }
    $child=[WjkOcrNative]::ChildWindowFromPointEx($target,$client,3)
    if($child -eq [IntPtr]::Zero -or $child -eq $target){ break }
    $target=$child
  }

  $pt=New-Object WjkOcrNative+POINT
  $pt.X=$sx; $pt.Y=$sy
  if(-not [WjkOcrNative]::ScreenToClient($target,[ref]$pt)){ throw "OCR retry ScreenToClient failed" }
  $lp=[IntPtr](($pt.Y -band 0xffff) -shl 16 -bor ($pt.X -band 0xffff))
  [void][WjkOcrNative]::SendMessage($target,0x0200,[IntPtr]::Zero,$lp)
  [void][WjkOcrNative]::SendMessage($target,0x0201,[IntPtr]1,$lp)
  [void][WjkOcrNative]::SendMessage($target,0x0202,[IntPtr]::Zero,$lp)
  return $true
}
