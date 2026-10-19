// Pure task routing: pick RPC first, then bounded durable commands.
const MAX_COMMAND_CHARS=120000;
export function pickWindowsWorkerTask(rows,callTimeoutMs){
 if(!Array.isArray(rows))return null;
 const tool=rows.find(t=>t?.action?.type==="tool");if(tool)return tool;
 const upper=Math.max(0,Number(callTimeoutMs)||0)-5000;
 return rows.find(t=>t?.action?.type==="command"&&typeof t.action.command==="string"&&t.action.command.trim().length>0&&t.action.command.length<=MAX_COMMAND_CHARS&&(t.action.timeout_ms==null||Number(t.action.timeout_ms)<=upper))||null;
}
export function windowsWorkerCall(task,callTimeoutMs){
 const action=task?.action;
 if(action?.type==="tool")return {tool:String(action.tool||""),args:action.args||{},isCommand:false};
 if(action?.type!=="command"||typeof action.command!=="string"||!action.command.trim())throw Error("invalid remote command");
 const upper=Math.max(0,Number(callTimeoutMs)||0)-5000;
 const requested=action.timeout_ms==null?upper:Number(action.timeout_ms);
 if(!Number.isFinite(requested)||requested<1000||requested>upper)throw Error("remote command timeout outside Windows tool worker bounds");
 if(action.command.length>MAX_COMMAND_CHARS)throw Error("remote command too long");
 return {tool:"exec_command",args:{command:action.command,shell:"auto",timeout_ms:requested,...(typeof action.cwd==="string"&&action.cwd?{cwd:action.cwd}:{})},isCommand:true};
}
export function windowsWorkerCompletion(task,mcpResult){
 if(task?.action?.type!=="command")return {mcpResult};
 const output=(mcpResult?.content||[]).filter(x=>x?.type==="text"&&typeof x.text==="string").map(x=>x.text).join("\n");
 if(mcpResult?.isError)throw Error("Windows command MCP error: "+output.slice(0,300));
 const match=/^\[exit\s+(-?\d+)\s+[^\]]+\]/.exec(output);
 if(!match)throw Error("Windows command returned no verifiable exit code");
 return {steps:[{title:"remote command",exitCode:Number(match[1]),output:output.slice(-20000)}],executedBy:"windows-tool-worker"};
}