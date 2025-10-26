# (WIP) ReviewTool

專案頁面：[ReviewTool](https://zh.wikipedia.org/wiki/User:SuperGrey/gadgets/ReviewTool)

快捷評審小工具。

## 使用方式
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
     npm run build
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
