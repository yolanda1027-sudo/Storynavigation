// 故事導航 — M6 主線交會器（注入）
//
// 只注入事件的 worldEffect（可察覺的後果），絕不注入 truth。
// 措辭是「背景事實」，不是給主模型的劇情指令。
// 每則事件從套用後開始注入，經過 N 則 AI 回覆後淡出。

import { ctx, getSettings, getState } from './state.js';

export const INJECT_KEY = 'story_navigator';

let lastText = '';

export function getLastInjection() {
    return lastText;
}

/** 從 injectFrom 樓層之後，主聊天出現了幾則 AI 回覆 */
function aiRepliesSince(floor) {
    const chat = ctx().chat || [];
    let n = 0;
    for (let i = Math.max(0, floor); i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) n++;
    }
    return n;
}

/** 目前應該注入的事件 */
export function getActiveInjectionEvents(state = getState()) {
    if (!state || !state.enabled) return [];
    const fade = Math.max(1, Number(getSettings().injection.fadeTurns) || 3);
    return state.events.filter(e => e.worldEffect.trim() && aiRepliesSince(e.injectFrom) < fade);
}

/** 組出注入文字（純程式組裝） */
export function composeInjection(events) {
    if (!events.length) return '';
    const offstage = getSettings().injection.cardHasEngine;
    const header = offstage
        ? '[場外動態——以下是發生在目前場景之外的事，僅供參考的背景，不需要在本回合提及，也不要據此推動劇情]'
        : '[幕後世界動態——僅供參考的背景，不需要強行在本回合提及]';
    return [header, ...events.map(e => `- ${e.worldEffect.trim().replace(/\s*\n\s*/g, ' ')}`)].join('\n');
}

/**
 * 重新計算並設定注入內容。聊天切換、套用結果、收到新回覆、設定變更時呼叫。
 * 若有事件第一次被注入，會回傳它們的 id（呼叫端可標記 injected）。
 */
export function updateInjection() {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return [];
    const inj = getSettings().injection;
    const state = getState();
    const events = inj.enabled ? getActiveInjectionEvents(state) : [];
    lastText = composeInjection(events);
    // setExtensionPrompt(key, value, position, depth, scan, role)
    c.setExtensionPrompt(INJECT_KEY, lastText, Number(inj.position), Number(inj.depth), false, Number(inj.role));
    return events.filter(e => !e.injected).map(e => e.id);
}

/** 清除注入（例如切到沒有導航的聊天） */
export function clearInjection() {
    lastText = '';
    ctx().setExtensionPrompt?.(INJECT_KEY, '', 1, 0, false, 0);
}
