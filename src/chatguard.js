// 故事導航 — 推進中暫停送出
//
// 推進要花一點時間，期間如果繼續聊，推進結果會和後面的劇情對不上。
// 開啟「推進中暫停送出」時（預設開），擋的是「往下聊」：
// - 按送出鍵、會送出的 Enter、Ctrl+Enter：在送出前就擋下，輸入框裡的字保留
// - 繼續、代寫、其他路徑送出的新訊息：用酒館的生成攔截（generate_interceptor）擋下
// 不擋重新生成和 swipe：酒館在生成攔截之前就會先刪掉要重新生成的那則回覆，這時擋下會把回覆弄丟；
// 而改寫最新回覆本來就有「樓層變動提示」會處理。
// 只在「推進劇情」進行中才擋；其他擴充的背景生成（quiet）不擋。

import { ctx, getSettings } from './state.js';
import { getCurrentTask } from './llm.js';
import { toast } from './ui/common.js';

const ADVANCE_TASK = '推進劇情';
let onBlocked = () => {};
let lastToast = 0;

/** 目前是否正在推進劇情 */
export function isAdvancing() {
    return getCurrentTask()?.name === ADVANCE_TASK;
}

function shouldBlock() {
    return getSettings().blockChatWhileAdvancing !== false && isAdvancing();
}

function warn() {
    const now = Date.now();
    if (now - lastToast > 3000) {
        lastToast = now;
        const step = getCurrentTask()?.step;
        toast('warning', `故事導航正在推進${step ? `（${step}）` : ''}，完成後再繼續聊天，推進結果才不會和後面的劇情對不上。不想等的話可以按畫面角落的「取消」。`, { title: '推進中，先等一下', timeOut: 8000 });
    }
    onBlocked();
}

/** 照酒館自己的規則判斷：這個 Enter 會不會送出訊息 */
function enterWouldSend(ev) {
    if (ev.key !== 'Enter' || ev.isComposing || ev.shiftKey || ev.altKey) return false;
    if (ev.ctrlKey || ev.metaKey) return true;   // Ctrl+Enter 是酒館的生成快捷鍵
    const c = ctx();
    const mode = Number(c.powerUserSettings?.send_on_enter ?? 0);   // -1 關、0 自動、1 開
    if (mode === -1) return false;
    if (mode === 1) return true;
    return !(typeof c.isMobile === 'function' && c.isMobile());
}

/** 把被酒館清掉的輸入框內容放回去（已經變成一則訊息送出的就不放，避免重複） */
function restoreTextarea(text) {
    const box = document.getElementById('send_textarea');
    if (!box || !text || box.value) return;
    const last = (ctx().chat || []).at(-1);
    if (last?.is_user && last.mes === text) return;
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
}

export function startChatGuard(onBlockedCb = () => {}) {
    onBlocked = onBlockedCb;
    // 捕獲階段：比酒館自己的處理更早，在訊息送出前就擋下
    window.addEventListener('click', (ev) => {
        if (!shouldBlock()) return;
        if (ev.target?.closest?.('#send_but')) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            warn();
        }
    }, true);
    window.addEventListener('keydown', (ev) => {
        if (!shouldBlock()) return;
        if (ev.target?.id === 'send_textarea' && enterWouldSend(ev)) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            warn();
        }
    }, true);
    // 酒館開始生成時會先清空輸入框，生成攔截在那之後才跑；先把輸入框的字記下來，被擋下時放回去
    let stash = null;
    const c = ctx();
    const types = c.eventTypes || c.event_types || {};
    if (types.GENERATION_STARTED) {
        c.eventSource.on(types.GENERATION_STARTED, (type, _opts, dryRun) => {
            stash = (!dryRun && type !== 'quiet' && shouldBlock()) ? (document.getElementById('send_textarea')?.value ?? null) : null;
        });
    }
    // 其他會往下聊的生成（繼續、代寫、其他路徑送出的新訊息）：用酒館的生成攔截擋下
    const BLOCK_TYPES = [undefined, 'normal', 'continue', 'impersonate'];
    globalThis.storyNavigatorInterceptor = async (_chat, _contextSize, abort, type) => {
        if (!BLOCK_TYPES.includes(type) || !shouldBlock()) return;
        abort(true);
        restoreTextarea(stash);
        stash = null;
        warn();
    };
}
