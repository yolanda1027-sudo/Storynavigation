// 故事導航 — M6 主線交會器（注入）
//
// 兩種模式（設定 injection.mode）：
// - world（世界運轉，預設）：把幕後世界的狀態交給主聊天的 AI——人物的目標、計畫、進度、最近行動（含真相）、
//   主要局勢與故事事實，並附上規則：真相不要無故說破、可以留蛛絲馬跡；幕後計畫只影響世界，不替玩家決定。
//   有 token 上限，超過時依重要性捨棄，不會越疊越多。
// - effects（只送後果）：只注入事件的「可察覺的後果」，每則經過 N 則 AI 回覆後淡出；絕不注入真相。

import { ctx, getSettings, getState, isAiReply } from './state.js';
import { estimateTokens } from './llm.js';

export const INJECT_KEY = 'story_navigator';

/** 世界運轉模式的開頭標記（注入檢查器用它在最終提示詞裡找） */
export const WORLD_HEADER = '[幕後世界・故事導航';

const RESULT = { success: '成功', fail: '失敗', delayed: '延後', complication: '引發新問題' };
const ROUTE_STATUS = { active: '進行中', dormant: '休眠' };

let lastText = '';
let lastTokens = 0;
let lastDropped = [];

export function getLastInjection() {
    return lastText;
}

/** 上次組出的注入：大約幾個 token、因為上限而沒放進去的內容 */
export function getLastInjectionInfo() {
    return { tokens: lastTokens, dropped: lastDropped };
}

/** 從 injectFrom 樓層之後，主聊天出現了幾則 AI 回覆 */
function aiRepliesSince(floor) {
    const chat = ctx().chat || [];
    let n = 0;
    for (let i = Math.max(0, floor); i < chat.length; i++) {
        if (isAiReply(chat[i])) n++;
    }
    return n;
}

const isActive = (state) => !!state && state.enabled && state.mode !== 'paused';
const oneLine = (s) => String(s ?? '').trim().replace(/\s*\n\s*/g, ' ');

/** 只送後果模式：目前應該注入的事件 */
export function getActiveInjectionEvents(state = getState()) {
    if (!isActive(state)) return [];
    const fade = Math.max(1, Number(getSettings().injection.fadeTurns) || 3);
    return state.events.filter(e => e.worldEffect.trim() && aiRepliesSince(e.injectFrom) < fade);
}

/** 只送後果模式的注入文字 */
export function composeInjection(events) {
    if (!events.length) return '';
    const offstage = getSettings().injection.cardHasEngine;
    const header = offstage
        ? '[場外動態——以下是發生在目前場景之外的事，僅供參考的背景，不需要在本回合提及，也不要據此推動劇情]'
        : '[幕後世界動態——僅供參考的背景，不需要強行在本回合提及]';
    return [header, ...events.map(e => `- ${oneLine(e.worldEffect)}`)].join('\n');
}

/** 一則事件寫成一行：行動、結果，真相（玩家還不知道時標明）與表面上看得到的後果 */
function eventLine(e, opt) {
    const parts = [`${oneLine(e.action) || '（無描述）'}（${RESULT[e.result] || '結果未知'}）`];
    if (opt.includeTruth && e.truth.trim()) {
        parts.push(e.playerKnows ? `真相：${oneLine(e.truth)}（玩家已知）` : `真相（玩家還不知道）：${oneLine(e.truth)}`);
    }
    if (e.worldEffect.trim()) parts.push(`表面上看得到的：${oneLine(e.worldEffect)}`);
    return parts.join('｜');
}

/**
 * 世界運轉模式：組出注入文字。依重要性放入，超過 token 上限的部分捨棄。
 * @returns {{text: string, tokens: number, dropped: string[]}}
 */
export function composeWorldInjection(state, inj = getSettings().injection) {
    if (!isActive(state)) return { text: '', tokens: 0, dropped: [] };
    const opt = {
        includeTruth: inj.includeTruth !== false,
        includePlans: inj.includePlans !== false,
        includeRoutes: inj.includeRoutes !== false,
        includeFacts: inj.includeFacts !== false,
        recentEvents: Math.max(0, Number(inj.recentEvents ?? 6)),
    };
    const budget = Math.max(300, Number(inj.budget) || 1500);
    const actors = state.actors.filter(a => a.active);
    const facts = opt.includeFacts ? (state.storyFacts || []).filter(f => String(f).trim()) : [];
    const routes = opt.includeRoutes ? state.routes.filter(r => r.status === 'active' || r.status === 'dormant') : [];
    const recent = opt.recentEvents ? state.events.slice(-opt.recentEvents) : [];
    if (!actors.length && !facts.length && !routes.length && !recent.length) return { text: '', tokens: 0, dropped: [] };

    const offstage = inj.cardHasEngine;
    const rules = [
        `${WORLD_HEADER}——寫給你的私密背景資料，玩家看不到]`,
        '以下是目前世界在幕後運轉的狀態。請依此維持人物動機與劇情連貫：',
        '- 這些人物會依自己的目標與計畫持續行動；寫到他們出場或間接影響時，言行要符合下面的狀態與進度，不要把已經完成的事寫成還在進行、也不要把已失敗的計畫寫成仍然順利。',
        opt.includeTruth ? '- 標記「玩家還不知道」的真相是秘密：不要無故說破，也不要讓人物突然全盤托出；可以透過細節、反常、傳聞、物證等蛛絲馬跡自然露出，讓玩家有機會察覺。' : '',
        '- 玩家角色的行動、想法與選擇由玩家決定；幕後計畫只能影響世界與其他人物，不能替玩家做決定，也不要強行把劇情推向某個結果。',
        offstage ? '- 這張卡本身有劇情引擎：這裡的內容是場景之外的事，只作為背景參考，不要據此改變卡片自己的劇情推進。' : '',
        '- 不需要每一回合都提到這些內容，只在合理時自然帶出；不要在正文裡複述或列出這份資料。',
    ].filter(Boolean).join('\n');

    // 依重要性排列的區塊；order 是輸出順序，priority 越小越先放
    const blocks = [];
    blocks.push({ order: 0, priority: 0, label: '規則', text: rules });
    if (state.worldTime?.label?.trim()) blocks.push({ order: 1, priority: 0, label: '世界時間', text: `【世界時間】${oneLine(state.worldTime.label)}` });

    const onStage = new Set(state.scene?.onStage || []);
    const lastEventIndex = (a) => {
        for (let i = state.events.length - 1; i >= 0; i--) if (state.events[i].actorId === a.id) return i;
        return -1;
    };
    // 同場的推手最優先，其次是最近有行動的
    const sorted = [...actors].sort((a, b) => (onStage.has(b.id) - onStage.has(a.id)) || (lastEventIndex(b) - lastEventIndex(a)));
    const recentIds = new Set(recent.map(e => e.id));
    sorted.forEach((a, i) => {
        const lines = [`◆ ${a.name || '（未命名）'}${a.identity ? `（${oneLine(a.identity)}）` : ''}${onStage.has(a.id) ? '［目前和玩家同場］' : ''}`];
        if (opt.includePlans) {
            if (a.objective) lines.push(`  目標：${oneLine(a.objective)}`);
            if (a.currentPlan) lines.push(`  目前計畫：${oneLine(a.currentPlan)}`);
            if (a.currentStep) lines.push(`  下一步：${oneLine(a.currentStep)}`);
            if (a.progress) lines.push(`  進度：${oneLine(a.progress)}`);
        }
        const mine = state.events.filter(e => e.actorId === a.id && recentIds.has(e.id)).slice(-2);
        mine.forEach(e => lines.push(`  最近行動：${eventLine(e, opt)}`));
        if (lines.length > 1) blocks.push({ order: 10 + i, priority: 1 + i * 0.01, label: `人物：${a.name}`, text: lines.join('\n'), group: 'actors' });
    });
    const others = recent.filter(e => !actors.some(a => a.id === e.actorId));
    if (others.length) blocks.push({ order: 60, priority: 3, label: '其他幕後事件', text: `【其他幕後事件】\n${others.map(e => `- ${eventLine(e, opt)}`).join('\n')}` });
    if (facts.length) {
        // 故事事實：新的在後；超過上限時從舊的開始捨棄
        facts.forEach((f, i) => blocks.push({ order: 2, sub: i, priority: 2 + (facts.length - i) * 0.001, label: `故事事實：${String(f).slice(0, 12)}`, text: `- ${oneLine(f)}`, group: 'facts' }));
    }
    if (routes.length) {
        routes.forEach((r, i) => blocks.push({
            order: 5, sub: i, priority: (r.type === 'main' ? 2.5 : 4) + i * 0.001, label: `局勢：${r.name}`, group: 'routes',
            text: `- ${r.name || '（未命名）'}（${r.type === 'main' ? '主線' : '支線'}・${ROUTE_STATUS[r.status] || r.status}）：${[r.stage, r.situation].map(oneLine).filter(Boolean).join('；') || '局勢未知'}`,
        }));
    }

    // 依優先度放入，直到上限
    const kept = [];
    const dropped = [];
    let used = 0;
    for (const b of [...blocks].sort((x, y) => x.priority - y.priority)) {
        const t = estimateTokens(b.text) + 2;
        if (b.priority === 0 || used + t <= budget) { kept.push(b); used += t; } else dropped.push(b.label);
    }
    kept.sort((x, y) => (x.order - y.order) || ((x.sub ?? 0) - (y.sub ?? 0)));
    const out = [];
    let lastGroup = '';
    for (const b of kept) {
        if (b.group !== lastGroup) {
            if (b.group === 'facts') out.push('【故事事實（優先於原著）】');
            if (b.group === 'routes') out.push('【主要局勢】');
            if (b.group === 'actors') out.push('【人物動向】');
            lastGroup = b.group;
        }
        out.push(b.text);
    }
    if (kept.filter(b => b.priority > 0).length === 0) return { text: '', tokens: 0, dropped };
    const text = out.join('\n');
    return { text, tokens: estimateTokens(text), dropped };
}

/**
 * 重新計算並設定注入內容。聊天切換、套用結果、收到新回覆、編輯資料、設定變更時呼叫。
 * 只送後果模式下，若有事件第一次被注入，會回傳它們的 id（呼叫端可標記 injected）。
 */
export function updateInjection() {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return [];
    const inj = getSettings().injection;
    const state = getState();
    let ids = [];
    if (!inj.enabled) {
        lastText = '';
        lastTokens = 0;
        lastDropped = [];
    } else if (inj.mode === 'effects') {
        const events = getActiveInjectionEvents(state);
        lastText = composeInjection(events);
        lastTokens = estimateTokens(lastText);
        lastDropped = [];
        ids = events.filter(e => !e.injected).map(e => e.id);
    } else {
        const r = composeWorldInjection(state, inj);
        lastText = r.text;
        lastTokens = r.tokens;
        lastDropped = r.dropped;
    }
    // setExtensionPrompt(key, value, position, depth, scan, role)
    c.setExtensionPrompt(INJECT_KEY, lastText, Number(inj.position), Number(inj.depth), false, Number(inj.role));
    return ids;
}

/** 清除注入（例如切到沒有導航的聊天） */
export function clearInjection() {
    lastText = '';
    ctx().setExtensionPrompt?.(INJECT_KEY, '', 1, 0, false, 0);
}
