// Personal Cowork parity: semantic Windows UI Automation tools.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { text } from "../toolkit.js";

const IS_WIN=process.platform==="win32";
const PRE=[
"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
"$OutputEncoding = [Console]::OutputEncoding",
"Add-Type -AssemblyName UIAutomationClient",
"Add-Type -AssemblyName UIAutomationTypes",
"Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class WjkNative { [DllImport(\"user32.dll\", CharSet=CharSet.Unicode, EntryPoint=\"SendMessageW\")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam); }\' -ErrorAction SilentlyContinue",
"$root=[System.Windows.Automation.AutomationElement]::RootElement",
"$sel=@{}",
"if($env:WJK_UIA_SELECTOR){$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WJK_UIA_SELECTOR));$sel=$json|ConvertFrom-Json}",
"$scope=$root",
"if($env:WJK_UIA_WINDOW){$wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition);foreach($w in $wins){if($w.Current.Name -like ('*'+$env:WJK_UIA_WINDOW+'*')){$scope=$w;break}}}",
"function ToRow($e,$i){try{$r=$e.Current.BoundingRectangle;$rect=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}}catch{$rect=$null};[pscustomobject]@{index=$i;name=$e.Current.Name;automationId=$e.Current.AutomationId;controlType=$e.Current.ControlType.ProgrammaticName;className=$e.Current.ClassName;enabled=$e.Current.IsEnabled;offscreen=$e.Current.IsOffscreen;rect=$rect}}",
"function Matches($e,$s){if($s.name -and $e.Current.Name -ne $s.name){return $false};if($s.name_contains -and $e.Current.Name -notlike ('*'+$s.name_contains+'*')){return $false};if($s.automation_id -and $e.Current.AutomationId -ne $s.automation_id){return $false};if($s.control_type){$ct=$e.Current.ControlType.ProgrammaticName;if($ct -ne $s.control_type -and $ct -ne ('ControlType.'+$s.control_type)){return $false}};if($s.class_name -and $e.Current.ClassName -ne $s.class_name){return $false};if($s.class_contains -and $e.Current.ClassName -notlike ('*'+$s.class_contains+'*')){return $false};return $true}",
"function FindMatches(){$all=$scope.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition);$m=New-Object System.Collections.ArrayList;foreach($e in $all){if(Matches $e $sel){[void]$m.Add($e)}};return ,$m}"
].join("\n");

function run(script,opts={}){
  if(!IS_WIN)throw new Error("Windows UI Automation은 Windows 전용");
  const selector=opts.selector||{},windowTitle=opts.windowTitle||"",timeout=opts.timeout||15000;
  const env={...process.env,WJK_UIA_SELECTOR:Buffer.from(JSON.stringify(selector)).toString("base64"),WJK_UIA_WINDOW:windowTitle};
  const r=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",PRE+"\n"+script],{encoding:"utf8",timeout,windowsHide:true,env});
  if(r.error)throw r.error;if(r.status!==0)throw new Error((r.stderr||r.stdout||"UIA 실패").trim());
  return (r.stdout||"").trim();
}
const selector=z.object({name:z.string().optional(),name_contains:z.string().optional(),automation_id:z.string().optional(),control_type:z.string().optional(),class_name:z.string().optional(),class_contains:z.string().optional(),index:z.number().int().min(0).optional()});

export function registerComputerUiaTools(reg,ctx){
  reg("computer_uia_status",{description:"Windows UI Automation 사용 가능 여부와 top-level window 수를 확인한다.",inputSchema:{}},async()=>{
    if(!IS_WIN)return text(JSON.stringify({available:false,platform:process.platform}));
    return text(run("$w=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition);@{available=$true;windows=$w.Count}|ConvertTo-Json -Compress"));
  });

  reg("computer_tree",{description:"접근성/UI Automation tree를 semantic control 정보로 읽는다. 좌표 조작 전에 우선 사용.",inputSchema:{window_title:z.string().optional(),max_depth:z.number().int().min(1).max(8).optional(),max_nodes:z.number().int().min(1).max(1000).optional()}},async({window_title="",max_depth=3,max_nodes=300})=>{
    const script="$rows=New-Object System.Collections.ArrayList;$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker;function Walk($e,$d){if($rows.Count -ge "+max_nodes+" -or $d -gt "+max_depth+"){return};[void]$rows.Add([pscustomobject]@{depth=$d;name=$e.Current.Name;automationId=$e.Current.AutomationId;controlType=$e.Current.ControlType.ProgrammaticName;className=$e.Current.ClassName;enabled=$e.Current.IsEnabled});if($d -ge "+max_depth+"){return};$c=$walker.GetFirstChild($e);while($c -and $rows.Count -lt "+max_nodes+"){Walk $c ($d+1);$c=$walker.GetNextSibling($c)}};Walk $scope 0;$rows|ConvertTo-Json -Depth 4 -Compress";
    return text(run(script,{windowTitle:window_title,timeout:20000})||"[]");
  });

  reg("computer_find",{description:"UIA selector(name/AutomationId/ControlType/class)로 semantic element를 찾는다.",inputSchema:{selector,window_title:z.string().optional(),limit:z.number().int().min(1).max(100).optional()}},async({selector:sel,window_title="",limit=30})=>{
    const script="$m=FindMatches;$rows=@();$i=0;foreach($e in $m){if($i -ge "+limit+"){break};$rows+=ToRow $e $i;$i++};$rows|ConvertTo-Json -Depth 5 -Compress";
    return text(run(script,{selector:sel,windowTitle:window_title})||"[]");
  });

  reg("computer_invoke",{description:"UIA InvokePattern으로 버튼/메뉴 등 semantic element를 실행한다.",inputSchema:{selector,window_title:z.string().optional()}},async({selector:sel,window_title=""})=>{
    const idx=sel.index||0,s={...sel};delete s.index;
    const script="$m=FindMatches;if($m.Count -le "+idx+"){throw 'element not found'};$e=$m["+idx+"];if($e.Current.NativeWindowHandle -ne 0 -and $e.Current.ClassName -like 'WindowsForms10.BUTTON*'){[void][WjkNative]::SendMessage([IntPtr]$e.Current.NativeWindowHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);'invoked-win32'}else{$p=$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);$p.Invoke();'invoked-uia'}";
    return text(run(script,{selector:s,windowTitle:window_title}));
  });

  reg("computer_set_value",{description:"UIA ValuePattern으로 textbox 등 semantic element 값을 설정한다.",inputSchema:{selector,value:z.string(),window_title:z.string().optional()}},async({selector:sel,value,window_title=""})=>{
    const idx=sel.index||0,s={...sel};delete s.index;const v=Buffer.from(value).toString("base64");
    const script="$m=FindMatches;if($m.Count -le "+idx+"){throw 'element not found'};$e=$m["+idx+"];$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+v+"'));$ok=$false;try{$p=$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$p.SetValue($v);$ok=$true}catch{};if(!$ok -and $e.Current.NativeWindowHandle -ne 0){$ptr=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($v);try{[void][WjkNative]::SendMessage([IntPtr]$e.Current.NativeWindowHandle,0x000C,[IntPtr]::Zero,$ptr);$ok=$true}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)}};if(!$ok){throw 'no supported value mechanism'};'value-set'";
    return text(run(script,{selector:s,windowTitle:window_title}));
  });

  reg("computer_select",{description:"UIA SelectionItemPattern으로 list/tab/item을 선택한다.",inputSchema:{selector,window_title:z.string().optional()}},async({selector:sel,window_title=""})=>{
    const idx=sel.index||0,s={...sel};delete s.index;
    return text(run("$m=FindMatches;if($m.Count -le "+idx+"){throw 'element not found'};$e=$m["+idx+"];$p=$e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern);$p.Select();'selected'",{selector:s,windowTitle:window_title}));
  });

  reg("computer_wait_element",{description:"UIA element가 나타날 때까지 기다린다.",inputSchema:{selector,window_title:z.string().optional(),timeout_ms:z.number().int().min(100).max(120000).optional()}},async({selector:sel,window_title="",timeout_ms=15000})=>{
    const until=Date.now()+timeout_ms;
    while(Date.now()<until){try{const out=run("$m=FindMatches;$m.Count",{selector:sel,windowTitle:window_title,timeout:5000});if(Number(out)>0)return text("found");}catch{}await new Promise(r=>setTimeout(r,300));}
    throw new Error("UIA element wait timeout");
  });
}
