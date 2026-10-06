# 聲譯 · 即時繁體中文字幕

免安裝網頁 App：擷取英文分頁／系統／麥克風音訊，透過 Gemini 即時轉錄並逐句翻譯，提供中英雙語字幕、置頂浮動字幕及 SRT 下載。

## 本機啟動

開發者電腦需 Node.js 22.12 或以上。使用者只需要瀏覽器；正式部署後使用者無須安裝 Node.js。

```powershell
cd C:\Users\aaron\Documents\translate
npm install
Copy-Item .env.example .env.local
# 用本機編輯器填寫 .env.local 的 GEMINI_API_KEY，請勿貼到聊天、Git 或前端程式。
npm run dev
```

開啟 http://localhost:3000。修改 `.env.local` 後必須重新啟動服務。若 `.env.local` 已存在，保留現有檔案，不要覆寫。

亦支援把金鑰放在 `.env`。金鑰優先使用程序環境變數，其次 `.env.local`，最後 `.env`；空白金鑰欄位會略過，不會遮住下一個來源的有效金鑰。不要把兩個設定檔提交到版本控制。

正式建置及本機驗證：

```powershell
npm run build
npm start
```

## 使用方式

1. 在電腦 Chrome／Edge 播放英文影片或加入會議。
2. 預設收錄電腦聲音：直接按「開始翻譯」，在 Windows 分享視窗點選一個螢幕、開啟「分享系統音訊」，再按 Share。網站不能省略瀏覽器的來源選擇及授權。
3. 如要只收錄影片／網頁版 Zoom、Teams，展開「更改聲音來源」，選「網上影片」，按開始後選對應分頁並勾選「分享分頁音訊」；亦可改用麥克風。選單依作業系統與瀏覽器而異；若沒有系統音訊選項，改用網頁版會議。系統音訊會包含其他程式的通知及聲音，使用者應選擇適當來源。
4. 可另外勾選麥克風，以收錄自己的英文發言。系統音訊通常只包含其他與會者。建議使用耳機避免回音；不要把相同聲音重複收錄。
5. 開啟「浮動字幕」並移動視窗。使用 Document Picture-in-Picture；屬於瀏覽器置頂視窗，非透明穿透桌面覆蓋層。部分全螢幕／手機／瀏覽器環境不支援，回退為本頁字幕。
6. 停止後等最後幾句字幕完成，再下載 SRT。重新開始或重新整理會清除本頁紀錄。

畫面影像僅用來維持瀏覽器分享授權，不會傳送到 Gemini。只有 PCM 音訊及翻譯所需的短文字前文送到 Gemini。伺服器不寫入錄音或字幕；Google 如何處理輸入資料依你的 API 帳戶方案與條款而定。

## 模型及費用

- 英文轉錄：`gemini-3.5-transcribe-live`，16 kHz、單聲道、16-bit little-endian PCM，約 100 ms 一包。
- 文字翻譯：`gemini-3.5-flash-lite`，繁體中文及香港常用詞、最多四句有限前文、minimal thinking。
- 暫定英文先翻譯成標示「即時預覽」的中文，最頻繁每 1.2 秒開始一次預覽請求；新內容只保留最新一份，最多一個預覽請求執行中。預覽可能隨語句修正，不會寫入字幕紀錄或 SRT。
- 正式英文完成後，另外翻譯並寫入字幕紀錄；預覽請求不會阻塞正式翻譯，遲到或已被英文修正否定的預覽不會覆蓋正式字幕。取消每 6 秒强制切斷音訊，避免截掉字詞；無聲約 650 ms 或停止時送出完成訊號。
- 不能保證固定 1–3 秒延遲；包含語句切分、轉錄、翻譯及網絡延遲，需以實際帳戶及音訊量測。
- 9 分鐘更新轉錄連線，更新時最多暫存 10 秒音訊。斷線最多嘗試恢復 3 次；持續失敗會停止並明確顯示。
- 預設每次 120 分鐘、最多 3 個同時使用者。可透過環境變數調整。
- UI 費用為估算：音訊按 PCM 時長×25 tokens/秒；轉錄文字按約 4 字元/token 估算；翻譯採 API 回傳 token 數。依 2026-10-06 官方標準費率計算，不等於帳單，換其他模型後估算也可能不準確。
- 原本只翻譯正式字幕時，10 分鐘估算約 US$0.10–0.15。即時中文預覽會增加文字翻譯請求，現在費用較高，依說話長度、更新頻率和上下文而變；UI 估算包括已回傳的預覽與正式翻譯 token，未回傳用量的取消／重試不能當作精確帳單。
- SRT 時間戳記按音訊收到及轉錄完成時估算；不提供精確字詞定位，亦不會讀取 YouTube 或會議的原始影片時間。

模型名稱可在 `.env.local` 更改；轉錄模型必須支援 Transcribe Live 的 TEXT 模式及相同事件格式。金鑰存在只表示伺服器已設定，不代表 API 權限、配額及模型可用性已通過真實測試。

官方參考：

- [即時轉錄](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
- [Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Gemini API 定價](https://ai.google.dev/gemini-api/docs/pricing)
- [瀏覽器分享音訊](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)

## 正式網址部署

專案包含可部署的 Node.js 服務；目前沒有公開網址。部署時：

1. 在 Node.js 主機執行 `npm ci`、`npm run build`、`npm start`。
2. 設定 `HOST=0.0.0.0`、伺服器端 `GEMINI_API_KEY`，以及至少 16 字元的隨機 `APP_ACCESS_CODE`。對外綁定但沒有密碼時服務會拒絕啟動。

   若管理員指定較短的使用密碼，需明確設定 `ALLOW_SHORT_ACCESS_CODE=true`；預設仍要求至少 16 字元，公開部署始終不可使用空白密碼。
3. 使用 HTTPS 反向代理，支援 `/api/live` WebSocket Upgrade，並保留原始 Host。瀏覽器收音與浮動字幕需要 secure context。
4. 非 API 頁面只提供建置檔案，`.env`、原始碼及私密檔案不會由正式服務提供。金鑰不會傳到瀏覽器。
5. 透過共享使用密碼登入，cookie 為 HttpOnly／SameSite=Strict。這是私人試用版入口，未包含個人帳戶、付款、個人配額及多伺服器共享狀態。公開商業服務需要再實作這些功能。

前端、API 與 WebSocket 必須同源。共享密碼驗證的 session 簽名在服務重啟後失效。已有的串流會於離線／停止／用量上限時釋放。不要在公共網絡部署開發模式。

## 檢查及真實驗收

```powershell
npm run typecheck
npm test
npm run build
```

自動測試涵蓋 16／44.1／48 kHz 音訊轉換、立體聲混合、字幕更新、SRT、錯誤遮罩、登入及來源檢查、翻譯顺序／取消、模型連線輪替及停止流程。測試中的模擬 Gemini 回應只用於測試，App 沒有假翻譯模式。

設定金鑰後需人工驗收：

- 播放英文影片，核對否定句、數字、姓名及術語是否保留。
- 以秒錶測量聲音到中文顯示的延遲；不中斷發言及背景噪音亦要測試。
- 在 Zoom／Teams 核對對方聲音及自己的麥克風選項，避免重複收音。
- 持續至少 12 分鐘，確認工作階段輪替及音訊接續。
- 取消分享、停止／重啟、關閉浮動視窗、拔除音訊設備、暫時斷網及配額錯誤。
- 比較本次估算與 Gemini 實際用量；字幕預覽／API 測試不能代替真實音訊品質驗收。

目前缺少金鑰時，畫面會顯示服務尚未設定並停用開始按鈕，不會假裝完成翻譯。

### 2026-10-06 真實 API 驗證

已使用設定的 Gemini 帳戶確認兩個預設模型可用，並通過文字翻譯及後端即時音訊整條流程測試。測試為自行產生的約 4.87 秒英文語音，成功得到英文轉錄及繁體中文字幕，保留上午 10:00 和「切勿分享密碼」的原意。未收錄使用者麥克風或私人會議。

型別檢查及 19 項自動測試通過，包括空白 `.env.local` 遮住 `.env` 金鑰的回歸測試。瀏覽器已確認開始按鈕啟用；實際影片／Zoom／Teams 收音、長會議連線輪替、浮動字幕及延遲仍需在使用者的獨立桌面瀏覽器驗收。
# translation

## Contabo VPS 部署

部署目錄 `/root/apps/translation`，Compose project `translation`、service `translation-app`、container `translation_app`。只綁定 `127.0.0.1:5440:8000`，外部由既有 HTTPS Nginx 提供 `/translation/`。

前端建置時設定 `APP_BASE_PATH=/translation/`，API、WebSocket、worklet 和資源網址都帶這個 prefix。`deploy/nginx-location.conf` 的 `proxy_pass` 帶尾斜線，移除 prefix 後轉送 Express 根路徑；不要再由 Express 加一次 prefix。登入 cookie 限定於 `/translation/`。

安全建立權限 `600` 的 `.env.production`，放入 `GEMINI_API_KEY`、至少 16 字元的 `APP_ACCESS_CODE`、轉錄及翻譯模型名稱。不要輸出、提交或把 env 放進 Docker image。Compose 的 `TRUST_PROXY=true` 只適用於這個單一 Nginx 代理；Nginx 覆寫 `X-Forwarded-For`，應用程式按真實來源 IP 限制登入嘗試。

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:5440/api/health
```

Docker build 會執行測試、型別檢查、production build 和 `check:deployment`（使用假金鑰，不呼叫 Gemini）。健康檢查只確認 HTTP 服務及金鑰已設定，不代表 Gemini 配額可用。

修改既有 Nginx 前先建立時間戳備份，只加入 translation locations；`nginx -t` 通過才 reload。公開健康檢查為 `https://www.4mstrategy.com/translation/api/health`。部署或重啟會結束當前翻譯連線，並需要重新登入。

此 App 沒有資料庫、uploads 或音訊／字幕檔案。應用程式僅輸出服務狀態到 stdout，Docker `local` 日誌保存在 host，限制每檔 10 MB、最多 3 檔。容器以非 root、唯讀 filesystem 執行，臨時檔使用獨立 tmpfs；將來新增檔案資料時必須另掛 host／named volume。

部署前確認 port 空閒、磁碟和記憶體，記錄其他容器 ID。部署後檢查 Git SHA、容器 health、internal/public HTTP、登入、WebSocket 及其他容器 ID 未改變；不要 rebuild 或 restart 其他 Compose projects。

技術依據：[Vite base path](https://vite.dev/guide/build#public-base-path)、[Nginx WebSocket proxy](https://nginx.org/en/docs/http/websocket.html)。
