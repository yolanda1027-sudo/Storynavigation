// 故事導航 — M5 動態路線重算
//
// 節點偵測後，若某條路線的失效條件成立、成立條件達成、核心人物／資源消失，
// 或使用者手動勾了「需要重算」，就只重算這些路線（推手接著依新的路線推進）。
// 永遠不抹除玩家已確定的行動結果、不強行拉回原著。

import { ROUTE_STATUSES, coerce } from './state.js';
import { callLLM, parseJsonObject } from './llm.js';
import { getPromptTemplate, sections } from './prompts.js';

const { str, strList } = coerce;
const FLAG_LABEL = { failed: '失效條件成立', reached: '成立條件達成', core_lost: '核心人物或資源消失', manual: '手動標記需重算' };

export function flagLabel(flag) {
    return FLAG_LABEL[flag] || flag;
}

/** 這次要重算哪些路線：偵測到的 + 手動標記的 */
export function collectRecalcTargets(state, routeFlags) {
    const targets = new Map();
    for (const f of routeFlags || []) targets.set(f.routeId, { routeId: f.routeId, flag: f.flag, reason: f.reason });
    for (const r of state.routes) {
        if (r.needsRecalc && !targets.has(r.id)) targets.set(r.id, { routeId: r.id, flag: 'manual', reason: '' });
    }
    return [...targets.values()].filter(t => state.routes.some(r => r.id === t.routeId));
}

export function validateRecalcOutput(obj, targetIds) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.routes)) {
        return { ok: false, errors: ['缺少 routes 陣列'], value: null };
    }
    const value = obj.routes
        .filter(r => r && typeof r === 'object' && targetIds.includes(str(r.routeId)))
        .map(r => ({
            routeId: str(r.routeId),
            status: ROUTE_STATUSES.includes(r.status) ? r.status : '',
            stage: str(r.stage),
            situation: str(r.situation),
            destination: str(r.destination),
            successCondition: str(r.successCondition),
            failCondition: str(r.failCondition),
            obstacles: Array.isArray(r.obstacles) ? strList(r.obstacles) : null,
            reason: str(r.reason),
        }));
    return { ok: true, errors: [], value };
}

/** 把重算結果套到路線上（草稿或快照都可用） */
export function applyRecalcToRoutes(routes, recalcs) {
    for (const rc of recalcs || []) {
        const route = routes.find(r => r.id === rc.routeId);
        if (!route) continue;
        for (const key of ['status', 'stage', 'situation', 'destination', 'successCondition', 'failCondition']) {
            if (str(rc[key]).trim()) route[key] = rc[key];
        }
        if (Array.isArray(rc.obstacles)) route.obstacles = rc.obstacles;
        route.needsRecalc = false;
    }
}

/**
 * 呼叫 AI 重算路線。
 * @returns {Promise<object[]>} 每條路線的重算結果（含 flag 與原本的名稱）
 */
export async function recalcRoutes(task, state, targets, newNodes) {
    if (!targets.length) return [];
    const ids = targets.map(t => t.routeId);
    const routes = state.routes.filter(r => ids.includes(r.id));
    const recentNodes = [...state.nodes.filter(n => n.confirmed).slice(-10), ...newNodes];
    const nameOf = (id) => state.actors.find(a => a.id === id)?.name || id;

    const user = sections([
        ['需要重算的路線', routes.map(r => {
            const t = targets.find(x => x.routeId === r.id);
            return `${JSON.stringify({
                routeId: r.id, name: r.name, type: r.type, status: r.status, conflict: r.conflict, stage: r.stage,
                situation: r.situation, destination: r.destination, successCondition: r.successCondition,
                failCondition: r.failCondition, obstacles: r.obstacles,
                relatedActors: r.actors.map(id => `${nameOf(id)}（目標：${state.actors.find(a => a.id === id)?.objective || '未知'}）`),
            }, null, 2)}\n重算原因：${flagLabel(t.flag)}${t.reason ? `｜${t.reason}` : ''}`;
        }).join('\n\n')],
        ['已發生的節點（最近）', recentNodes.length ? recentNodes.map(n => `- ${n.id}（#${n.floor}，${n.type}）${n.summary}`).join('\n') : '（無）'],
        ['任務', '請重新評估上面的路線，只輸出 JSON。'],
    ]);

    task.setStep(`路線重算（${routes.length} 條）`);
    const res = await callLLM({ system: getPromptTemplate('recalcRoutes'), user, purpose: '路線重算', signal: task.signal });
    task.assertSameChat();
    let parsed;
    try {
        parsed = parseJsonObject(res.text);
    } catch (e) {
        res.logEntry.error = `解析失敗：${e.message}`;
        throw new Error(`路線重算的回覆無法解析：${e.message}`);
    }
    const v = validateRecalcOutput(parsed, ids);
    if (!v.ok) {
        res.logEntry.error = `驗證失敗：${v.errors.join('；')}`;
        throw new Error(`路線重算的回覆格式不符：${v.errors.join('；')}`);
    }
    return v.value.map(rc => {
        const t = targets.find(x => x.routeId === rc.routeId);
        const before = routes.find(r => r.id === rc.routeId);
        return { ...rc, flag: t.flag, flagReason: t.reason, routeName: before.name, statusBefore: before.status };
    });
}
