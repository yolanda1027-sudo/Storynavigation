// 故事導航 — 從畫面上的資料直接下載目前聊天（不經過伺服器）
//
// 酒館存檔卡住時，還沒存到的訊息只在瀏覽器的記憶體裡；酒館內建的「匯出聊天」是從伺服器硬碟讀檔，匯出的會是舊的。
// 這裡照酒館自己存檔的格式（第一行是聊天設定，之後每行一則訊息）產生 .jsonl，
// 可以用酒館的「匯入聊天」匯回去。只讀取資料，不修改任何東西。

import { ctx } from './state.js';

/**
 * 下載目前聊天。
 * @returns {{fileName: string, count: number}}
 */
export function downloadCurrentChat() {
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    const chat = c.chat || [];
    if (!chatId || !chat.length) throw new Error('目前沒有開啟聊天');

    const metadata = JSON.parse(JSON.stringify(c.chatMetadata || {}));
    // 比照酒館建立分支：換一組新的完整性標記，匯入後不會和原本的聊天檔互相干擾
    if (typeof c.uuidv4 === 'function') metadata.integrity = c.uuidv4();
    const header = { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
    const text = [header, ...chat].map(x => JSON.stringify(x)).join('\n');

    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    const safeName = String(chatId).replace(/[\\/:*?"<>|]+/g, '_');
    const fileName = `${safeName}（備份 ${stamp}）.jsonl`;

    // 用 octet-stream，避免手機瀏覽器把它當文字檔打開或改副檔名
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { fileName, count: chat.length };
}
