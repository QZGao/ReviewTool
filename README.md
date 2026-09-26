# ReviewTool

專案頁面：[ReviewTool](https://zh.wikipedia.org/wiki/User:SuperGrey/gadgets/ReviewTool)

條目評審小工具。具有3大功能：

1. 條目文筆批註。
   - 在條目頁，開啟「批註模式」後，選擇文字進行批註。
   - （批註本地儲存於瀏覽器中，暫不具備同步功能；可匯出為JSON檔。）
2. 快速添加條目評審子章節。
   - 自動識別討論頁/評選頁2級標題，若2級標題含「乙(上)級評審(選)」、「優良條目(級)評審(選)」、「甲級評審(選)」、「典範條目(級)評審(選)」等字樣，則載入「管理評審」面板。
   - 在「管理評審」面板中，自由選取想要評審的條目標準，建立子章節（3級或4級標題）。
3. 格式化文筆評審。
   - 自動識別討論頁/評選頁3/4級標題中的「文筆」字樣，載入「檢查文筆」面板。
   - 在「檢查文筆」面板中，編輯文筆意見，或從已有批註（或備份JSON檔）匯入。儲存文筆意見到評審區。

## 使用方式

### 在 Chrome 測試即時頁面

執行 `npm run dev:chrome`，以 Playwright 啟動 Chrome 並載入本機建構的擴充功能；預設使用正常模式及真正的 MediaWiki API。

執行 `npm run dev:chrome:dry` 可使用乾跑模式：讀取維基資料，但修改只存於該測試瀏覽器的本機資料庫。JavaScript 內含 source map，可在 DevTools 中除錯 TypeScript。

完整指令、模式差異及驗證方式見 [Live Chrome development](tests/live/README.md)。

### 發行版本

将如下程式碼复制至 [User:你的用戶名/common.js](https://zh.wikipedia.org/wiki/Special:MyPage/common.js) 頁面：

```js
importScript('User:SuperGrey/gadgets/ReviewTool/main.js');  // Backlink: [[User:SuperGrey/gadgets/ReviewTool]]
```

### 從原始碼建構

1. **安裝 Node.js**
   - 請先安裝 [Node.js](https://nodejs.org/)。

2. **安裝依賴套件**
   - 在 ReviewTool 目錄下執行：

     ```sh
     npm install
     ```

3. **建構 Bundled 版本**
   - 執行下列指令以產生 `dist/bundled.js`：

     ```sh
     npm run release
     ```

   - 若需持續監看檔案變動並自動重建，請執行：

     ```sh
     npm run watch
     ```

4. **安裝至維基**
   - 將 `dist/bundled.js` 上傳至你的維基用戶頁面，例如 [User:你的用戶名/ReviewTool.js](https://zh.wikipedia.org/wiki/Special:MyPage/ReviewTool.js)。
   - 在 [User:你的用戶名/common.js](https://zh.wikipedia.org/wiki/Special:MyPage/common.js) 頁面加入：

     ```js
     importScript('User:你的用戶名/ReviewTool.js');  // 修改為你的用戶名
     ```
