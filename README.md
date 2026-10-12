# 故事導航 Story Navigator

SillyTavern 第三方 UI 擴充。在主聊天之外維護「劇情導航＋幕後推手」，讓重要 NPC／勢力在玩家沒參與時也持續追求自己的目標，並把適合揭露的後果以背景事實交給主模型。

插件**不**替玩家決策、**不**模擬瑣碎日常、**不**改寫角色卡與世界書、**不**強行拉回原著。

> 目前進度：**Phase 1｜骨架（不呼叫 AI）**

## 安裝

1. 酒館右上角「擴充功能」（積木圖示）→ **Install Extension**
2. 貼上 `https://github.com/yolanda1027-sudo/Storynavigation`
   - 若要安裝開發分支，在分支欄位填 `claude/new-session-sqahhz`
3. 安裝完重新整理頁面

更新：擴充功能 → Manage Extensions → 故事導航旁的更新按鈕，然後重新整理。

## 在哪裡打開

- **擴充設定區**：擴充功能面板右欄的「故事導航」抽屜
- **浮動視窗**：聊天輸入框左邊的魔杖選單 →「故事導航」，或面板上的「浮動視窗」按鈕（手機上會佔滿螢幕寬度）

## Phase 1 功能

| 分頁 | 內容 |
| --- | --- |
| 劇情導航 | 主線／支線（所有欄位可編輯）、劇情節點（手動）、變化紀錄（可回到任一步） |
| 幕後推手 | 推手資料、knowledge、相關路線、最新行動（取自世界事件） |
| 世界事件 | 「真相／可察覺後果」兩欄、玩家是否已知、誰知道 |
| 推進控制 | 模式、世界時間、自動推進頻率（預設 5）、支線／推手上限（預設 3／3）（Phase 1 只儲存；推進按鈕 Phase 2 開放） |
| 設定與資料 | 匯出／匯入 JSON、刪除此聊天資料、復原紀錄份數、輸入預算（預設 8000）／輸出上限（預設 3000）、debug（錯誤紀錄、原始資料） |

- 資料存在每個聊天的 `chatMetadata.storyNavigator`，不同聊天互不影響。
- 每次修改（離開欄位時）存一份快照，可復原／重做，預設保留 30 份。
- 匯入前會先驗證；格式不對時不會動到現有資料，錯誤會出現在 debug 區。

## 檔案結構

```
manifest.json
index.js            入口：註冊事件、掛 UI
src/state.js        狀態讀寫、快照、undo/redo、驗證
src/ui/panel.js     介面（五分頁、浮動視窗）
templates/panel.html
style.css
```

之後的 Phase 會加入 `src/reader.js`、`src/llm.js`、`src/prompts.js`、`src/navigator.js`、`src/actors.js`、`src/detector.js`、`src/injector.js`。
