// 故事導航 — 待確認結果（pending）：套用／編輯後套用／捨棄
// 生成失敗或驗證失敗時根本不會進到 pending，因此既有資料不會被覆蓋。

import { getChatId, getState, setTransient, coerce, normalizeRoute, normalizeActor, normalizeNode, normalizeEvent } from './state.js';
import { applyBuild } from './navigator.js';
import { applyAdvance } from './actors.js';
import { applyProposePending } from './propose.js';

export function getPending() {
    return getState()?.pending ?? null;
}

export async function discardPending() {
    if (!getState()) return;
    await setTransient('pending', null);
}

/** 套用 pending；成功後清空 pending */
export async function applyPending(pending = getPending()) {
    if (!pending) throw new Error('沒有待確認的結果');
    const chatId = getChatId();
    if (pending.kind === 'build') await applyBuild(pending, chatId);
    else if (pending.kind === 'advance') await applyAdvance(pending, chatId);
    else if (pending.kind === 'propose') await applyProposePending(pending, chatId);
    else throw new Error(`未知的結果類型：${pending.kind}`);
    await setTransient('pending', null, chatId);
}

/**
 * 驗證使用者手動編輯過的 pending JSON。
 * 只檢查結構與型別，並把各項目正規化（缺欄位會補上預設值）。
 */
export function validateEditedPending(json, original) {
    let obj;
    try {
        obj = JSON.parse(json);
    } catch (e) {
        return { ok: false, errors: [`JSON 格式錯誤：${e.message}`] };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['必須是 JSON 物件'] };
    if (obj.kind !== original.kind) return { ok: false, errors: ['不能修改 kind'] };
    const errors = [];
    if (obj.kind === 'propose') {
        if (!obj.data || !Array.isArray(obj.data.routes) || !Array.isArray(obj.data.actors)) return { ok: false, errors: ['data.routes 與 data.actors 必須是陣列'] };
        obj.data.routes = obj.data.routes.map(normalizeRoute);
        obj.data.actors = obj.data.actors.map(normalizeActor);
    } else if (obj.kind === 'build') {
        if (!obj.data || !Array.isArray(obj.data.routes) || !Array.isArray(obj.data.actors)) errors.push('data.routes 與 data.actors 必須是陣列');
        if (errors.length) return { ok: false, errors };
        obj.data.routes = obj.data.routes.map(normalizeRoute);
        obj.data.actors = obj.data.actors.map(normalizeActor);
        obj.data.worldTime = coerce.str(obj.data.worldTime);
    } else {
        for (const key of ['nodes', 'actorResults', 'revealedEvents']) {
            if (obj[key] !== undefined && !Array.isArray(obj[key])) errors.push(`${key} 必須是陣列`);
        }
        if (errors.length) return { ok: false, errors };
        obj.nodes = (obj.nodes || []).map(normalizeNode);
        obj.revealedEvents = coerce.strList(obj.revealedEvents);
        obj.routeRecalcs = (Array.isArray(obj.routeRecalcs) ? obj.routeRecalcs : []).filter(r => r && typeof r === 'object');
        obj.routeFlags = (Array.isArray(obj.routeFlags) ? obj.routeFlags : []).filter(r => r && typeof r === 'object');
        if (obj.proposals) {
            obj.proposals.routes = (obj.proposals.routes || []).map(normalizeRoute);
            obj.proposals.actors = (obj.proposals.actors || []).map(normalizeActor);
        }
        obj.actorResults = (obj.actorResults || []).filter(r => r && typeof r === 'object').map(r => ({
            ...r,
            updates: r.updates && typeof r.updates === 'object' ? r.updates : {},
            knowledgeAdd: coerce.strList(r.knowledgeAdd),
            event: r.event ? normalizeEvent(r.event) : null,
            routeUpdates: Array.isArray(r.routeUpdates) ? r.routeUpdates : [],
        }));
    }
    // 保留原本不可編輯的欄位
    obj.createdAt = original.createdAt;
    obj.atFloor = original.atFloor;
    obj.fromFloor = original.fromFloor;
    obj.report = original.report;
    return { ok: true, errors: [], value: obj };
}
