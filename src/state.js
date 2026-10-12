// 故事導航 — 狀態讀寫、快照、undo/redo、驗證
//
// 重要原則：
// - 每次都重新呼叫 SillyTavern.getContext() 取 chatMetadata。
//   酒館切換聊天時會整個替換 chat_metadata 物件，留著舊參照會串檔。
// - 所有寫入都先在草稿（深拷貝）上進行，驗證通過才換進正式狀態。

export const SETTINGS_KEY = 'storyNavigator';
export const META_KEY = 'storyNavigator';
export const STATE_VERSION = 1;

export const ROUTE_TYPES = ['main', 'side'];
export const ROUTE_STATUSES = ['active', 'reached', 'invalidated', 'dormant'];
export const MODES = ['manual', 'auto', 'paused'];
export const NODE_TYPES = ['appear', 'leave', 'item', 'death', 'secret', 'stance', 'task', 'time'];
export const EVENT_RESULTS = ['success', 'fail', 'delayed', 'complication'];

/** 全域設定預設值（extensionSettings.storyNavigator） */
export const DEFAULT_SETTINGS = Object.freeze({
    historyLimit: 30,
    // 以下為之後 Phase 會用到的設定，Phase 1 只負責儲存
    autoFrequency: 5,
    maxSideRoutes: 3,
    maxActors: 3,
    tokenBudget: 4000,
    autoApply: false,
});

// 快照中不包含的欄位（避免遞迴與把未確認內容存進歷史）
const NON_SNAPSHOT_KEYS = ['history', 'historyIndex', 'pending'];

// ───────────────────────── 小工具 ─────────────────────────

export function ctx() {
    return SillyTavern.getContext();
}

export function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function makeId(prefix) {
    const c = ctx();
    const raw = typeof c.uuidv4 === 'function'
        ? c.uuidv4()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${raw.replace(/-/g, '').slice(0, 10)}`;
}

/** 目前聊天 ID；沒有開啟聊天時回傳 undefined */
export function getChatId() {
    const c = ctx();
    return typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : c.chatId;
}

// ───────────────────────── 全域設定 ─────────────────────────

export function getSettings() {
    const c = ctx();
    if (!c.extensionSettings[SETTINGS_KEY] || typeof c.extensionSettings[SETTINGS_KEY] !== 'object') {
        c.extensionSettings[SETTINGS_KEY] = {};
    }
    const s = c.extensionSettings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = clone(value);
    }
    return s;
}

export function updateSettings(patch) {
    Object.assign(getSettings(), patch);
    ctx().saveSettingsDebounced();
}

// ───────────────────────── 結構與正規化 ─────────────────────────

export function createEmptyState() {
    return {
        version: STATE_VERSION,
        enabled: true,
        mode: 'manual',
        worldTime: { label: '', source: 'manual' },
        routes: [],
        actors: [],
        nodes: [],
        events: [],
        pending: null,
        history: [],
        historyIndex: -1,
        lastPushFloor: 0,
    };
}

export function createRoute(type = 'side') {
    return normalizeRoute({ id: makeId('route'), type });
}

export function createActor() {
    return normalizeActor({ id: makeId('actor') });
}

export function createNode() {
    return normalizeNode({ id: makeId('node') });
}

export function createEvent() {
    return normalizeEvent({ id: makeId('evt') });
}

const str = (v) => (typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)));
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(x => x.trim() !== '') : []);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export function normalizeRoute(r = {}) {
    return {
        ...r,
        id: str(r.id) || makeId('route'),
        name: str(r.name),
        type: oneOf(r.type, ROUTE_TYPES, 'side'),
        conflict: str(r.conflict),
        actors: strList(r.actors),
        stage: str(r.stage),
        situation: str(r.situation),
        destination: str(r.destination),
        successCondition: str(r.successCondition),
        failCondition: str(r.failCondition),
        obstacles: strList(r.obstacles),
        status: oneOf(r.status, ROUTE_STATUSES, 'active'),
        links: strList(r.links),
    };
}

export function normalizeActor(a = {}) {
    return {
        ...a,
        id: str(a.id) || makeId('actor'),
        // name 為顯示用名稱（規格外的小擴充，方便辨識推手）
        name: str(a.name),
        identity: str(a.identity),
        objective: str(a.objective),
        motive: str(a.motive),
        resources: strList(a.resources),
        constraints: strList(a.constraints),
        currentPlan: str(a.currentPlan),
        currentStep: str(a.currentStep),
        obstacles: strList(a.obstacles),
        knowledge: strList(a.knowledge),
        progress: str(a.progress),
        relatedRoutes: strList(a.relatedRoutes),
        active: bool(a.active, true),
    };
}

export function normalizeNode(n = {}) {
    return {
        ...n,
        id: str(n.id) || makeId('node'),
        floor: num(n.floor, 0),
        swipeId: num(n.swipeId, 0),
        summary: str(n.summary),
        type: oneOf(n.type, NODE_TYPES, 'appear'),
        involved: strList(n.involved),
        confirmed: bool(n.confirmed, false),
    };
}

export function normalizeEvent(e = {}) {
    return {
        ...e,
        id: str(e.id) || makeId('evt'),
        actorId: str(e.actorId),
        action: str(e.action),
        result: oneOf(e.result, EVENT_RESULTS, 'success'),
        truth: str(e.truth),
        worldEffect: str(e.worldEffect),
        whoKnows: strList(e.whoKnows),
        playerKnows: bool(e.playerKnows, false),
        revealHook: str(e.revealHook),
        injected: bool(e.injected, false),
        atFloor: num(e.atFloor, 0),
        worldTime: str(e.worldTime),
    };
}

/**
 * 驗證並正規化整份狀態。
 * 結構性錯誤（不是物件、陣列欄位型別錯）會回傳 ok:false；
 * 缺漏欄位則自動補上預設值。
 * @returns {{ok: boolean, errors: string[], value: object|null}}
 */
export function validateState(input) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, errors: ['資料必須是一個 JSON 物件'], value: null };
    }
    if (input.version !== undefined && Number(input.version) > STATE_VERSION) {
        errors.push(`資料版本 ${input.version} 比插件支援的版本 ${STATE_VERSION} 新`);
    }
    for (const key of ['routes', 'actors', 'nodes', 'events']) {
        if (input[key] !== undefined && !Array.isArray(input[key])) {
            errors.push(`「${key}」必須是陣列`);
        } else if (Array.isArray(input[key]) && input[key].some(x => !x || typeof x !== 'object' || Array.isArray(x))) {
            errors.push(`「${key}」裡的每一項都必須是物件`);
        }
    }
    if (errors.length) return { ok: false, errors, value: null };

    const base = createEmptyState();
    const value = {
        ...base,
        ...input,
        version: STATE_VERSION,
        enabled: bool(input.enabled, true),
        mode: oneOf(input.mode, MODES, 'manual'),
        worldTime: {
            label: str(input.worldTime?.label),
            source: str(input.worldTime?.source) || 'manual',
        },
        routes: (input.routes || []).map(normalizeRoute),
        actors: (input.actors || []).map(normalizeActor),
        nodes: (input.nodes || []).map(normalizeNode),
        events: (input.events || []).map(normalizeEvent),
        pending: input.pending ?? null,
        history: Array.isArray(input.history) ? input.history : [],
        historyIndex: Number.isInteger(input.historyIndex) ? input.historyIndex : -1,
        lastPushFloor: num(input.lastPushFloor, 0),
    };

    // ID 重複檢查
    for (const key of ['routes', 'actors', 'nodes', 'events']) {
        const seen = new Set();
        for (const item of value[key]) {
            if (seen.has(item.id)) errors.push(`「${key}」中有重複的 id：${item.id}`);
            seen.add(item.id);
        }
    }
    if (errors.length) return { ok: false, errors, value: null };

    if (value.historyIndex >= value.history.length) value.historyIndex = value.history.length - 1;
    return { ok: true, errors: [], value };
}

// ───────────────────────── 讀取 ─────────────────────────

let loadError = null;

/** 最近一次讀取失敗的原因（資料損壞時），沒有則為 null */
export function getLoadError() {
    return loadError;
}

/** 目前聊天 metadata 中的原始資料（debug 用） */
export function getRawState() {
    return getChatId() ? ctx().chatMetadata?.[META_KEY] ?? null : null;
}

/** 取得目前聊天的狀態；沒有聊天、尚未建立或資料損壞時回傳 null */
export function getState() {
    loadError = null;
    if (!getChatId()) return null;
    const raw = getRawState();
    if (!raw) return null;
    // 第一次讀到這份資料：補齊缺漏欄位（不覆蓋既有內容）
    if (raw.__normalizedFor !== getChatId()) {
        const v = validateState(raw);
        if (!v.ok) {
            loadError = v.errors;
            return null;
        }
        Object.keys(raw).forEach(k => delete raw[k]);
        Object.assign(raw, v.value);
        Object.defineProperty(raw, '__normalizedFor', { value: getChatId(), enumerable: false, configurable: true, writable: true });
    }
    return raw;
}

function dataOf(state) {
    const data = {};
    for (const [k, v] of Object.entries(state)) {
        if (!NON_SNAPSHOT_KEYS.includes(k)) data[k] = v;
    }
    return clone(data);
}

function pushSnapshot(state, label) {
    const limit = Math.max(1, num(getSettings().historyLimit, DEFAULT_SETTINGS.historyLimit));
    // 在中間做了新修改 → 丟棄 redo 分支
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push({ label, time: Date.now(), data: dataOf(state) });
    while (state.history.length > limit) state.history.shift();
    state.historyIndex = state.history.length - 1;
}

// ───────────────────────── 寫入 ─────────────────────────

/** 寫回酒館。若期間聊天已切換則放棄寫入。 */
async function persist(expectedChatId) {
    if (!expectedChatId || getChatId() !== expectedChatId) {
        console.warn('[故事導航] 聊天已切換，放棄寫入');
        return false;
    }
    await ctx().saveMetadata();
    return true;
}

/** 在目前聊天建立空白導航（不呼叫 AI） */
export async function initState() {
    const chatId = getChatId();
    if (!chatId) throw new Error('目前沒有開啟聊天');
    const state = createEmptyState();
    pushSnapshot(state, '建立空白導航');
    ctx().chatMetadata[META_KEY] = state;
    await persist(chatId);
    return getState();
}

/**
 * 正式寫入：在草稿上執行 mutator → 驗證 → 換入正式狀態 → 存快照 → 儲存。
 * mutator 丟錯或驗證失敗時，正式狀態完全不變。
 * @param {string|((draft: object) => string)} label 變化紀錄文字；函式形式會在 mutator 之後以草稿計算
 * @param {(draft: object) => void} mutator
 */
export async function commit(label, mutator) {
    const chatId = getChatId();
    const state = getState();
    if (!chatId || !state) throw new Error('目前聊天尚未建立導航');

    if (state.history.length === 0) pushSnapshot(state, '（初始狀態）');

    const draft = dataOf(state);
    mutator(draft);
    const v = validateState({ ...draft, history: state.history, historyIndex: state.historyIndex, pending: state.pending });
    if (!v.ok) {
        const err = new Error(`驗證失敗：${v.errors.join('；')}`);
        err.validationErrors = v.errors;
        throw err;
    }
    if (getChatId() !== chatId) throw new Error('聊天已切換，已取消這次修改');

    applyData(state, dataOf(v.value));
    pushSnapshot(state, typeof label === 'function' ? label(v.value) : label);
    await persist(chatId);
    return state;
}

/** 修改 pending 等不進快照的欄位 */
export async function setTransient(key, value) {
    if (!NON_SNAPSHOT_KEYS.includes(key) || key === 'history' || key === 'historyIndex') {
        throw new Error(`不允許直接修改欄位：${key}`);
    }
    const chatId = getChatId();
    const state = getState();
    if (!state) return;
    state[key] = value;
    await persist(chatId);
}

function applyData(state, data) {
    for (const k of Object.keys(state)) {
        if (!NON_SNAPSHOT_KEYS.includes(k)) delete state[k];
    }
    Object.assign(state, clone(data));
}

// ───────────────────────── undo / redo ─────────────────────────

export function canUndo(state = getState()) {
    return !!state && state.historyIndex > 0;
}

export function canRedo(state = getState()) {
    return !!state && state.historyIndex < state.history.length - 1;
}

export async function jumpTo(index) {
    const chatId = getChatId();
    const state = getState();
    if (!state || index < 0 || index >= state.history.length || index === state.historyIndex) return false;
    applyData(state, state.history[index].data);
    state.historyIndex = index;
    await persist(chatId);
    return true;
}

export const undo = () => { const s = getState(); return s ? jumpTo(s.historyIndex - 1) : false; };
export const redo = () => { const s = getState(); return s ? jumpTo(s.historyIndex + 1) : false; };

// ───────────────────────── 匯出 / 匯入 / 刪除 ─────────────────────────

/** 匯出用：不含快照歷史 */
export function exportState() {
    const state = getState();
    if (!state) return null;
    const data = dataOf(state);
    data.pending = clone(state.pending);
    return data;
}

/** 匯入第一步：解析並驗證（不寫入） */
export function parseImport(json) {
    let parsed;
    try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (e) {
        return { ok: false, errors: [`JSON 格式錯誤：${e.message}`], value: null };
    }
    return validateState(parsed);
}

/** 匯入第二步：寫入已驗證的資料，並存成一個可 undo 的快照 */
export async function applyImport(value) {
    if (!getState()) await initState();
    await commit('匯入 JSON', (draft) => {
        const incoming = dataOf(value);
        Object.keys(draft).forEach(k => delete draft[k]);
        Object.assign(draft, incoming);
    });
}

/** 刪除目前聊天的全部導航資料（無法 undo） */
export async function deleteState() {
    const chatId = getChatId();
    if (!chatId) return;
    delete ctx().chatMetadata[META_KEY];
    await persist(chatId);
}
