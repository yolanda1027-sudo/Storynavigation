// 故事導航 — 讀取「柏宝书」記錄的故事時間（選用）
//
// 柏宝书提供唯讀的全域 API：globalThis.STBaiBaiBook（見其 PUBLIC_API.md，apiVersion 1）。
// 有裝就用來取得各樓層的故事時間；沒裝或出錯就回傳空字串，不影響其他功能。

function api() {
    const a = globalThis.STBaiBaiBook;
    return a && typeof a.getSnapshot === 'function' && Number(a.apiVersion) >= 1 ? a : null;
}

export function hasBaiBai() {
    return !!api();
}

/**
 * 某一樓的故事時間。
 * @param {number} floor 零基樓層
 * @param {'before'|'after'} at before＝不含這一樓，after＝含這一樓
 */
export function getBaiBaiTime(floor, at = 'after') {
    const a = api();
    if (!a || floor < 0) return '';
    try {
        const snap = a.getSnapshot({ floor, at });
        return String(snap?.state?.time ?? '').trim();
    } catch (e) {
        console.warn('[故事導航] 讀取柏宝书時間失敗', e);
        return '';
    }
}
