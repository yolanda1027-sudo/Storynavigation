// 故事導航 — 酒館存檔卡住警報
//
// 酒館存檔時會上一把鎖（isChatSaving）。如果某次存檔請求一直沒有回應（例如手機關螢幕、切到別的 App 時連線被凍結），
// 這把鎖會一直卡住，之後的存檔都會默默放棄，畫面上卻看不出來。
// 這裡只「讀取」那把鎖的狀態，不做任何修改；卡住太久就跳出警告，提醒先備份再重新整理。

import { getSettings } from './state.js';
import { toast } from './ui/common.js';
import { downloadCurrentChat } from './chatbackup.js';

let stModule = null;
let stuckMs = 0;
let lastTick = 0;
let snoozeUntil = 0;
let warnEl = null;
let warned = false;      // 這次卡住有沒有警告過（收起來也算），恢復時要通知

/** 取得酒館主程式的模組：用頁面上實際載入的那個網址，確保是同一份、不會重新執行 */
async function loadStModule() {
    const tag = document.querySelector('script[type="module"][src$="script.js"]');
    if (!tag?.src) return null;
    const mod = await import(tag.src);
    // 再確認一次是正在執行的那一份（聊天陣列是同一個）
    if (!('isChatSaving' in mod) || mod.chat !== SillyTavern.getContext().chat) return null;
    return mod;
}

export async function startSaveWatch() {
    try {
        stModule = await loadStModule();
    } catch (e) {
        console.warn('[故事導航] 無法讀取酒館的存檔狀態，存檔卡住警報停用', e);
        return false;
    }
    if (!stModule) {
        console.warn('[故事導航] 找不到酒館的存檔狀態，存檔卡住警報停用');
        return false;
    }
    lastTick = performance.now();
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => { lastTick = performance.now(); });
    return true;
}

function tick() {
    const now = performance.now();
    // 計時器在背景會被放慢，單次最多算 2 秒，避免回到前景時一口氣跳很多
    const dt = Math.min(2000, now - lastTick);
    lastTick = now;
    const s = getSettings();
    if (s.saveWatchdog === false || !stModule.isChatSaving) {
        if (warnEl) warnEl.hidden = true;
        if (warned && !stModule.isChatSaving) toast('success', '酒館的存檔恢復正常了');
        warned = false;
        stuckMs = 0;
        return;
    }
    // 頁面在背景（關螢幕、切 App）時不計時：回到前景後存檔通常會自己完成
    if (document.visibilityState !== 'visible') return;
    stuckMs += dt;
    const limitMs = Math.max(5, Number(s.saveWatchdogSec) || 20) * 1000;
    if (stuckMs >= limitMs && Date.now() >= snoozeUntil) showWarning(Math.round(stuckMs / 1000));
}

function showWarning(seconds) {
    warned = true;
    if (!warnEl) {
        warnEl = document.createElement('div');
        warnEl.className = 'story-nav-save-warning';
        warnEl.setAttribute('role', 'alert');
        warnEl.innerHTML = `
            <div class="story-nav-save-warning-title"><i class="fa-solid fa-triangle-exclamation"></i> 酒館的存檔卡住了<span class="story-nav-save-warning-sec"></span></div>
            <div>最近的聊天可能還沒存到伺服器，<b>現在重新整理頁面會遺失</b>。</div>
            <div>請先按下面的按鈕備份，<b>確認手機的「下載」資料夾裡有這個檔案</b>，再重新整理頁面。</div>
            <div class="story-nav-row story-nav-wrap">
                <button type="button" class="menu_button story-nav-btn story-nav-save-warning-download" data-save-warning-download><i class="fa-solid fa-download"></i><span>立刻下載目前聊天（備份）</span></button>
                <button type="button" class="menu_button story-nav-btn" data-save-warning-snooze>我知道了（5 分鐘內不再跳出）</button>
            </div>
            <div class="story-nav-save-warning-done" hidden></div>
            <div class="story-nav-hint">下載的是畫面上這一份（包含還沒存到伺服器的訊息），重新整理後可以用酒館的「匯入聊天」匯回去。
                這個警告來自「故事導航」：它只讀取酒館的存檔狀態，不會修改任何東西。存檔恢復後會自動消失。</div>`;
        warnEl.querySelector('[data-save-warning-download]').addEventListener('click', () => {
            const done = warnEl.querySelector('.story-nav-save-warning-done');
            try {
                const r = downloadCurrentChat();
                done.textContent = `✓ 已下載「${r.fileName}」（${r.count} 則訊息）。請到手機的「下載」資料夾確認檔案在不在。`;
            } catch (e) {
                done.textContent = `✗ 下載失敗：${e.message}。請改用電子書匯出，或手動複製最近幾則訊息。`;
            }
            done.hidden = false;
        });
        warnEl.querySelector('[data-save-warning-snooze]').addEventListener('click', () => {
            snoozeUntil = Date.now() + 5 * 60 * 1000;
            warnEl.hidden = true;
        });
        document.body.appendChild(warnEl);
    }
    warnEl.querySelector('.story-nav-save-warning-sec').textContent = `（已經 ${seconds} 秒）`;
    if (warnEl.hidden) warnEl.querySelector('.story-nav-save-warning-done').hidden = true;
    warnEl.hidden = false;
}
