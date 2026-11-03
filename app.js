import { FFmpeg } from "./vendor/ffmpeg/classes.js";

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_CACHE = `video-trimmer-ffmpeg-core-${CORE_VERSION}`;

const elements = {
    file: document.getElementById("videoFile"),
    preview: document.getElementById("preview"),
    fileName: document.getElementById("fileName"),
    duration: document.getElementById("durationLabel"),
    start: document.getElementById("startTime"),
    end: document.getElementById("endTime"),
    markStart: document.getElementById("markStart"),
    markEnd: document.getElementById("markEnd"),
    trim: document.getElementById("trimButton"),
    status: document.getElementById("status"),
    download: document.getElementById("downloadLink"),
    install: document.getElementById("installButton"),
    pwaStatus: document.getElementById("pwaStatus")
};

let selectedFile = null;
let previewUrl = null;
let outputUrl = null;
let ffmpeg = null;
let isBusy = false;
let installPrompt = null;
let recentFfmpegLogs = [];

function setStatus(message, state = "") {
    elements.status.textContent = message;
    elements.status.dataset.state = state;
}

function setBusy(busy) {
    isBusy = busy;
    elements.trim.disabled = busy || !selectedFile;
    elements.file.disabled = busy;
    elements.start.disabled = busy;
    elements.end.disabled = busy;
    elements.markStart.disabled = busy || !selectedFile;
    elements.markEnd.disabled = busy || !selectedFile;
}

function clearDownload() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = null;
    elements.download.removeAttribute("href");
    elements.download.hidden = true;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const remainder = seconds - hours * 3600 - minutes * 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function formatFileSize(bytes) {
    return bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${(bytes / 1024).toFixed(1)} KB`;
}

function safeExtension(name) {
    const match = name.match(/\.([a-z0-9]{1,8})$/i);
    if (!match) throw new Error("無法判斷影片副檔名，請使用常見影片格式。");
    return `.${match[1].toLowerCase()}`;
}

function markTime(input) {
    if (!Number.isFinite(elements.preview.currentTime)) return;
    input.value = elements.preview.currentTime.toFixed(2);
}

function readTrimRange() {
    const start = Number(elements.start.value);
    const end = Number(elements.end.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error("請輸入有效的開始及結束時間，且結束時間必須大於開始時間。");
    }
    if (Number.isFinite(elements.preview.duration) && end > elements.preview.duration) {
        throw new Error("結束時間不可超過影片長度。");
    }
    return { start, end };
}

async function fetchCoreAsset(url, contentType) {
    let response;
    if ("caches" in window) {
        const cache = await caches.open(CORE_CACHE);
        response = await cache.match(url);
        if (!response) {
            setStatus("正在下載影片處理引擎（首次約 32 MB）…", "busy");
            response = await fetch(url);
            if (!response.ok || response.type === "opaque") {
                throw new Error(`無法取得處理引擎：HTTP ${response.status}`);
            }
            await cache.put(url, response.clone());
        }
    } else {
        setStatus("正在下載影片處理引擎（首次約 32 MB）…", "busy");
        response = await fetch(url);
        if (!response.ok || response.type === "opaque") {
            throw new Error(`無法取得處理引擎：HTTP ${response.status}`);
        }
    }
    return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: contentType }));
}

async function ensureEngine() {
    if (ffmpeg?.loaded) return ffmpeg;
    if (!window.isSecureContext || !("Worker" in window)) {
        throw new Error("影片處理引擎需要安全來源，請以 localhost 或 HTTPS 開啟此 PWA。");
    }
    const coreUrl = `${CORE_BASE}/ffmpeg-core.js`;
    const wasmUrl = `${CORE_BASE}/ffmpeg-core.wasm`;
    const [coreBlobUrl, wasmBlobUrl] = await Promise.all([
        fetchCoreAsset(coreUrl, "text/javascript"),
        fetchCoreAsset(wasmUrl, "application/wasm")
    ]);
    try {
        ffmpeg = new FFmpeg();
        ffmpeg.on("log", ({ message }) => {
            if (message) {
                recentFfmpegLogs.push(message);
                if (recentFfmpegLogs.length > 6) recentFfmpegLogs.shift();
                elements.status.textContent = `正在本機處理：${message.slice(0, 180)}`;
            }
        });
        await ffmpeg.load({ coreURL: coreBlobUrl, wasmURL: wasmBlobUrl });
        return ffmpeg;
    } catch (error) {
        if (ffmpeg) {
            try {
                await ffmpeg.terminate();
            } catch (cleanupError) {
                console.error("無法清除未載入的 FFmpeg Worker：", cleanupError);
            }
        }
        ffmpeg = null;
        throw new Error(`處理引擎載入失敗：${error.message}`);
    } finally {
        URL.revokeObjectURL(coreBlobUrl);
        URL.revokeObjectURL(wasmBlobUrl);
    }
}

async function trimVideo() {
    if (isBusy || !selectedFile) return;
    clearDownload();
    let saveHandlePromise = null;
    let range;
    let extension;
    const baseName = selectedFile.name.replace(/\.[^.]+$/, "") || "video";
    try {
        range = readTrimRange();
        extension = safeExtension(selectedFile.name);
        if ("showSaveFilePicker" in window) {
            saveHandlePromise = window.showSaveFilePicker({
                suggestedName: `${baseName}_trimmed${extension}`
            });
        }
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), "error");
        return;
    }

    setBusy(true);
    let mounted = false;
    let inputDirectoryCreated = false;
    let engine;
    const mountPoint = "/local-video";
    const outputPath = "/trimmed-video";

    try {
        if (saveHandlePromise) setStatus("請選擇裁切影片的儲存位置…", "busy");
        const saveHandle = saveHandlePromise ? await saveHandlePromise : null;
        setStatus("正在準備本機處理引擎…", "busy");
        engine = await ensureEngine();
        await engine.createDir(mountPoint);
        inputDirectoryCreated = true;
        await engine.mount("WORKERFS", {
            blobs: [{ name: `source${extension}`, data: selectedFile }]
        }, mountPoint);
        mounted = true;

        const inputPath = `${mountPoint}/source${extension}`;
        const outputFile = `${outputPath}${extension}`;
        const duration = range.end - range.start;
        const args = [
            "-y", "-ss", range.start.toFixed(3),
            "-i", inputPath,
            "-t", duration.toFixed(3),
            "-map", "0",
            "-c", "copy",
            "-avoid_negative_ts", "make_zero"
        ];
        if ([".mp4", ".mov", ".m4v", ".3gp"].includes(extension)) {
            args.push("-movflags", "+faststart");
        }
        args.push(outputFile);

        setStatus("正在本機複製影音封包；請保持頁面開啟…", "busy");
        recentFfmpegLogs = [];
        const exitCode = await engine.exec(args);
        if (exitCode !== 0) {
            const details = recentFfmpegLogs.slice(-4).join(" | ");
            throw new Error(`裁切失敗（FFmpeg 結束碼 ${exitCode}）。${details}`);
        }

        const result = await engine.readFile(outputFile);
        if (!(result instanceof Uint8Array) || result.byteLength === 0) {
            throw new Error("處理完成但沒有輸出影片，請確認來源格式與裁切區間。");
        }
        await engine.deleteFile(outputFile);
        const outputBlob = new Blob([result], { type: selectedFile.type || "application/octet-stream" });
        const outputName = `${baseName}_trimmed${extension}`;
        if (saveHandle) {
            const writable = await saveHandle.createWritable();
            await writable.write(outputBlob);
            await writable.close();
            setStatus(`裁切完成，已儲存 ${saveHandle.name}（${formatFileSize(outputBlob.size)}）。`, "success");
        } else {
            outputUrl = URL.createObjectURL(outputBlob);
            elements.download.href = outputUrl;
            elements.download.download = outputName;
            elements.download.hidden = false;
            elements.download.click();
            const downloadUrl = outputUrl;
            window.setTimeout(() => {
                URL.revokeObjectURL(downloadUrl);
                if (outputUrl === downloadUrl) outputUrl = null;
            }, 60_000);
            setStatus(`裁切完成，已觸發下載 ${outputName}（${formatFileSize(outputBlob.size)}）。若瀏覽器未開始下載，可點下方連結重試。`, "success");
        }
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            setStatus("已取消儲存，影片未裁切。");
        } else {
            setStatus(error instanceof Error ? error.message : String(error), "error");
        }
    } finally {
        if (mounted && engine) {
            try {
                await engine.unmount(mountPoint);
            } catch (error) {
                console.error("無法卸載本機影片來源：", error);
            }
        }
        if (inputDirectoryCreated && engine) {
            try {
                await engine.deleteDir(mountPoint);
            } catch (error) {
                console.error("無法清除本機影片暫存目錄：", error);
            }
        }
        setBusy(false);
    }
}

elements.file.addEventListener("change", () => {
    const file = elements.file.files?.[0] ?? null;
    clearDownload();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    selectedFile = file;
    elements.preview.removeAttribute("src");
    elements.preview.load();
    elements.duration.textContent = "總長度 —";
    elements.start.value = "0";
    elements.end.value = "0";

    if (!file) {
        elements.fileName.textContent = "尚未選取影片";
        setStatus("請先選擇影片。");
        setBusy(false);
        return;
    }

    previewUrl = URL.createObjectURL(file);
    elements.preview.src = previewUrl;
    elements.fileName.textContent = `${file.name}（${formatFileSize(file.size)}）`;
    elements.preview.onloadedmetadata = () => {
        if (!Number.isFinite(elements.preview.duration)) {
            setBusy(false);
            elements.duration.textContent = "總長度無法讀取";
            setStatus("無法讀取影片長度；請手動輸入起訖秒數後嘗試本機處理。", "error");
            return;
        }
        elements.duration.textContent = `總長度 ${formatTime(elements.preview.duration)}`;
        elements.end.value = elements.preview.duration.toFixed(2);
        elements.start.max = String(elements.preview.duration);
        elements.end.max = String(elements.preview.duration);
        setBusy(false);
        setStatus("影片已載入；選擇要保留的開始與結束時間。");
    };
    elements.preview.onerror = () => {
        elements.duration.textContent = "總長度無法預覽";
        setStatus("無法在此瀏覽器預覽影片；請手動輸入起訖秒數後嘗試本機處理。", "error");
    };
    setBusy(false);
    elements.markStart.disabled = false;
    elements.markEnd.disabled = false;
});

elements.markStart.addEventListener("click", () => markTime(elements.start));
elements.markEnd.addEventListener("click", () => markTime(elements.end));
elements.trim.addEventListener("click", trimVideo);

window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    elements.install.hidden = false;
});

elements.install.addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    elements.install.hidden = true;
});

window.addEventListener("appinstalled", () => {
    elements.install.hidden = true;
    elements.pwaStatus.textContent = "PWA 已安裝";
});

if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js")
        .then(() => { elements.pwaStatus.textContent = "PWA 可安裝；離線需先載入處理引擎"; })
        .catch(error => {
            elements.pwaStatus.textContent = "PWA 離線快取無法啟用";
            console.error("Service worker 註冊失敗：", error);
        });
} else {
    elements.pwaStatus.textContent = "請透過 localhost 或 HTTPS 啟用 PWA";
}

window.addEventListener("pagehide", () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
});
