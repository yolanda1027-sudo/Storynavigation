// 故事導航 — M4 劇情節點偵測器
// 讀取「上次推進之後」的新聊天，請 AI 擷取重要變化。沒有新訊息就不呼叫 AI。

import { NODE_TYPES, coerce, ctx, normalizeNode, makeId } from './state.js';
import { callLLM, parseJsonObject } from './llm.js';
import { readSources } from './reader.js';
import { getPromptTemplate, sections } from './prompts.js';

const { str, strList, num, oneOf } = coerce;

/**
 * 驗證節點偵測輸出。
 * @param {object} obj AI 輸出
 * @param {{fromFloor: number, toFloor: number, actorIds: string[], eventIds: string[]}} ctx
 */
export function validateDetectOutput(obj, { fromFloor, toFloor, actorIds, eventIds }) {
    const errors = [];
    const warnings = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['不是 JSON 物件'], warnings, value: null };
    if (obj.nodes !== undefined && !Array.isArray(obj.nodes)) errors.push('nodes 必須是陣列');
    if (errors.length) return { ok: false, errors, warnings, value: null };

    const nodes = (obj.nodes || []).filter(n => n && typeof n === 'object' && str(n.summary).trim()).map(n => {
        let floor = num(n.floor, toFloor);
        if (floor < fromFloor || floor > toFloor) {
            warnings.push(`節點「${str(n.summary).slice(0, 20)}」的樓層 #${floor} 不在本次範圍內，已改為 #${toFloor}`);
            floor = toFloor;
        }
        const knownBy = strList(n.knownBy).filter(id => actorIds.includes(id));
        return normalizeNode({
            id: makeId('node'),
            floor,
            summary: str(n.summary),
            type: oneOf(n.type, NODE_TYPES, 'stance'),
            involved: strList(n.involved),
            knownBy,
            confirmed: false,
        });
    });
    const revealedEvents = strList(obj.revealedEvents).filter(id => eventIds.includes(id));
    return {
        ok: true,
        errors,
        warnings,
        value: { nodes, revealedEvents, worldTime: str(obj.worldTime), elapsed: str(obj.elapsed) },
    };
}

/**
 * 偵測新節點。
 * @param {object} task runTask 提供的任務物件
 * @param {object} state 目前狀態
 * @returns {Promise<{nodes: object[], revealedEvents: string[], worldTime: string, elapsed: string, report: object, fromFloor: number, toFloor: number, skipped: boolean, warnings: string[]}>}
 */
export async function detectNodes(task, state) {
    const fromFloor = (Number(state.lastPushFloor) || 0) + 1;
    const src = await readSources({
        purpose: 'detect',
        fromFloor,
        extraKeywords: [...state.routes.map(r => r.name), ...state.actors.map(a => a.name)],
    });
    const toFloor = src.lastFloor;

    if (!src.messages.length) {
        return { nodes: [], revealedEvents: [], worldTime: '', elapsed: '', report: src.report, fromFloor, toFloor, skipped: true, warnings: [] };
    }

    const actorList = state.actors.map(a => `${a.id}：${a.name || '（未命名）'}`).join('\n');
    const hiddenEvents = state.events.filter(e => !e.playerKnows && e.truth.trim());
    const eventList = hiddenEvents.slice(-15).map(e => `${e.id}：${e.truth}`).join('\n');

    const user = sections([
        ['玩家角色', `${src.persona.name}（由真人扮演；聊天中以此名字出現的就是玩家）`],
        ['推手名單', actorList || '（無）'],
        ['玩家尚未得知的幕後事件', eventList || '（無）'],
        ['相關世界書條目', src.loreText],
        ['新的聊天內容', src.messagesText],
        ['任務', '請擷取上面新聊天中的重要變化，只輸出 JSON。'],
    ]);

    task.setStep('偵測劇情節點');
    const res = await callLLM({ system: getPromptTemplate('detectNodes'), user, purpose: '節點偵測', signal: task.signal });
    task.assertSameChat();

    let parsed;
    try {
        parsed = parseJsonObject(res.text);
    } catch (e) {
        res.logEntry.error = `解析失敗：${e.message}`;
        throw new Error(`節點偵測的回覆無法解析：${e.message}`);
    }
    const v = validateDetectOutput(parsed, {
        fromFloor: src.messages[0].floor,
        toFloor,
        actorIds: state.actors.map(a => a.id),
        eventIds: hiddenEvents.map(e => e.id),
    });
    if (!v.ok) {
        res.logEntry.error = `驗證失敗：${v.errors.join('；')}`;
        throw new Error(`節點偵測的回覆格式不符：${v.errors.join('；')}`);
    }
    // 補上 swipe 編號，之後樓層變動時可以比對
    const chat = ctx().chat || [];
    v.value.nodes.forEach(n => { n.swipeId = Number(chat[n.floor]?.swipe_id ?? 0); });

    return { ...v.value, report: src.report, fromFloor, toFloor, skipped: false, warnings: v.warnings };
}
