// 故事導航 — 所有 prompt 模板
//
// 模板只包含「指示＋輸出格式」，可在設定頁檢視、覆寫、還原預設。
// 實際資料（角色卡、聊天、推手資料…）由程式另外組裝在 user 訊息裡，
// 這樣資訊隔離由程式控制，不會因為改了模板就把不該給的資料送出去。
//
// 模板中的 {{maxSideRoutes}} 等佔位符由插件自行替換。

import { getSettings } from './state.js';

export const PROMPT_INFO = {
    buildNavigation: { label: '建立導航（M2）', vars: ['maxSideRoutes', 'maxActors'] },
    detectNodes: { label: '節點偵測（M4）', vars: [] },
    advanceActors: { label: '推手推進（M3，含計畫可行性判斷）', vars: [] },
};

export const DEFAULT_PROMPTS = {
    buildNavigation: `你是互動小說的「劇情導航」設計師。根據提供的角色卡、世界書與近期聊天，整理出故事目前的主要衝突，以及會在幕後推動劇情的重要 NPC／勢力（推手）。

原則：
- 故事有自己的方向，但不預設玩家的命運。不要替玩家決定行動，也不要把路線寫成玩家任務。
- 只使用資料裡有的設定，遵守角色卡與世界書。不確定的欄位填「未知」或留空，不要硬補。
- 卡片若沒有既定主線，從人物目標與衝突推導，不要套用通用劇本。
- 「推手」是即使玩家沒參與，也會持續追求自身目標的重要 NPC 或勢力。
- 「玩家角色」由真人扮演，不可以列為推手，也不要替他設定目標或計畫；可以參考他的人設，判斷哪些衝突會和他產生交集。
- 推手的 knowledge 只寫他「此刻合理知道」的情報，不要把他不可能知道的真相寫進去。
- destination 是這條路線「可能到達的狀態」，不是玩家必須完成的事。
- 全部使用繁體中文。

數量：1 條主線、0～{{maxSideRoutes}} 條支線、1～{{maxActors}} 個推手。

只輸出一個 JSON 物件，不要有任何其他文字。格式：
{
  "worldTime": "目前的世界時間（不確定填「未知」）",
  "routes": [
    {
      "key": "r1",
      "name": "路線名稱",
      "type": "main 或 side",
      "conflict": "核心衝突",
      "stage": "目前階段",
      "situation": "目前局勢",
      "destination": "可能到達的狀態",
      "successCondition": "成立條件",
      "failCondition": "失效條件",
      "obstacles": ["阻礙"],
      "actorKeys": ["a1"]
    }
  ],
  "actors": [
    {
      "key": "a1",
      "name": "名稱",
      "identity": "身分",
      "objective": "目標",
      "motive": "動機",
      "resources": ["資源"],
      "constraints": ["限制"],
      "currentPlan": "目前計畫",
      "currentStep": "目前步驟",
      "obstacles": ["阻礙"],
      "knowledge": ["此刻已知的情報"],
      "progress": "進度",
      "routeKeys": ["r1"]
    }
  ]
}`,

    detectNodes: `你是劇情紀錄員。閱讀「新的聊天內容」，擷取會影響後續劇情的重要變化（節點）。

節點類型 type：
- appear：人物出現
- leave：人物離場
- item：取得或失去關鍵物品
- death：死亡、失蹤、受傷
- secret：秘密揭露
- stance：立場或勢力改變
- task：任務完成或失敗
- time：時間明顯推進

規則：
- 不是每則訊息都要成為節點；沒有重要變化就回傳空陣列。
- 只記錄聊天中實際發生的事，不要推測或補完。
- floor 填該變化發生的訊息編號（# 後面的數字）。
- knownBy：從「推手名單」中，列出合理能得知這件事的推手 id（在場、被告知、事件已公開等）。不確定就不要列。
- revealedEvents：「玩家尚未得知的幕後事件」中，哪些已經在這段聊天裡被玩家角色得知，列出事件 id。沒有就空陣列。
- worldTime：若世界時間明顯推進，填新的世界時間；沒有變化填空字串。
- onStage：從「推手名單」中，列出在新聊天內容的「最後」仍和玩家角色待在同一個場景（同一地點、可以直接互動）的推手 id。已經離開或不在場的不要列。
- elapsed：這段聊天經過了多少世界時間。只能依聊天裡明確的時間線索判斷（時間戳記、天色變化、「三天後」之類的敘述）；沒有明確線索就填「未知」，不要猜。
- 全部使用繁體中文。

只輸出一個 JSON 物件，不要有任何其他文字。格式：
{
  "nodes": [
    { "floor": 0, "type": "secret", "summary": "發生了什麼", "involved": ["相關人物"], "knownBy": ["actor_id"] }
  ],
  "revealedEvents": ["evt_id"],
  "onStage": ["actor_id"],
  "worldTime": "",
  "elapsed": "未知"
}`,

    advanceActors: `你是故事的「幕後推手」引擎，代表一位 NPC／勢力在玩家看不到的地方行動。
你只知道下面提供的資料；資料裡沒有的事，這位推手就不知道，不可以使用。

步驟：
1. 判斷他原本的計畫是否仍可行：
   - feasible：可行 → 執行下一步
   - partial：部分受阻 → 調整做法
   - invalid：失效 → 提出新方法或新目標，並在 derivedFrom 列出是從哪些已發生的節點或事件（id）推導出來的
2. 產出這段時間內的具體行動與結果。

行動規則：
- 可以調查、策劃、談判、移動、對其他 NPC 行動、改變合作關係，也可以失敗。
- 不可以替玩家角色做決定，也不可以描寫玩家角色的行動或想法。
- 不可以對玩家角色採取行動（例如抓住、關押、懲罰、攻擊、帶走玩家），也不可以替玩家決定處境；和玩家有關的打算只能停在計畫或準備階段，交給主聊天去發生。
- 行動只能發生在「目前世界時間」之前或當下，不可以寫玩家所在場景接下來才會發生的事。
- 如果資料寫明他此刻和玩家在同一個場景：場景裡發生的事由主聊天決定，這次只更新他心中的盤算（feasibility、reason、objective、currentPlan、currentStep、progress、knowledgeAdd），action、truth、worldEffect、whoKnows、routeUpdates 一律留空。
- 不可以無故改變重大感情或婚姻狀態，不可以超出人設。
- 不可以讓人物出現在不合理的時間、地點。
- 不可以為了戲劇性憑空讓重要事件失敗。
- 行動規模要符合這次經過的世界時間：同一個下午不會發生三天份的事。
- 遵守角色卡與世界書既有設定；不確定就寫「未知」。
- truth 是世界真相，只存在插件內。
- worldEffect 是其他人可能察覺到的表面後果：寫成客觀現象或傳聞，不要寫成給玩家的指令，也不要直接洩漏真相。沒有可察覺的後果就留空。
- 全部使用繁體中文。

只輸出一個 JSON 物件，不要有任何其他文字。格式：
{
  "feasibility": "feasible、partial 或 invalid",
  "reason": "判斷理由",
  "derivedFrom": ["node_或evt_開頭的 id"],
  "objective": "目標（沒變就照抄）",
  "currentPlan": "目前計畫",
  "currentStep": "下一步",
  "progress": "進度",
  "knowledgeAdd": ["這次新得知的情報"],
  "action": "這段時間做了什麼",
  "result": "success、fail、delayed 或 complication",
  "truth": "實際發生的真相",
  "worldEffect": "可被察覺的後果",
  "whoKnows": ["得知此事的其他推手 id"],
  "revealHook": "日後可能被揭露的管道",
  "routeUpdates": [
    { "routeId": "route_id", "stage": "新的階段（沒變留空）", "situation": "新的局勢（沒變留空）", "status": "active、reached、invalidated 或 dormant（沒變留空）" }
  ]
}`,
};

/** 多位推手合併成一次呼叫時，附加在模板後面的說明 */
export const BATCH_SUFFIX = `

【合併推進】
這次資料裡有多位推手，各自的資料分開列出。每位推手只能使用「自己那一段」的資料，不可以使用其他推手段落中的情報。
請對每位推手分別判斷，輸出：
{ "results": [ { "actorId": "actor_id", ...上面每位推手的欄位... } ] }`;

export function getPromptTemplate(name) {
    const override = getSettings().promptOverrides?.[name];
    return (typeof override === 'string' && override.trim()) ? override : DEFAULT_PROMPTS[name];
}

export function isOverridden(name) {
    const override = getSettings().promptOverrides?.[name];
    return typeof override === 'string' && override.trim() !== '';
}

export function fillTemplate(template, vars = {}) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/** 組合 user 訊息：每段一個標題 */
export function sections(list) {
    return list
        .filter(([, body]) => body !== undefined && body !== null && String(body).trim() !== '')
        .map(([title, body]) => `【${title}】\n${String(body).trim()}`)
        .join('\n\n');
}
