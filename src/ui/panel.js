// 故事導航 — 操作介面（M7）
//
// 面板只有一份 DOM：平常放在擴充設定區，開啟浮動視窗時整個搬進浮動視窗，關閉時再搬回來。
// 欄位編輯採「change 事件」（離開欄位時）才寫入，每次寫入就是一個可 undo 的步驟。

import {
    ROUTE_STATUSES, MODES, NODE_TYPES, EVENT_RESULTS,
    ctx, getChatId, getState, getRawState, getLoadError, updateSetting,
    initState, commit, undo, redo, jumpTo, canUndo, canRedo,
    exportState, parseImport, applyImport, deleteState,
    createRoute, createActor, createNode, createEvent,
} from '../state.js';
import { onLlmChange, getCurrentTask } from '../llm.js';
import { updateInjection } from '../injector.js';
import {
    esc, toast, logDebug, getDebugLog, confirmDialog, badge, openCards, settingsField, btn,
} from './common.js';
import {
    AI_ACTIONS, setRerender, renderAiControl, renderAiStatus, renderAiSettings, renderAiDebug,
    handleAiChange, handleAiInput, onSettingChanged,
} from './ai.js';

export { logDebug };

// ───────────────────────── 文字對照 ─────────────────────────

const L = {
    routeType: { main: '主線', side: '支線' },
    routeStatus: { active: '進行中', reached: '已到達', invalidated: '已失效', dormant: '休眠' },
    mode: { manual: '手動', auto: '自動', paused: '暫停' },
    nodeType: { appear: '人物出現', leave: '人物離場', item: '關鍵物品', death: '死亡／失蹤／受傷', secret: '秘密揭露', stance: '立場／勢力改變', task: '任務完成／失敗', time: '時間推進' },
    eventResult: { success: '成功', fail: '失敗', delayed: '延後', complication: '引發新問題' },
    coll: { routes: '路線', actors: '推手', nodes: '節點', events: '事件', root: '導航' },
};

const opts = (list, map) => list.map(v => [v, map[v]]);

const ROUTE_FIELDS = [
    { key: 'name', label: '路線名稱', type: 'text' },
    { key: 'type', label: '類型', type: 'select', options: [['main', '主線'], ['side', '支線']], rerender: true },
    { key: 'status', label: '狀態', type: 'select', options: opts(ROUTE_STATUSES, L.routeStatus), rerender: true },
    { key: 'conflict', label: '核心衝突', type: 'textarea' },
    { key: 'stage', label: '目前階段', type: 'text' },
    { key: 'situation', label: '目前局勢', type: 'textarea' },
    { key: 'destination', label: '預期目的地（可能到達的狀態，不是玩家任務）', type: 'textarea' },
    { key: 'successCondition', label: '成立條件', type: 'textarea' },
    { key: 'failCondition', label: '失效條件', type: 'textarea' },
    { key: 'obstacles', label: '阻礙（一行一項）', type: 'list' },
    { key: 'actors', label: '相關推手', type: 'refs', ref: 'actors' },
    { key: 'links', label: '關聯（一行一項）', type: 'list' },
];

const ACTOR_FIELDS = [
    { key: 'name', label: '名稱', type: 'text' },
    { key: 'active', label: '啟用（參與推進）', type: 'bool', rerender: true },
    { key: 'identity', label: '身分', type: 'textarea' },
    { key: 'objective', label: '目標', type: 'textarea' },
    { key: 'motive', label: '動機', type: 'textarea' },
    { key: 'currentPlan', label: '目前計畫', type: 'textarea' },
    { key: 'currentStep', label: '目前步驟', type: 'textarea' },
    { key: 'progress', label: '進度', type: 'textarea' },
    { key: 'resources', label: '資源（一行一項）', type: 'list' },
    { key: 'constraints', label: '限制（一行一項）', type: 'list' },
    { key: 'obstacles', label: '阻礙（一行一項）', type: 'list' },
    { key: 'knowledge', label: '已知情報 knowledge（一行一項；只有這裡的內容會餵給此推手）', type: 'list', rows: 4 },
    { key: 'relatedRoutes', label: '相關路線', type: 'refs', ref: 'routes' },
];

const NODE_FIELDS = [
    { key: 'summary', label: '摘要', type: 'textarea' },
    { key: 'type', label: '類型', type: 'select', options: opts(NODE_TYPES, L.nodeType), rerender: true },
    { key: 'floor', label: '樓層（訊息編號）', type: 'number', rerender: true },
    { key: 'swipeId', label: 'Swipe 編號', type: 'number' },
    { key: 'involved', label: '涉及人物（一行一項）', type: 'list' },
    { key: 'knownBy', label: '哪些推手知道（推進時只會餵給這些推手）', type: 'refs', ref: 'actors' },
    { key: 'confirmed', label: '已確認', type: 'bool', rerender: true },
];

const EVENT_FIELDS_TOP = [
    { key: 'actorId', label: '推手', type: 'ref', ref: 'actors', rerender: true },
    { key: 'result', label: '結果', type: 'select', options: opts(EVENT_RESULTS, L.eventResult), rerender: true },
    { key: 'action', label: '行動', type: 'textarea' },
];
const EVENT_FIELD_TRUTH = { key: 'truth', label: '真相（只存在插件內，不會注入）', type: 'textarea', rows: 4 };
const EVENT_FIELD_EFFECT = { key: 'worldEffect', label: '可察覺的後果（之後可注入主聊天）', type: 'textarea', rows: 4 };
const EVENT_FIELDS_BOTTOM = [
    { key: 'playerKnows', label: '玩家角色已在劇情中得知', type: 'bool', rerender: true },
    { key: 'revealHook', label: '日後可能揭露的管道', type: 'textarea' },
    { key: 'whoKnows', label: '哪些推手得知', type: 'refs', ref: 'actors' },
    { key: 'atFloor', label: '發生於樓層', type: 'number' },
    { key: 'worldTime', label: '世界時間', type: 'text' },
    { key: 'injected', label: '已注入過', type: 'bool' },
];

// ───────────────────────── 模組狀態 ─────────────────────────

let root = null;          // .story-nav-panel
let inlineHost = null;    // 擴充設定區裡放面板的位置
let floatWin = null;      // 浮動視窗
let activeTab = 'routes';

// ───────────────────────── 小工具 ─────────────────────────

function actorName(state, id) {
    const a = state.actors.find(x => x.id === id);
    if (!a) return id ? `（已刪除：${id}）` : '（未指定）';
    return a.name || a.identity.slice(0, 20) || a.id;
}

function routeName(state, id) {
    const r = state.routes.find(x => x.id === id);
    return r ? (r.name || '（未命名路線）') : `（已刪除：${id}）`;
}

function refLabel(state, refColl, id) {
    return refColl === 'actors' ? actorName(state, id) : routeName(state, id);
}

function cardTitle(state, coll, item) {
    switch (coll) {
        case 'routes': return item.name || '（未命名路線）';
        case 'actors': return actorName(state, item.id);
        case 'nodes': return item.summary ? item.summary.slice(0, 40) : '（空白節點）';
        case 'events': return item.action ? item.action.slice(0, 40) : '（空白事件）';
        default: return item.id;
    }
}

function cardBadges(state, coll, item) {
    switch (coll) {
        case 'routes':
            return badge(L.routeType[item.type], item.type === 'main' ? 'main' : '') + badge(L.routeStatus[item.status], item.status);
        case 'actors':
            return item.active ? badge('啟用', 'active') : badge('停用', 'dormant');
        case 'nodes':
            return badge(`#${item.floor}`) + badge(L.nodeType[item.type]) + (item.confirmed ? badge('已確認', 'active') : badge('未確認', 'dormant'));
        case 'events':
            return badge(actorName(state, item.actorId)) + badge(L.eventResult[item.result], item.result)
                + (item.playerKnows ? badge('玩家已知', 'known') : badge('玩家未知', 'unknown'));
        default: return '';
    }
}

// ───────────────────────── 欄位渲染 ─────────────────────────

function dataAttrs(coll, id, field) {
    return `data-field="1" data-coll="${esc(coll)}" data-id="${esc(id ?? '')}" data-key="${esc(field.key)}" data-ftype="${esc(field.type)}"${field.rerender ? ' data-rerender="1"' : ''}`;
}

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function renderField(state, coll, item, field) {
    const value = getPath(item, field.key);
    const attrs = dataAttrs(coll, item.id, field);
    let control;
    switch (field.type) {
        case 'text':
            control = `<input type="text" class="text_pole story-nav-input" ${attrs} value="${esc(value)}">`;
            break;
        case 'number':
            control = `<input type="number" class="text_pole story-nav-input" ${attrs} value="${esc(value)}">`;
            break;
        case 'textarea':
            control = `<textarea class="text_pole story-nav-input" rows="${field.rows || 2}" ${attrs}>${esc(value)}</textarea>`;
            break;
        case 'list':
            control = `<textarea class="text_pole story-nav-input" rows="${field.rows || 3}" ${attrs}>${esc((value || []).join('\n'))}</textarea>`;
            break;
        case 'select':
            control = `<select class="text_pole story-nav-input" ${attrs}>${field.options.map(([v, t]) =>
                `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
            break;
        case 'bool':
            return `<label class="story-nav-check"><input type="checkbox" ${attrs}${value ? ' checked' : ''}><span>${esc(field.label)}</span></label>`;
        case 'ref': {
            const list = state[field.ref];
            const missing = value && !list.some(x => x.id === value);
            control = `<select class="text_pole story-nav-input" ${attrs}>
                <option value="">（未指定）</option>
                ${list.map(x => `<option value="${esc(x.id)}"${x.id === value ? ' selected' : ''}>${esc(refLabel(state, field.ref, x.id))}</option>`).join('')}
                ${missing ? `<option value="${esc(value)}" selected>${esc(refLabel(state, field.ref, value))}</option>` : ''}
            </select>`;
            break;
        }
        case 'refs': {
            const list = state[field.ref].filter(x => !(coll === field.ref && x.id === item.id));
            const selected = new Set(value || []);
            const orphan = [...selected].filter(id => !list.some(x => x.id === id));
            const all = [...list.map(x => x.id), ...orphan];
            control = all.length
                ? `<div class="story-nav-refs">${all.map(id => `<label class="story-nav-check">
                    <input type="checkbox" ${attrs} data-ref-value="${esc(id)}"${selected.has(id) ? ' checked' : ''}>
                    <span>${esc(refLabel(state, field.ref, id))}</span></label>`).join('')}</div>`
                : `<div class="story-nav-hint">目前沒有可選的${esc(L.coll[field.ref])}。</div>`;
            break;
        }
        default:
            control = '';
    }
    // refs 內含多個 checkbox，外層不能用 <label>（點空白處會誤勾第一個）
    const tag = field.type === 'refs' ? 'div' : 'label';
    return `<${tag} class="story-nav-field"><span class="story-nav-label">${esc(field.label)}</span>${control}</${tag}>`;
}

function renderCard(state, coll, item, bodyHtml) {
    const key = `${coll}:${item.id}`;
    return `<details class="story-nav-card" data-card="${esc(key)}"${openCards.has(key) ? ' open' : ''}>
        <summary class="story-nav-card-summary">
            <span class="story-nav-card-title">${esc(cardTitle(state, coll, item))}</span>
            <span class="story-nav-card-badges">${cardBadges(state, coll, item)}</span>
        </summary>
        <div class="story-nav-card-body">
            ${bodyHtml}
            <div class="story-nav-card-footer">
                <code class="story-nav-id" title="內部 ID">${esc(item.id)}</code>
                <button type="button" class="menu_button story-nav-btn story-nav-btn-danger" data-action="delete" data-coll="${esc(coll)}" data-id="${esc(item.id)}">
                    <i class="fa-solid fa-trash-can"></i><span>刪除</span>
                </button>
            </div>
        </div>
    </details>`;
}

const fieldsHtml = (state, coll, item, fields) => fields.map(f => renderField(state, coll, item, f)).join('');

// ───────────────────────── 各分頁 ─────────────────────────

function renderNoChat() {
    return `<div class="story-nav-empty">請先開啟一個聊天。</div>`;
}

function renderNoState() {
    const err = getLoadError();
    if (err) {
        return `<div class="story-nav-empty story-nav-error">
            <p>此聊天的導航資料無法讀取：</p>
            <ul>${err.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
            <p>可以到「設定與資料」分頁查看原始資料、匯出備份，或刪除後重新建立。</p>
        </div>`;
    }
    return `<div class="story-nav-empty">
        <p>此聊天尚未建立導航。</p>
        <p class="story-nav-hint">可以讓 AI 讀角色卡、世界書與近期聊天來建立，或建立空白導航自己填。開啟插件時不會自動呼叫 AI。</p>
        <div class="story-nav-ai-status">${renderAiStatus()}</div>
        <div class="story-nav-row story-nav-wrap">
            ${btn('ai-build', '用 AI 建立導航', { icon: 'fa-wand-magic-sparkles', disabled: !!getCurrentTask() })}
            ${btn('init', '建立空白導航', { icon: 'fa-plus' })}
        </div>
    </div>`;
}

function renderHistory(state) {
    if (!state.history.length) return '<div class="story-nav-hint">尚無紀錄。</div>';
    const rows = state.history.map((h, i) => ({ h, i })).reverse().map(({ h, i }) => {
        const current = i === state.historyIndex;
        const future = i > state.historyIndex;
        const time = new Date(h.time).toLocaleString();
        return `<li class="story-nav-history-item${current ? ' story-nav-current' : ''}${future ? ' story-nav-future' : ''}">
            <span class="story-nav-history-label">${current ? '▶ ' : ''}${esc(h.label)}</span>
            <span class="story-nav-history-time">${esc(time)}</span>
            ${current ? '' : `<button type="button" class="menu_button story-nav-btn story-nav-btn-small" data-action="jump" data-index="${i}">回到這裡</button>`}
        </li>`;
    }).join('');
    return `<ul class="story-nav-history">${rows}</ul>`;
}

function renderRoutesTab(state) {
    const routes = [...state.routes].sort((a, b) => (a.type === b.type ? 0 : a.type === 'main' ? -1 : 1));
    const nodes = [...state.nodes].sort((a, b) => a.floor - b.floor);
    return `
        <section class="story-nav-section">
            <div class="story-nav-section-head">
                <h4>路線</h4>
                <div class="story-nav-row">
                    <button type="button" class="menu_button story-nav-btn" data-action="add-route" data-type="main"><i class="fa-solid fa-plus"></i><span>主線</span></button>
                    <button type="button" class="menu_button story-nav-btn" data-action="add-route" data-type="side"><i class="fa-solid fa-plus"></i><span>支線</span></button>
                </div>
            </div>
            ${routes.length ? routes.map(r => renderCard(state, 'routes', r, fieldsHtml(state, 'routes', r, ROUTE_FIELDS))).join('') : '<div class="story-nav-hint">還沒有路線。</div>'}
        </section>
        <section class="story-nav-section">
            <div class="story-nav-section-head">
                <h4>劇情節點</h4>
                <button type="button" class="menu_button story-nav-btn" data-action="add-node"><i class="fa-solid fa-plus"></i><span>節點</span></button>
            </div>
            ${nodes.length ? nodes.map(n => renderCard(state, 'nodes', n, fieldsHtml(state, 'nodes', n, NODE_FIELDS))).join('') : '<div class="story-nav-hint">還沒有節點。按「推進劇情」時會從新的聊天內容偵測。</div>'}
        </section>
        <section class="story-nav-section">
            <details class="story-nav-card" data-card="history"${openCards.has('history') ? ' open' : ''}>
                <summary class="story-nav-card-summary"><span class="story-nav-card-title">變化紀錄</span>
                    <span class="story-nav-card-badges">${badge(`${state.history.length} 筆`)}</span></summary>
                <div class="story-nav-card-body">${renderHistory(state)}</div>
            </details>
        </section>`;
}

function renderActorsTab(state) {
    const cards = state.actors.map(a => {
        const latest = [...state.events].reverse().find(e => e.actorId === a.id);
        const latestHtml = `<div class="story-nav-field"><span class="story-nav-label">最新行動</span>
            <div class="story-nav-readonly">${latest ? `${esc(latest.action || '（無描述）')} ${badge(L.eventResult[latest.result], latest.result)}` : '（尚無）'}</div></div>`;
        return renderCard(state, 'actors', a, latestHtml + fieldsHtml(state, 'actors', a, ACTOR_FIELDS));
    }).join('');
    return `<section class="story-nav-section">
        <div class="story-nav-section-head">
            <h4>幕後推手</h4>
            <button type="button" class="menu_button story-nav-btn" data-action="add-actor"><i class="fa-solid fa-plus"></i><span>推手</span></button>
        </div>
        ${cards || '<div class="story-nav-hint">還沒有推手。</div>'}
    </section>`;
}

function renderEventsTab(state) {
    const cards = [...state.events].reverse().map(e => renderCard(state, 'events', e, `
        ${fieldsHtml(state, 'events', e, EVENT_FIELDS_TOP)}
        <div class="story-nav-two-col">
            <div class="story-nav-col-truth">${renderField(state, 'events', e, EVENT_FIELD_TRUTH)}</div>
            <div class="story-nav-col-effect">${renderField(state, 'events', e, EVENT_FIELD_EFFECT)}</div>
        </div>
        ${fieldsHtml(state, 'events', e, EVENT_FIELDS_BOTTOM)}`)).join('');
    return `<section class="story-nav-section">
        <div class="story-nav-section-head">
            <h4>世界事件</h4>
            <button type="button" class="menu_button story-nav-btn" data-action="add-event"><i class="fa-solid fa-plus"></i><span>事件</span></button>
        </div>
        <div class="story-nav-hint">新的在上。左欄「真相」只存在插件內；右欄「可察覺的後果」才可能被注入主聊天。</div>
        ${cards || '<div class="story-nav-hint">還沒有事件。</div>'}
    </section>`;
}

function renderControlTab(state) {
    const rootItem = { id: '', ...state };
    return `
        <section class="story-nav-section">
            <h4>此聊天</h4>
            ${renderField(state, 'root', rootItem, { key: 'enabled', label: '此聊天啟用故事導航', type: 'bool' })}
            ${renderField(state, 'root', rootItem, { key: 'mode', label: '模式', type: 'select', options: opts(MODES, L.mode) })}
            ${renderField(state, 'root', rootItem, { key: 'worldTime.label', label: '世界時間（AI 推進時會更新，也可手動修改）', type: 'text' })}
        </section>
        ${renderAiControl(state)}
        ${renderGlobalControlSettings()}`;
}

/** 全域設定與聊天無關，沒開聊天或尚未建立導航時也要能改 */
function renderGlobalControlSettings() {
    return `<section class="story-nav-section">
            <h4>全域推進設定</h4>
            <div class="story-nav-hint">這些設定所有聊天共用。自動模式在 Phase 3 加入。</div>
            ${settingsField('autoFrequency', '自動模式：每幾則 AI 回覆推進一次', 'number', { min: 1 })}
            ${settingsField('maxSideRoutes', '支線數量上限', 'number', { min: 0, max: 10 })}
            ${settingsField('maxActors', '推手數量上限', 'number', { min: 1, max: 10 })}
            ${settingsField('autoApply', '自動套用 AI 結果（不經確認）', 'bool')}
        </section>`;
}

function renderSettingsTab(state) {
    const raw = getRawState();
    const debugLog = getDebugLog();
    const logHtml = debugLog.length
        ? `<ul class="story-nav-log">${debugLog.map(d => `<li class="story-nav-log-${esc(d.level)}">
            <span class="story-nav-history-time">${esc(d.time.toLocaleTimeString())}</span> ${esc(d.message)}
            ${d.detail ? `<pre>${esc(typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail, null, 2))}</pre>` : ''}</li>`).join('')}</ul>`
        : '<div class="story-nav-hint">目前沒有紀錄。</div>';
    const hasChat = !!getChatId();
    return `
        <section class="story-nav-section">
            <h4>此聊天的資料</h4>
            <div class="story-nav-row story-nav-wrap">
                <button type="button" class="menu_button story-nav-btn" data-action="export"${state ? '' : ' disabled'}><i class="fa-solid fa-file-export"></i><span>匯出 JSON</span></button>
                <button type="button" class="menu_button story-nav-btn" data-action="import"${hasChat ? '' : ' disabled'}><i class="fa-solid fa-file-import"></i><span>匯入 JSON</span></button>
                <button type="button" class="menu_button story-nav-btn story-nav-btn-danger" data-action="delete-state"${raw ? '' : ' disabled'}><i class="fa-solid fa-trash-can"></i><span>刪除此聊天的導航資料</span></button>
            </div>
            <div class="story-nav-hint">匯入會覆蓋此聊天目前的導航（可以用「復原」還原）。刪除則無法復原，建議先匯出備份。</div>
        </section>
        <section class="story-nav-section">
            <h4>一般設定</h4>
            ${settingsField('historyLimit', '復原紀錄保留份數', 'number', { min: 1, max: 200 })}
        </section>
        ${renderAiSettings()}
        <section class="story-nav-section">
            <h4>Debug</h4>
            ${renderAiDebug()}
            <details class="story-nav-card" data-card="debug-log"${openCards.has('debug-log') ? ' open' : ''}>
                <summary class="story-nav-card-summary"><span class="story-nav-card-title">錯誤與訊息紀錄</span>
                    <span class="story-nav-card-badges">${badge(`${debugLog.length} 筆`)}</span></summary>
                <div class="story-nav-card-body">${logHtml}</div>
            </details>
            <details class="story-nav-card" data-card="debug-raw"${openCards.has('debug-raw') ? ' open' : ''}>
                <summary class="story-nav-card-summary"><span class="story-nav-card-title">此聊天的原始資料（唯讀）</span></summary>
                <div class="story-nav-card-body"><pre class="story-nav-raw">${esc(raw ? JSON.stringify({ ...raw, history: `（${raw.history?.length ?? 0} 份快照，略）` }, null, 2) : '（無）')}</pre></div>
            </details>
        </section>`;
}

// ───────────────────────── 渲染主流程 ─────────────────────────

function renderToolbar(state) {
    const chatId = getChatId();
    const c = ctx();
    const label = root.querySelector('.story-nav-chat-label');
    label.textContent = chatId ? `${c.name2 || ''}｜${chatId}` : '（沒有開啟聊天）';
    label.title = chatId || '';
    root.querySelector('[data-action="undo"]').disabled = !canUndo(state);
    root.querySelector('[data-action="redo"]').disabled = !canRedo(state);
    root.querySelector('.story-nav-float-label').textContent = isFloating() ? '收回面板' : '浮動視窗';
}

function renderTab(tab, state) {
    const body = root.querySelector(`[data-tab-body="${tab}"]`);
    if (tab === 'settings') {
        body.innerHTML = renderSettingsTab(state);
        return;
    }
    const extra = tab === 'control' ? renderGlobalControlSettings() : '';
    if (!getChatId()) { body.innerHTML = renderNoChat() + extra; return; }
    if (!state) { body.innerHTML = renderNoState() + extra; return; }
    switch (tab) {
        case 'routes': body.innerHTML = renderRoutesTab(state); break;
        case 'actors': body.innerHTML = renderActorsTab(state); break;
        case 'events': body.innerHTML = renderEventsTab(state); break;
        case 'control': body.innerHTML = renderControlTab(state); break;
    }
}

const TABS = ['routes', 'actors', 'events', 'control', 'settings'];

/** 全部重畫 */
export function render() {
    if (!root) return;
    const state = getState();
    root.dataset.chatId = getChatId() || '';
    renderToolbar(state);
    for (const tab of TABS) renderTab(tab, state);
    showTab(activeTab);
}

/** 欄位文字修改後的輕量更新：不重畫目前分頁（避免打斷焦點），只更新其他分頁與標題 */
function renderAfterTextEdit(coll, id) {
    const state = getState();
    renderToolbar(state);
    for (const tab of TABS) if (tab !== activeTab) renderTab(tab, state);
    const item = state?.[coll]?.find?.(x => x.id === id);
    const card = root.querySelector(`[data-tab-body="${activeTab}"] [data-card="${CSS.escape(`${coll}:${id}`)}"]`);
    if (item && card) {
        card.querySelector('.story-nav-card-title').textContent = cardTitle(state, coll, item);
        card.querySelector('.story-nav-card-badges').innerHTML = cardBadges(state, coll, item);
    }
    // 變化紀錄在路線分頁裡，順手更新
    const hist = root.querySelector('[data-tab-body="routes"] [data-card="history"] .story-nav-card-body');
    if (hist && state && activeTab === 'routes') hist.innerHTML = renderHistory(state);
}

function showTab(tab) {
    activeTab = tab;
    root.querySelectorAll('.story-nav-tab').forEach(b => b.classList.toggle('story-nav-tab-active', b.dataset.tab === tab));
    root.querySelectorAll('.story-nav-tab-body').forEach(b => { b.hidden = b.dataset.tabBody !== tab; });
}

// ───────────────────────── 寫入動作 ─────────────────────────

async function safeCommit(label, mutator) {
    try {
        await commit(label, mutator);
        return true;
    } catch (e) {
        logDebug('error', `寫入失敗：${typeof label === 'function' ? '編輯欄位' : label}`, e.message);
        toast('error', e.message);
        return false;
    }
}

function readFieldValue(el) {
    const type = el.dataset.ftype;
    if (type === 'bool') return el.checked;
    if (type === 'number') return Number(el.value) || 0;
    if (type === 'list') return el.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (type === 'refs') {
        const group = el.closest('.story-nav-refs');
        return [...group.querySelectorAll('input[type="checkbox"]')].filter(x => x.checked).map(x => x.dataset.refValue);
    }
    return el.value;
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) {
        if (!o[k] || typeof o[k] !== 'object') o[k] = {};
        o = o[k];
    }
    o[keys[keys.length - 1]] = value;
}

/** 路線.actors 與 推手.relatedRoutes 雙向同步 */
function syncRefs(draft, coll, id, key, value) {
    const pairs = { 'routes.actors': ['actors', 'relatedRoutes'], 'actors.relatedRoutes': ['routes', 'actors'] };
    const pair = pairs[`${coll}.${key}`];
    if (!pair) return;
    const [otherColl, otherKey] = pair;
    const selected = new Set(value);
    for (const other of draft[otherColl]) {
        const list = other[otherKey] || [];
        const has = list.includes(id);
        if (selected.has(other.id) && !has) other[otherKey] = [...list, id];
        if (!selected.has(other.id) && has) other[otherKey] = list.filter(x => x !== id);
    }
}

async function onFieldChange(el) {
    const { coll, id, key, ftype } = el.dataset;
    // 防串檔：畫面是舊聊天的就不寫入
    if ((getChatId() || '') !== root.dataset.chatId) { render(); return; }
    const value = readFieldValue(el);
    const state = getState();
    if (!state) return;
    const fieldLabel = el.closest('.story-nav-field')?.querySelector('.story-nav-label')?.textContent
        || el.closest('.story-nav-check')?.textContent?.trim() || key;
    const label = (draft) => {
        const target = coll === 'root' ? null : draft[coll].find(x => x.id === id);
        const name = target ? `「${cardTitle(draft, coll, target)}」` : '';
        return `編輯${L.coll[coll]}${name}：${fieldLabel}`;
    };
    const ok = await safeCommit(label, (draft) => {
        const target = coll === 'root' ? draft : draft[coll].find(x => x.id === id);
        if (!target) throw new Error('找不到要編輯的項目（可能已被刪除或已切換聊天）');
        setPath(target, key, value);
        syncRefs(draft, coll, id, key, value);
    });
    if (!ok) { render(); return; }
    if (el.dataset.rerender || ftype === 'refs' || ftype === 'ref') render();
    else renderAfterTextEdit(coll, id);
}

async function onSettingChange(el) {
    const path = el.dataset.setting;
    const type = el.dataset.ftype;
    let value;
    if (type === 'bool') {
        value = el.checked;
    } else if (type === 'number') {
        const min = el.min !== '' ? Number(el.min) : -Infinity;
        const max = el.max !== '' ? Number(el.max) : Infinity;
        value = Math.min(max, Math.max(min, Math.round(Number(el.value) || 0)));
        el.value = String(value);
    } else if (type === 'select' && /^-?\d+$/.test(el.value) && typeof getPathValue(path) === 'number') {
        value = Number(el.value);
    } else {
        value = type === 'text' ? el.value.trim() : el.value;
    }
    updateSetting(path, value);
    onSettingChanged(path);
    if (el.dataset.rerender) render();
}

function getPathValue(path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx().extensionSettings.storyNavigator);
}

async function addItem(coll, factory, label) {
    const item = factory();
    const ok = await safeCommit(label, (draft) => { draft[coll].push(item); });
    if (ok) openCards.add(`${coll}:${item.id}`);
    render();
}

async function deleteItem(coll, id) {
    const state = getState();
    const item = state?.[coll]?.find(x => x.id === id);
    if (!item) return;
    const title = cardTitle(state, coll, item);
    if (!await confirmDialog(`確定要刪除${L.coll[coll]}「${title}」嗎？\n（之後可以用「復原」還原）`)) return;
    await safeCommit(`刪除${L.coll[coll]}「${title}」`, (draft) => {
        draft[coll] = draft[coll].filter(x => x.id !== id);
        if (coll === 'actors') {
            draft.routes.forEach(r => { r.actors = r.actors.filter(x => x !== id); });
            draft.events.forEach(e => { e.whoKnows = e.whoKnows.filter(x => x !== id); });
            // 事件的 actorId 保留，面板會顯示「已刪除」，避免抹掉歷史
        }
        if (coll === 'routes') {
            draft.actors.forEach(a => { a.relatedRoutes = a.relatedRoutes.filter(x => x !== id); });
        }
    });
    openCards.delete(`${coll}:${id}`);
    render();
}

function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onImportFile(file) {
    const chatIdAtStart = getChatId();
    const text = await file.text();
    const parsed = parseImport(text);
    if (!parsed.ok) {
        toast('error', `匯入失敗：${parsed.errors.join('；')}`);
        logDebug('error', `匯入失敗：${file.name}`, parsed.errors.join('\n'));
        render();
        return;
    }
    if (getState() && !await confirmDialog('匯入會覆蓋此聊天目前的導航資料（可用「復原」還原）。要繼續嗎？')) return;
    if (getChatId() !== chatIdAtStart) {
        toast('warning', '聊天已切換，已取消匯入');
        return;
    }
    try {
        await applyImport(parsed.value);
        toast('success', '匯入完成');
        logDebug('info', `已匯入：${file.name}`);
    } catch (e) {
        toast('error', `匯入失敗：${e.message}`);
        logDebug('error', `匯入失敗：${file.name}`, e.message);
    }
    render();
}

const ACTIONS = {
    ...AI_ACTIONS,
    'undo': async () => { await undo(); updateInjection(); render(); },
    'redo': async () => { await redo(); updateInjection(); render(); },
    'jump': async (el) => { await jumpTo(Number(el.dataset.index)); updateInjection(); render(); },
    'toggle-float': () => toggleFloating(),
    'init': async () => {
        try { await initState(); } catch (e) { toast('error', e.message); logDebug('error', '建立導航失敗', e.message); }
        render();
    },
    'add-route': (el) => addItem('routes', () => createRoute(el.dataset.type), el.dataset.type === 'main' ? '新增主線' : '新增支線'),
    'add-actor': () => addItem('actors', createActor, '新增推手'),
    'add-node': () => addItem('nodes', createNode, '新增節點'),
    'add-event': () => addItem('events', createEvent, '新增事件'),
    'delete': (el) => deleteItem(el.dataset.coll, el.dataset.id),
    'export': () => {
        const data = exportState();
        if (!data) return;
        const safe = String(getChatId() || 'chat').replace(/[\\/:*?"<>|\s]+/g, '_');
        downloadJson(data, `story-navigator_${safe}.json`);
    },
    'import': () => {
        const input = root.querySelector('.story-nav-import-file');
        input.value = '';
        input.click();
    },
    'delete-state': async () => {
        if (!await confirmDialog('確定要刪除此聊天的全部導航資料嗎？\n這個動作「無法復原」，建議先匯出備份。')) return;
        await deleteState();
        updateInjection();
        logDebug('info', '已刪除此聊天的導航資料');
        render();
    },
};

function bindEvents() {
    root.addEventListener('click', async (ev) => {
        const tabBtn = ev.target.closest('.story-nav-tab');
        if (tabBtn) { showTab(tabBtn.dataset.tab); return; }
        const btn = ev.target.closest('[data-action]');
        if (!btn || btn.disabled) return;
        const fn = ACTIONS[btn.dataset.action];
        if (!fn) return;
        ev.preventDefault();
        btn.disabled = true;
        try { await fn(btn); } finally { if (btn.isConnected) btn.disabled = false; renderToolbar(getState()); }
    });

    root.addEventListener('change', (ev) => {
        const el = ev.target;
        if (el.matches('.story-nav-import-file')) {
            if (el.files?.[0]) onImportFile(el.files[0]);
            return;
        }
        if (handleAiChange(el)) return;
        if (el.dataset.setting) { onSettingChange(el); return; }
        if (el.dataset.field) onFieldChange(el);
    });

    root.addEventListener('input', (ev) => handleAiInput(ev.target));

    // 記住卡片的展開狀態
    root.addEventListener('toggle', (ev) => {
        const card = ev.target.closest?.('[data-card]');
        if (!card || card !== ev.target) return;
        if (card.open) openCards.add(card.dataset.card);
        else openCards.delete(card.dataset.card);
    }, true);
}

// ───────────────────────── AI 執行狀態 ─────────────────────────

let wasBusy = false;
let busyTimer = null;

/** 任務開始／結束時整個重畫；執行中只更新狀態列（不打斷正在輸入的欄位） */
function onTaskChange() {
    const busy = !!getCurrentTask();
    if (busy !== wasBusy) {
        wasBusy = busy;
        clearInterval(busyTimer);
        if (busy) busyTimer = setInterval(updateBusyStatus, 1000);
        render();
    } else {
        updateBusyStatus();
    }
}

function updateBusyStatus() {
    root?.querySelectorAll('.story-nav-ai-status').forEach(el => { el.innerHTML = renderAiStatus(); });
}

// ───────────────────────── 浮動視窗 ─────────────────────────

function isFloating() {
    return !!floatWin && !floatWin.hidden;
}

function ensureFloatWindow() {
    if (floatWin) return floatWin;
    floatWin = document.createElement('div');
    floatWin.className = 'story-nav-float';
    floatWin.hidden = true;
    floatWin.innerHTML = `
        <div class="story-nav-float-head">
            <span class="story-nav-float-title"><i class="fa-solid fa-compass"></i> 故事導航</span>
            <button type="button" class="menu_button story-nav-btn story-nav-btn-small" data-float-close title="收回面板"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="story-nav-float-body"></div>`;
    document.body.appendChild(floatWin);
    floatWin.querySelector('[data-float-close]').addEventListener('click', () => toggleFloating(false));
    makeDraggable(floatWin, floatWin.querySelector('.story-nav-float-head'));
    return floatWin;
}

function makeDraggable(win, handle) {
    let start = null;
    handle.addEventListener('pointerdown', (ev) => {
        if (ev.target.closest('button') || window.matchMedia('(max-width: 768px)').matches) return;
        const rect = win.getBoundingClientRect();
        start = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top };
        handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener('pointermove', (ev) => {
        if (!start) return;
        const left = Math.min(window.innerWidth - 80, Math.max(0, start.left + ev.clientX - start.x));
        const top = Math.min(window.innerHeight - 40, Math.max(0, start.top + ev.clientY - start.y));
        win.style.left = `${left}px`;
        win.style.top = `${top}px`;
        win.style.right = 'auto';
    });
    const end = () => { start = null; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

export function toggleFloating(force) {
    const win = ensureFloatWindow();
    const open = force ?? !isFloating();
    if (open) {
        win.querySelector('.story-nav-float-body').appendChild(root);
        win.hidden = false;
        inlineHost.querySelector('.story-nav-inline-note').hidden = false;
    } else {
        inlineHost.appendChild(root);
        win.hidden = true;
        inlineHost.querySelector('.story-nav-inline-note').hidden = true;
    }
    renderToolbar(getState());
}

// ───────────────────────── 初始化 ─────────────────────────

export async function mountPanel() {
    const url = new URL('../../templates/panel.html', import.meta.url);
    const html = await (await fetch(url)).text();

    const drawer = document.createElement('div');
    drawer.className = 'story-nav-settings';
    drawer.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-compass"></i> 故事導航</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content story-nav-inline-host">
                <div class="story-nav-inline-note" hidden>
                    面板目前在浮動視窗中。
                    <button type="button" class="menu_button story-nav-btn story-nav-btn-small" data-inline-recall>收回到這裡</button>
                </div>
            </div>
        </div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    container.appendChild(drawer);
    inlineHost = drawer.querySelector('.story-nav-inline-host');
    inlineHost.querySelector('[data-inline-recall]').addEventListener('click', () => toggleFloating(false));

    const tmp = document.createElement('div');
    tmp.innerHTML = html.trim();
    root = tmp.firstElementChild;
    inlineHost.appendChild(root);

    // 魔杖選單（#extensionsMenu）加一個開關浮動視窗的入口，手機上比較好找
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        const item = document.createElement('div');
        item.className = 'list-group-item flex-container flexGap5 interactable story-nav-menu-item';
        item.tabIndex = 0;
        item.innerHTML = '<div class="fa-solid fa-compass extensionsMenuExtensionButton"></div><span>故事導航</span>';
        item.addEventListener('click', () => toggleFloating());
        menu.appendChild(item);
    }

    bindEvents();
    setRerender(render);
    onLlmChange(onTaskChange);
    render();
}
