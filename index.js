// 故事導航 Story Navigator — 入口
// 註冊事件、掛 UI。所有酒館功能一律透過 SillyTavern.getContext() 取用。

import { getSettings, getState, getChatId, patchSilently } from './src/state.js';
import { mountPanel, render, logDebug } from './src/ui/panel.js';
import { updateInjection } from './src/injector.js';

/**
 * 主聊天收到 AI 回覆：在這則回覆之前就已套用、還沒標記的事件，這次生成都有被注入（淡出期至少 1 則），
 * 標記為 injected；接著重新計算淡出。
 */
async function onMessageReceived() {
    const state = getState();
    const inj = getSettings().injection;
    if (state?.enabled && inj.enabled) {
        const replyIndex = (SillyTavern.getContext().chat?.length ?? 0) - 1;
        const ids = new Set(state.events
            .filter(e => !e.injected && e.worldEffect.trim() && e.injectFrom <= replyIndex)
            .map(e => e.id));
        if (ids.size) {
            await patchSilently((s) => {
                s.events.forEach(e => { if (ids.has(e.id)) e.injected = true; });
            }, getChatId());
        }
    }
    updateInjection();
}

async function init() {
    const ctx = SillyTavern.getContext();
    getSettings(); // 補齊全域設定預設值

    await mountPanel();

    const { eventSource } = ctx;
    const types = ctx.eventTypes || ctx.event_types || {};
    const on = (name, fn) => {
        if (types[name]) eventSource.on(types[name], fn);
    };

    // 切換聊天：只重新載入此聊天的資料與注入內容，不自動呼叫任何 API
    on('CHAT_CHANGED', () => {
        updateInjection();
        render();
    });
    on('CHAT_DELETED', () => render());
    on('GROUP_CHAT_DELETED', () => render());

    // 注入淡出以 AI 回覆數計算
    on('MESSAGE_RECEIVED', () => onMessageReceived().catch(e => logDebug('error', '更新注入失敗', e.message)));
    on('MESSAGE_DELETED', () => updateInjection());
    on('MESSAGE_SWIPED', () => updateInjection());

    updateInjection();
    logDebug('info', '故事導航已載入（Phase 2）');
}

// 第三方擴充以 ES module 載入，jQuery ready 時 DOM 已就緒
jQuery(async () => {
    try {
        await init();
    } catch (e) {
        console.error('[故事導航] 初始化失敗', e);
        globalThis.toastr?.error(`初始化失敗：${e.message}`, '故事導航');
    }
});
