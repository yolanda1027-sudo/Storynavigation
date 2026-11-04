// 故事導航 — 注入檢查器
//
// 主聊天每次真的要生成時，在送出前「只讀取」最終的提示詞，逐一檢查每個擴充的注入（故事導航、人物檔案館、柏宝书…）
// 有沒有在裡面，並記下它們插在哪個位置。不呼叫 AI、不修改提示詞。
// 故事導航或人物檔案館「有內容卻沒送出」時跳出提醒；看得出規律時（例如插在聊天中的全部不見）會給出判斷。

import { ctx, getChatId } from './state.js';
import { INJECT_KEY } from './injector.js';
import { toast, logDebug } from './ui/common.js';

const ARCHIVE_KEY = 'char_archive_inject';
// 已知的注入來源，顯示時用好懂的名字
const NAMES = {
    [INJECT_KEY]: '故事導航',
    [ARCHIVE_KEY]: '人物檔案館',
    baibai_book_memory_history: '柏宝书（歷史摘要）',
    baibai_book_memory_state: '柏宝书（目前狀態）',
    baibai_book_time_tag: '柏宝书（時間標籤）',
    '1_memory': '酒館摘要',
    '2_floating_prompt': '作者備註',
    '3_vectors': '向量記憶',
};
export const POSITION_LABEL = { 0: '主提示詞之後', 1: '聊天中', 2: '主提示詞之前' };

let armed = null;
let last = null;
const warnedChats = new Set();
let onUpdate = () => {};

/**
 * 最近一次檢查結果（目前聊天）。
 * { time, items: [{ key, name, position, depth, status: 'ok'|'missing' }], ours, archive, diagnosis }
 * ours／archive：'ok'|'missing'|'empty'|'none'
 */
export function getLastInjectionCheck() {
    return last && last.chatId === getChatId() ? last : null;
}

/**
 * 從注入內容挑幾段拿來比對：去掉巨集（{{char}} 之類會被替換）與行首行尾的符號，
 * 取中間一小段，避免第一行被預設或正則改動時誤判。
 */
function markers(text) {
    const lines = String(text || '').split('\n')
        .map(l => l.replace(/\{\{[^}]*\}\}/g, '').trim())
        .filter(l => l.length >= 8);
    if (!lines.length) return [];
    const pick = lines.length <= 3 ? lines : [lines[0], lines[Math.floor(lines.length / 2)], lines[lines.length - 1]];
    return pick.map(l => {
        const start = Math.min(2, Math.max(0, l.length - 12));
        return l.slice(start, start + 12);
    });
}

async function judgeAll(haystack) {
    const prompts = ctx().extensionPrompts || {};
    const items = [];
    for (const [key, p] of Object.entries(prompts)) {
        if (!p || Number(p.position) === -1) continue;              // NONE：本來就不注入
        if (!String(p.value ?? '').trim()) continue;                 // 沒有內容
        if (typeof p.filter === 'function') {                        // 有條件、這次條件不成立：本來就不會放進去
            try { if (!await p.filter()) continue; } catch { continue; }
        }
        const ms = markers(p.value);
        if (!ms.length) continue;
        items.push({
            key,
            name: NAMES[key] || (key.startsWith('baibai_book') ? `柏宝书（${key}）` : key),
            position: Number(p.position),
            depth: Number(p.depth),
            status: ms.some(m => haystack.includes(m)) ? 'ok' : 'missing',
        });
    }
    return items;
}

function diagnose(items) {
    const missing = items.filter(i => i.status === 'missing');
    if (!missing.length) return '';
    const inChat = items.filter(i => i.position === 1);
    const notInChat = items.filter(i => i.position !== 1);
    if (inChat.length && inChat.every(i => i.status === 'missing') && notInChat.some(i => i.status === 'ok')) {
        return 'in-chat';      // 插在聊天中的全部不見，其他位置的正常
    }
    if (items.every(i => i.status === 'missing')) return 'all';     // 所有擴充的注入都不見
    return 'some';
}

async function check(haystack) {
    const items = await judgeAll(haystack);
    const status = (key, installed) => {
        const it = items.find(i => i.key === key);
        if (it) return it.status;
        return installed ? 'empty' : 'none';
    };
    const prompts = ctx().extensionPrompts || {};
    last = {
        time: new Date(),
        chatId: getChatId(),
        items,
        ours: status(INJECT_KEY, true),
        archive: status(ARCHIVE_KEY, ARCHIVE_KEY in prompts),
        diagnosis: diagnose(items),
    };
    if (last.ours === 'missing' || last.archive === 'missing') {
        const who = [last.ours === 'missing' ? '故事導航' : '', last.archive === 'missing' ? '人物檔案館' : ''].filter(Boolean).join('、');
        logDebug('error', `注入檢查：${who}的注入有內容，但沒有出現在這次送給 AI 的提示詞裡`,
            items.map(i => `${i.name}（${POSITION_LABEL[i.position] ?? i.position}${i.position === 1 ? `・深度 ${i.depth}` : ''}）：${i.status === 'ok' ? '有' : '沒有'}`).join('\n'));
        if (!warnedChats.has(last.chatId)) {
            warnedChats.add(last.chatId);
            const tip = {
                'in-chat': '看起來是插在「聊天中」的注入全部被擠掉了，可以把故事導航的「位置」改成「主提示詞之後」試試。',
                all: '所有擴充的注入都不見，可能有擴充或預設把整份提示詞重新組過。',
            }[last.diagnosis] || '';
            toast('warning', `${who}的注入有內容，但這次送給 AI 的提示詞裡找不到。${tip}詳情在「設定與資料 → 注入設定」。`, { title: '注入檢查', timeOut: 20000 });
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
    const fn = async (data, dryRun) => {
        if (!armed || dryRun) return;
        armed = null;
        try {
            await check(promptText(data));
        } catch (e) {
            logDebug('error', '注入檢查失敗', e.message);
        }
    };
    if (!types.GENERATE_AFTER_DATA) return;
    if (typeof c.eventSource.makeLast === 'function') c.eventSource.makeLast(types.GENERATE_AFTER_DATA, fn);
    else c.eventSource.on(types.GENERATE_AFTER_DATA, fn);
}
