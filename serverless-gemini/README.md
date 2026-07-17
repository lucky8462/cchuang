# 圖片轉 Word 表格（免後端版）

單一 `index.html` 檔案，完全在瀏覽器內運行，無需任何後端伺服器。

- **圖片辨識**：使用者自行輸入 Gemini API Key，前端直接呼叫 Gemini 1.5 Flash Vision API 辨識表格內容。
- **Word 產生**：使用 `docx` 套件（透過 unpkg CDN 載入瀏覽器版 UMD 版本），在瀏覽器記憶體內組出含跨欄合併（`columnSpan`）的表格，`Packer.toBlob` 產生 `.docx` 後直接觸發下載。
- **樣式**：Tailwind CSS（Play CDN）。

## 使用方式

直接用瀏覽器開啟 `index.html`，或部署到任何靜態網頁託管（GitHub Pages、Vercel、Netlify 皆可，不需要 build step）：

1. 到 [Google AI Studio](https://aistudio.google.com/apikey) 免費申請一組 Gemini API Key。
2. 貼到頁面上的「Gemini API Key」欄位（只會存在你瀏覽器的 LocalStorage，不會經過任何伺服器）。
3. 上傳一張或多張表格圖片，按「開始轉換」。
4. 完成後按「下載 .docx」。

## 與 `public/`（Node 後端版）的差異

本專案 repo 內同時有兩套實作：

- `public/` + `src/`：Node.js/Express 後端，OCR 用 Tesseract.js（免費、離線、不需 API Key），需要一台持續運行的伺服器（見根目錄 README 的 Render/Railway 部署說明）。
- `serverless-gemini/`（本資料夾）：純前端、無後端，OCR 用 Gemini API（免費額度，但需使用者自行申請並輸入 API Key），可用任何靜態網頁託管免費上線。

兩者是獨立的實作，各自運作，互不依賴。

## 已知限制

- 每個使用者需要自行申請並輸入 Gemini API Key；沒有金鑰無法使用。
- Gemini 免費額度有請求頻率限制，圖片數量多或短時間內重複使用可能會遇到限流錯誤。
- API Key 儲存在瀏覽器 LocalStorage 中，僅存在該瀏覽器/該裝置上；換瀏覽器或清除瀏覽資料需要重新輸入。
- 辨識準確度取決於 Gemini 模型本身，跨欄合併、直向合併（同欄跨多列）等結構皆由模型自行判斷後輸出，複雜或畫質差的表格仍可能需要事後在 Word 中手動微調。
