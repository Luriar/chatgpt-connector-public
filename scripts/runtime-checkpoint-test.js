import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registerTaskTools } from '../src/tools/tasks.js';

for (const profile of ['nas', 'windows']) {
  for (const action of ['start', 'status']) {
    const r = spawnSync(process.execPath, ['scripts/runtime.js', action, '--profile', profile, '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.profile, profile);
    if (profile === 'nas') {
      assert.ok(plan.commands.every(cmd => cmd.some(x => x.includes('nas-compose.yml'))));
      if (action === 'start') {
        assert.equal(plan.commands.length, 2);
        const buildIndex = plan.commands[0].indexOf('build');
        assert.ok(buildIndex >= 0);
        assert.deepEqual(plan.commands[0].slice(buildIndex + 1), ['coordinator', 'connector', 'browser-nas']);
        assert.ok(plan.commands[1].includes('up'));
        assert.ok(plan.commands[1].includes('--no-build'));
        assert.ok(plan.commands[1].includes('tailscale'));
      }
    } else if (action === 'start') {
      assert.deepEqual(plan.launches.map(x => x.mode), ['daemon', 'browser', 'tools']);
    } else {
      assert.ok(plan.commands[0].some(x => x.endsWith('status.js')));
    }
  }
}
assert.notEqual(spawnSync(process.execPath, ['scripts/runtime.js', 'start', '--profile', 'invalid']).status, 0);
let disk;
const store = { data: { tasks: { task_test: { id:'task_test', status:'paused', steps:[{title:'one',status:'succeeded'},{title:'two',status:'pending'}], currentStep:null, events:[] } } }, save(){disk=structuredClone(this.data);} };
const ctx={store,cfg:{readOnly:false,permissions:{default:'allow'}}};
const handlers={};
registerTaskTools((name,meta,handler)=>handlers[name]=handler,ctx);
await handlers.task_checkpoint({id:'task_test',summary:'Decision summary',draft:'unfinished draft',command_results:'exit 0',next_steps:['two']});
await handlers.task_checkpoint({id:'task_test',draft:'updated draft'});
assert.equal(disk.tasks.task_test.checkpoint.summary,'Decision summary');
assert.equal(disk.tasks.task_test.checkpoint.draft,'updated draft');
store.data=structuredClone(disk);
const restored=JSON.parse((await handlers.task_status({id:'task_test'})).content[0].text);
assert.deepEqual(restored.checkpoint.next_steps,['two']);
await handlers.task_resume({id:'task_test'});
assert.equal(store.data.tasks.task_test.steps[0].status,'succeeded');
assert.equal(store.data.tasks.task_test.status,'queued');
ctx.cfg.readOnly=true;
await assert.rejects(()=>handlers.task_checkpoint({id:'task_test',draft:'denied'}),/readOnly/);
console.log('PASS: profile routing, checkpoint persistence/merge, resume, read-only');

// Exercise a real short-lived command against an isolated in-memory store.
const liveStore={data:{tasks:{}},save(){this.saved=structuredClone(this.data);}};
const live={};
registerTaskTools((name,meta,handler)=>live[name]=handler,{store:liveStore,cfg:{roots:[process.cwd()],permissions:{default:'allow'}}});
const command=process.platform==='win32' ? "Write-Output 'partial-output'; Start-Sleep -Seconds 6" : "printf partial-output; sleep 6";
const task=JSON.parse((await live.task_create({title:'checkpoint test',steps:[{title:'short step',command}]})).content[0].text);
await new Promise(r=>setTimeout(r,6500));
assert.match(liveStore.saved.tasks[task.id].steps[0].output,/partial-output/);
assert.ok(liveStore.saved.tasks[task.id].steps[0].checkpointAt);
await new Promise(r=>setTimeout(r,2000));
assert.equal(liveStore.saved.tasks[task.id].status,'succeeded');
console.log('PASS: in-flight and final command output persisted');
