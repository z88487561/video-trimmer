# 本機影片無損裁切 PWA

在瀏覽器中以 FFmpeg WASM 的 stream copy 模式裁掉片頭／片尾；不重新編碼，影片不會上傳。第一次裁切會從 jsDelivr 下載並在瀏覽器快取 FFmpeg 核心（約 32 MB）；快取完成後可離線使用。

## 開啟與安裝

https://z88487561.github.io/video-trimmer/

## 無損裁切限制

`-c copy` 只複製既有影音封包，不會逐影格重新編碼。開始點可能需落在前一個關鍵影格，結束點及音訊也會受封包邊界影響，因此不能承諾精確到指定影格／毫秒。要求精準裁切時必須重新編碼。輸出維持來源副檔名，實際可處理容器與軌道依 FFmpeg WASM 核心支援而異。輸入以瀏覽器 WorkerFS 掛載，避免先把整個來源檔複製進記憶體；輸出檔仍需暫存在瀏覽器記憶體，超大型輸出受裝置可用記憶體限制。

## 執行核心與授權

FFmpeg WASM JavaScript client（`vendor/ffmpeg/`）採 MIT 授權。FFmpeg 核心不隨此工作區散佈；首次執行時從 `@ffmpeg/core@0.12.10` jsDelivr CDN 載入並快取到瀏覽器。該 FFmpeg 核心採 GPL-2.0-or-later，使用／重新散佈前請依其授權條款辦理。核心版本固定，影片檔案不會送至 CDN。
