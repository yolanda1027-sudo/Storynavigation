// 故事導航 — 注入檢查器
//
// 主聊天每次真的要生成時，在送出前「只讀取」最終的提示詞，記錄故事導航（以及人物檔案館）的注入有沒有在裡面。
// 不呼叫 AI、不修改提示詞。發現「有內容卻沒送出」時跳出提醒。

import { ctx, getChatId } from './state.js';
import { getLastInjection } from './injector.js';
import { toast, logDebug } from './ui/common.js';

const ARCHIVE_KEY = 'char_archive_inject';

let armed = null;
let last = null;
const warnedChats = new Set();
let onUpdate = () => {};

/** 最近一次檢查結果：{ time, ours: 'ok'|'missing'|'empty', archive: 'ok'|'missing'|'empty'|'none' } */
export function getLastInjectionCheck() {
    return last && last.chatId === getChatId() ? last : null;
}

const marker = (text) => String(text || '').trim().split('\n')[0].slice(0, 30);

function judge(expected, haystack) {
    const m = marker(expected);
    if (!m) return 'empty';
    return haystack.includes(m) ? 'ok' : 'missing';
}

function check(haystack) {
    const c = ctx();
    const archiveEntry = c.extensionPrompts?.[ARCHIVE_KEY];
    last = {
        time: new Date(),
        chatId: getChatId(),
        ours: judge(getLastInjection(), haystack),
        archive: archiveEntry === undefined ? 'none' : judge(archiveEntry.value, haystack),
    };
    if (last.ours === 'missing' || last.archive === 'missing') {
        const who = [last.ours === 'missing' ? '故事導航' : '', last.archive === 'missing' ? '人物檔案館' : ''].filter(Boolean).join('、');
        logDebug('error', `注入檢查：${who}的注入有內容，但沒有出現在這次送給 AI 的提示詞裡`);
        if (!warnedChats.has(last.chatId)) {
            warnedChats.add(last.chatId);
            toast('warning', `${who}的注入有內容，但這次送給 AI 的提示詞裡找不到。詳情在「設定與資料 → 注入設定」。`, { title: '注入檢查', timeOut: 15000 });
        }
    }
    onUpdate();
}

const textOf = (content) => (Array.isArray(content)
    ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n')
    : String(content ?? ''));

/** 從酒館組好的送出資料取出全部文字（Chat Completion 是訊息陣列，Text Completion 是字串） */
function promptText(data) {
    const p = data?.prompt;
    if (Array.isArray(p)) return p.map(m => textOf(m?.content)).join('\n');
    if (typeof p === 'string') return p;
    try { return JSON.stringify(data); } catch { return ''; }
}

export function startInjectionCheck(onChange = () => {}) {
    onUpdate = onChange;
    const c = ctx();
    const types = c.eventTypes || c.event_types || {};
    const on = (name, fn) => { if (types[name]) c.eventSource.on(types[name], fn); };
    // 主聊天真的要生成（不是試算、也不是背景的 quiet 生成）才檢查
    on('GENERATION_STARTED', (type, _opts, dryRun) => {
        armed = (dryRun || type === 'quiet') ? null : { time: Date.now() };
    });
    on('GENERATION_STOPPED', () => { armed = null; });
    // GENERATE_AFTER_DATA 只有主聊天生成才會發出（其他擴充用 generateRaw 的請求不會），
    // 而且是在所有提示詞處理完之後；排在最後讀，才看得到其他擴充改過的結果
    const fn = (data, dryRun) => {
        if (!armed || dryRun) return;
        armed = null;
        check(promptText(data));
    };
    if (!types.GENERATE_AFTER_DATA) return;
    if (typeof c.eventSource.makeLast === 'function') c.eventSource.makeLast(types.GENERATE_AFTER_DATA, fn);
    else c.eventSource.on(types.GENERATE_AFTER_DATA, fn);
}
