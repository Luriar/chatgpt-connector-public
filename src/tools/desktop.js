// 데스크톱 제어(computer use) — Windows 전용, 네이티브 의존성 0 (PowerShell 사용)
// 스크린샷 / 클릭 / 이동 / 타이핑 / 키 조합 / 창 목록 / 클립보드
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { assertMutationAllowed } from "../security.js";
import { text } from "../toolkit.js";

const IS_WIN = process.platform === "win32";

function ps(script, timeout = 20_000) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { encoding: "utf8", timeout });
  if (r.error) throw new Error(`PowerShell 실행 실패: ${r.error.message}`);
  if (r.status !== 0 && r.stderr) throw new Error(`PowerShell 오류: ${r.stderr.slice(0, 800)}`);
  return (r.stdout || "").trim();
}

const MOUSE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags,int dx,int dy,int data,int extra);' -Name U32 -Namespace WJK
`;

function guard(cfg) {
  if (!IS_WIN) throw new Error("데스크톱 제어는 Windows에서만 동작해(이 서버를 Windows PC에서 실행 중일 때). 원격/리눅스 배포 인스턴스에서는 로컬 PC 인스턴스를 쓰거나 codex_delegate를 이용해.");
  if (!cfg.desktop.enabled) throw new Error("설정에서 desktop.enabled=false로 꺼져 있어.");
}

export function registerDesktopTools(reg, ctx) {
  const cfg = ctx.cfg;

  reg("desktop_screenshot", {
    description: "Windows 화면을 작은 JPEG로 전송. window_title 지정 시 창만 캡처; 좌표 변환은 반환 metadata 참고.",
    inputSchema: {
      window_title: z.string().max(200).optional(),
      max_width: z.number().int().min(480).max(2200).optional(),
      max_height: z.number().int().min(320).max(1400).optional(),
      quality: z.number().int().min(35).max(85).optional()
    }
  }, async ({ window_title = "", max_width = 1600, max_height = 1000, quality = 68 }) => {
    guard(cfg);
    const out = path.join(cfg.stateDir, "tmp", `shot-${crypto.randomBytes(3).toString("hex")}.jpg`);
    const title64 = Buffer.from(window_title, "utf16le").toString("base64");
    // Return only bounded JPEG bytes through the Coordinator's JSON transport.
    try {
      const dimensions = ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$virtual=[System.Windows.Forms.SystemInformation]::VirtualScreen
$region=$virtual
if ('${title64}' -ne '') {
  $title=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${title64}'))
  $proc=Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like ('*'+$title+'*') } | Select-Object -First 1
  if (!$proc) { throw 'Requested window not found' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WjkCaptureRect {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
  $wrect=New-Object WjkCaptureRect+RECT
  if (![WjkCaptureRect]::GetWindowRect($proc.MainWindowHandle,[ref]$wrect)) { throw 'GetWindowRect failed' }
  $candidate=[Drawing.Rectangle]::FromLTRB($wrect.Left,$wrect.Top,$wrect.Right,$wrect.Bottom)
  $region=[Drawing.Rectangle]::Intersect($candidate,$virtual)
}
if ($region.Width -lt 1 -or $region.Height -lt 1) { throw 'Capture bounds empty' }
$scale=[Math]::Min(1.0,[Math]::Min(${max_width}/[double]$region.Width,${max_height}/[double]$region.Height))
$w=[Math]::Max(1,[int][Math]::Round($region.Width*$scale))
$h=[Math]::Max(1,[int][Math]::Round($region.Height*$scale))
$source=New-Object Drawing.Bitmap($region.Width,$region.Height)
$g=[Drawing.Graphics]::FromImage($source)
try {
  $g.CopyFromScreen($region.X,$region.Y,0,0,$source.Size)
  $codec=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg' | Select-Object -First 1
  # Keep inline JPEG under the tool gateway's 80 KB result-text limit.
  $limitBytes=35000
  $currentW=$w
  $currentH=$h
  $currentQuality=${quality}
  $encoded=$null
  for ($attempt=0; $attempt -lt 8; $attempt++) {
    $target=New-Object Drawing.Bitmap($currentW,$currentH)
    $g2=[Drawing.Graphics]::FromImage($target)
    $mem=New-Object IO.MemoryStream
    try {
      $g2.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($source,0,0,$currentW,$currentH)
      $ep=New-Object Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0]=New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality,[long]$currentQuality)
      $target.Save($mem,$codec,$ep)
      $encoded=$mem.ToArray()
    } finally { $mem.Dispose(); $g2.Dispose(); $target.Dispose() }
    if ($encoded.Length -le $limitBytes) { break }
    $currentQuality=[Math]::Max(25,$currentQuality-8)
    $currentW=[Math]::Max(300,[int][Math]::Round($currentW*0.78))
    $currentH=[Math]::Max(180,[int][Math]::Round($currentH*0.78))
  }
  if ($encoded.Length -gt $limitBytes) { throw 'JPEG could not fit safe tool result limit' }
  [IO.File]::WriteAllBytes('${out.replace(/\\/g, "\\\\")}', $encoded)
  $actualScale=$currentW/[double]$region.Width
  @{left=$region.X;top=$region.Y;width=$region.Width;height=$region.Height;renderedWidth=$currentW;renderedHeight=$currentH;scale=$actualScale;format='jpeg'} | ConvertTo-Json -Compress
} finally { $g.Dispose(); $source.Dispose() }
`, 30_000);
      const bytes = fs.readFileSync(out);
      if (bytes.length > 1_600_000) throw new Error("Screenshot too large for Coordinator; use smaller max_width/max_height or window_title");
      const parsed = JSON.parse(dimensions);
      return { content: [
        { type: "text", text: JSON.stringify({ captured: true, ...parsed, bytes: bytes.length, coordinateHint: "desktop_click.x = left + imageX / scale; desktop_click.y = top + imageY / scale" }) },
        { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" }
      ] };
    } finally {
      try { fs.rmSync(out, { force: true }); } catch {}
    }
  });

  reg("desktop_click", {
    description: "지정 좌표 마우스 클릭",
    inputSchema: {
      x: z.number().int(), y: z.number().int(),
      button: z.enum(["left", "right"]).optional(),
      double: z.boolean().optional()
    }
  }, async ({ x, y, button = "left", double = false }) => {
    guard(cfg); assertMutationAllowed(cfg, "마우스 입력");
    const dn = button === "left" ? 2 : 8, up = button === "left" ? 4 : 16;
    const clickOnce = `[WJK.U32]::mouse_event(${dn},0,0,0,0); Start-Sleep -Milliseconds 40; [WJK.U32]::mouse_event(${up},0,0,0,0)`;
    ps(`${MOUSE}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 60
${clickOnce}
${double ? `Start-Sleep -Milliseconds 80; ${clickOnce}` : ""}`);
    return text(`🖱 (${x}, ${y}) ${button}${double ? " 더블" : ""}클릭 완료. desktop_screenshot으로 결과 확인 추천.`);
  });

  reg("desktop_move", {
    description: "마우스 커서 이동",
    inputSchema: { x: z.number().int(), y: z.number().int() }
  }, async ({ x, y }) => {
    guard(cfg); assertMutationAllowed(cfg, "마우스 입력");
    ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`);
    return text(`커서 이동: (${x}, ${y})`);
  });

  reg("desktop_type", {
    description: "현재 포커스된 곳에 텍스트 입력(한글 포함 유니코드 안전 — 클립보드 경유 붙여넣기)",
    inputSchema: { text: z.string() }
  }, async ({ text: t }) => {
    guard(cfg); assertMutationAllowed(cfg, "키보드 입력");
    const b64 = Buffer.from(t, "utf16le").toString("base64");
    ps(`
Add-Type -AssemblyName System.Windows.Forms
$prev = $null; try { $prev = Get-Clipboard -Raw } catch {}
$s = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}'))
Set-Clipboard -Value $s
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 200
if ($prev -ne $null) { Set-Clipboard -Value $prev }
`);
    return text(`⌨️ ${t.length}자 입력 완료(붙여넣기 방식)`);
  });

  reg("desktop_key", {
    description: "키/단축키 전송. SendKeys 문법: {ENTER} {TAB} {ESC} {F5} ^c(Ctrl+C) %{F4}(Alt+F4) +(Shift) 등",
    inputSchema: { keys: z.string() }
  }, async ({ keys }) => {
    guard(cfg); assertMutationAllowed(cfg, "키보드 입력");
    const esc = keys.replace(/'/g, "''");
    ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${esc}')`);
    return text(`⌨️ 키 전송: ${keys}`);
  });

  reg("desktop_windows", {
    description: "열린 창 목록(프로세스명 + 창 제목)",
    inputSchema: {}
  }, async () => {
    guard(cfg);
    const out = ps(`Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName) — $($_.MainWindowTitle)" }`);
    return text(out || "제목 있는 창 없음");
  });

  reg("desktop_focus", {
    description: "창 제목(부분 일치)으로 해당 창을 앞으로 가져오기",
    inputSchema: { title: z.string() }
  }, async ({ title }) => {
    guard(cfg); assertMutationAllowed(cfg, "창 조작");
    const esc = title.replace(/'/g, "''");
    const out = ps(`
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);' -Name W -Namespace WJK2
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${esc}*' } | Select-Object -First 1
if ($p) { [WJK2.W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [WJK2.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "OK: $($p.MainWindowTitle)" } else { "NOTFOUND" }`);
    if (out.includes("NOTFOUND")) throw new Error(`'${title}' 창을 못 찾았어. desktop_windows로 목록 확인해.`);
    return text(`🪟 포커스: ${out.replace("OK: ", "")}`);
  });

  reg("desktop_clipboard", {
    description: "클립보드 읽기/쓰기. op=get|set",
    inputSchema: { op: z.enum(["get", "set"]), text: z.string().optional() }
  }, async ({ op, text: t }) => {
    guard(cfg);
    if (op === "get") {
      const out = ps("try { Get-Clipboard -Raw } catch { '' }");
      return text(out || "(클립보드 비어 있음)");
    }
    assertMutationAllowed(cfg, "클립보드 쓰기");
    const b64 = Buffer.from(t || "", "utf16le").toString("base64");
    ps(`Set-Clipboard -Value ([System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')))`);
    return text("클립보드에 저장됨");
  });
}