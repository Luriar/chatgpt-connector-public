const messageOf=error=>String(error?.message||error||"");

export function isRepairableWindowsLocalMcpFailure(error){
  const message=messageOf(error);
  return /Windows local MCP call deadline exceeded|MCP error -32001:\s*Request timed out|request timeout|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i.test(message);
}
