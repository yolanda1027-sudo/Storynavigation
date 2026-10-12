// 故事導航 Story Navigator — 入口
// 註冊事件、掛 UI。所有酒館功能一律透過 SillyTavern.getContext() 取用。

import { getSettings } from './src/state.js';
import { mountPanel, render, logDebug } from './src/ui/panel.js';

async function init() {
    const ctx = SillyTavern.getContext();
    getSettings(); // 補齊全域設定預設值

    await mountPanel();

    const { eventSource, eventTypes } = ctx;
    const types = eventTypes || ctx.event_types;

    // 切換聊天：只重新載入此聊天的資料，不自動呼叫任何 API
    if (types?.CHAT_CHANGED) {
        eventSource.on(types.CHAT_CHANGED, () => render());
    }
    // 聊天被刪除時畫面可能還停在舊資料
    for (const name of ['CHAT_DELETED', 'GROUP_CHAT_DELETED']) {
        if (types?.[name]) eventSource.on(types[name], () => render());
    }

    logDebug('info', '故事導航已載入（Phase 1）');
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
