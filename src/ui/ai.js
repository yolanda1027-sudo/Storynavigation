// 故事導航 — AI 相關介面：推進控制、待確認結果、連線／世界書／注入／prompt 設定、資料來源檢視、呼叫紀錄

import {
    ctx, getChatId, getState, getSettings, updateSetting,
} from '../state.js';
import {
    getCurrentTask, cancelCurrentTask, getCallLog, runTask, callLLM, fetchCustomModels,
    getProfileService, listProfiles,
} from '../llm.js';
import { readSources, getLastReport } from '../reader.js';
import { buildNavigation } from '../navigator.js';
import { advanceStory } from '../actors.js';
import { applyPending, discardPending, validateEditedPending } from '../pending.js';
import { updateInjection, getLastInjection } from '../injector.js';
import { DEFAULT_PROMPTS, PROMPT_INFO, getPromptTemplate, isOverridden } from '../prompts.js';
import {
    esc, toast, logDebug, confirmDialog, badge, btn, detailsCard, settingsField, hint, pre,
} from './common.js';

const L = {
    feasibility: { feasible: '可行', partial: '部分受阻', invalid: '失效' },
    eventResult: { success: '成功', fail: '失敗', delayed: '延後', complication: '引發新問題' },
    routeType: { main: '主線', side: '支線' },
    routeStatus: { active: '進行中', reached: '已到達', invalidated: '已失效', dormant: '休眠' },
    nodeType: { appear: '人物出現', leave: '人物離場', item: '關鍵物品', death: '死亡／失蹤／受傷', secret: '秘密揭露', stance: '立場／勢力改變', task: '任務完成／失敗', time: '時間推進' },
};

/** 一列「標籤：內容」；內容空白就不顯示 */
const kv = (label, value) => (String(value ?? '').trim() ? `<div class="story-nav-kv"><span>${esc(label)}</span>${esc(value)}</div>` : '');

// 只存在記憶體的介面狀態
const ui = {
    lastError: null,      // { message, retry: 'build' | 'advance' }
    elapsed: '',          // 「這次經過的時間」輸入框
    editingPending: false,
    editDraft: null,      // 「編輯後套用」的表單草稿（pending 的深拷貝）
    loreQuery: '',
    models: [],
    previewReport: null,
};

let rerender = () => {};
let hooks = { gotoPending: () => {} };
export function setRerender(fn, extraHooks = {}) {
    rerender = fn;
    hooks = { ...hooks, ...extraHooks };
}

const nameOf = (state, id) => state?.actors.find(a => a.id === id)?.name || id || '（未指定）';

// ───────────────────────── 執行狀態 ─────────────────────────

export function renderAiStatus() {
    const task = getCurrentTask();
    if (task) {
        const sec = Math.round((Date.now() - task.startedAt) / 1000);
        return `<div class="story-nav-busy">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>${esc(task.name)}：${esc(task.step || '準備中')}（${sec} 秒）</span>
            ${btn('ai-cancel', '取消', { cls: 'story-nav-btn-small' })}
        </div>`;
    }
    if (ui.lastError) {
        return `<div class="story-nav-error-box">
            <div><i class="fa-solid fa-triangle-exclamation"></i> ${esc(ui.lastError.message)}</div>
            <div class="story-nav-hint">既有的導航與事件沒有被修改。原始輸出可以到「設定與資料 → AI 呼叫紀錄」查看。</div>
            <div class="story-nav-row story-nav-wrap">
                ${btn(ui.lastError.retry === 'build' ? 'ai-build' : 'ai-advance', '重試', { icon: 'fa-rotate-right', cls: 'story-nav-btn-small' })}
                ${btn('ai-dismiss-error', '關閉', { cls: 'story-nav-btn-small' })}
            </div>
        </div>`;
    }
    return '';
}

// ───────────────────────── 推進控制分頁 ─────────────────────────

export function renderAiControl(state) {
    const busy = !!getCurrentTask();
    const hasActors = state.actors.some(a => a.active);
    return `<section class="story-nav-section">
        <h4>AI 動作</h4>
        <div class="story-nav-ai-status">${renderAiStatus()}</div>
        <label class="story-nav-field"><span class="story-nav-label">這次推進經過的世界時間（選填，留空由 AI 從聊天判斷）</span>
            <input type="text" class="text_pole story-nav-input" data-ui="elapsed" value="${esc(ui.elapsed)}" placeholder="例如：一個下午、三天"></label>
        ${btn('ai-advance', '推進劇情', { icon: 'fa-forward', cls: 'story-nav-btn-primary', disabled: busy || !state.routes.length,
            title: state.routes.length ? '偵測新節點 → 推手推進 → 待確認' : '請先建立導航' })}
        ${!hasActors && state.routes.length ? hint('目前沒有啟用中的推手，推進時只會做節點偵測。') : ''}
        <div class="story-nav-row story-nav-wrap">
            ${btn('ai-build', state.routes.length ? '用 AI 重新建立導航' : '用 AI 建立導航', { icon: 'fa-wand-magic-sparkles', disabled: busy })}
        </div>
        ${hint(`上次推進到 #${state.lastPushFloor}；下次推進會讀取 #${state.lastPushFloor + 1} 之後的新訊息。`)}
    </section>
    <section class="story-nav-section">
        <h4>待確認的結果</h4>
        ${renderPending(state)}
    </section>`;
}

function renderPending(state) {
    const p = state.pending;
    if (!p) return hint('目前沒有待確認的結果。');
    const busy = !!getCurrentTask();
    if (ui.editingPending && ui.editDraft) {
        return `<div class="story-nav-pending">
            ${hint('直接修改下面的欄位；不想要的項目取消勾選「套用」就好。改完按最下面的「套用編輯後的結果」。')}
            ${p.kind === 'build' ? renderBuildEditor(ui.editDraft) : renderAdvanceEditor(ui.editDraft, state)}
            <div class="story-nav-row story-nav-wrap">
                ${btn('pending-apply-edit', '套用編輯後的結果', { icon: 'fa-check', cls: 'story-nav-btn-accent', disabled: busy })}
                ${btn('pending-cancel-edit', '取消編輯')}
            </div>
        </div>`;
    }
    const actions = `<div class="story-nav-row story-nav-wrap">
                ${btn('pending-apply', '套用', { icon: 'fa-check', cls: 'story-nav-btn-accent', disabled: busy })}
                ${btn('pending-edit', '編輯後套用', { icon: 'fa-pen', disabled: busy })}
                ${btn('pending-discard', '捨棄', { icon: 'fa-xmark', disabled: busy })}
                ${btn(p.kind === 'build' ? 'ai-build' : 'ai-advance', '重新生成', { icon: 'fa-rotate-right', disabled: busy })}
           </div>`;
    const warnings = [...(p.warnings || []), ...(p.actorResults || []).flatMap(r => (r.warnings || []).map(w => `${r.actorName || r.actorId}：${w}`))];
    const head = `<div class="story-nav-hint">${esc(new Date(p.createdAt).toLocaleString())}${p.kind === 'advance' ? `｜樓層 #${p.fromFloor}～#${p.atFloor}｜經過時間：${esc(p.elapsed || '未知')}` : ''}</div>
        ${warnings.length ? `<div class="story-nav-warn-box">${warnings.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
        ${(p.errors || []).length ? `<div class="story-nav-error-box">${p.errors.map(e => `<div>✗ ${esc(e.actorId ? `${nameOf(state, e.actorId)}：` : '')}${esc(e.message)}</div>`).join('')}</div>` : ''}`;
    const body = p.kind === 'build' ? renderBuildPreview(p) : renderAdvancePreview(p, state);
    return `<div class="story-nav-pending">${head}${body}${actions}</div>`;
}

function renderBuildPreview(p) {
    const d = p.data;
    const nameOfLocal = (id) => d.actors.find(a => a.id === id)?.name || id;
    return `<div class="story-nav-hint">世界時間：${esc(d.worldTime || '未知')}</div>
        ${d.routes.map(r => `<div class="story-nav-preview-item">
            <div><b>${esc(r.name || '（未命名）')}</b> ${badge(L.routeType[r.type], r.type === 'main' ? 'main' : '')}</div>
            ${kv('衝突', r.conflict)}${kv('局勢', r.situation)}${kv('目的地', r.destination)}
            ${kv('推手', r.actors.map(nameOfLocal).join('、') || '（無）')}
        </div>`).join('')}
        ${d.actors.map(a => `<div class="story-nav-preview-item">
            <div><b>推手：${esc(a.name || '（未命名）')}</b></div>
            ${kv('身分', a.identity)}${kv('目標', a.objective)}${kv('計畫', a.currentPlan)}
            ${kv('已知', a.knowledge.join('；') || '（無）')}
        </div>`).join('')}`;
}

function renderAdvancePreview(p, state) {
    const nodes = p.nodes?.length
        ? p.nodes.map(n => `<div class="story-nav-preview-item"><div class="story-nav-card-badges">${badge(`#${n.floor}`)}${badge(L.nodeType[n.type] || n.type)}</div><div>${esc(n.summary)}</div>
            <div class="story-nav-hint">知道的推手：${esc(n.knownBy.map(id => nameOf(state, id)).join('、') || '（無）')}</div></div>`).join('')
        : hint('沒有偵測到新的重要變化。');
    const revealed = p.revealedEvents?.length
        ? `<div class="story-nav-preview-item">玩家已得知的幕後事件：${esc(p.revealedEvents.map(id => state.events.find(e => e.id === id)?.action || id).join('、'))}</div>` : '';
    const results = (p.actorResults || []).map(r => {
        const e = r.event;
        return `<div class="story-nav-preview-item">
            <div><b>${esc(r.actorName || nameOf(state, r.actorId))}</b></div>
            <div class="story-nav-card-badges">${badge(`原計畫：${L.feasibility[r.feasibility] || r.feasibility}`, r.feasibility === 'invalid' ? 'fail' : r.feasibility === 'partial' ? 'delayed' : 'success')}${e ? badge(`本次行動：${L.eventResult[e.result] || '未知'}`, e.result) : badge('與玩家同場：只更新盤算', 'known')}</div>
            ${kv('判斷理由', r.reason)}
            ${(r.derivedFrom || []).length ? `<div class="story-nav-kv"><span>依據</span><ul class="story-nav-list">${r.derivedFrom.map(id => `<li>${esc(describeRef(id, p, state))}</li>`).join('')}</ul></div>` : ''}
            ${e ? `${kv('行動', e.action)}
            <div class="story-nav-two-col">
                <div class="story-nav-col-truth"><span class="story-nav-label">真相</span><div>${esc(e.truth)}</div></div>
                <div class="story-nav-col-effect"><span class="story-nav-label">可察覺的後果</span><div>${esc(e.worldEffect || '（無）')}</div></div>
            </div>` : hint('他現在和玩家在同一個場景，場景裡會發生什麼交給主聊天；這次只記下他心裡的打算。')}
            ${kv('目標', r.updates?.objective)}${kv('計畫', r.updates?.currentPlan)}${kv('下一步', r.updates?.currentStep)}
            ${kv('新情報', (r.knowledgeAdd || []).join('；'))}
            ${kv('誰得知', (e?.whoKnows || []).map(id => nameOf(state, id)).join('、'))}
            ${kv('路線變化', (r.routeUpdates || []).map(u => `${state.routes.find(x => x.id === u.routeId)?.name || u.routeId}：${[u.stage, u.situation, u.status && L.routeStatus[u.status]].filter(Boolean).join('／')}`).join('；'))}
        </div>`;
    }).join('');
    return `<div class="story-nav-label">新節點</div>${nodes}${revealed}
        <div class="story-nav-label">推手行動</div>${results || hint('（沒有推手結果）')}`;
}

/** 把 node_／evt_ 編號翻成看得懂的內容 */
function describeRef(id, p, state) {
    const short = (t) => (t.length > 40 ? `${t.slice(0, 40)}…` : t);
    const node = (p.nodes || []).find(n => n.id === id) || state.nodes.find(n => n.id === id);
    if (node) return `劇情節點 #${node.floor}：${short(node.summary)}`;
    const ev = state.events.find(e => e.id === id);
    if (ev) return `過往事件：${short(ev.action || ev.truth)}`;
    return `（找不到這個項目：${id}）`;
}

// ───────────────────────── 編輯後套用（表單） ─────────────────────────

/** 草稿欄位：path 例如 "actorResults.0.event.action" */
function pField(path, label, type = 'text', value = '', rows = 2) {
    const attrs = `data-pedit="${esc(path)}" data-ptype="${esc(type)}"`;
    if (type === 'bool' || type === 'include') {
        return `<label class="story-nav-check"><input type="checkbox" ${attrs}${value ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    }
    const v = type === 'list' ? (value || []).join('\n') : value;
    const control = type === 'textarea' || type === 'list'
        ? `<textarea class="text_pole story-nav-input" rows="${rows}" ${attrs}>${esc(v)}</textarea>`
        : `<input type="text" class="text_pole story-nav-input" ${attrs} value="${esc(v)}">`;
    return `<label class="story-nav-field"><span class="story-nav-label">${esc(label)}</span>${control}</label>`;
}

function pRefs(path, label, selectedIds, options) {
    const selected = new Set(selectedIds || []);
    return `<div class="story-nav-field"><span class="story-nav-label">${esc(label)}</span>
        ${options.length ? `<div class="story-nav-refs">${options.map(([id, name]) => `<label class="story-nav-check">
            <input type="checkbox" data-pedit="${esc(path)}" data-ptype="refs" data-ref-value="${esc(id)}"${selected.has(id) ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>` : hint('（無）')}
    </div>`;
}

const include = (path, item) => pField(`${path}._skip`, '套用這一項', 'include', !item._skip);

function renderBuildEditor(d) {
    const data = d.data;
    return `${pField('data.worldTime', '世界時間', 'text', data.worldTime)}
        ${data.routes.map((r, i) => `<div class="story-nav-preview-item${r._skip ? ' story-nav-skipped' : ''}">
            <div><b>${esc(L.routeType[r.type])}</b></div>
            ${include(`data.routes.${i}`, r)}
            ${pField(`data.routes.${i}.name`, '路線名稱', 'text', r.name)}
            ${pField(`data.routes.${i}.conflict`, '核心衝突', 'textarea', r.conflict)}
            ${pField(`data.routes.${i}.situation`, '目前局勢', 'textarea', r.situation)}
            ${pField(`data.routes.${i}.destination`, '預期目的地', 'textarea', r.destination)}
        </div>`).join('')}
        ${data.actors.map((a, i) => `<div class="story-nav-preview-item${a._skip ? ' story-nav-skipped' : ''}">
            <div><b>推手</b></div>
            ${include(`data.actors.${i}`, a)}
            ${pField(`data.actors.${i}.name`, '名稱', 'text', a.name)}
            ${pField(`data.actors.${i}.identity`, '身分', 'textarea', a.identity)}
            ${pField(`data.actors.${i}.objective`, '目標', 'textarea', a.objective)}
            ${pField(`data.actors.${i}.currentPlan`, '目前計畫', 'textarea', a.currentPlan)}
            ${pField(`data.actors.${i}.knowledge`, '已知情報（一行一項）', 'list', a.knowledge, 3)}
        </div>`).join('')}
        ${hint('其他欄位套用後可以在「劇情導航」「幕後推手」分頁繼續修改。')}`;
}

function renderAdvanceEditor(d, state) {
    const actorOptions = state.actors.map(a => [a.id, a.name || a.id]);
    const nodes = (d.nodes || []).map((n, i) => `<div class="story-nav-preview-item${n._skip ? ' story-nav-skipped' : ''}">
            <div class="story-nav-card-badges">${badge(`#${n.floor}`)}${badge(L.nodeType[n.type] || n.type)}</div>
            ${include(`nodes.${i}`, n)}
            ${pField(`nodes.${i}.summary`, '摘要', 'textarea', n.summary)}
            ${pRefs(`nodes.${i}.knownBy`, '哪些推手知道這件事', n.knownBy, actorOptions)}
        </div>`).join('');
    const revealed = (d.revealedEvents || []).length
        ? pRefs('revealedEvents', '玩家這次得知的幕後事件（取消勾選就不標記）', d.revealedEvents,
            d.revealedEvents.map(id => [id, state.events.find(e => e.id === id)?.action || id]))
        : '';
    const results = (d.actorResults || []).map((r, i) => {
        const others = actorOptions.filter(([id]) => id !== r.actorId);
        return `<div class="story-nav-preview-item${r._skip ? ' story-nav-skipped' : ''}">
            <div><b>${esc(r.actorName || nameOf(state, r.actorId))}</b></div>
            ${include(`actorResults.${i}`, r)}
            ${r.event ? `${pField(`actorResults.${i}.event.action`, '行動', 'textarea', r.event.action)}
            ${pField(`actorResults.${i}.event.truth`, '真相（不會注入）', 'textarea', r.event.truth)}
            ${pField(`actorResults.${i}.event.worldEffect`, '可察覺的後果（會注入主聊天）', 'textarea', r.event.worldEffect)}` : hint('與玩家同場：只更新盤算，沒有行動。')}
            ${pField(`actorResults.${i}.updates.objective`, '目標（留空＝不變）', 'textarea', r.updates?.objective)}
            ${pField(`actorResults.${i}.updates.currentPlan`, '計畫（留空＝不變）', 'textarea', r.updates?.currentPlan)}
            ${pField(`actorResults.${i}.updates.currentStep`, '下一步', 'textarea', r.updates?.currentStep)}
            ${pField(`actorResults.${i}.knowledgeAdd`, '新得知的情報（一行一項）', 'list', r.knowledgeAdd, 3)}
            ${r.event ? pRefs(`actorResults.${i}.event.whoKnows`, '還有哪些推手得知', r.event.whoKnows, others) : ''}
        </div>`;
    }).join('');
    return `${pField('worldTime', '世界時間（留空＝不變）', 'text', d.worldTime)}
        <div class="story-nav-label">新節點</div>${nodes || hint('（沒有）')}
        ${revealed}
        <div class="story-nav-label">推手行動</div>${results || hint('（沒有）')}`;
}

function setDraftPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) {
        if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
        o = o[k];
    }
    o[keys[keys.length - 1]] = value;
}

/** 移除被取消勾選的項目與 _skip 標記，回傳可套用的 pending */
function cleanDraft(draft) {
    const d = JSON.parse(JSON.stringify(draft));
    if (d.kind === 'build') {
        const skippedRoutes = new Set(d.data.routes.filter(r => r._skip).map(r => r.id));
        const skippedActors = new Set(d.data.actors.filter(a => a._skip).map(a => a.id));
        d.data.routes = d.data.routes.filter(r => !r._skip).map(({ _skip, ...r }) => ({ ...r, actors: r.actors.filter(id => !skippedActors.has(id)) }));
        d.data.actors = d.data.actors.filter(a => !a._skip).map(({ _skip, ...a }) => ({ ...a, relatedRoutes: a.relatedRoutes.filter(id => !skippedRoutes.has(id)) }));
    } else {
        d.nodes = (d.nodes || []).filter(n => !n._skip).map(({ _skip, ...n }) => n);
        d.actorResults = (d.actorResults || []).filter(r => !r._skip).map(({ _skip, ...r }) => r);
    }
    return d;
}

// ───────────────────────── 設定分頁 ─────────────────────────

export function renderAiSettings() {
    const s = getSettings();
    const profileAvailable = !!getProfileService();
    const modeOptions = [['st', '跟隨目前酒館 API'], ...(profileAvailable ? [['profile', 'Connection Profile']] : []), ['custom', '自訂 OpenAI 相容 API']];
    let modeBody = '';
    if (s.connection.mode === 'profile' && profileAvailable) {
        const profiles = listProfiles();
        modeBody = profiles.length
            ? settingsField('connection.profileId', 'Connection Profile', 'select', { options: [['', '（請選擇）'], ...profiles.map(p => [p.id, p.name])] })
            : hint('還沒有可用的 Connection Profile（只支援 Chat Completion／Text Completion 類型）。');
    } else if (s.connection.mode === 'custom') {
        modeBody = `${settingsField('connection.customUrl', 'Base URL', 'text', { placeholder: 'https://api.example.com/v1' })}
            ${settingsField('connection.customKey', 'API Key', 'password')}
            ${hint('金鑰會跟其他擴充設定一起存在酒館的設定檔裡，酒館的「API 金鑰」保管機制不會保護它。介意的話建議改用 Connection Profile。')}
            ${settingsField('connection.customModel', '模型名稱', 'text', { list: 'story-nav-model-list' })}
            <datalist id="story-nav-model-list">${ui.models.map(m => `<option value="${esc(m)}"></option>`).join('')}</datalist>
            <div class="story-nav-row story-nav-wrap">${btn('ai-fetch-models', '抓取模型列表', { icon: 'fa-list' })}${ui.models.length ? `<span class="story-nav-hint">已抓到 ${ui.models.length} 個模型</span>` : ''}</div>`;
    } else {
        modeBody = hint('使用酒館目前選擇的 API 與模型，但只送出插件組好的內容（不夾帶角色卡與聊天的預設 prompt）。');
    }

    return `
        <section class="story-nav-section">
            <h4>AI 連線</h4>
            ${settingsField('connection.mode', '連線方式', 'select', { options: modeOptions, rerender: true })}
            ${!profileAvailable ? hint('這個酒館沒有啟用 Connection Manager，所以不提供 Connection Profile 選項。') : ''}
            ${modeBody}
            ${settingsField('timeoutSec', '逾時（秒）', 'number', { min: 10, max: 1200 })}
            ${settingsField('inputBudget', '輸入預算（每次送給 AI 的資料量，token）', 'number', { min: 1000 })}
            ${hint('太小時角色卡、世界書或聊天內容會被截掉，AI 看不到重要設定。')}
            ${settingsField('maxOutputTokens', '輸出上限（AI 回覆最多幾個 token）', 'number', { min: 256 })}
            ${hint('太小時 JSON 可能寫到一半被截斷（不會影響既有資料，只是這次失敗）。用會先思考的模型時，思考內容也算在內，建議調高。')}
            <div class="story-nav-row">${btn('ai-test', '測試連線', { icon: 'fa-plug', disabled: !!getCurrentTask() })}</div>
        </section>
        <section class="story-nav-section">
            <h4>讀取與推進</h4>
            ${settingsField('recentMessages', '讀取的聊天則數 N（建立導航讀最近 N 則；推進最多讀 N 則新訊息）', 'number', { min: 1, max: 200 })}
            ${settingsField('isolateActors', '每個推手分開呼叫（資訊隔離最嚴格）', 'bool')}
            ${hint('關閉後所有推手合併成一次呼叫，比較省，但 AI 會在同一次對話裡看到所有推手的資料，可能混用彼此的情報。')}
        </section>
        ${renderLorebookSettings()}
        ${renderInjectionSettings()}
        ${renderPromptSettings()}`;
}

function getAutoLorebooks() {
    const c = ctx();
    const auto = [];
    const ch = c.characters?.[c.characterId];
    if (ch?.data?.extensions?.world) auto.push({ name: ch.data.extensions.world, source: '角色綁定' });
    if (ch?.data?.character_book?.entries?.length && !ch?.data?.extensions?.world) auto.push({ name: `${ch.name}（內嵌）`, source: '角色內嵌' });
    if (c.chatMetadata?.world_info) auto.push({ name: c.chatMetadata.world_info, source: '聊天綁定' });
    return auto;
}

/** 下拉選單的選項（依搜尋文字篩選，排除已加入與自動讀取的） */
function loreOptionsHtml() {
    const c = ctx();
    const all = typeof c.getWorldInfoNames === 'function' ? c.getWorldInfoNames() : [];
    const taken = new Set([...(getSettings().globalLorebooks || []), ...getAutoLorebooks().map(b => b.name)]);
    const q = ui.loreQuery.trim().toLowerCase();
    const list = all.filter(n => !taken.has(n) && (!q || n.toLowerCase().includes(q)));
    return `<option value="">${esc(list.length ? `選擇要加入的世界書（${list.length} 本）` : (q ? '沒有符合搜尋的世界書' : '沒有其他世界書'))}</option>
        ${list.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
}

function renderLorebookSettings() {
    const auto = getAutoLorebooks();
    const extra = getSettings().globalLorebooks || [];
    return `<section class="story-nav-section">
        <h4>Lorebook 選擇</h4>
        ${hint('角色卡內嵌／綁定、聊天綁定的世界書會自動讀取；也可以另外加入其他世界書。只有關鍵字或標題命中的條目（和常駐條目）才會送出。')}
        <div class="story-nav-field"><span class="story-nav-label">目前自動讀取</span>
            <div class="story-nav-chips">${auto.length ? auto.map(b => `<span class="story-nav-chip story-nav-chip-auto">${esc(b.name)}<small>${esc(b.source)}</small></span>`).join('') : hint('（無）')}</div></div>
        <div class="story-nav-field"><span class="story-nav-label">目前額外讀取</span>
            <div class="story-nav-chips">${extra.length ? extra.map(n => `<span class="story-nav-chip">${esc(n)}
                <button type="button" class="story-nav-chip-x" data-action="lore-remove" data-name="${esc(n)}" title="移除" aria-label="移除 ${esc(n)}">×</button></span>`).join('') : hint('（無）')}</div></div>
        <div class="story-nav-field"><span class="story-nav-label">加入世界書</span>
            <input type="search" class="text_pole story-nav-input" data-ui="lore-search" value="${esc(ui.loreQuery)}" placeholder="搜尋世界書名稱" autocomplete="off">
            <select class="text_pole story-nav-input" data-ui="lore-add">${loreOptionsHtml()}</select></div>
    </section>`;
}

function renderInjectionSettings() {
    const text = getLastInjection();
    return `<section class="story-nav-section">
        <h4>注入設定</h4>
        ${settingsField('injection.enabled', '注入幕後動態到主聊天（關掉就只在面板看）', 'bool')}
        ${settingsField('injection.cardHasEngine', '此卡已有隱藏引擎（DRIVERS／THREADS／NEXT 等）→ 只描述場外發生的事', 'bool')}
        ${settingsField('injection.position', '位置', 'select', { options: [[1, '聊天中（指定深度）'], [0, '主提示詞之後'], [2, '主提示詞之前']] })}
        ${settingsField('injection.depth', '深度（位置為「聊天中」時有效）', 'number', { min: 0, max: 100 })}
        ${settingsField('injection.role', '角色', 'select', { options: [[0, 'System'], [1, 'User'], [2, 'Assistant']] })}
        ${settingsField('injection.fadeTurns', '每則事件持續注入幾則 AI 回覆後淡出', 'number', { min: 1, max: 50 })}
        <div class="story-nav-field"><span class="story-nav-label">目前注入的內容</span>
            <div class="story-nav-readonly">${text ? pre(text) : '（目前沒有要注入的內容）'}</div></div>
    </section>`;
}

function renderPromptSettings() {
    return `<section class="story-nav-section">
        <h4>Prompt 模板</h4>
        ${hint('這裡只有「指示與輸出格式」；角色卡、聊天、推手資料等由插件另外組裝，資訊隔離不受模板影響。改完離開欄位就會儲存。')}
        ${Object.entries(PROMPT_INFO).map(([name, info]) => detailsCard(`prompt:${name}`, info.label,
            isOverridden(name) ? badge('已覆寫', 'delayed') : badge('預設'),
            `<textarea class="text_pole story-nav-input story-nav-json-editor" rows="14" data-prompt="${esc(name)}">${esc(getPromptTemplate(name))}</textarea>
            ${info.vars.length ? hint(`可用佔位符：${info.vars.map(v => `{{${v}}}`).join('、')}`) : ''}
            <div class="story-nav-row">${btn('prompt-reset', '還原預設', { attrs: `data-prompt-name="${esc(name)}"`, disabled: !isOverridden(name) })}</div>`)).join('')}
    </section>`;
}

/** 資料來源檢視 + AI 呼叫紀錄（放在 Debug 區） */
export function renderAiDebug() {
    const report = ui.previewReport || getState()?.pending?.report || getLastReport();
    const log = getCallLog();
    return `${detailsCard('sources', '資料來源檢視', report ? badge(`約 ${report.totalTokens} token`) : '', `
            ${hint('看看這次送給 AI 的是哪些欄位、哪些世界書條目、大約多少 token。')}
            <div class="story-nav-row">${btn('ai-preview-sources', '預覽建立導航的素材（不呼叫 AI）', { icon: 'fa-eye', disabled: !getChatId() })}</div>
            ${report ? renderReport(report) : hint('還沒有紀錄。')}`)}
        ${detailsCard('calls', 'AI 呼叫紀錄', badge(`${log.length} 筆`), log.length ? log.map(renderCall).join('') : hint('還沒有呼叫過 AI。'))}`;
}

function renderReport(r) {
    const purpose = { build: '建立導航', detect: '節點偵測', advance: '推進劇情' }[r.purpose] || r.purpose;
    return `<div class="story-nav-hint">${esc(purpose)}｜${esc(new Date(r.time).toLocaleString())}｜預算 ${esc(r.budget)} token</div>
        <table class="story-nav-table"><thead><tr><th>來源</th><th>內容</th><th>約 token</th></tr></thead><tbody>
        ${r.items.map(i => `<tr><td>${esc(i.kind)}</td><td>${esc(i.label)}</td><td>${esc(i.tokens)}</td></tr>`).join('')}
        <tr><td colspan="2"><b>合計</b></td><td><b>${esc(r.totalTokens)}</b></td></tr></tbody></table>
        ${(r.notes || []).map(n => hint(`※ ${n}`)).join('')}
        ${r.books?.length ? `<div class="story-nav-label">讀到的世界書</div>${r.books.map(b => `<div class="story-nav-hint">${esc(b.name)}（${esc(b.source)}，${b.count} 條）</div>`).join('')}` : ''}
        ${r.lore?.length ? `<div class="story-nav-label">送出的條目</div><ul class="story-nav-list">${r.lore.map(e => `<li>${esc(e.title)} ${e.constant ? badge('常駐') : badge(`命中 ${e.hits}`)} <span class="story-nav-hint">${esc(e.book)}・約 ${e.tokens}</span></li>`).join('')}</ul>` : ''}
        ${r.skippedLore?.length ? `<div class="story-nav-label">因預算不足沒送的條目</div><ul class="story-nav-list">${r.skippedLore.map(e => `<li>${esc(e.title)} <span class="story-nav-hint">約 ${e.tokens}</span></li>`).join('')}</ul>` : ''}`;
}

function renderCall(c) {
    const mode = { st: '酒館 API', profile: 'Profile', custom: '自訂 API' }[c.mode] || c.mode;
    const status = c.error ? badge('失敗', 'fail') : c.durationMs ? badge('成功', 'success') : badge('執行中');
    return detailsCard(`call:${c.id}`, `${c.purpose}`, `${status}${badge(mode)}${badge(`入 ${c.inputTokens}／出 ${c.outputTokens}`)}`, `
        <div class="story-nav-hint">${esc(c.time.toLocaleString())}｜${(c.durationMs / 1000).toFixed(1)} 秒</div>
        ${c.error ? `<div class="story-nav-error-box">${esc(c.error)}</div>` : ''}
        <div class="story-nav-label">System prompt</div>${pre(c.system)}
        <div class="story-nav-label">User（送出的資料）</div>${pre(c.user)}
        ${c.reasoning ? `<div class="story-nav-label">思考內容</div>${pre(c.reasoning)}` : ''}
        <div class="story-nav-label">原始輸出</div>${pre(c.output || '（無）')}`);
}

// ───────────────────────── 動作 ─────────────────────────

async function runAi(kind) {
    ui.lastError = null;
    ui.editingPending = false;
    rerender();
    try {
        if (kind === 'build') await buildNavigation();
        else await advanceStory({ elapsed: ui.elapsed });
        ui.previewReport = null;
        const pending = getState()?.pending;
        if (getSettings().autoApply && pending) {
            await applyAndRefresh(pending, true);
        } else {
            toast('success', kind === 'build' ? '導航已生成，請確認後按「套用」' : '推進完成，請確認後按「套用」');
            rerender();
            hooks.gotoPending();
            return;
        }
    } catch (e) {
        if (e.name === 'ChatChangedError') {
            toast('warning', e.message);
            logDebug('info', e.message);
        } else {
            ui.lastError = { message: e.message, retry: kind };
            logDebug('error', kind === 'build' ? '建立導航失敗' : '推進劇情失敗', e.message);
            toast('error', e.message);
        }
    }
    rerender();
}

async function applyAndRefresh(pending, auto = false) {
    const state = getState();
    if (!auto && pending.kind === 'build' && (state.routes.length || state.actors.length)) {
        if (!await confirmDialog('套用後會取代目前的路線與推手（節點與事件保留）。\n之後可以用「復原」還原。要繼續嗎？')) return false;
    }
    await applyPending(pending);
    updateInjection();
    toast('success', auto ? '已自動套用結果' : '已套用');
    return true;
}

export const AI_ACTIONS = {
    // 失敗時不留下空白導航：成功後才會建立（見 navigator.buildNavigation）
    'ai-build': () => runAi('build'),
    'ai-advance': () => runAi('advance'),
    'ai-cancel': () => cancelCurrentTask(),
    'ai-dismiss-error': () => { ui.lastError = null; rerender(); },
    'pending-apply': async () => {
        try {
            await applyAndRefresh(getState().pending);
        } catch (e) {
            toast('error', `套用失敗：${e.message}`);
            logDebug('error', '套用失敗', e.message);
        }
        rerender();
    },
    'pending-edit': () => {
        ui.editingPending = true;
        ui.editDraft = JSON.parse(JSON.stringify(getState().pending));
        rerender();
    },
    'pending-cancel-edit': () => { ui.editingPending = false; rerender(); },
    'pending-apply-edit': async () => {
        const original = getState()?.pending;
        if (!original) return;
        const v = validateEditedPending(JSON.stringify(cleanDraft(ui.editDraft)), original);
        if (!v.ok) {
            toast('error', `格式錯誤：${v.errors.join('；')}`);
            return;
        }
        try {
            if (await applyAndRefresh(v.value)) ui.editingPending = false;
        } catch (e) {
            toast('error', `套用失敗：${e.message}`);
            logDebug('error', '套用失敗', e.message);
        }
        rerender();
    },
    'pending-discard': async () => {
        if (!await confirmDialog('確定要捨棄這次的結果嗎？')) return;
        await discardPending();
        ui.editingPending = false;
        rerender();
    },
    'ai-fetch-models': async () => {
        try {
            ui.models = await fetchCustomModels();
            toast('success', `抓到 ${ui.models.length} 個模型`);
        } catch (e) {
            toast('error', e.message);
            logDebug('error', '抓取模型列表失敗', e.message);
        }
        rerender();
    },
    'ai-test': async () => {
        try {
            await runTask('測試連線', async (task) => {
                task.setStep('等待 AI 回覆');
                const res = await callLLM({
                    system: '你是連線測試。只輸出 JSON。',
                    user: '請輸出 {"ok": true, "message": "連線成功"}',
                    purpose: '測試連線',
                    signal: task.signal,
                });
                toast('success', `連線成功：${res.text.slice(0, 80)}`);
            });
        } catch (e) {
            toast('error', e.message);
            logDebug('error', '測試連線失敗', e.message);
        }
        rerender();
    },
    'ai-preview-sources': async () => {
        try {
            const src = await readSources({ purpose: 'build' });
            ui.previewReport = src.report;
        } catch (e) {
            toast('error', e.message);
        }
        rerender();
    },
    'lore-remove': (el) => {
        updateSetting('globalLorebooks', (getSettings().globalLorebooks || []).filter(n => n !== el.dataset.name));
        rerender();
    },
    'prompt-reset': async (el) => {
        const name = el.dataset.promptName;
        if (!await confirmDialog(`要把「${PROMPT_INFO[name].label}」還原成預設模板嗎？`)) return;
        const overrides = { ...getSettings().promptOverrides };
        delete overrides[name];
        updateSetting('promptOverrides', overrides);
        rerender();
    },
};

/** 處理 AI 介面裡的特殊欄位；處理了就回傳 true */
export function handleAiChange(el) {
    if (el.dataset.ui === 'elapsed') {
        ui.elapsed = el.value;
        return true;
    }
    if (el.dataset.pedit && ui.editDraft) {
        const type = el.dataset.ptype;
        let value;
        if (type === 'include') value = !el.checked;           // 勾選「套用」＝不跳過
        else if (type === 'list') value = el.value.split('\n').map(x => x.trim()).filter(Boolean);
        else if (type === 'refs') {
            const group = el.closest('.story-nav-refs');
            value = [...group.querySelectorAll('input[type="checkbox"]')].filter(x => x.checked).map(x => x.dataset.refValue);
        } else value = el.value;
        setDraftPath(ui.editDraft, el.dataset.pedit, value);
        if (type === 'include') el.closest('.story-nav-preview-item')?.classList.toggle('story-nav-skipped', value);
        return true;
    }
    if (el.dataset.ui === 'lore-search') return true;
    if (el.dataset.ui === 'lore-add') {
        if (el.value) {
            updateSetting('globalLorebooks', [...new Set([...(getSettings().globalLorebooks || []), el.value])]);
            rerender();
        }
        return true;
    }
    if (el.dataset.prompt) {
        const name = el.dataset.prompt;
        const overrides = { ...getSettings().promptOverrides };
        if (!el.value.trim() || el.value.trim() === DEFAULT_PROMPTS[name].trim()) delete overrides[name];
        else overrides[name] = el.value;
        updateSetting('promptOverrides', overrides);
        const card = el.closest('[data-card]');
        card?.querySelector('.story-nav-card-badges')?.replaceChildren();
        if (card) card.querySelector('.story-nav-card-badges').innerHTML = isOverridden(name) ? badge('已覆寫', 'delayed') : badge('預設');
        const resetBtn = card?.querySelector('[data-action="prompt-reset"]');
        if (resetBtn) resetBtn.disabled = !isOverridden(name);
        return true;
    }
    return false;
}

/** 讓 input 事件也能即時記住輸入（避免重畫時遺失） */
export function handleAiInput(el) {
    if (el.dataset.ui === 'elapsed') ui.elapsed = el.value;
    if (el.dataset.ui === 'lore-search') {
        ui.loreQuery = el.value;
        // 只更新下拉選單，不整頁重畫（避免搜尋欄失去焦點）
        const select = el.closest('.story-nav-section')?.querySelector('[data-ui="lore-add"]');
        if (select) select.innerHTML = loreOptionsHtml();
    }
}

/** 設定變更後是否需要更新注入 */
export function onSettingChanged(path) {
    if (path.startsWith('injection.')) updateInjection();
}

