// goal 루프(서버사이드) + effort 모드 + 세션 메모리/Compact & Resume
// 핵심 아이디어: 브라우저 자동타이핑 대신, 모든 도구 응답에 goal 진행상태를 주입해
// 모델이 한 턴 안에서 도구 체이닝으로 스스로 완주하게 만든다. (toolkit.js decorate 참고)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { text, EFFORT_LEVELS } from "../toolkit.js";
import { currentEffort, currentGoal, currentGoalHistory, setCurrentEffort, setCurrentGoal, sessionKey } from "../session-state.js";
import { ensureWorkspace, bindWorkspace } from "../workspaces.js";

export function registerGoalTools(reg, ctx) {
  const { store, cfg } = ctx;

  function writeHandoff(extra,goalOverride){
    const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + crypto.randomBytes(2).toString("hex");
    const g = goalOverride===undefined ? currentGoal(ctx) : goalOverride;
    const journalTail = ctx.journal.tail(60).map((l) => {
      try { const j = JSON.parse(l); return `- ${j.ts?.slice(11, 19)} ${j.tool} ${j.ok ? "ok" : "FAIL"}`; } catch { return null; }
    }).filter(Boolean);
    const md = [
      `# 웹쫀쿠 핸드오프 (${id})`,
      "", "## 활성 goal",
      g ? `"${g.title}"\n` + g.steps.map((s, i) => `- [${s.done ? "x" : " "}] ${i + 1}. ${s.text}${s.note ? ` — ${s.note}` : ""}`).join("\n") + (g.doneCriteria ? `\n완료 기준: ${g.doneCriteria}` : "") : "(없음)",
      "", "## effort", currentEffort(ctx),
      "", "## 저장된 메모",
      store.data.notes.slice(-30).map((n) => `- ${n.ts.slice(0, 16)} ${n.note}`).join("\n") || "(없음)",
      "", "## 최근 도구 호출(요약)",
      journalTail.join("\n") || "(없음)",
      "", "## 모델 작성 요약",
      extra || "(미작성)"
    ].join("\n");
    const dir=path.join(cfg.stateDir,"sessions");fs.mkdirSync(dir,{recursive:true});
    const file = path.join(dir, `${id}.md`);
    fs.writeFileSync(file, md);
    store.data.sessions.push({ id, file, createdAt: new Date().toISOString(), auto: true, goalId:g?.id||null, workspaceId:g?.workspaceId||null, lineageId:g?.lineageId||null, sessionKey:sessionKey(ctx) });
    if(store.data.sessions.length>100)store.data.sessions=store.data.sessions.slice(-100);
    store.save();
    return id;
  }

  // ── goal ──────────────────────────────────────────────────────
  reg("goal_set", {
    description: "목표(goal) 설정. 단계 리스트와 완료 기준을 등록하면 이후 모든 도구 응답에 진행상태가 표시되고, 모델은 완료까지 자율 진행한다.",
    inputSchema: {
      title: z.string(),
      steps: z.array(z.string()).min(1).describe("실행 단계 목록(순서대로)"),
      done_criteria: z.string().optional().describe("완료 판정 기준(테스트 통과 등)"),
      project_id:z.string().optional(), root:z.string().optional(), lineage_id:z.string().optional(), workspace_id:z.string().optional()
    }
  }, async ({ title, steps, done_criteria, project_id, root, lineage_id, workspace_id }) => {
    const prev=currentGoal(ctx);
    const g={
      id: "g" + crypto.randomBytes(3).toString("hex"),
      title,
      steps: steps.map((s) => ({ text: s, done: false, note: null })),
      doneCriteria: done_criteria || null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      summary: null
    };
    const project=project_id?store.data.projects?.[project_id]:null;
    if(project_id&&!project)throw new Error("project not found: "+project_id);
    const workspace=await ensureWorkspace(ctx,{goalId:g.id,lineageId:lineage_id||g.id,projectId:project_id,root:root||project?.root,workspaceId:workspace_id});
    Object.assign(g,{workspaceId:workspace.id,lineageId:workspace.lineageId,projectId:project_id||null,repoRoot:workspace.repoRoot});
    if (prev && !prev.finishedAt) currentGoalHistory(ctx).push(prev);
    goals()[g.id]=g;
    setCurrentGoal(ctx,g);
    store.save();
    writeHandoff(`auto checkpoint: goal set — ${title}`,g);
    return text(`🎯 goal 설정: "${title}" (${steps.length}단계)\nID: ${g.id}\n` +
      steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
      (done_criteria ? `\n완료 기준: ${done_criteria}` : "") +
      `\n워크스페이스: ${workspace.id}\n경로: ${workspace.root}\n새 Chat에서 work_resume{goal_id:"${g.id}"}로 같은 작업을 재개해.\n\n지금부터 1단계를 바로 시작해. 각 단계 완료 시 goal_step_done 호출.`);
  });

  reg("goal_status", {
    description: "현재 goal 진행상태 확인",
    inputSchema: { goal_id: z.string().optional().describe("재연결/후속 실행에서 이어갈 persistent goal ID") }
  }, async ({ goal_id }) => {
    const g = await resolveGoal(goal_id,{allowMissing:true,bind:true});
    if (!g) return text("활성 goal 없음. goal_set으로 설정 가능.");
    const rows = g.steps.map((s, i) => `  ${s.done ? "✅" : "⬜"} ${i + 1}. ${s.text}${s.note ? ` — ${s.note}` : ""}`);
    return text(`🎯 "${g.title}" (${g.steps.filter((s) => s.done).length}/${g.steps.length})${g.finishedAt ? " [완료됨]" : ""}\n` +
      rows.join("\n") + (g.doneCriteria ? `\n완료 기준: ${g.doneCriteria}` : ""));
  });

  reg("goal_step_done", {
    description: "단계 완료 처리. index 생략 시 첫 미완료 단계.",
    inputSchema: {
      goal_id: z.string().optional().describe("persistent goal ID"),
      index: z.number().int().min(1).optional(),
      note: z.string().optional().describe("결과 요약(검증 내용 등)")
    }
  }, async ({ goal_id, index, note }) => {
    const g = await resolveGoal(goal_id,{bind:true});
    const i = index ? index - 1 : g.steps.findIndex((s) => !s.done);
    if (i < 0 || i >= g.steps.length) throw new Error("해당 단계 없음");
    g.steps[i].done = true;
    g.steps[i].note = note || null;
    store.save();
    const remain = g.steps.filter((s) => !s.done).length;
    writeHandoff(`auto checkpoint: goal step ${i+1} done${note?` — ${note}`:""}`,g);
    return text(`✅ ${i + 1}단계 완료${note ? `: ${note}` : ""}\n남은 단계 ${remain}개${remain ? " — 바로 다음 단계 진행해." : " — done_criteria 검증 후 goal_finish 호출해."}`);
  });

  reg("goal_add_step", {
    description: "진행 중 발견된 추가 작업을 goal에 단계로 추가",
    inputSchema: { goal_id: z.string().optional().describe("persistent goal ID"), step: z.string(), position: z.number().int().min(1).optional() }
  }, async ({ goal_id, step, position }) => {
    const g = await resolveGoal(goal_id,{bind:true});
    const item = { text: step, done: false, note: null };
    if (position) g.steps.splice(position - 1, 0, item);
    else g.steps.push(item);
    store.save();
    return text(`단계 추가됨 (총 ${g.steps.length}개)`);
  });

  reg("goal_finish", {
    description: "goal 완료 선언. done_criteria 검증 결과와 최종 요약 필수.",
    inputSchema: { goal_id: z.string().optional().describe("persistent goal ID"), summary: z.string().describe("무엇을 했고 어떻게 검증했는지") }
  }, async ({ goal_id, summary }) => {
    const g = await resolveGoal(goal_id,{bind:true});
    const undone = g.steps.filter((s) => !s.done);
    if (undone.length) {
      return text(`⚠️ 아직 미완료 단계 ${undone.length}개 있어:\n` + undone.map((s) => `  ⬜ ${s.text}`).join("\n") +
        "\n전부 끝내고 다시 호출하거나, 불필요해진 단계면 goal_step_done{note:'skip: 이유'}로 정리해.");
    }
    g.finishedAt = new Date().toISOString();
    g.summary = summary;
    currentGoalHistory(ctx).push(g);
    if(currentGoal(ctx)?.id===g.id)setCurrentGoal(ctx,null);
    store.save();
    writeHandoff(`auto checkpoint: goal finished — ${summary}`,g);
    return text(`🏁 goal 완료: "${g.title}"\n${summary}`);
  });

  // ── effort 모드 ───────────────────────────────────────────────
  reg("effort_set", {
    description: "노력(effort) 모드 선택: minimal|low|medium|high|max. 이후 모든 작업의 꼼꼼함 기준이 되고 codex 위임 시 reasoning effort로 매핑됨.",
    inputSchema: { level: z.enum(["minimal", "low", "medium", "high", "max"]) }
  }, async ({ level }) => {
    setCurrentEffort(ctx,level);
    store.save();
    return text(`⚙️ effort=${level}\n${EFFORT_LEVELS[level]}`);
  });

  // ── 세션 메모리 / Compact & Resume ────────────────────────────
  reg("session_save", {
    description: "중요 컨텍스트/결정사항을 영속 메모로 저장(대화가 바뀌어도 유지됨)",
    inputSchema: { note: z.string(), tags: z.array(z.string()).optional() }
  }, async ({ note, tags = [] }) => {
    store.data.notes.push({ ts: new Date().toISOString(), note, tags });
    if (store.data.notes.length > 500) store.data.notes = store.data.notes.slice(-500);
    store.save();
    return text(`메모 저장됨 (총 ${store.data.notes.length}개)`);
  });

  reg("session_compact", {
    description: "Compact & Resume: 현재 상태(골/메모/최근 작업 저널)를 핸드오프 문서로 저장. 새 대화에서 session_recall로 복원.",
    inputSchema: { extra: z.string().optional().describe("모델이 직접 쓰는 진행상황 요약(강력 추천)") }
  }, async ({ extra }) => {
    const id=writeHandoff(extra);
    const rec=store.data.sessions.find(s=>s.id===id);if(rec)rec.auto=false;store.save();
    return text(`💾 핸드오프 저장: ${id}\n새 대화에서 첫 메시지로 "session_recall 해줘"라고 하면 이 상태 그대로 복원돼.`);
  });

  reg("session_recall", {
    description: "저장된 핸드오프 복원(기본: 최신). 새 대화 시작 시 호출하면 이전 컨텍스트가 그대로 이어짐.",
    inputSchema: { id: z.string().optional() }
  }, async ({ id }) => {
    const list = store.data.sessions;
    if (!list.length) return text("저장된 핸드오프 없음.");
    const g=currentGoal(ctx);
    const rec = id ? list.find((s) => s.id === id) : (g?[...list].reverse().find(s=>s.goalId===g.id):null)||list[list.length - 1];
    if (!rec) throw new Error(`핸드오프 ${id} 없음. session_list로 확인.`);
    if(id&&rec.goalId)await resolveGoal(rec.goalId,{allowMissing:true,bind:true});
    const md = fs.readFileSync(rec.file, "utf8");
    return text(md + "\n\n→ 위 상태를 이어받아 작업 계속해.");
  });

  reg("session_list", {
    description: "핸드오프 목록",
    inputSchema: {}
  }, async () => {
    const list = store.data.sessions.slice(-30);
    return text(list.length ? list.map((s) => `${s.id} (${s.createdAt.slice(0, 16)})`).join("\n") : "없음");
  });

  function goals(){
    if(!store.data.goals||typeof store.data.goals!=="object"||Array.isArray(store.data.goals))store.data.goals={};
    return store.data.goals;
  }
  function chooseImplicitActiveGoal(active){
    if(active.length===1)return active[0];
    if(active.length<2)return null;
    const titles=new Set(active.map(g=>String(g?.title||"").trim()));
    if(titles.size!==1)return null;
    return [...active].sort((a,b)=>{
      const ad=(a.steps||[]).filter(s=>s?.done).length,bd=(b.steps||[]).filter(s=>s?.done).length;
      if(ad!==bd)return bd-ad;
      return (Date.parse(b.createdAt||"")||0)-(Date.parse(a.createdAt||"")||0);
    })[0]||null;
  }
  async function resolveGoal(goalId,{allowMissing=false,bind=false}={}){
    let g=goalId?goals()[String(goalId)]:currentGoal(ctx);
    if(!g&&!goalId){
      const active=Object.values(goals()).filter(x=>x&&!x.finishedAt);
      g=chooseImplicitActiveGoal(active);
      if(g)bind=true;
      else if(active.length>1)throw new Error("미완료 persistent goal이 여러 개라 자동 선택할 수 없음. goal_id로 지정해.");
    }
    if(!g||g.finishedAt){
      if(allowMissing)return null;
      throw new Error(goalId?`goal ${goalId} 없음 또는 완료됨`:"활성 goal 없음. goal_set 먼저.");
    }
    if(bind){
      const w=g.workspaceId?bindWorkspace(ctx,g.workspaceId):await ensureWorkspace(ctx,{goalId:g.id,lineageId:g.lineageId||g.id,projectId:g.projectId,root:g.repoRoot,legacyRoot:true});
      g.workspaceId=w.id;g.lineageId=w.lineageId;setCurrentGoal(ctx,g);store.save();
    }
    return g;
  }
}
