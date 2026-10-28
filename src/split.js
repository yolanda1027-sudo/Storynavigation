// 故事導航 — 把被合成一個推手的多人拆開
//
// 流程：使用者在推手卡片按「拆開」→ 填要拆成哪些人（可留空讓 AI 判斷）→ AI 分配各自的資料 →
// 預覽確認 → 用新推手取代原推手，並把路線、節點、事件、同場名單裡的引用一起換掉（可復原）。
// AI 只看得到這個推手自己的資料、相關路線與他名下的事件，不會讀聊天原文。

import { coerce, getState, commit, normalizeActor, makeId } from './state.js';
import { callLLM, parseJsonObject, runTask } from './llm.js';
import { getPersona } from './reader.js';
import { getPromptTemplate, sections } from './prompts.js';

const { str, strList } = coerce;

const MAX_EVENTS = 20;

/** 從推手名稱猜可能是哪幾個人，例如「河俊赫與姜宥燦」→ ['河俊赫', '姜宥燦'] */
export function guessNames(name) {
    const parts = str(name)
        .split(/\s*(?:、|，|,|&|＆|\/|／|\+|＋|與|和|以及|及|跟)\s*/)
        .map(s => s.trim())
        .filter(Boolean);
    return parts.length >= 2 ? [...new Set(parts)] : [];
}

/** 解析使用者輸入的名單：一行一個，也接受頓號、逗號分隔 */
export function parseNames(text) {
    return [...new Set(str(text)
        .split(/[\n、，,]+/)
        .map(s => s.trim())
        .filter(Boolean))];
}

export function validateSplitOutput(obj, actor, events, names) {
    const warnings = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['不是 JSON 物件'], warnings, value: null };
    const raw = (Array.isArray(obj.actors) ? obj.actors : []).filter(a => a && typeof a === 'object' && str(a.name).trim());
    if (raw.length < 2) return { ok: false, errors: ['AI 沒有拆成兩個以上的推手'], warnings, value: null };
    if (names.length) {
        const got = new Set(raw.map(a => str(a.name).trim()));
        const missing = names.filter(n => !got.has(n));
        if (missing.length) warnings.push(`名單裡的「${missing.join('、')}」沒有出現在拆分結果中`);
    }

    const allowedRoutes = actor.relatedRoutes;
    const actors = raw.map(a => {
        let routes = strList(a.routeIds ?? a.relatedRoutes).filter(id => allowedRoutes.includes(id));
        if (!routes.length) routes = [...allowedRoutes];
        return normalizeActor({
            id: makeId('actor'),
            name: str(a.name).trim(),
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
            relatedRoutes: routes,
            active: actor.active,
        });
    });

    // 原本記在他名下的事件，改記到做這件事的人身上；沒指定就記給第一位
    const byName = new Map(actors.map(a => [a.name, a.id]));
    const eventOwners = {};
    for (const o of (Array.isArray(obj.eventOwners) ? obj.eventOwners : [])) {
        const evId = str(o?.eventId);
        const ownerId = byName.get(str(o?.name).trim());
        if (ownerId && events.some(e => e.id === evId)) eventOwners[evId] = ownerId;
    }
    const unassigned = events.filter(e => !eventOwners[e.id]);
    if (unassigned.length) warnings.push(`有 ${unassigned.length} 則過往事件沒有指定是誰做的，先記在「${actors[0].name}」名下`);
    unassigned.forEach(e => { eventOwners[e.id] = actors[0].id; });

    return { ok: true, errors: [], warnings, value: { reason: str(obj.reason), actors, eventOwners } };
}

/** 呼叫 AI 拆分；結果不寫入，交給介面預覽後再呼叫 applySplit */
export function requestSplit(actorId, names = []) {
    return runTask('拆開推手', async (task) => {
        const state = getState();
        if (!state) throw new Error('此聊天尚未建立導航');
        if (state.pending) throw new Error('有待確認的結果，請先套用或捨棄再拆開推手');
        const actor = state.actors.find(a => a.id === actorId);
        if (!actor) throw new Error('找不到這個推手');

        const routes = state.routes.filter(r => actor.relatedRoutes.includes(r.id));
        const events = state.events.filter(e => e.actorId === actor.id).slice(-MAX_EVENTS);
        const { id, active, ...data } = actor;

        const user = sections([
            ['要拆開的推手', JSON.stringify(data, null, 2)],
            ['相關路線', routes.length
                ? routes.map(r => `- ${r.id}：${r.name || '（未命名）'}（${r.type === 'main' ? '主線' : '支線'}）衝突：${r.conflict || '未知'}`).join('\n')
                : '（無）'],
            ['他名下的過往事件', events.length ? events.map(e => `- ${e.id}：${e.action}`).join('\n') : '（無）'],
            ['玩家角色', `${getPersona().name}（由真人扮演，不可成為推手）`],
            ['要拆成', names.length ? names.map(n => `- ${n}`).join('\n') : '（沒有指定，請依資料判斷是哪幾個人或勢力）'],
            ['任務', '請把這個推手拆成各自獨立的推手，只輸出 JSON。'],
        ]);

        task.setStep(`拆開推手「${actor.name}」`);
        const res = await callLLM({ system: getPromptTemplate('splitActor'), user, purpose: '拆開推手', signal: task.signal });
        task.assertSameChat();
        let parsed;
        try {
            parsed = parseJsonObject(res.text);
        } catch (e) {
            res.logEntry.error = `解析失敗：${e.message}`;
            throw new Error(`拆分的回覆無法解析：${e.message}`);
        }
        const v = validateSplitOutput(parsed, actor, events, names);
        if (!v.ok) {
            res.logEntry.error = `驗證失敗：${v.errors.join('；')}`;
            throw new Error(`拆分的回覆格式不符：${v.errors.join('；')}`);
        }
        return { ...v.value, warnings: v.warnings, originalId: actor.id, originalName: actor.name, chatId: task.chatId };
    });
}

const replaceId = (list, oldId, newIds) => [...new Set(list.flatMap(x => (x === oldId ? newIds : [x])))];

/** 用新推手取代原推手，並換掉所有引用 */
export async function applySplit(result) {
    await commit(`拆開推手「${result.originalName}」`, (draft) => {
        const idx = draft.actors.findIndex(a => a.id === result.originalId);
        if (idx < 0) throw new Error('原本的推手已經不在了（可能被刪除或復原），沒有套用');
        const newActors = result.actors.map(a => normalizeActor(a));
        const newIds = newActors.map(a => a.id);
        draft.actors.splice(idx, 1, ...newActors);

        // 路線：原推手換成「有掛這條路線」的新推手，並補齊雙向關聯
        for (const r of draft.routes) {
            const members = newActors.filter(a => a.relatedRoutes.includes(r.id)).map(a => a.id);
            r.actors = replaceId(r.actors, result.originalId, members);
            members.forEach(id => { if (!r.actors.includes(id)) r.actors.push(id); });
        }
        // 他知道的節點與事件，拆開後每個人都知道
        draft.nodes.forEach(n => { n.knownBy = replaceId(n.knownBy, result.originalId, newIds); });
        draft.events.forEach(e => {
            e.whoKnows = replaceId(e.whoKnows, result.originalId, newIds);
            if (e.actorId === result.originalId) {
                const owner = result.eventOwners[e.id] || newIds[0];
                e.actorId = owner;
                // 事件的執行者不需要再列在「誰知道」裡
                e.whoKnows = e.whoKnows.filter(x => x !== owner);
                newIds.filter(x => x !== owner).forEach(x => { if (!e.whoKnows.includes(x)) e.whoKnows.push(x); });
            }
        });
        if (draft.scene?.onStage) draft.scene.onStage = replaceId(draft.scene.onStage, result.originalId, newIds);
    }, { expectedChatId: result.chatId });
}
