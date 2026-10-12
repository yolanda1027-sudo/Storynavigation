// 故事導航 — 樓層變動提示（只提示，不自動回溯）
//
// 每個由 AI 偵測的節點都記下來源訊息的 swipe 編號與內容指紋。
// 訊息被刪除、修改、換 swipe 後，對應節點就會被列出來，讓使用者決定：
//   - 回到記錄這些節點之前的快照
//   - 只刪除這些節點（並讓下次推進重新讀那幾樓）
//   - 忽略（以目前的訊息為準）

import { ctx, getState, getChatId, commit, jumpTo, patchSilently, hashText } from './state.js';

const REASON = { deleted: '訊息已刪除', edited: '訊息內容被修改', swiped: '換了另一個 swipe' };

export function reasonLabel(reason) {
    return REASON[reason] || reason;
}

/**
 * 找出來源訊息變了的節點。
 * @returns {{nodes: {id: string, floor: number, summary: string, reason: string}[], pushBeyondEnd: boolean, lastFloor: number}}
 */
export function getFloorAlerts(state = getState()) {
    const empty = { nodes: [], pushBeyondEnd: false, lastFloor: -1 };
    if (!state) return empty;
    const chat = ctx().chat || [];
    const lastFloor = chat.length - 1;
    const nodes = [];
    for (const n of state.nodes) {
        if (!n.sourceHash || n.sourceHash === 'gone') continue;
        const m = chat[n.floor];
        let reason = '';
        if (!m) reason = 'deleted';
        else if (Number(m.swipe_id ?? 0) !== n.swipeId) reason = 'swiped';
        else if (hashText(m.mes) !== n.sourceHash) reason = 'edited';
        if (reason) nodes.push({ id: n.id, floor: n.floor, summary: n.summary, reason });
    }
    // 聊天被刪到比上次推進的位置還短：下次推進會漏讀新訊息
    const pushBeyondEnd = Number(state.lastPushFloor) > lastFloor && state.lastPushFloor > 0;
    return { nodes, pushBeyondEnd, lastFloor };
}

export function hasFloorAlerts(state = getState()) {
    const a = getFloorAlerts(state);
    return a.nodes.length > 0 || a.pushBeyondEnd;
}

/** 回溯：跳到「還沒有這些節點」的最近一份快照（可以用重做回來） */
export async function restoreBeforeNodes() {
    const state = getState();
    const { nodes } = getFloorAlerts(state);
    if (!state || !nodes.length) return { ok: false, message: '沒有需要回溯的節點' };
    const ids = new Set(nodes.map(n => n.id));
    for (let i = state.historyIndex; i >= 0; i--) {
        const data = state.history[i]?.data;
        if (data && !(data.nodes || []).some(n => ids.has(n.id))) {
            if (i === state.historyIndex) break;
            await jumpTo(i);
            return { ok: true, message: `已回到「${state.history[i].label}」之後的狀態（可以用「重做」回來）` };
        }
    }
    return { ok: false, message: '找不到記錄這些節點之前的快照（可能超過保留份數），可以改用「只刪除這些節點」' };
}

/** 只刪除受影響的節點；上次推進位置退回到最早變動的樓層之前，下次推進會重新讀那幾樓 */
export async function dropAffectedNodes() {
    const state = getState();
    const { nodes, lastFloor } = getFloorAlerts(state);
    const ids = new Set(nodes.map(n => n.id));
    const minFloor = nodes.length ? Math.min(...nodes.map(n => n.floor)) : Infinity;
    await commit(`刪除 ${nodes.length} 個來源訊息已變動的節點`, (draft) => {
        draft.nodes = draft.nodes.filter(n => !ids.has(n.id));
        draft.lastPushFloor = Math.max(0, Math.min(Number(draft.lastPushFloor) || 0, minFloor - 1, lastFloor));
    });
}

/** 忽略：以目前的訊息為準，不再提示這些節點 */
export async function acknowledgeAlerts() {
    const chatId = getChatId();
    const chat = ctx().chat || [];
    await patchSilently((s) => {
        for (const n of s.nodes) {
            if (!n.sourceHash || n.sourceHash === 'gone') continue;
            const m = chat[n.floor];
            if (!m) {
                n.sourceHash = 'gone';
            } else {
                n.swipeId = Number(m.swipe_id ?? 0);
                n.sourceHash = hashText(m.mes);
            }
        }
        if (Number(s.lastPushFloor) > chat.length - 1) s.lastPushFloor = Math.max(0, chat.length - 1);
    }, chatId);
}
