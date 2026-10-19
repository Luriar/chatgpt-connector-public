import os from "node:os";

export function runtimeHost(cfg){
  if(cfg?.runtimeProfile==="windows")return "windows";
  if(cfg?.runtimeProfile==="nas")return "nas";
  return process.platform==="win32"?"windows":"nas";
}

export function workerPolicy(cfg,host=runtimeHost(cfg)){
  const base=cfg?.workers||{};
  const override=base.hosts?.[host]||{};
  const max=Math.max(1,Number(override.max??base.max??8)||8);
  const queueMax=Math.max(max,Number(override.queueMax??base.queueMax??32)||32);
  const minFreeMemoryMB=Math.max(0,Number(override.minFreeMemoryMB??base.minFreeMemoryMB??512)||0);
  const maxLoadPerCpu=Math.max(0.1,Number(override.maxLoadPerCpu??base.maxLoadPerCpu??1.5)||1.5);
  return {host,max,queueMax,minFreeMemoryMB,maxLoadPerCpu};
}

export function workerPressure(cfg,host=runtimeHost(cfg)){
  const policy=workerPolicy(cfg,host);
  const cpus=Math.max(1,os.cpus()?.length||1);
  const freeMemoryMB=Math.round(os.freemem()/1024/1024);
  const load1=Number(os.loadavg?.()[0]||0);
  const loadPerCpu=load1/cpus;
  const memoryOk=freeMemoryMB>=policy.minFreeMemoryMB;
  const loadOk=host==="windows"||loadPerCpu<=policy.maxLoadPerCpu;
  return {...policy,cpus,freeMemoryMB,load1,loadPerCpu:Number(loadPerCpu.toFixed(3)),memoryOk,loadOk,available:memoryOk&&loadOk};
}
