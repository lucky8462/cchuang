# 圖片 OCR 轉 Word 系統

將照片或截圖中的表格，透過 OCR 辨識後轉換成可編輯、可複製文字的 Word（.docx）文件。支援一次上傳多張圖片、手動框出表格範圍與格線、以及辨識後逐格校對文字，確保產出的內容與原圖一致。

全部使用免費/開源套件建置：

- 後端：Node.js + Express
- OCR：[Tesseract.js](https://github.com/naptha/tesseract.js)（繁體中文 + 英文，離線執行，不需任何付費 API 金鑰）
- 圖片處理：[sharp](https://github.com/lovell/sharp)
- Word 產生：[docx](https://github.com/dolanmiu/docx)

## 系統需求

- Node.js 18 以上
- 約 30MB 磁碟空間（用於下載繁中/英文語言模型）

## 安裝

```bash
npm install
```

安裝時會自動：

1. 套用 `patches/` 內對 tesseract.js 的修補（修正部分環境下 WASM SIMD 造成的辨識錯誤/崩潰問題）
2. 下載 Tesseract 的繁體中文與英文語言模型到 `tessdata/`（僅需下載一次，之後離線執行）

若下載失敗（例如網路限制），可依終端機提示的網址手動下載 `chi_tra.traineddata.gz`、`eng.traineddata.gz` 並放到 `tessdata/` 資料夾。

## 執行

```bash
npm start
```

啟動後開啟瀏覽器造訪 `http://localhost:3000`。

## 使用流程

1. **上傳圖片**：拖曳或選擇一張或多張圖片，可個別旋轉（若照片方向不正）。
2. **設定格線**：系統會先自動偵測表格格線做為初始建議，接著請對照原圖，拖曳紅線（列）／藍線（欄）調整到與實際表格邊界完全吻合，格線最外框請只框住實際表格內容（排除照片中其餘畫面，例如工具列、多餘留白）。可用「新增列線／新增欄線」增加線條、雙擊線條可刪除。
3. **校對內容**：按「開始辨識」，系統會逐格裁切、放大並個別辨識文字（此法比整張圖辨識準確許多），辨識信心較低的儲存格會以橘色標示，請對照左側原圖逐一確認並直接點擊儲存格修改文字。如需合併儲存格（例如跨欄的標題），拖曳選取範圍後按「合併選取儲存格」；已合併者可選取後按「取消合併」還原。
4. 多張圖片可個別完成後，於「產生 Word 文件」輸入檔名並下載，所有圖片會依序合併成同一份 Word 文件（各自一個表格）。

產出的 Word 文件中的表格為真正的 Word 表格（非圖片），文字皆可自由編輯與複製。

## 部署給別人使用（Render / Railway）

這個系統需要一台「持續運作」的伺服器（會在記憶體中保留已上傳的圖片與 OCR 引擎狀態），不適合純靜態或 serverless 平台，但很適合 Render、Railway 這類會啟動一個持續運行容器的平台，程式碼不需要修改。

### Render

1. 到 [render.com](https://render.com) 用 GitHub 帳號登入，選擇這個 repository。
2. Render 會偵測到 repo 內的 `render.yaml` 並自動帶入設定（build command: `npm install`，start command: `npm start`，分支：`claude/image-ocr-to-word-z82aqf`）。若要手動設定，Runtime 選 Node，其餘同上。
3. 選擇免費方案（Free）即可，部署完成後 Render 會給一個 `https://xxx.onrender.com` 的公開網址，貼給別人就能用。
4. 免費方案閒置一段時間會休眠，下次有人開啟時需要等待約 30-60 秒喚醒（之後 OCR 引擎還會再花約 30-90 秒初始化，此為程式啟動時自動處理，無需手動操作）。

### Railway

1. 到 [railway.app](https://railway.app) 用 GitHub 帳號登入，選擇這個 repository 與分支。
2. Railway 會自動偵測 Node.js 專案，直接使用 `package.json` 裡的 `start` 指令，通常不需要額外設定。
3. 部署完成後在 Settings 產生一個公開網域（Generate Domain），即可取得公開連結。

兩個平台都有免費額度，但都是「共用資源」等級，多人同時上傳/辨識圖片時速度會變慢；若使用量增加，建議升級到付費方案取得更穩定的 CPU 資源（OCR 運算較吃 CPU）。

## 已知限制

- 自動格線偵測僅供參考起點，對於翻拍模糊、反光或傾斜的照片可能不準確，請務必手動核對調整。
- OCR 辨識準確度取決於照片清晰度與格線是否精確對齊；系統以「逐格辨識 + 人工校對」的流程確保最終輸出正確，而非完全仰賴自動辨識。

## 專案結構

```
src/
  server.js          Express 進入點
  lib/
    imageStore.js    圖片上傳後的正規化與暫存
    gridDetect.js     自動格線偵測（起始建議用）
    cellOcr.js         單一儲存格裁切 + 前處理 + OCR
    ocrWorker.js       Tesseract worker pool
    docxBuilder.js     依表格結構產生 .docx
  routes/
    images.js, ocr.js, export.js
public/               前端頁面（原生 HTML/CSS/JS，無框架依賴）
scripts/download-tessdata.js  下載語言模型
patches/              tesseract.js 的修補檔（by patch-package）
```
