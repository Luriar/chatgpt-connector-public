// Safe read-only Windows integration test for the UIA + JPEG screenshot bridge.
// Usage: node scripts/windows-ui-bridge-smoke.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerComputerUiaTools } from "../src/tools/computer-uia.js";
import { registerDesktopTools } from "../src/tools/desktop.js";

if(process.platform!=="win32"){ console.log("SKIP: Windows-only integration test");process.exit(0); }
const root=path.join(os.tmpdir(),"wjk-ui-smoke-"+process.pid);
fs.mkdirSync(path.join(root,"tmp"),{recursive:true});
const entries=new Map();
const reg=(name,_schema,handler)=>entries.set(name,handler);
const cfg={desktop:{enabled:true},stateDir:root};
registerComputerUiaTools(reg,{cfg});
registerDesktopTools(reg,{cfg});
try{
 const status=JSON.parse((await entries.get("computer_uia_status")({})).content[0].text);
 if(!status.available)throw new Error("UIA unavailable");
 const treeText=(await entries.get("computer_tree")({window_title:"Edge",max_depth:6,max_nodes:400})).content[0].text;
 const tree=JSON.parse(treeText);
 if(!Array.isArray(tree) || !tree.length)throw new Error("UIA tree empty");
 if(treeText.includes("\uFFFD")||treeText.includes("����"))throw new Error("UIA text contains Unicode replacement characters");
 const out=await entries.get("desktop_screenshot")({window_title:"Edge",max_width:1200,max_height:850,quality:55});
 const metadata=JSON.parse(out.content.find(x=>x.type==="text").text);
 const jpg=Buffer.from(out.content.find(x=>x.type==="image").data,"base64");
 if(jpg.length>1600000)throw new Error("Remote screenshot unexpectedly large");
 if(jpg[0]!==0xff||jpg[1]!==0xd8)throw new Error("Screenshot is not JPEG");
 if(!(metadata.scale>0) || !Number.isFinite(metadata.left) || !Number.isFinite(metadata.top))throw new Error("Invalid screen coordinate metadata");
 console.log(JSON.stringify({pass:true,uiElements:tree.length,uiKorean:treeText.includes("사람인"),screenshotBytes:jpg.length,capture:metadata},null,2));
}catch(e){console.error("FAIL:",String(e?.stack||e));process.exitCode=1}
finally{try{fs.rmSync(root,{recursive:true,force:true})}catch{}}
