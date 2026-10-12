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
import { applyPending, discardPending, validateEditedPending, editablePendingJson } from '../pending.js';
import { updateInjection, getLastInjection } from '../injector.js';
import { DEFAULT_PROMPTS, PROMPT_INFO, getPromptTemplate, isOverridden } from '../prompts.js';
import {
    esc, toast, logDebug, confirmDialog, badge, btn, detailsCard, settingsField, hint, pre,
} from './common.js';

const L = {
    feasibility: { feasible: '計畫可行', partial: '部分受阻', invalid: '計畫失效' },
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
    pendingDraft: '',
    models: [],
    previewReport: null,
};

let rerender = () => {};
export function setRerender(fn) {
    rerender = fn;
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
    const actions = ui.editingPending
        ? `<textarea class="text_pole story-nav-input story-nav-json-editor" rows="16" data-ui="pending-draft">${esc(ui.pendingDraft)}</textarea>
           <div class="story-nav-row story-nav-wrap">
                ${btn('pending-apply-edit', '套用編輯後的結果', { icon: 'fa-check', disabled: busy })}
                ${btn('pending-cancel-edit', '取消編輯')}
           </div>`
        : `<div class="story-nav-row story-nav-wrap">
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
            <div><b>${esc(r.actorName || nameOf(state, r.actorId))}</b> ${badge(L.feasibility[r.feasibility] || r.feasibility, r.feasibility === 'invalid' ? 'fail' : r.feasibility === 'partial' ? 'delayed' : 'success')} ${badge(L.eventResult[e?.result] || '', e?.result)}</div>
            ${kv('判斷', r.reason)}${kv('依據', (r.derivedFrom || []).join('、'))}${kv('行動', e?.action)}
            <div class="story-nav-two-col">
                <div class="story-nav-col-truth"><span class="story-nav-label">真相</span><div>${esc(e?.truth)}</div></div>
                <div class="story-nav-col-effect"><span class="story-nav-label">可察覺的後果</span><div>${esc(e?.worldEffect || '（無）')}</div></div>
            </div>
            ${kv('下一步', r.updates?.currentStep)}${kv('目標', r.updates?.objective)}
            ${kv('新情報', (r.knowledgeAdd || []).join('；'))}
            ${kv('誰得知', (e?.whoKnows || []).map(id => nameOf(state, id)).join('、'))}
            ${kv('路線變化', (r.routeUpdates || []).map(u => `${state.routes.find(x => x.id === u.routeId)?.name || u.routeId}：${[u.stage, u.situation, u.status && L.routeStatus[u.status]].filter(Boolean).join('／')}`).join('；'))}
        </div>`;
    }).join('');
    return `<div class="story-nav-label">新節點</div>${nodes}${revealed}
        <div class="story-nav-label">推手行動</div>${results || hint('（沒有推手結果）')}`;
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

function renderLorebookSettings() {
    const c = ctx();
    const all = typeof c.getWorldInfoNames === 'function' ? c.getWorldInfoNames() : [];
    const selected = new Set(getSettings().globalLorebooks || []);
    const auto = [];
    const ch = c.characters?.[c.characterId];
    if (ch?.data?.extensions?.world) auto.push(`角色綁定：${ch.data.extensions.world}`);
    if (ch?.data?.character_book?.entries?.length && !ch?.data?.extensions?.world) auto.push(`角色內嵌：${ch.name}`);
    if (c.chatMetadata?.world_info) auto.push(`聊天綁定：${c.chatMetadata.world_info}`);
    return `<section class="story-nav-section">
        <h4>Lorebook 選擇</h4>
        ${hint('角色卡內嵌／綁定、聊天綁定的世界書會自動讀取；下面勾選的全域世界書也會一起讀。只有關鍵字或標題命中的條目（和常駐條目）才會送出。')}
        <div class="story-nav-hint">目前自動讀取：${esc(auto.join('、') || '（無）')}</div>
        ${all.length ? `<div class="story-nav-refs">${all.map(n => `<label class="story-nav-check">
            <input type="checkbox" data-lorebook="${esc(n)}"${selected.has(n) ? ' checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div>`
        : hint('沒有找到任何世界書。')}
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
            toast('success', kind === 'build' ? '導航已生成，請到「推進控制」確認' : '推進完成，請到「推進控制」確認');
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
        ui.pendingDraft = editablePendingJson(getState().pending);
        rerender();
    },
    'pending-cancel-edit': () => { ui.editingPending = false; rerender(); },
    'pending-apply-edit': async () => {
        const original = getState()?.pending;
        if (!original) return;
        const v = validateEditedPending(ui.pendingDraft, original);
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
    if (el.dataset.ui === 'pending-draft') {
        ui.pendingDraft = el.value;
        return true;
    }
    if (el.dataset.lorebook !== undefined) {
        const set = new Set(getSettings().globalLorebooks || []);
        if (el.checked) set.add(el.dataset.lorebook);
        else set.delete(el.dataset.lorebook);
        updateSetting('globalLorebooks', [...set]);
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
    if (el.dataset.ui === 'pending-draft') ui.pendingDraft = el.value;
}

/** 設定變更後是否需要更新注入 */
export function onSettingChanged(path) {
    if (path.startsWith('injection.')) updateInjection();
}

