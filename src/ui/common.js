// 故事導航 — 介面共用小工具

import { ctx, getSetting } from '../state.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 目前展開中的卡片（重畫時保留展開狀態） */
export const openCards = new Set();

export function toast(type, msg) {
    const t = globalThis.toastr;
    if (t && typeof t[type] === 'function') t[type](msg, '故事導航');
    else console.log(`[故事導航] ${msg}`);
}

const debugLog = [];

export function getDebugLog() {
    return debugLog;
}

export function logDebug(level, message, detail) {
    debugLog.unshift({ time: new Date(), level, message, detail });
    if (debugLog.length > 30) debugLog.length = 30;
    if (level === 'error') console.error('[故事導航]', message, detail ?? '');
}

export async function confirmDialog(message) {
    const c = ctx();
    if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE) {
        const result = await c.callGenericPopup(`<div>${esc(message).replace(/\n/g, '<br>')}</div>`, c.POPUP_TYPE.CONFIRM);
        return result === c.POPUP_RESULT?.AFFIRMATIVE;
    }
    return window.confirm(message);
}

export function badge(text, kind = '') {
    return `<span class="story-nav-badge ${kind ? `story-nav-badge-${kind}` : ''}">${esc(text)}</span>`;
}

export function btn(action, label, { icon = '', cls = '', disabled = false, attrs = '', title = '' } = {}) {
    return `<button type="button" class="menu_button story-nav-btn ${cls}" data-action="${esc(action)}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''} ${attrs}>${icon ? `<i class="fa-solid ${icon}"></i>` : ''}<span>${esc(label)}</span></button>`;
}

/** 可展開的卡片 */
export function detailsCard(key, title, badges, body) {
    return `<details class="story-nav-card" data-card="${esc(key)}"${openCards.has(key) ? ' open' : ''}>
        <summary class="story-nav-card-summary"><span class="story-nav-card-title">${esc(title)}</span>
            <span class="story-nav-card-badges">${badges || ''}</span></summary>
        <div class="story-nav-card-body">${body}</div>
    </details>`;
}

/**
 * 全域設定欄位。path 可為 "injection.depth" 這種巢狀路徑。
 * type：number | bool | text | password | select | textarea
 */
export function settingsField(path, label, type, extra = {}) {
    const value = getSetting(path);
    const attrs = `data-setting="${esc(path)}" data-ftype="${esc(type)}"${extra.rerender ? ' data-rerender="1"' : ''}`;
    if (type === 'bool') {
        return `<label class="story-nav-check"><input type="checkbox" ${attrs}${value ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    }
    let control;
    if (type === 'number') {
        control = `<input type="number" class="text_pole story-nav-input" ${attrs} value="${esc(value)}" min="${extra.min ?? 0}"${extra.max !== undefined ? ` max="${extra.max}"` : ''}>`;
    } else if (type === 'select') {
        control = `<select class="text_pole story-nav-input" ${attrs}>${extra.options.map(([v, t]) =>
            `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    } else if (type === 'textarea') {
        control = `<textarea class="text_pole story-nav-input" rows="${extra.rows || 3}" ${attrs}>${esc(value)}</textarea>`;
    } else {
        control = `<input type="${type === 'password' ? 'password' : 'text'}" class="text_pole story-nav-input" ${attrs} value="${esc(value)}"${extra.placeholder ? ` placeholder="${esc(extra.placeholder)}"` : ''}${extra.list ? ` list="${esc(extra.list)}"` : ''} autocomplete="off">`;
    }
    return `<label class="story-nav-field"><span class="story-nav-label">${esc(label)}</span>${control}</label>`;
}

export function hint(text) {
    return `<div class="story-nav-hint">${esc(text)}</div>`;
}

export function pre(text, cls = '') {
    return `<pre class="story-nav-pre ${cls}">${esc(text)}</pre>`;
}
