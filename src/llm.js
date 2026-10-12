// 故事導航 — 所有 AI 呼叫的統一出口
//
// 三種連線方式：
// 1. st      跟隨目前酒館 API：generateRaw（只送我們組好的 system + user，不夾帶角色卡與聊天）
// 2. profile Connection Profile：ConnectionManagerRequestService（酒館內建 Connection Manager 擴充）
// 3. custom  自訂 OpenAI 相容 API：透過酒館後端 /api/backends/chat-completions 轉發，避開瀏覽器 CORS
//
// 統一處理：逾時、不自動重試、token 估算、輸出上限、錯誤訊息、單一任務鎖、防串檔。

import { ctx, getChatId, getSettings } from './state.js';

// ───────────────────────── 呼叫紀錄（debug 用，只存在記憶體） ─────────────────────────

const callLog = [];
const listeners = new Set();

export function getCallLog() {
    return callLog;
}

export function onLlmChange(fn) {
    listeners.add(fn);
}

function emit() {
    listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
}

// ───────────────────────── token 估算 ─────────────────────────

/** 粗估 token：中日韓字約 1 字 1 token，其他約 4 字元 1 token */
export function estimateTokens(text) {
    const s = String(text ?? '');
    const cjk = (s.match(/[　-鿿가-힯豈-﫿＀-￯]/g) || []).length;
    return Math.ceil(cjk + (s.length - cjk) / 4);
}

async function countTokens(text) {
    try {
        const c = ctx();
        if (typeof c.getTokenCountAsync === 'function') return await c.getTokenCountAsync(text);
    } catch { /* 用估算 */ }
    return estimateTokens(text);
}

// ───────────────────────── 任務鎖 ─────────────────────────

let currentTask = null;

export function getCurrentTask() {
    return currentTask;
}

export class ChatChangedError extends Error {
    constructor() {
        super('聊天已切換，這次結果已丟棄，不會寫入');
        this.name = 'ChatChangedError';
    }
}

/**
 * 同一時間只允許一個 AI 任務。
 * @param {string} name 任務名稱
 * @param {(task: {chatId: string, signal: AbortSignal, assertSameChat: () => void}) => Promise<any>} fn
 */
export async function runTask(name, fn) {
    if (currentTask) throw new Error(`「${currentTask.name}」還在執行中，請等它結束`);
    const chatId = getChatId();
    if (!chatId) throw new Error('目前沒有開啟聊天');
    const controller = new AbortController();
    currentTask = {
        name,
        chatId,
        controller,
        startedAt: Date.now(),
        step: '',
    };
    emit();
    const task = {
        chatId,
        signal: controller.signal,
        assertSameChat() {
            if (getChatId() !== chatId) throw new ChatChangedError();
            if (controller.signal.aborted) throw new Error('已取消');
        },
        setStep(step) {
            currentTask.step = step;
            emit();
        },
    };
    try {
        return await fn(task);
    } finally {
        currentTask = null;
        emit();
    }
}

export function cancelCurrentTask() {
    currentTask?.controller.abort(new Error('已取消'));
}

// ───────────────────────── 連線 ─────────────────────────

/** Connection Manager 是否可用（不可用時設定頁隱藏此選項） */
export function getProfileService() {
    const c = ctx();
    const svc = c.ConnectionManagerRequestService;
    if (!svc || c.extensionSettings?.disabledExtensions?.includes('connection-manager')) return null;
    return svc;
}

export function listProfiles() {
    const svc = getProfileService();
    if (!svc) return [];
    try {
        return (svc.getSupportedProfiles() || []).map(p => ({ id: p.id, name: p.name || p.id }));
    } catch {
        return [];
    }
}

function customHeadersYaml(key) {
    // 酒館後端會用 YAML 解析 custom_include_headers，並覆蓋它自己的 Authorization
    return key ? `Authorization: ${JSON.stringify(`Bearer ${key}`)}` : '';
}

/** 抓取自訂 API 的模型列表 */
export async function fetchCustomModels() {
    const { customUrl, customKey } = getSettings().connection;
    if (!customUrl) throw new Error('請先填 Base URL');
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: customUrl,
            custom_include_headers: customHeadersYaml(customKey),
        }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
        throw new Error(`抓取模型列表失敗（HTTP ${res.status}）${data?.message ? `：${data.message}` : ''}`);
    }
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
    return list.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
}

async function sendViaST({ system, user, maxTokens }) {
    const c = ctx();
    if (typeof c.generateRaw !== 'function') throw new Error('這個版本的酒館沒有 generateRaw');
    const text = await c.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens });
    return { text: String(text ?? ''), reasoning: '' };
}

async function sendViaProfile({ system, user, maxTokens, signal }) {
    const svc = getProfileService();
    if (!svc) throw new Error('Connection Manager 無法使用（可能被停用了）');
    const { profileId } = getSettings().connection;
    if (!profileId) throw new Error('請先在設定選擇 Connection Profile');
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const prompt = typeof svc.constructPrompt === 'function' ? svc.constructPrompt(messages, profileId) : messages;
    const res = await svc.sendRequest(profileId, prompt, maxTokens, {
        stream: false, signal, extractData: true, includePreset: true, includeInstruct: true,
    });
    return { text: String(res?.content ?? ''), reasoning: String(res?.reasoning ?? '') };
}

async function sendViaCustom({ system, user, maxTokens, signal }) {
    const c = ctx();
    const { customUrl, customKey, customModel } = getSettings().connection;
    if (!customUrl || !customModel) throw new Error('請先填自訂 API 的 Base URL 與模型名稱');
    const svc = c.ChatCompletionService;
    if (!svc) throw new Error('這個版本的酒館沒有 ChatCompletionService');
    const res = await svc.processRequest({
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        model: customModel,
        chat_completion_source: 'custom',
        custom_url: customUrl,
        custom_include_headers: customHeadersYaml(customKey),
        max_tokens: maxTokens,
    }, {}, true, signal);
    return { text: String(res?.content ?? ''), reasoning: String(res?.reasoning ?? '') };
}

/**
 * 呼叫 AI。不自動重試；失敗直接丟錯。
 * @param {{system: string, user: string, purpose: string, signal?: AbortSignal}} req
 * @returns {Promise<{text: string, reasoning: string, logEntry: object}>}
 */
export async function callLLM({ system, user, purpose, signal }) {
    const settings = getSettings();
    const mode = settings.connection.mode;
    const maxTokens = Math.max(64, Number(settings.maxOutputTokens) || 3000);
    const timeoutMs = Math.max(10, Number(settings.timeoutSec) || 180) * 1000;

    const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        time: new Date(),
        purpose,
        mode,
        system,
        user,
        inputTokens: await countTokens(`${system}\n${user}`),
        outputTokens: 0,
        durationMs: 0,
        output: '',
        reasoning: '',
        error: '',
    };
    callLog.unshift(entry);
    if (callLog.length > 20) callLog.length = 20;
    emit();

    // 逾時：profile / custom 可真正中止請求；generateRaw 無法中止，只能不再等它
    const timeoutController = new AbortController();
    const linked = new AbortController();
    const abortLinked = (reason) => { if (!linked.signal.aborted) linked.abort(reason); };
    signal?.addEventListener('abort', () => abortLinked(signal.reason));
    timeoutController.signal.addEventListener('abort', () => abortLinked(timeoutController.signal.reason));
    const timer = setTimeout(() => timeoutController.abort(new Error(`逾時（超過 ${timeoutMs / 1000} 秒）`)), timeoutMs);

    const started = performance.now();
    try {
        const send = mode === 'profile' ? sendViaProfile : mode === 'custom' ? sendViaCustom : sendViaST;
        const aborted = new Promise((_, reject) => {
            linked.signal.addEventListener('abort', () => reject(linked.signal.reason instanceof Error ? linked.signal.reason : new Error('已取消')));
        });
        const res = await Promise.race([send({ system, user, maxTokens, signal: linked.signal }), aborted]);
        entry.output = res.text;
        entry.reasoning = res.reasoning;
        entry.outputTokens = await countTokens(res.text + res.reasoning);
        if (!res.text.trim()) throw new Error('AI 回傳了空白內容');
        return { text: res.text, reasoning: res.reasoning, logEntry: entry };
    } catch (e) {
        const cause = e?.cause?.message ? `（${e.cause.message}）` : '';
        entry.error = `AI 呼叫失敗：${e?.message || e}${cause}`;
        throw new Error(entry.error, { cause: e });
    } finally {
        clearTimeout(timer);
        entry.durationMs = Math.round(performance.now() - started);
        emit();
    }
}

// ───────────────────────── JSON 解析（容錯） ─────────────────────────

/**
 * 從 AI 回覆中取出單一 JSON 物件。容錯處理 ```json 圍欄、<think> 區塊與前後雜訊。
 * @returns {object}
 */
export function parseJsonObject(text) {
    let s = String(text ?? '');
    s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence && fence[1].includes('{')) s = fence[1];

    const start = s.indexOf('{');
    if (start < 0) throw new Error('回覆中找不到 JSON 物件');
    const end = findMatchingBrace(s, start);
    if (end < 0) {
        throw new Error('JSON 不完整（可能被截斷了，可以到設定把「輸出上限」調高）');
    }
    const body = s.slice(start, end + 1);
    try {
        return JSON.parse(body);
    } catch {
        // 常見錯誤：結尾多逗號
        try {
            return JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
        } catch (e2) {
            throw new Error(`JSON 格式錯誤：${e2.message}`);
        }
    }
}

function findMatchingBrace(s, start) {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}
