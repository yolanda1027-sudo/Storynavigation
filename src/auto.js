// 故事導航 — 自動推進（每 N 則 AI 回覆推進一次）
//
// - 只有模式為「自動」時才會觸發
// - 有待確認的結果還沒處理時不觸發（避免蓋掉）
// - 失敗不會一直重試：要再累積 N 則 AI 回覆才會再試

import { ctx, getChatId, getSettings, getState, isAiReply } from './state.js';
import { getCurrentTask } from './llm.js';

// 每個聊天上次自動推進失敗時的 AI 回覆數（只存在記憶體）
const failedAt = new Map();

/** 上次推進讀到的那一樓之後，主聊天出現了幾則 AI 回覆（被隱藏的也算） */
export function aiRepliesSincePush(state = getState()) {
    if (!state) return 0;
    const chat = ctx().chat || [];
    let n = 0;
    for (let i = (Number(state.lastPushFloor) || 0) + 1; i < chat.length; i++) {
        if (isAiReply(chat[i])) n++;
    }
    return n;
}

/**
 * 自動推進的狀態，給介面顯示用。
 * @returns {{active: boolean, count: number, every: number, remaining: number, blocked: string}}
 */
export function getAutoStatus(state = getState()) {
    const every = Math.max(1, Number(getSettings().autoFrequency) || 5);
    const active = !!state && state.enabled && state.mode === 'auto';
    const count = aiRepliesSincePush(state);
    let blocked = '';
    if (active) {
        if (!state.routes.length) blocked = '還沒有建立導航';
        else if (state.pending && !getSettings().autoApply) blocked = '有待確認的結果還沒處理';
        else if (failedAt.has(getChatId()) && count < failedAt.get(getChatId()) + every) {
            blocked = `上次自動推進失敗，再 ${failedAt.get(getChatId()) + every - count} 則 AI 回覆後會再試`;
        }
    }
    return { active, count, every, remaining: Math.max(0, every - count), blocked };
}

export function shouldAutoAdvance() {
    if (getCurrentTask()) return false;
    const s = getAutoStatus();
    return s.active && !s.blocked && s.count >= s.every;
}

export function markAutoFailed() {
    failedAt.set(getChatId(), aiRepliesSincePush());
}

export function clearAutoFailed() {
    failedAt.delete(getChatId());
}
