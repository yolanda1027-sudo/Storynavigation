// 故事導航 Story Navigator — 入口
// 註冊事件、掛 UI。所有酒館功能一律透過 SillyTavern.getContext() 取用。

import { getSettings, getState, getChatId, patchSilently } from './src/state.js';
import { mountPanel, render, softRender, logDebug } from './src/ui/panel.js';
import { updateInjection } from './src/injector.js';
import { shouldAutoAdvance } from './src/auto.js';
import { runAutoAdvance } from './src/ui/ai.js';
import { startSaveWatch } from './src/savewatch.js';
import { startInjectionCheck } from './src/injectcheck.js';
import { startChatGuard } from './src/chatguard.js';
import { pulseBusyFab } from './src/ui/panel.js';

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
    softRender();
    // 自動模式：累積到 N 則 AI 回覆就推進（稍等一下，讓酒館先存好這則訊息）
    if (shouldAutoAdvance()) {
        setTimeout(() => {
            if (shouldAutoAdvance()) runAutoAdvance();
        }, 800);
    }
}

/** 訊息被刪除／修改／換 swipe：更新注入，並讓樓層變動提示出現（不自動回溯） */
function onMessageChanged() {
    updateInjection();
    softRender();
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
    on('MESSAGE_DELETED', onMessageChanged);
    on('MESSAGE_SWIPED', onMessageChanged);
    on('MESSAGE_EDITED', onMessageChanged);
    on('MESSAGE_UPDATED', onMessageChanged);

    updateInjection();
    // 推進中暫停送出：推進劇情進行中擋下送出與生成，避免劇情割裂
    startChatGuard(() => pulseBusyFab());
    // 注入檢查：主聊天生成前只讀取最終提示詞，確認注入有沒有真的送出
    startInjectionCheck(() => softRender());
    // 存檔卡住警報：只讀取酒館的存檔狀態；讀不到就停用，不影響其他功能
    startSaveWatch().then(ok => logDebug('info', ok ? '存檔卡住警報已啟動' : '存檔卡住警報無法啟動（讀不到酒館的存檔狀態）'))
        .catch(e => logDebug('error', '存檔卡住警報啟動失敗', e.message));
    logDebug('info', '故事導航已載入');
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
