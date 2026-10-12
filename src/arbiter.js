// 故事導航 — 推手衝突裁決
//
// 推手各自行動（彼此不一定知道對方在做什麼），全部行動完後，
// 把這一輪的行動交給「裁決」檢查有沒有互相干擾，必要時調整結果。
// 裁決是旁白層級（不是推手），可以看到所有推手這一輪的行動。

import { EVENT_RESULTS, coerce } from './state.js';
import { callLLM, parseJsonObject } from './llm.js';
import { getPromptTemplate, sections } from './prompts.js';

const { str, strList } = coerce;

export function validateArbiterOutput(obj, actorIds) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.conflicts)) {
        return { ok: false, errors: ['缺少 conflicts 陣列'], value: null };
    }
    const value = obj.conflicts
        .filter(c => c && typeof c === 'object' && str(c.description).trim())
        .map(c => ({
            actorIds: strList(c.actorIds).filter(id => actorIds.includes(id)),
            description: str(c.description),
            adjustments: (Array.isArray(c.adjustments) ? c.adjustments : [])
                .filter(a => a && typeof a === 'object' && actorIds.includes(str(a.actorId)))
                .map(a => ({
                    actorId: str(a.actorId),
                    result: EVENT_RESULTS.includes(a.result) ? a.result : '',
                    truth: str(a.truth),
                    worldEffect: str(a.worldEffect),
                    whoKnowsAdd: strList(a.whoKnowsAdd).filter(id => actorIds.includes(id) && id !== str(a.actorId)),
                })),
        }));
    return { ok: true, errors: [], value };
}

/** 把裁決的調整套到推手結果上（直接修改 results） */
export function applyArbiter(results, conflicts) {
    for (const c of conflicts) {
        for (const adj of c.adjustments) {
            const r = results.find(x => x.actorId === adj.actorId);
            if (!r?.event) continue;
            if (adj.result) r.event.result = adj.result;
            if (adj.truth) r.event.truth = adj.truth;
            if (adj.worldEffect) r.event.worldEffect = adj.worldEffect;
            r.event.whoKnows = [...new Set([...(r.event.whoKnows || []), ...adj.whoKnowsAdd])];
            r.arbitrated = true;
        }
    }
}

/**
 * 檢查這一輪推手行動之間的衝突。少於兩個行動時不呼叫 AI。
 * @returns {Promise<object[]>} 衝突列表（已套用到 results）
 */
export async function resolveConflicts(task, state, results, time) {
    const acted = results.filter(r => r.event);
    if (acted.length < 2) return [];
    const nameOf = (id) => state.actors.find(a => a.id === id)?.name || id;

    const user = sections([
        ['這一輪的推手行動', acted.map(r => JSON.stringify({
            actorId: r.actorId,
            name: nameOf(r.actorId),
            identity: state.actors.find(a => a.id === r.actorId)?.identity || '',
            action: r.event.action,
            result: r.event.result,
            truth: r.event.truth,
            worldEffect: r.event.worldEffect,
        }, null, 2)).join('\n')],
        ['世界時間', `目前：${time.worldTime || '未知'}\n這次推進經過的時間：${time.elapsed || '未知'}`],
        ['任務', '請檢查上面的行動之間有沒有互相干擾，只輸出 JSON。'],
    ]);

    task.setStep('檢查推手之間的衝突');
    const res = await callLLM({ system: getPromptTemplate('resolveConflicts'), user, purpose: '衝突裁決', signal: task.signal });
    task.assertSameChat();
    let parsed;
    try {
        parsed = parseJsonObject(res.text);
    } catch (e) {
        res.logEntry.error = `解析失敗：${e.message}`;
        throw new Error(`衝突裁決的回覆無法解析：${e.message}`);
    }
    const v = validateArbiterOutput(parsed, state.actors.map(a => a.id));
    if (!v.ok) {
        res.logEntry.error = `驗證失敗：${v.errors.join('；')}`;
        throw new Error(`衝突裁決的回覆格式不符：${v.errors.join('；')}`);
    }
    applyArbiter(results, v.value);
    return v.value;
}
