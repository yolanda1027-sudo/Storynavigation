// 故事導航 — 提議新的支線／推手
//
// 兩種觸發方式：
// - 手動要求：按按鈕，結果自成一份待確認（kind: 'propose'）
// - 自動提議：推進時，若距離上次提議已累積 N 則 AI 回覆，就順便提議，放進推進結果裡
// 受支線／推手數量上限限制；每一項都要使用者勾選才會加入。

import { ROUTE_STATUSES, coerce, ctx, getSettings, getState, initState, commit, setTransient, normalizeRoute, normalizeActor, makeId } from './state.js';
import { callLLM, parseJsonObject, runTask } from './llm.js';
import { readSources } from './reader.js';
import { getPromptTemplate, fillTemplate, sections } from './prompts.js';

const { str, strList } = coerce;

/** 還能新增幾條支線、幾個推手 */
export function getProposalSlots(state) {
    const s = getSettings();
    const liveSides = state.routes.filter(r => r.type === 'side' && (r.status === 'active' || r.status === 'dormant')).length;
    return {
        sideSlots: Math.max(0, (Number(s.maxSideRoutes) || 0) - liveSides),
        actorSlots: Math.max(0, (Number(s.maxActors) || 0) - state.actors.length),
    };
}

/** 上次提議之後，主聊天出現了幾則 AI 回覆 */
export function aiRepliesSinceProposal(state) {
    const chat = ctx().chat || [];
    let n = 0;
    for (let i = (Number(state.lastProposeFloor) || 0) + 1; i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) n++;
    }
    return n;
}

/** 這次推進要不要順便提議 */
export function isAutoProposalDue(state) {
    const p = getSettings().proposal;
    if (!p?.auto) return false;
    const slots = getProposalSlots(state);
    if (!slots.sideSlots && !slots.actorSlots) return false;
    return aiRepliesSinceProposal(state) >= Math.max(1, Number(p.every) || 15);
}

export function validateProposalOutput(obj, state, slots) {
    const warnings = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['不是 JSON 物件'], warnings, value: null };
    let rawRoutes = (Array.isArray(obj.routes) ? obj.routes : []).filter(r => r && typeof r === 'object' && str(r.name).trim());
    let rawActors = (Array.isArray(obj.actors) ? obj.actors : []).filter(a => a && typeof a === 'object' && str(a.name).trim());

    // 和現有的同名就不要
    const existingRouteNames = new Set(state.routes.map(r => r.name.trim()));
    const existingActorNames = new Set(state.actors.map(a => a.name.trim()));
    const dupRoutes = rawRoutes.filter(r => existingRouteNames.has(str(r.name).trim()));
    const dupActors = rawActors.filter(a => existingActorNames.has(str(a.name).trim()));
    if (dupRoutes.length || dupActors.length) warnings.push(`已略過和現有重複的：${[...dupRoutes, ...dupActors].map(x => x.name).join('、')}`);
    rawRoutes = rawRoutes.filter(r => !dupRoutes.includes(r));
    rawActors = rawActors.filter(a => !dupActors.includes(a));

    if (rawRoutes.length > slots.sideSlots) warnings.push(`支線超過可新增的 ${slots.sideSlots} 條，多出的已捨棄`);
    if (rawActors.length > slots.actorSlots) warnings.push(`推手超過可新增的 ${slots.actorSlots} 個，多出的已捨棄`);
    rawRoutes = rawRoutes.slice(0, slots.sideSlots);
    rawActors = rawActors.slice(0, slots.actorSlots);

    const routeIds = rawRoutes.map(() => makeId('route'));
    const actorIds = rawActors.map(() => makeId('actor'));
    const routeKey = new Map();
    const actorKey = new Map();
    rawRoutes.forEach((r, i) => { const k = str(r.key) || `r${i + 1}`; if (!routeKey.has(k)) routeKey.set(k, routeIds[i]); });
    rawActors.forEach((a, i) => { const k = str(a.key) || `a${i + 1}`; if (!actorKey.has(k)) actorKey.set(k, actorIds[i]); });
    // 可以引用新的 key，也可以引用既有的 id
    const resolve = (list, keyMap, existing) => [...new Set(strList(list)
        .map(k => keyMap.get(k) || (existing.some(x => x.id === k) ? k : null))
        .filter(Boolean))];

    const routes = rawRoutes.map((r, i) => normalizeRoute({
        id: routeIds[i],
        name: str(r.name),
        type: 'side',
        conflict: str(r.conflict),
        stage: str(r.stage),
        situation: str(r.situation),
        destination: str(r.destination),
        successCondition: str(r.successCondition),
        failCondition: str(r.failCondition),
        obstacles: strList(r.obstacles),
        status: ROUTE_STATUSES.includes(r.status) ? r.status : 'active',
        actors: resolve(r.actorKeys ?? r.actors, actorKey, state.actors),
    }));
    const actors = rawActors.map((a, i) => normalizeActor({
        id: actorIds[i],
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
        relatedRoutes: resolve(a.routeKeys ?? a.relatedRoutes, routeKey, state.routes),
        active: true,
    }));
    return { ok: true, errors: [], warnings, value: { reason: str(obj.reason), routes, actors } };
}

/**
 * 呼叫 AI 提議。沒有名額時回傳 null（不呼叫 AI）。
 */
export async function proposeThreads(task, state) {
    const slots = getProposalSlots(state);
    if (!slots.sideSlots && !slots.actorSlots) return null;

    const src = await readSources({
        purpose: 'detect',
        fromFloor: (Number(state.lastProposeFloor) || 0) + 1,
        extraKeywords: [...state.routes.map(r => r.name), ...state.actors.map(a => a.name)],
    });
    task.assertSameChat();
    const routeList = state.routes.map(r => `${r.id}：${r.name || '（未命名）'}（${r.type === 'main' ? '主線' : '支線'}，${r.status}）衝突：${r.conflict || '未知'}｜目的地：${r.destination || '未知'}`).join('\n');
    const actorList = state.actors.map(a => `${a.id}：${a.name || '（未命名）'}｜身分：${a.identity || '未知'}｜目標：${a.objective || '未知'}`).join('\n');
    const nodes = state.nodes.filter(n => n.confirmed).slice(-15).map(n => `- #${n.floor}（${n.type}）${n.summary}`).join('\n');

    const system = fillTemplate(getPromptTemplate('proposeThreads'), slots);
    const user = sections([
        ['現有路線', routeList || '（無）'],
        ['現有推手', actorList || '（無）'],
        ['玩家角色', `${src.persona.name}（由真人扮演，不可列為推手）`],
        ['最近的劇情節點', nodes || '（無）'],
        ['相關世界書條目', src.loreText],
        ['上次提議之後的聊天', src.messagesText || '（沒有新訊息）'],
        ['任務', '請判斷是否需要新增支線或推手，只輸出 JSON。'],
    ]);

    task.setStep('提議新支線／推手');
    const res = await callLLM({ system, user, purpose: '提議新支線／推手', signal: task.signal });
    task.assertSameChat();
    let parsed;
    try {
        parsed = parseJsonObject(res.text);
    } catch (e) {
        res.logEntry.error = `解析失敗：${e.message}`;
        throw new Error(`提議的回覆無法解析：${e.message}`);
    }
    const v = validateProposalOutput(parsed, state, slots);
    if (!v.ok) {
        res.logEntry.error = `驗證失敗：${v.errors.join('；')}`;
        throw new Error(`提議的回覆格式不符：${v.errors.join('；')}`);
    }
    return { ...v.value, warnings: v.warnings, atFloor: src.lastFloor, report: src.report };
}

/** 手動要求提議：結果自成一份待確認 */
export function requestProposals() {
    return runTask('提議新支線／推手', async (task) => {
        const state = getState();
        if (!state) throw new Error('此聊天尚未建立導航');
        const snapshot = JSON.parse(JSON.stringify(state));
        const result = await proposeThreads(task, snapshot);
        if (!result) throw new Error('支線和推手都已達上限，沒有名額可以提議（可以在「推進控制」調高上限）');
        task.assertSameChat();
        // AI 認為不需要新增：不產生待確認結果
        if (!result.routes.length && !result.actors.length) return { ...result, empty: true };
        await setTransient('pending', {
            kind: 'propose',
            createdAt: Date.now(),
            atFloor: result.atFloor,
            warnings: result.warnings,
            report: result.report,
            data: { reason: result.reason, routes: result.routes, actors: result.actors },
        }, task.chatId);
        return result;
    });
}

/**
 * 把勾選的提議加進草稿（推進套用與手動提議套用共用）。
 * 會雙向補齊與既有路線、推手的關聯。
 */
export function addProposalsToDraft(draft, data, atFloor) {
    const routes = (data?.routes || []).filter(r => !r._skip).map(({ _skip, ...r }) => normalizeRoute(r));
    const actors = (data?.actors || []).filter(a => !a._skip).map(({ _skip, ...a }) => normalizeActor(a));
    const routeIds = new Set([...draft.routes.map(r => r.id), ...routes.map(r => r.id)]);
    const actorIds = new Set([...draft.actors.map(a => a.id), ...actors.map(a => a.id)]);
    routes.forEach(r => { r.actors = r.actors.filter(id => actorIds.has(id)); });
    actors.forEach(a => { a.relatedRoutes = a.relatedRoutes.filter(id => routeIds.has(id)); });
    draft.routes.push(...routes.filter(r => !draft.routes.some(x => x.id === r.id)));
    draft.actors.push(...actors.filter(a => !draft.actors.some(x => x.id === a.id)));
    for (const r of draft.routes) {
        for (const aid of r.actors) {
            const a = draft.actors.find(x => x.id === aid);
            if (a && !a.relatedRoutes.includes(r.id)) a.relatedRoutes.push(r.id);
        }
    }
    for (const a of draft.actors) {
        for (const rid of a.relatedRoutes) {
            const r = draft.routes.find(x => x.id === rid);
            if (r && !r.actors.includes(a.id)) r.actors.push(a.id);
        }
    }
    draft.lastProposeFloor = Math.max(Number(draft.lastProposeFloor) || 0, Number(atFloor) || 0);
    return { routes: routes.length, actors: actors.length };
}

export async function applyProposePending(pending, expectedChatId) {
    if (!getState()) await initState();
    await commit('加入 AI 提議的支線／推手', (draft) => {
        addProposalsToDraft(draft, pending.data, pending.atFloor);
    }, { expectedChatId });
}
