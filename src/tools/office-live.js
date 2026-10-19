// Personal Cowork parity: live Microsoft Office context bridge via COM automation (Windows).
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { text } from "../toolkit.js";

const WIN=process.platform==="win32";
function ps(code,env={},timeout=20000){
  if(!WIN)throw new Error("Office live bridge는 Windows 전용");
  const r=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",code],{encoding:"utf8",timeout,windowsHide:true,env:{...process.env,...env}});
  if(r.error)throw r.error;if(r.status!==0)throw new Error((r.stderr||r.stdout||"Office COM 실패").trim());return (r.stdout||"").trim();
}
const PRE=[
"function Active($prog){try{return [Runtime.InteropServices.Marshal]::GetActiveObject($prog)}catch{return $null}}",
"$excel=Active 'Excel.Application'",
"$word=Active 'Word.Application'",
"$ppt=Active 'PowerPoint.Application'"
].join("\n");

export function registerOfficeLiveTools(reg,ctx){
  reg("office_live_status",{description:"현재 실행 중인 Excel/Word/PowerPoint COM 세션을 확인한다.",inputSchema:{}},async()=>{
    if(!WIN)return text(JSON.stringify({available:false,platform:process.platform}));
    return text(ps(PRE+"\n@{excel=($null-ne $excel);word=($null-ne $word);powerpoint=($null-ne $ppt)}|ConvertTo-Json -Compress"));
  });

  reg("office_live_context",{description:"현재 열려 있는 Excel/Word/PowerPoint의 active workbook/document/deck와 selection context를 읽는다.",inputSchema:{}},async()=>{
    const code=PRE+"\n"+[
      "$out=@{}",
      "if($excel){try{$sel=$excel.Selection;$out.excel=@{workbook=$excel.ActiveWorkbook.Name;sheet=$excel.ActiveSheet.Name;selection=$sel.Address();value=$sel.Value2;formula=$sel.Formula}}catch{$out.excel=@{error=$_.Exception.Message}}}",
      "if($word){try{$s=$word.Selection;$out.word=@{document=$word.ActiveDocument.Name;selectionText=$s.Text;start=$s.Start;end=$s.End}}catch{$out.word=@{error=$_.Exception.Message}}}",
      "if($ppt){try{$v=$ppt.ActiveWindow.View;$slide=$v.Slide;$names=@();$texts=@();if($ppt.ActiveWindow.Selection.Type -eq 2){foreach($sh in $ppt.ActiveWindow.Selection.ShapeRange){$names+=$sh.Name;if($sh.HasTextFrame -and $sh.TextFrame.HasText){$texts+=$sh.TextFrame.TextRange.Text}}};$out.powerpoint=@{presentation=$ppt.ActivePresentation.Name;slideIndex=$slide.SlideIndex;selectedShapes=$names;selectedTexts=$texts}}catch{$out.powerpoint=@{error=$_.Exception.Message}}}",
      "$out|ConvertTo-Json -Depth 6 -Compress"
    ].join("\n");
    return text(ps(code));
  });

  reg("office_excel_write",{description:"열려 있는 Excel active sheet에 시작 셀부터 2차원 values/formulas를 실시간 기록한다. expected_*를 지정하면 focus가 바뀐 경우 쓰기를 중단한다.",inputSchema:{start:z.string(),values:z.array(z.array(z.any())),formulas:z.boolean().optional(),expected_workbook:z.string().optional(),expected_sheet:z.string().optional()}},async({start,values,formulas=false,expected_workbook,expected_sheet})=>{
    const cells=[];values.forEach((row,r)=>row.forEach((v,c)=>cells.push({r,c,t:v===null?"null":typeof v,v})));
    const env={WJK_OFFICE_DATA:Buffer.from(JSON.stringify(cells)).toString("base64"),WJK_OFFICE_START:start,WJK_OFFICE_FORMULAS:formulas?"1":"0",WJK_EXPECT_WB:expected_workbook||"",WJK_EXPECT_SHEET:expected_sheet||""};
    const code=PRE+"\n"+[
      "if(!$excel){throw 'Excel not running'}",
      "if($env:WJK_EXPECT_WB -and $excel.ActiveWorkbook.Name -ne $env:WJK_EXPECT_WB){throw 'Active workbook changed'};if($env:WJK_EXPECT_SHEET -and $excel.ActiveSheet.Name -ne $env:WJK_EXPECT_SHEET){throw 'Active sheet changed'}",
      "$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WJK_OFFICE_DATA))|ConvertFrom-Json",
      "$base=$excel.ActiveSheet.Range($env:WJK_OFFICE_START);$r0=$base.Row;$c0=$base.Column",
      "foreach($item in @($data)){$cell=$excel.ActiveSheet.Cells.Item($r0+[int]$item.r,$c0+[int]$item.c);if($env:WJK_OFFICE_FORMULAS -eq '1'){$cell.Formula=[string]$item.v}elseif($item.t -eq 'null'){$cell.ClearContents()}elseif($item.t -eq 'string'){$cell.Value2=[string]$item.v}elseif($item.t -eq 'number'){$cell.Value2=[double]$item.v}elseif($item.t -eq 'boolean'){$cell.Value2=[bool]$item.v}else{$cell.Value2=[string]$item.v}}",
      "@{ok=$true;workbook=$excel.ActiveWorkbook.Name;sheet=$excel.ActiveSheet.Name;start=$env:WJK_OFFICE_START}|ConvertTo-Json -Compress"
    ].join("\n");
    return text(ps(code,env));
  });

  reg("office_word_replace",{description:"열려 있는 Word active document에서 텍스트를 찾고 치환한다. expected_document가 다르면 중단한다.",inputSchema:{find:z.string(),replace:z.string(),replace_all:z.boolean().optional(),expected_document:z.string().optional()}},async({find,replace,replace_all=true,expected_document})=>{
    const env={WJK_FIND:Buffer.from(find).toString("base64"),WJK_REPLACE:Buffer.from(replace).toString("base64"),WJK_ALL:replace_all?"1":"0",WJK_EXPECT_DOC:expected_document||""};
    const code=PRE+"\n"+[
      "if(!$word){throw 'Word not running'}",
      "if($env:WJK_EXPECT_DOC -and $word.ActiveDocument.Name -ne $env:WJK_EXPECT_DOC){throw 'Active document changed'}",
      "$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WJK_FIND));$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WJK_REPLACE))",
      "$range=$word.ActiveDocument.Content;$findObj=$range.Find;$findObj.ClearFormatting();$findObj.Replacement.ClearFormatting()",
      "$replaceMode=1;if($env:WJK_ALL -eq '1'){$replaceMode=2}",
      "$ok=$findObj.Execute($f,$false,$false,$false,$false,$false,$true,1,$false,$r,$replaceMode)",
      "@{ok=$ok;document=$word.ActiveDocument.Name}|ConvertTo-Json -Compress"
    ].join("\n");
    return text(ps(code,env));
  });

  reg("office_word_set_selection",{description:"열려 있는 Word의 현재 selection 텍스트를 교체한다. expected_document가 다르면 중단한다.",inputSchema:{text:z.string(),expected_document:z.string().optional()}},async({text:value,expected_document})=>{
    const env={WJK_TEXT:Buffer.from(value).toString("base64"),WJK_EXPECT_DOC:expected_document||""};
    const code=PRE+"\nif(!$word){throw 'Word not running'};if($env:WJK_EXPECT_DOC -and $word.ActiveDocument.Name -ne $env:WJK_EXPECT_DOC){throw 'Active document changed'};$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WJK_TEXT));$word.Selection.Text=$v;@{ok=$true;document=$word.ActiveDocument.Name}|ConvertTo-Json -Compress";
    return text(ps(code,env));
  });

  reg("office_powerpoint_set_selected_text",{description:"PowerPoint에서 현재 선택한 text-capable shape들의 텍스트를 실시간 교체한다. expected_presentation이 다르면 중단한다.",inputSchema:{text:z.string(),expected_presentation:z.string().optional()}},async({text:value,expected_presentation})=>{
    const env={WJK_TEXT:Buffer.from(value).toString("base64"),WJK_EXPECT_PPT:expected_presentation||""};
    const code=PRE+"\n"+[
      "if(!$ppt){throw 'PowerPoint not running'}",
      "if($env:WJK_EXPECT_PPT -and $ppt.ActivePresentation.Name -ne $env:WJK_EXPECT_PPT){throw 'Active presentation changed'}",
      "$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WJK_TEXT));$n=0",
      "if($ppt.ActiveWindow.Selection.Type -eq 2){foreach($sh in $ppt.ActiveWindow.Selection.ShapeRange){if($sh.HasTextFrame){$sh.TextFrame.TextRange.Text=$v;$n++}}}",
      "@{ok=$true;presentation=$ppt.ActivePresentation.Name;changed=$n}|ConvertTo-Json -Compress"
    ].join("\n");
    return text(ps(code,env));
  });

  reg("office_live_save",{description:"현재 열려 있는 Excel/Word/PowerPoint active 문서를 저장한다. expected_*를 지정하면 focus가 바뀐 경우 저장하지 않는다.",inputSchema:{apps:z.array(z.enum(["excel","word","powerpoint"])).optional(),expected_workbook:z.string().optional(),expected_document:z.string().optional(),expected_presentation:z.string().optional()}},async({apps=["excel","word","powerpoint"],expected_workbook,expected_document,expected_presentation})=>{
    const env={WJK_APPS:apps.join(","),WJK_EXPECT_WB:expected_workbook||"",WJK_EXPECT_DOC:expected_document||"",WJK_EXPECT_PPT:expected_presentation||""};
    const code=PRE+"\n$done=@();if($env:WJK_APPS -like '*excel*' -and $excel){if($env:WJK_EXPECT_WB -and $excel.ActiveWorkbook.Name -ne $env:WJK_EXPECT_WB){throw 'Active workbook changed'};$excel.ActiveWorkbook.Save();$done+='excel'};if($env:WJK_APPS -like '*word*' -and $word){if($env:WJK_EXPECT_DOC -and $word.ActiveDocument.Name -ne $env:WJK_EXPECT_DOC){throw 'Active document changed'};$word.ActiveDocument.Save();$done+='word'};if($env:WJK_APPS -like '*powerpoint*' -and $ppt){if($env:WJK_EXPECT_PPT -and $ppt.ActivePresentation.Name -ne $env:WJK_EXPECT_PPT){throw 'Active presentation changed'};$ppt.ActivePresentation.Save();$done+='powerpoint'};@{saved=$done}|ConvertTo-Json -Compress";
    return text(ps(code,env,30000));
  });
}
