// 故事導航 — M1 設定讀取器（不呼叫 AI）
//
// 讀取角色卡、世界書（角色內嵌／角色綁定、聊天綁定、使用者勾選的全域）、近期聊天，
// 依「輸入預算」裁切，並產生資料來源報告（送了哪些欄位、哪些條目、約多少 token）。

import { ctx, getSettings } from './state.js';
import { estimateTokens } from './llm.js';

const CHAT_LORE_KEY = 'world_info'; // world-info.js 的 METADATA_KEY（聊天綁定的世界書）

let lastReport = null;

export function getLastReport() {
    return lastReport;
}

// ───────────────────────── 角色卡 ─────────────────────────

/** 目前聊天的角色（群組聊天時為所有成員） */
async function getChatCharacters() {
    const c = ctx();
    const ids = [];
    if (c.groupId) {
        const group = c.groups?.find(g => g.id == c.groupId);
        for (const avatar of group?.members || []) {
            const idx = c.characters.findIndex(ch => ch.avatar === avatar);
            if (idx >= 0) ids.push(idx);
        }
    } else if (c.characterId !== undefined && c.characterId !== null) {
        ids.push(Number(c.characterId));
    }
    const result = [];
    for (const chid of ids) {
        // 酒館可能只載入角色的精簡版，需要完整資料時要先展開
        if (typeof c.unshallowCharacter === 'function') {
            try { await c.unshallowCharacter(chid); } catch { /* 忽略 */ }
        }
        const ch = c.characters[chid];
        if (!ch) continue;
        let fields = {};
        try {
            fields = typeof c.getCharacterCardFields === 'function' && !c.groupId
                ? c.getCharacterCardFields({ chid })
                : {};
        } catch { fields = {}; }
        result.push({
            chid,
            name: ch.name,
            description: fields.description ?? ch.description ?? ch.data?.description ?? '',
            personality: fields.personality ?? ch.personality ?? ch.data?.personality ?? '',
            scenario: fields.scenario ?? ch.scenario ?? ch.data?.scenario ?? '',
            mes_example: fields.mesExamples ?? ch.mes_example ?? ch.data?.mes_example ?? '',
            raw: ch,
        });
    }
    return result;
}

/** 玩家角色（User）的名字與人設 */
export function getPersona() {
    const c = ctx();
    let description = '';
    try {
        description = typeof c.getCharacterCardFields === 'function' ? (c.getCharacterCardFields().persona ?? '') : '';
    } catch { description = ''; }
    if (!description) description = c.powerUserSettings?.persona_description ?? '';
    return { name: c.name1 || '玩家', description: String(description).trim() };
}

// ───────────────────────── 世界書 ─────────────────────────

function entriesFromBook(book, bookName) {
    const entries = book?.entries ? Object.values(book.entries) : [];
    return entries
        .filter(e => e && !e.disable && String(e.content ?? '').trim())
        .map(e => ({
            book: bookName,
            uid: e.uid,
            title: e.comment || (Array.isArray(e.key) ? e.key.slice(0, 3).join('、') : '') || `#${e.uid}`,
            keys: [...(Array.isArray(e.key) ? e.key : []), ...(Array.isArray(e.keysecondary) ? e.keysecondary : [])]
                .map(k => String(k).trim()).filter(Boolean),
            constant: !!e.constant,
            content: String(e.content),
        }));
}

/** 回傳所有來源的世界書名稱與條目 */
async function collectLore(characters) {
    const c = ctx();
    const books = []; // { name, source, entries }
    const seen = new Set();

    const addByName = async (name, source) => {
        if (!name || seen.has(name)) return;
        seen.add(name);
        try {
            const data = await c.loadWorldInfo(name);
            if (data) books.push({ name, source, entries: entriesFromBook(data, name) });
        } catch (e) {
            console.warn('[故事導航] 讀取世界書失敗', name, e);
        }
    };

    for (const ch of characters) {
        // 角色綁定的世界書（匯入卡片時內嵌的 character_book 通常會被轉成這個）
        await addByName(ch.raw?.data?.extensions?.world, `角色「${ch.name}」綁定`);
        // 內嵌但尚未轉成獨立世界書的 character_book
        const embedded = ch.raw?.data?.character_book;
        const embeddedName = `${ch.name}（內嵌）`;
        if (embedded?.entries?.length && !ch.raw?.data?.extensions?.world && typeof c.convertCharacterBook === 'function') {
            try {
                books.push({ name: embeddedName, source: `角色「${ch.name}」內嵌`, entries: entriesFromBook(c.convertCharacterBook(embedded), embeddedName) });
            } catch (e) {
                console.warn('[故事導航] 轉換內嵌世界書失敗', e);
            }
        }
    }
    await addByName(c.chatMetadata?.[CHAT_LORE_KEY], '聊天綁定');
    for (const name of getSettings().globalLorebooks || []) {
        await addByName(name, '全域（設定中勾選）');
    }
    return books;
}

function keyMatches(key, haystack) {
    const regex = key.match(/^\/(.+)\/([a-z]*)$/i);
    if (regex) {
        try { return new RegExp(regex[1], regex[2]).test(haystack); } catch { return false; }
    }
    return haystack.toLowerCase().includes(key.toLowerCase());
}

/** 依關鍵字比對挑出相關條目：常駐條目優先，其次依命中數排序 */
function pickLore(books, haystack, budgetTokens) {
    const scored = [];
    for (const book of books) {
        for (const e of book.entries) {
            const titleHit = e.title && e.title.length >= 2 && haystack.toLowerCase().includes(e.title.toLowerCase()) ? 1 : 0;
            const hits = e.keys.filter(k => keyMatches(k, haystack)).length + titleHit;
            if (e.constant || hits > 0) scored.push({ ...e, hits, tokens: estimateTokens(e.content) });
        }
    }
    scored.sort((a, b) => (Number(b.constant) - Number(a.constant)) || (b.hits - a.hits));
    const picked = [];
    const skipped = [];
    let used = 0;
    for (const e of scored) {
        if (used + e.tokens <= budgetTokens) {
            picked.push(e);
            used += e.tokens;
        } else {
            skipped.push(e);
        }
    }
    const totalEntries = books.reduce((n, b) => n + b.entries.length, 0);
    return { picked, skipped, used, totalEntries, unmatched: totalEntries - scored.length };
}

// ───────────────────────── 聊天 ─────────────────────────

/** 讀取聊天訊息（包含被隱藏的樓層）。from/to 為樓層編號（含）。 */
export function readMessages({ from = 0, to = null, limit = 20 } = {}) {
    const chat = ctx().chat || [];
    const end = to === null ? chat.length - 1 : Math.min(to, chat.length - 1);
    const start = Math.max(from, end - limit + 1, 0);
    const out = [];
    for (let i = start; i <= end; i++) {
        const m = chat[i];
        if (!m) continue;
        out.push({
            floor: i,
            swipeId: Number(m.swipe_id ?? 0),
            name: m.name || (m.is_user ? '玩家' : '角色'),
            isUser: !!m.is_user,
            hidden: !!m.is_system,
            text: String(m.mes ?? ''),
        });
    }
    return out;
}

function formatMessages(messages) {
    return messages.map(m => `#${m.floor}${m.hidden ? '（隱藏）' : ''} ${m.name}：${m.text}`).join('\n\n');
}

/** 截斷時保留開頭與結尾（狀態欄、時間通常在訊息最後），只刪中間 */
function truncate(text, maxTokens) {
    const s = String(text ?? '');
    const total = estimateTokens(s);
    if (total <= maxTokens) return s;
    const keep = Math.max(0, Math.floor(s.length * (maxTokens / total)) - 12);
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    return `${s.slice(0, head)}…（中略）…${tail > 0 ? s.slice(s.length - tail) : ''}`;
}

/** 建立導航用：從最新往回取，直到用完預算 */
function fitRecent(messages, budgetTokens) {
    const kept = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const t = estimateTokens(messages[i].text) + 8;
        if (used + t > budgetTokens && kept.length) break;
        const m = used + t > budgetTokens ? { ...messages[i], text: truncate(messages[i].text, budgetTokens - used - 8) } : messages[i];
        kept.unshift(m);
        used += estimateTokens(m.text) + 8;
    }
    return { kept, used, coveredTo: null };
}

const MIN_PER_MESSAGE = 150;

/**
 * 偵測節點用：新訊息一則都不能漏。
 * 放得下就全放；放不下就平均裁短每一則（保留頭尾）；
 * 連這樣都太擠，就只讀前面一段，回傳 coveredTo（下次推進從這裡接著讀）。
 */
function fitAll(messages, budgetTokens) {
    const cost = (m) => estimateTokens(m.text) + 8;
    const total = messages.reduce((n, m) => n + cost(m), 0);
    if (total <= budgetTokens) return { kept: messages, used: total, coveredTo: null };

    const fair = Math.floor(budgetTokens / messages.length) - 8;
    if (fair >= MIN_PER_MESSAGE) {
        // 短的訊息原樣保留，省下來的額度分給長的
        const sorted = [...messages].sort((a, b) => cost(a) - cost(b));
        let remaining = budgetTokens;
        let left = messages.length;
        const limit = new Map();
        for (const m of sorted) {
            const share = Math.floor(remaining / left) - 8;
            const t = Math.min(estimateTokens(m.text), share);
            limit.set(m, t);
            remaining -= t + 8;
            left--;
        }
        const kept = messages.map(m => (estimateTokens(m.text) > limit.get(m) ? { ...m, text: truncate(m.text, limit.get(m)), trimmed: true } : m));
        return { kept, used: kept.reduce((n, m) => n + cost(m), 0), coveredTo: null };
    }

    // 太擠：從最舊的開始讀，每則最多 600 token，讀到預算用完為止
    const kept = [];
    let used = 0;
    for (const m of messages) {
        const t = truncate(m.text, 600);
        const c = estimateTokens(t) + 8;
        if (used + c > budgetTokens && kept.length) break;
        kept.push(t === m.text ? m : { ...m, text: t, trimmed: true });
        used += c;
    }
    return { kept, used, coveredTo: kept[kept.length - 1].floor };
}

/**
 * 從訊息原文找出時間線索（日期、時刻、星期、第幾天、狀態欄的時間欄位…），每則最多 3 條。
 * 在裁短之前就先抓，避免狀態欄被截掉。
 */
const TIME_PATTERNS = [
    /\d{3,4}\s*[年\/.\-]\s*\d{1,2}\s*[月\/.\-]\s*\d{1,2}/,
    /\d{1,2}\s*月\s*\d{1,2}\s*[日號号]/,
    /(?:^|[^\d])\d{1,2}\s*[:：]\s*\d{2}(?!\d)/,
    /(?:星期|週|周|禮拜|礼拜)[一二三四五六日天]/,
    /第\s*[一二三四五六七八九十百千\d]+\s*[天日]/,
    /(?:時間|时间|日期|Time|Date)\s*[:：]/i,
    /(?:清晨|早上|上午|中午|下午|傍晚|黃昏|黄昏|晚上|深夜|午夜|凌晨|隔天|翌日|次日|[一兩两三四五六七八九十\d]+\s*(?:天|日|週|周|個月|个月|年)後)/,
];

export function extractTimeCues(text) {
    const plain = String(text ?? '')
        .replace(/<(?:br|\/p|\/div|\/li|\/tr)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    const cues = [];
    for (const raw of plain.split(/\n+/)) {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line || !TIME_PATTERNS.some(re => re.test(line))) continue;
        const clipped = line.length > 80 ? `${line.slice(0, 80)}…` : line;
        if (!cues.includes(clipped)) cues.push(clipped);
    }
    // 優先留下最後幾條（狀態欄、柏宝书時間標籤通常在後面）
    return cues.slice(-3);
}

// ───────────────────────── 對外：組裝素材 ─────────────────────────

/**
 * 讀取素材並依預算裁切。
 * @param {object} opt
 * @param {'build'|'detect'} opt.purpose
 * @param {number} [opt.fromFloor] 只讀這個樓層之後的訊息（推進時用）
 * @param {string[]} [opt.extraKeywords] 額外的比對文字（路線名、推手名等）
 * @param {number} [opt.reserveTokens] 預留給 prompt 本身與其他資料的 token
 */
export async function readSources({ purpose, fromFloor = 0, extraKeywords = [], reserveTokens = 1500 } = {}) {
    const settings = getSettings();
    // 預留給 prompt 本身的空間；預算設很小時至少留 500 給素材
    const budget = Math.max(500, (Number(settings.inputBudget) || 8000) - reserveTokens);
    const limit = Math.max(1, Number(settings.recentMessages) || 20);

    const report = { purpose, time: new Date(), budget: budget + reserveTokens, items: [], lore: [], skippedLore: [], notes: [] };

    // 1) 聊天：建立導航時讀最近 N 則；偵測節點時讀上次推進後的新訊息（最多 N 則）
    const allMessages = readMessages({ from: fromFloor, limit });
    allMessages.forEach(m => { m.timeCues = extractTimeCues(m.text); });
    const chatBudget = Math.floor(budget * (purpose === 'detect' ? 0.7 : 0.3));
    const { kept: messages, used: chatTokens, coveredTo } = purpose === 'detect'
        ? fitAll(allMessages, chatBudget)
        : fitRecent(allMessages, chatBudget);
    if (purpose !== 'detect' && messages.length < allMessages.length) report.notes.push(`聊天只放得下最近 ${messages.length} 則（共 ${allMessages.length} 則）`);
    const trimmedCount = messages.filter(m => m.trimmed).length;
    if (trimmedCount) report.notes.push(`有 ${trimmedCount} 則訊息太長，已裁短（保留開頭與結尾）`);
    if (coveredTo !== null) report.notes.push(`新訊息太多，這次只讀到 #${coveredTo}，剩下的下次推進會接著讀`);
    report.items.push({ kind: '聊天', label: messages.length ? `#${messages[0].floor}～#${messages[messages.length - 1].floor}（${messages.length} 則）` : '（沒有訊息）', tokens: chatTokens });

    // 2) 角色卡與玩家人設：建立導航時才送（推進時推手只看自己的資料）
    let cardText = '';
    let personaText = '';
    const persona = getPersona();
    const characters = await getChatCharacters();
    if (purpose === 'build') {
        if (persona.description) {
            const p = truncate(persona.description, Math.floor(budget * 0.08));
            personaText = `【${persona.name}】\n${p}`;
            report.items.push({ kind: '玩家人設', label: `${persona.name}${p !== persona.description ? '（已截斷）' : ''}`, tokens: estimateTokens(p) });
        } else {
            report.notes.push(`玩家「${persona.name}」沒有填寫人設描述`);
        }
        const cardBudget = Math.floor(budget * 0.3);
        const fieldNames = { description: '描述', personality: '個性', scenario: '情境', mes_example: '對話範例' };
        const perChar = Math.floor(cardBudget / Math.max(1, characters.length));
        const parts = [];
        for (const ch of characters) {
            const fieldBudget = { description: 0.55, personality: 0.15, scenario: 0.2, mes_example: 0.1 };
            const lines = [`【${ch.name}】`];
            for (const [key, label] of Object.entries(fieldNames)) {
                const value = String(ch[key] || '').trim();
                if (!value) continue;
                const v = truncate(value, Math.floor(perChar * fieldBudget[key]));
                lines.push(`${label}：${v}`);
                report.items.push({ kind: '角色卡', label: `${ch.name}．${label}${v !== value ? '（已截斷）' : ''}`, tokens: estimateTokens(v) });
            }
            parts.push(lines.join('\n'));
        }
        cardText = parts.join('\n\n');
    }

    // 3) 世界書：用卡片＋聊天＋額外關鍵字比對
    const books = await collectLore(characters);
    const haystack = [cardText, personaText, formatMessages(messages), ...extraKeywords].join('\n');
    const usedSoFar = chatTokens + estimateTokens(cardText) + estimateTokens(personaText);
    const loreBudget = Math.max(0, budget - usedSoFar);
    const lore = pickLore(books, haystack, loreBudget);
    report.lore = lore.picked.map(e => ({ book: e.book, title: e.title, tokens: e.tokens, constant: e.constant, hits: e.hits }));
    report.skippedLore = lore.skipped.map(e => ({ book: e.book, title: e.title, tokens: e.tokens }));
    report.items.push({ kind: '世界書', label: `${lore.picked.length} 條（共 ${lore.totalEntries} 條，${lore.unmatched} 條未命中關鍵字${lore.skipped.length ? `，${lore.skipped.length} 條超出預算` : ''}）`, tokens: lore.used });
    report.books = books.map(b => ({ name: b.name, source: b.source, count: b.entries.length }));
    if (!books.length) report.notes.push('沒有找到任何世界書');

    const loreText = lore.picked.map(e => `【${e.title}】${e.constant ? '（常駐）' : ''}\n${e.content}`).join('\n\n');
    report.totalTokens = report.items.reduce((n, i) => n + i.tokens, 0);

    lastReport = report;
    return {
        characterNames: characters.map(c => c.name),
        persona,
        personaText,
        cardText,
        loreText,
        messages,
        messagesText: formatMessages(messages),
        lastFloor: (ctx().chat || []).length - 1,
        // 偵測時若訊息太多只讀到一部分，這裡是實際讀到的最後一樓
        coveredTo,
        report,
    };
}

/** 記錄一份額外的報告（例如推手推進時各自送出的資料） */
export function setLastReport(report) {
    lastReport = report;
}
