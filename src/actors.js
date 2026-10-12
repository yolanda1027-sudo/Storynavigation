// 故事導航 — M3 幕後推手引擎（MVP 內含 M5 簡化版重算：計畫可行性判斷）
//
// 「推進劇情」流程：節點偵測 → 每個 active 推手推進 → 結果進 pending → 確認後套用。
//
// 資訊隔離由程式控制：每個推手只會收到
//   - 自己的資料與 knowledge
//   - 自己相關的路線
//   - knownBy 包含他的節點
//   - 他自己做的、或 whoKnows 包含他的事件
//   - 其他推手的 id 與名字（用來填 whoKnows）
// 其他推手的資料、聊天原文、他不知道的事件真相都不會送出。

import {
    ROUTE_STATUSES, EVENT_RESULTS, coerce, ctx, getSettings, getState, commit, setTransient,
    normalizeNode, normalizeEvent, makeId,
} from './state.js';
import { callLLM, parseJsonObject, runTask, estimateTokens } from './llm.js';
import { detectNodes } from './detector.js';
import { setLastReport } from './reader.js';
import { getPromptTemplate, sections, BATCH_SUFFIX } from './prompts.js';

const { str, strList, oneOf } = coerce;
const FEASIBILITY = ['feasible', 'partial', 'invalid'];
const MAX_NODES_PER_ACTOR = 15;
const MAX_EVENTS_PER_ACTOR = 8;

// ───────────────────────── 資訊隔離：組出單一推手看得到的資料 ─────────────────────────

/**
 * @param {object} actor
 * @param {object} state 已確認的狀態
 * @param {object[]} newNodes 本次偵測到、尚未確認的節點
 * @param {{worldTime: string, elapsed: string}} time
 */
export function buildActorView(actor, state, newNodes, time) {
    const routes = state.routes.filter(r => actor.relatedRoutes.includes(r.id));
    const nodes = [...state.nodes.filter(n => n.confirmed), ...newNodes]
        .filter(n => n.knownBy.includes(actor.id))
        .slice(-MAX_NODES_PER_ACTOR);
    const events = state.events
        .filter(e => e.actorId === actor.id || e.whoKnows.includes(actor.id))
        .slice(-MAX_EVENTS_PER_ACTOR);
    const others = state.actors.filter(a => a.id !== actor.id);

    const self = {
        id: actor.id,
        name: actor.name,
        identity: actor.identity,
        objective: actor.objective,
        motive: actor.motive,
        resources: actor.resources,
        constraints: actor.constraints,
        currentPlan: actor.currentPlan,
        currentStep: actor.currentStep,
        obstacles: actor.obstacles,
        progress: actor.progress,
    };
    const lines = (list) => list.length ? list.map(x => `- ${x}`).join('\n') : '（無）';

    const text = sections([
        ['推手資料', JSON.stringify(self, null, 2)],
        ['他已知的情報（knowledge）', lines(actor.knowledge)],
        ['相關路線', routes.length ? routes.map(r => JSON.stringify({
            routeId: r.id, name: r.name, type: r.type, status: r.status, conflict: r.conflict, stage: r.stage,
            situation: r.situation, destination: r.destination, successCondition: r.successCondition,
            failCondition: r.failCondition, obstacles: r.obstacles,
        }, null, 2)).join('\n') : '（無）'],
        ['他知道的已發生節點', nodes.length ? nodes.map(n => `- ${n.id}（#${n.floor}，${n.type}）${n.summary}`).join('\n') : '（無）'],
        ['他知道的過往事件', events.length ? events.map(e => `- ${e.id}：${e.actorId === actor.id ? '（自己的行動）' : ''}${e.action}｜結果：${e.result}｜真相：${e.truth}`).join('\n') : '（無）'],
        ['其他推手（只有名字，可用於 whoKnows）', others.length ? others.map(a => `- ${a.id}：${a.name || '（未命名）'}`).join('\n') : '（無）'],
        ['世界時間', `目前：${time.worldTime || '未知'}\n這次推進經過的時間：${time.elapsed || '未知'}`],
    ]);

    return {
        text,
        summary: `自身資料、knowledge ${actor.knowledge.length} 條、路線 ${routes.length} 條、節點 ${nodes.length} 個、事件 ${events.length} 則`,
        tokens: estimateTokens(text),
        allowedRouteIds: routes.map(r => r.id),
        knownIds: [...nodes.map(n => n.id), ...events.map(e => e.id)],
    };
}

// ───────────────────────── 驗證 ─────────────────────────

export function validateActorOutput(obj, actor, { otherActorIds, allowedRouteIds, knownIds }) {
    const errors = [];
    const warnings = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['不是 JSON 物件'], warnings, value: null };
    if (!str(obj.action).trim()) errors.push('缺少 action（行動）');
    if (errors.length) return { ok: false, errors, warnings, value: null };

    if (!FEASIBILITY.includes(obj.feasibility)) warnings.push(`feasibility「${str(obj.feasibility)}」無法辨識，視為 feasible`);
    const whoKnowsRaw = strList(obj.whoKnows);
    const whoKnows = whoKnowsRaw.filter(id => otherActorIds.includes(id));
    if (whoKnows.length < whoKnowsRaw.length) warnings.push('whoKnows 裡有不存在的推手 id，已移除');

    const routeUpdates = (Array.isArray(obj.routeUpdates) ? obj.routeUpdates : [])
        .filter(u => u && typeof u === 'object')
        .map(u => ({
            routeId: str(u.routeId),
            stage: str(u.stage),
            situation: str(u.situation),
            status: ROUTE_STATUSES.includes(u.status) ? u.status : '',
        }))
        .filter(u => {
            const ok = allowedRouteIds.includes(u.routeId);
            if (!ok && u.routeId) warnings.push(`推手試圖修改與他無關的路線 ${u.routeId}，已忽略`);
            return ok && (u.stage || u.situation || u.status);
        });

    const derivedFrom = strList(obj.derivedFrom);
    const unknownRefs = derivedFrom.filter(id => !knownIds.includes(id));
    if (unknownRefs.length) warnings.push(`derivedFrom 引用了他不知道的項目：${unknownRefs.join('、')}`);

    return {
        ok: true,
        errors,
        warnings,
        value: {
            actorId: actor.id,
            actorName: actor.name,
            feasibility: oneOf(obj.feasibility, FEASIBILITY, 'feasible'),
            reason: str(obj.reason),
            derivedFrom,
            updates: {
                objective: str(obj.objective),
                currentPlan: str(obj.currentPlan),
                currentStep: str(obj.currentStep),
                progress: str(obj.progress),
            },
            knowledgeAdd: strList(obj.knowledgeAdd),
            event: normalizeEvent({
                id: makeId('evt'),
                actorId: actor.id,
                action: str(obj.action),
                result: oneOf(obj.result, EVENT_RESULTS, 'success'),
                truth: str(obj.truth),
                worldEffect: str(obj.worldEffect),
                whoKnows,
                playerKnows: false,
                revealHook: str(obj.revealHook),
                injected: false,
            }),
            routeUpdates,
            warnings,
        },
    };
}

// ───────────────────────── 推進 ─────────────────────────

function parseOrThrow(res, label) {
    try {
        return parseJsonObject(res.text);
    } catch (e) {
        res.logEntry.error = `解析失敗：${e.message}`;
        throw new Error(`${label}的回覆無法解析：${e.message}`);
    }
}

async function advanceOne(task, actor, view, state) {
    const res = await callLLM({
        system: getPromptTemplate('advanceActors'),
        user: `${view.text}\n\n【任務】\n請代表這位推手推進一次，只輸出 JSON。`,
        purpose: `推手推進：${actor.name || actor.id}`,
        signal: task.signal,
    });
    task.assertSameChat();
    const parsed = parseOrThrow(res, `推手「${actor.name || actor.id}」`);
    const v = validateActorOutput(parsed, actor, {
        otherActorIds: state.actors.filter(a => a.id !== actor.id).map(a => a.id),
        allowedRouteIds: view.allowedRouteIds,
        knownIds: view.knownIds,
    });
    if (!v.ok) {
        res.logEntry.error = `驗證失敗：${v.errors.join('；')}`;
        throw new Error(`推手「${actor.name || actor.id}」的回覆格式不符：${v.errors.join('；')}`);
    }
    return v.value;
}

async function advanceBatch(task, actors, views, state) {
    const user = actors.map((a, i) => `════ 推手 ${a.id}（${a.name || '未命名'}）的資料 ════\n${views[i].text}`).join('\n\n')
        + '\n\n【任務】\n請對每位推手分別推進一次，只輸出 JSON。';
    const res = await callLLM({
        system: getPromptTemplate('advanceActors') + BATCH_SUFFIX,
        user,
        purpose: `推手推進（合併 ${actors.length} 位）`,
        signal: task.signal,
    });
    task.assertSameChat();
    const parsed = parseOrThrow(res, '推手推進');
    const list = Array.isArray(parsed.results) ? parsed.results : [];
    const results = [];
    const errors = [];
    actors.forEach((actor, i) => {
        const item = list.find(r => r?.actorId === actor.id);
        if (!item) {
            errors.push({ actorId: actor.id, message: `回覆中沒有推手「${actor.name || actor.id}」的結果` });
            return;
        }
        const v = validateActorOutput(item, actor, {
            otherActorIds: state.actors.filter(a => a.id !== actor.id).map(a => a.id),
            allowedRouteIds: views[i].allowedRouteIds,
            knownIds: views[i].knownIds,
        });
        if (v.ok) results.push(v.value);
        else errors.push({ actorId: actor.id, message: v.errors.join('；') });
    });
    return { results, errors };
}

/**
 * 推進劇情：偵測 → 推手推進 → pending。
 * @param {{elapsed?: string}} opt 使用者手動填的「這次經過的時間」，留空由 AI 從聊天判斷
 */
export function advanceStory({ elapsed = '' } = {}) {
    return runTask('推進劇情', async (task) => {
        const state = getState();
        if (!state) throw new Error('此聊天尚未建立導航');
        const snapshot = JSON.parse(JSON.stringify(state)); // 推進期間以這份為準
        const settings = getSettings();

        // 1) 節點偵測
        task.setStep('偵測劇情節點');
        const detected = await detectNodes(task, snapshot);
        task.assertSameChat();

        const time = {
            worldTime: detected.worldTime || snapshot.worldTime.label,
            elapsed: elapsed.trim() || detected.elapsed || '未知',
        };

        // 2) 推手推進
        const maxActors = Math.max(1, Number(settings.maxActors) || 3);
        const actors = snapshot.actors.filter(a => a.active).slice(0, maxActors);
        const views = actors.map(a => buildActorView(a, snapshot, detected.nodes, time));
        const results = [];
        const errors = [];

        if (!actors.length) {
            errors.push({ actorId: '', message: '沒有啟用中的推手，這次只做節點偵測' });
        } else if (settings.isolateActors || actors.length === 1) {
            for (let i = 0; i < actors.length; i++) {
                task.setStep(`推手推進：${actors[i].name || actors[i].id}（${i + 1}/${actors.length}）`);
                try {
                    results.push(await advanceOne(task, actors[i], views[i], snapshot));
                } catch (e) {
                    if (e.name === 'ChatChangedError' || task.signal.aborted) throw e;
                    errors.push({ actorId: actors[i].id, message: e.message });
                }
            }
        } else {
            task.setStep(`推手推進（合併 ${actors.length} 位）`);
            const batch = await advanceBatch(task, actors, views, snapshot);
            results.push(...batch.results);
            errors.push(...batch.errors);
        }
        task.assertSameChat();

        if (actors.length && !results.length) {
            throw new Error(`所有推手都推進失敗：${errors.map(e => e.message).join('；')}`);
        }

        const report = {
            ...detected.report,
            purpose: 'advance',
            items: [
                ...detected.report.items.map(i => ({ ...i, kind: `節點偵測．${i.kind}` })),
                ...actors.map((a, i) => ({ kind: `推手：${a.name || a.id}`, label: views[i].summary, tokens: views[i].tokens })),
            ],
        };
        report.totalTokens = report.items.reduce((n, i) => n + i.tokens, 0);
        if (detected.skipped) report.notes = [...(report.notes || []), '上次推進後沒有新訊息，略過節點偵測'];
        setLastReport(report);

        await setTransient('pending', {
            kind: 'advance',
            createdAt: Date.now(),
            fromFloor: detected.fromFloor,
            atFloor: detected.toFloor,
            elapsed: time.elapsed,
            worldTime: detected.worldTime,
            nodes: detected.nodes,
            revealedEvents: detected.revealedEvents,
            actorResults: results,
            errors,
            warnings: detected.warnings,
            report,
        }, task.chatId);
        return { results, errors };
    });
}

/** 套用 pending 中的推進結果 */
export async function applyAdvance(pending, expectedChatId) {
    const chatLength = (ctx().chat || []).length;
    await commit(`推進劇情（#${pending.fromFloor}～#${pending.atFloor}）`, (draft) => {
        for (const n of pending.nodes || []) {
            if (!draft.nodes.some(x => x.id === n.id)) draft.nodes.push(normalizeNode({ ...n, confirmed: true }));
        }
        for (const id of pending.revealedEvents || []) {
            const e = draft.events.find(x => x.id === id);
            if (e) e.playerKnows = true;
        }
        for (const r of pending.actorResults || []) {
            const actor = draft.actors.find(a => a.id === r.actorId);
            if (!actor) continue; // 推手在等待確認期間被刪除了
            for (const [key, value] of Object.entries(r.updates || {})) {
                if (str(value).trim()) actor[key] = value;
            }
            for (const k of r.knowledgeAdd || []) {
                if (!actor.knowledge.includes(k)) actor.knowledge.push(k);
            }
            if (r.event && !draft.events.some(x => x.id === r.event.id)) {
                draft.events.push(normalizeEvent({
                    ...r.event,
                    whoKnows: (r.event.whoKnows || []).filter(id => draft.actors.some(a => a.id === id)),
                    atFloor: pending.atFloor,
                    worldTime: pending.worldTime || draft.worldTime.label,
                    injectFrom: chatLength,
                }));
            }
            for (const u of r.routeUpdates || []) {
                const route = draft.routes.find(x => x.id === u.routeId);
                if (!route || !actor.relatedRoutes.includes(route.id)) continue;
                if (u.stage) route.stage = u.stage;
                if (u.situation) route.situation = u.situation;
                if (u.status) route.status = u.status;
            }
        }
        if (pending.worldTime && pending.worldTime !== '未知') {
            draft.worldTime = { label: pending.worldTime, source: 'ai' };
        }
        draft.lastPushFloor = Math.max(Number(draft.lastPushFloor) || 0, Number(pending.atFloor) || 0);
    }, { expectedChatId });
}
