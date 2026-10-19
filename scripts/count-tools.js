import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path"; import os from "node:os"; import fs from "node:fs"; import { fileURLToPath } from "node:url";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),d=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-count-")),cfg=path.join(d,"cfg.json");
fs.writeFileSync(cfg,JSON.stringify({roots:[d]},null,2));
const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfg],cwd:d});
const c=new Client({name:"count",version:"1"});await c.connect(tr);const {tools}=await c.listTools();console.log(JSON.stringify({count:tools.length,names:tools.map(x=>x.name)},null,2));await c.close();try{fs.rmSync(d,{recursive:true,force:true})}catch{};process.exit(0);
