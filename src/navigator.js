// 故事導航 — M2 劇情導航器：建立導航（結果先進 pending，確認後才寫入）

import {
    ROUTE_STATUSES, coerce, getSettings, getState, initState, commit, setTransient,
    normalizeRoute, normalizeActor, makeId,
} from './state.js';
import { callLLM, parseJsonObject, runTask } from './llm.js';
import { readSources } from './reader.js';
import { getPromptTemplate, fillTemplate, sections } from './prompts.js';

const { str, strList, oneOf } = coerce;

/**
 * 驗證並轉換 AI 的建立導航輸出。
 * @returns {{ok: boolean, errors: string[], warnings: string[], value: object|null}}
 */
export function validateBuildOutput(obj) {
    const errors = [];
    const warnings = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['不是 JSON 物件'], warnings, value: null };
    if (!Array.isArray(obj.routes) || !obj.routes.length) errors.push('routes 必須是非空陣列');
    if (!Array.isArray(obj.actors)) errors.push('actors 必須是陣列');
    if (errors.length) return { ok: false, errors, warnings, value: null };

    const settings = getSettings();
    const maxSide = Math.max(0, Number(settings.maxSideRoutes) || 0);
    const maxActors = Math.max(1, Number(settings.maxActors) || 1);

    const rawRoutes = obj.routes.filter(r => r && typeof r === 'object');
    const rawActors = obj.actors.filter(a => a && typeof a === 'object');

    // 主線只留一條；沒有主線就把第一條當主線
    let mainIndex = rawRoutes.findIndex(r => r.type === 'main');
    if (mainIndex < 0) {
        mainIndex = 0;
        warnings.push('AI 沒有標出主線，已把第一條路線當作主線');
    }
    const ordered = [rawRoutes[mainIndex], ...rawRoutes.filter((_, i) => i !== mainIndex)];
    const sides = ordered.slice(1);
    if (sides.length > maxSide) warnings.push(`支線超過上限 ${maxSide} 條，多出的 ${sides.length - maxSide} 條已捨棄`);
    const keptRoutes = [ordered[0], ...sides.slice(0, maxSide)];
    if (rawActors.length > maxActors) warnings.push(`推手超過上限 ${maxActors} 個，多出的 ${rawActors.length - maxActors} 個已捨棄`);
    const keptActors = rawActors.slice(0, maxActors);
    if (!keptActors.length) warnings.push('AI 沒有提出任何推手，可以之後手動新增');

    // AI 用的暫時 key → 正式 id
    // 每一項都先拿到自己的正式 id；key 重複時只有第一個能被引用
    const routeIdList = keptRoutes.map(() => makeId('route'));
    const actorIdList = keptActors.map(() => makeId('actor'));
    const routeIds = new Map();
    const actorIds = new Map();
    keptRoutes.forEach((r, i) => { const k = str(r.key) || `r${i + 1}`; if (!routeIds.has(k)) routeIds.set(k, routeIdList[i]); });
    keptActors.forEach((a, i) => { const k = str(a.key) || `a${i + 1}`; if (!actorIds.has(k)) actorIds.set(k, actorIdList[i]); });
    const mapKeys = (list, map) => [...new Set(strList(list).map(k => map.get(k)).filter(Boolean))];

    const routes = keptRoutes.map((r, i) => normalizeRoute({
        id: routeIdList[i],
        name: str(r.name),
        type: i === 0 ? 'main' : 'side',
        conflict: str(r.conflict),
        stage: str(r.stage),
        situation: str(r.situation),
        destination: str(r.destination),
        successCondition: str(r.successCondition),
        failCondition: str(r.failCondition),
        obstacles: strList(r.obstacles),
        status: oneOf(r.status, ROUTE_STATUSES, 'active'),
        actors: mapKeys(r.actorKeys ?? r.actors, actorIds),
    }));
    const actors = keptActors.map((a, i) => normalizeActor({
        id: actorIdList[i],
        name: str(a.name),
        identity: str(a.identity),
        objective: str(a.objective),
        motive: str(a.motive),
        resources: strList(a.resources),
        constraints: strList(a.constraints),
        currentPlan: str(a.currentPlan),
        currentStep: str(a.currentStep),
        obstacles: strList(a.obstacles),
        knowledge: strList(a.knowledge),
        progress: str(a.progress),
        relatedRoutes: mapKeys(a.routeKeys ?? a.relatedRoutes, routeIds),
        active: true,
    }));

    // 雙向補齊路線↔推手關聯
    for (const r of routes) {
        for (const aid of r.actors) {
            const a = actors.find(x => x.id === aid);
            if (a && !a.relatedRoutes.includes(r.id)) a.relatedRoutes.push(r.id);
        }
    }
    for (const a of actors) {
        for (const rid of a.relatedRoutes) {
            const r = routes.find(x => x.id === rid);
            if (r && !r.actors.includes(a.id)) r.actors.push(a.id);
        }
    }

    return { ok: true, errors, warnings, value: { worldTime: str(obj.worldTime), routes, actors } };
}

/** 呼叫 AI 建立導航，結果放進 pending */
export function buildNavigation() {
    return runTask('建立導航', async (task) => {
        task.setStep('讀取角色卡、世界書與聊天');
        const settings = getSettings();
        const src = await readSources({ purpose: 'build' });
        task.assertSameChat();

        const system = fillTemplate(getPromptTemplate('buildNavigation'), {
            maxSideRoutes: settings.maxSideRoutes,
            maxActors: settings.maxActors,
        });
        const user = sections([
            ['玩家角色（由真人扮演）', src.personaText || `名字：${src.persona.name}（沒有人設描述）`],
            ['角色卡', src.cardText],
            ['世界書（依關鍵字挑選的相關條目）', src.loreText],
            ['近期聊天', src.messagesText],
            ['任務', '請依上面的資料建立劇情導航，只輸出 JSON。'],
        ]);

        task.setStep('等待 AI 回覆');
        const res = await callLLM({ system, user, purpose: '建立導航', signal: task.signal });
        task.assertSameChat();

        let parsed;
        try {
            parsed = parseJsonObject(res.text);
        } catch (e) {
            res.logEntry.error = `解析失敗：${e.message}`;
            throw new Error(`AI 回覆無法解析：${e.message}`);
        }
        const v = validateBuildOutput(parsed);
        if (!v.ok) {
            res.logEntry.error = `驗證失敗：${v.errors.join('；')}`;
            throw new Error(`AI 回覆格式不符：${v.errors.join('；')}`);
        }

        if (!getState()) await initState('開始建立導航（AI 結果待確認）');
        task.assertSameChat();
        await setTransient('pending', {
            kind: 'build',
            createdAt: Date.now(),
            atFloor: src.lastFloor,
            warnings: v.warnings,
            report: src.report,
            data: v.value,
        }, task.chatId);
        return v;
    });
}

/** 套用 pending 中的建立導航結果 */
export async function applyBuild(pending, expectedChatId) {
    const data = pending.data;
    await commit('套用 AI 建立的導航', (draft) => {
        draft.routes = data.routes.map(normalizeRoute);
        draft.actors = data.actors.map(normalizeActor);
        if (data.worldTime && data.worldTime !== '未知') {
            draft.worldTime = { label: data.worldTime, source: 'ai' };
        }
        draft.lastPushFloor = Math.max(draft.lastPushFloor || 0, Number(pending.atFloor) || 0);
        // 建立導航本身就整理過一次路線與推手，提議的間隔也從這裡開始算
        draft.lastProposeFloor = Math.max(draft.lastProposeFloor || 0, Number(pending.atFloor) || 0);
    }, { expectedChatId });
}
