/* ======================================================================
   Image Tool v5 — multi-folder, lazy-loading
   ====================================================================== */

(function () {
    "use strict";
    var $ = function (s) { return document.querySelector(s); };
    var $$ = function (s) { return document.querySelectorAll(s); };
    var PAGE_SIZE = 10;

    // ---- DOM refs ---------------------------------------------------------
    var dom = {
        folderPath:   $("#folder-path"),
        btnBrowse:    $("#btn-browse-folder"),
        btnLoad:      $("#btn-load-folder"),
        noData:       $("#no-data"),
        workspace:    $("#workspace"),
        stripsCtr:    $("#strips-container"),
        // Sidebar
        algoSelect:   $("#algo-select"),
        algoParams:   $("#algo-params"),
        batchPreset:  $("#batch-preset"),
        batchSrcDir:  $("#batch-src-dir"),
        batchDstDir:  $("#batch-dst-dir"),
        btnBatchRun:  $("#btn-batch-run"),
        batchStatus:  $("#batch-status"),
        // Mode
        tabSim:       $("#mode-tab-sim"), tabProd: $("#mode-tab-prod"),
        // Paired crop
        pairCropPanel:  $("#pair-crop-panel"),
        pairAutoStatus: $("#pair-auto-status"),
        pairScale:      $("#pair-scale"),
        pairInfo:       $("#pair-info"), btnPairCrop: $("#btn-pair-crop"),
        pairOutDir:     $("#pair-out-dir"), btnPairOutBrowse: $("#btn-pair-out-browse"),
        pairLabelSelect:$("#pair-label-select"), pairLabelInput: $("#pair-label-input"),
        btnPairLabelAdd:$("#btn-pair-label-add"),
        pairStatus:     $("#pair-status"),
        btnRunAlgo:   $("#btn-run-algo"),
        btnShowResult: $("#btn-show-result"),
        btnShowOrig:   $("#btn-show-original"),
        algoInfo:      $("#algo-info"),
        btnAddPipe:    $("#btn-add-pipeline"),
        btnClearPipe:  $("#btn-clear-pipeline"),
        pipeList:      $("#pipeline-list"),
        btnAlgoInfo:   $("#btn-algo-info"),
        algoInfoModal: $("#algo-info-modal"),
        algoInfoTitle: $("#algo-info-title"),
        algoInfoBody:  $("#algo-info-body"),
        algoInfoClose: $("#algo-info-close"),
        saveFilename: $("#save-filename"), batchName: $("#batch-name"),
        btnSave:      $("#btn-save"), presetSel: $("#preset-select"), btnPreset: $("#btn-preset-save"),
        // Main
        imgMain:      $("#img-main"), mainTitle: $("#main-title"), mainTime: $("#main-time"), mainPanel: $("#main-panel"),
        // Crop
        cropToggle:   $("#crop-toggle"), cropPanel: $("#crop-panel"),
        cropOverlay:  $("#crop-overlay"), cropBoxEl: $("#crop-box-el"),
        cropX: $("#crop-x"), cropY: $("#crop-y"), cropW: $("#crop-w"), cropH: $("#crop-h"),
        cropAspectLock: $("#crop-aspect-lock"), cropBatchName: $("#crop-batch-name"), btnCropSave: $("#btn-crop-save"),
        statusBar:    $("#status-bar"),
    };

    // ---- State -------------------------------------------------------------
    var state = {
        folders: [],       // [{id, path, name, files:[{name,path}], images:[], page, totalCount}]
        results: [],       // [{id, name, path, uri, isResult}]
        activeFid: null,   // folder id
        activeIid: null,   // image id (in folder.images or results)
        algorithms: {}, activeAlgo: "usm_sharp", algoParams: {},
        algoCache: {},     // {"imageId--algoName": resultImageId}
        pipeline: [],      // [{algorithm, params, label}]
        editStepIdx: -1,   // which pipeline step is being edited (-1 = none)
        selectedIds: [],   // for multi-image algorithms
        prodMode: false,  // false=sim, true=production
        // Paired cropping
        pairLqDir: "", pairHqDir: "", pairScale: 2,
        pairLqOut: "", pairHqOut: "",
        pairFiles: [],     // [{name, lq_uri, hq_uri, lq_path, hq_path}]
        pairIdx: 0, pairCurrentName: null,
        pairOutputDir: "",   // user-selected base output directory
        pairLabel: "",       // currently selected label
        pairLabels: ["building", "vegetation", "road", "person", "vehicle", "text", "sign", "indoor"],
        pairCropCounts: {},  // "baseName_label" → next index
        pairLqImg: null,   // Image element for LQ inset
        viewState: {},     // {originalImageId: {viewing: "result", algoKey: "usm_sharp"}}
        cropMode: false, cropBox: { x:0, y:0, w:256, h:256 }, cropDragging: null, cropLastMouse: { x:0, y:0 },
        cropAspectLocked: false, cropAspectRatio: 1.0, cropInitDone: false,
        zoom: { scale:1, panX:0, panY:0, panning:false, lastX:0, lastY:0 },
    };
    var _nid = 0; function uid() { return "i" + (++_nid); }
    function fid() { return "f" + (++_nid); }

    // ---- Helpers -----------------------------------------------------------
    function setStatus(m, c) { dom.statusBar.textContent = m; dom.statusBar.className = c || ""; }
    function hasImage() { return !!dom.imgMain.src; }
    function dirOf(p) { var r = p.replace(/\//g, "\\").replace(/\\+$/, ""); var i = r.lastIndexOf("\\"); return i > 0 ? r.substring(0, i) : r; }
    function formatDir(p) { var parts = p.replace(/\//g, "\\").split("\\").filter(Boolean); return parts.length <= 3 ? parts.join("\\") : "...\\" + parts.slice(-3).join("\\"); }
    function imageLabel(img) { return img.isResult ? img.name : (formatDir(dirOf(img.path || "")) + "\\" + img.name); }
    function shortName(path) { var parts = path.replace(/\//g, "\\").split("\\").filter(Boolean); return parts[parts.length - 1] || path; }

    /** Find image by id across all folders + results */
    function findImage(iid) {
        if (!iid) return null;
        for (var fi = 0; fi < state.folders.length; fi++) {
            var imgs = state.folders[fi].images;
            for (var j = 0; j < imgs.length; j++) if (imgs[j].id === iid) return { folder: state.folders[fi], img: imgs[j] };
        }
        for (var k = 0; k < state.results.length; k++) if (state.results[k].id === iid) return { folder: null, img: state.results[k] };
        return null;
    }

    /** All currently loaded images across all folders + results */
    function allLoadedImages() {
        var all = [];
        state.folders.forEach(function (f) { all = all.concat(f.images); });
        return all.concat(state.results);
    }

    // ---- Folder management -------------------------------------------------
    /** Insert folder into state.folders sorted by image resolution (descending).
     *  Loads one image to detect dimensions, stores _res, then calls callback. */
    function insertFolderSorted(f, callback) {
        function insert(res) {
            f._res = res || 0;
            // Insert at correct position: higher resolution first
            var idx = 0;
            for (; idx < state.folders.length; idx++) {
                if ((state.folders[idx]._res || 0) < f._res) break;
            }
            state.folders.splice(idx, 0, f);
            callback();
        }
        // If folder already has loaded images, use first one directly
        if (f.images && f.images.length && f.images[0].uri) {
            var img = new Image();
            img.onload = function () { insert(img.naturalWidth * img.naturalHeight); };
            img.onerror = function () { insert(0); };
            img.src = f.images[0].uri;
        } else if (f.files && f.files.length) {
            _loadOneImage(f, f.files[0].name, function (uri) {
                if (!uri) { insert(0); return; }
                var img = new Image();
                img.onload = function () { insert(img.naturalWidth * img.naturalHeight); };
                img.onerror = function () { insert(0); };
                img.src = uri;
            });
        } else {
            insert(0);
        }
    }

    function addFolderByPath(path) {
        var norm = path.replace(/\//g, "\\").replace(/\\+$/, "");
        // Dedup
        if (state.folders.some(function (f) { return f.path === norm; })) {
            setStatus("文件夹已存在: " + shortName(norm), "error"); return;
        }
        setStatus("正在扫描 " + shortName(norm) + "...");
        fetch("/api/scan_folder", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: norm }),
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.status !== "ok") { setStatus(data.message, "error"); return; }
            var f = {
                id: fid(), path: norm, name: shortName(norm),
                files: data.files.sort(function (a, b) { return a.name.localeCompare(b.name); }), totalCount: data.total,
                images: [], page: 0, pageSize: PAGE_SIZE,
            };
            insertFolderSorted(f, function () {
                dom.noData.style.display = "none"; dom.workspace.style.display = "";
                buildAllStrips();
                loadFolderPage(f.id, 0);
            });
        })
        .catch(function (e) { setStatus("扫描失败: " + e.message, "error"); });
    }

    function loadFolderPage(folderId, page) {
        var f = state.folders.find(function (x) { return x.id === folderId; });
        if (!f) return;
        f.page = page;
        var start = page * PAGE_SIZE;
        var batch = f.files.slice(start, start + PAGE_SIZE);
        if (!batch.length) return;
        setStatus("正在加载 " + shortName(f.path) + " 第 " + (page + 1) + " 页...");

        // Virtual folder (from drag-drop): load via FileReader from stored entries
        if (f._isVirtual) {
            var results = []; var pending2 = batch.length; var vpage = page;
            batch.forEach(function (file) {
                file._entry.file(function (fl) {
                    var rd = new FileReader();
                    rd.onload = function (e) { results.push({ name: file.name, path: file.path, uri: e.target.result, id: uid() }); pending2--; if (!pending2) vdone(); };
                    rd.readAsDataURL(fl);
                });
            });
            function vdone() {
                if (f.page !== vpage) return;
                results.sort(function (a, b) { return a.name.localeCompare(b.name); });
                f.images = results;
                buildAllStrips();
                if (!state.activeIid && f.images.length > 0) showImage(f.images[0].id);
                setStatus(f.name + ": " + f.totalCount + " 张 (第 " + (f.page + 1) + "/" + totalPages(f) + " 页)", "ok");
            }
            return;
        }

        var names = batch.map(function (x) { return x.name; });
        fetch("/api/load_folder", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: f.path, names: names }),
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.status !== "ok") { setStatus(data.message, "error"); return; }
            if (f.page !== page) return;
            f.images = [];
            // Sort to match requested names order
            var nameIdx = {}; names.forEach(function (n, i) { nameIdx[n] = i; });
            data.images.sort(function (a, b) { return (nameIdx[a.name] || 0) - (nameIdx[b.name] || 0); });
            data.images.forEach(function (img) {
                if (img.name !== names[f.images.length]) console.warn("MISMATCH: expected", names[f.images.length], "got", img.name);
                f.images.push({ id: uid(), name: img.name, path: img.path, uri: img.uri, width: 0, height: 0 });
            });
            buildAllStrips();
            if (!state.activeIid && f.images.length > 0) showImage(f.images[0].id);
            setStatus(shortName(f.path) + ": " + f.totalCount + " 张 (第 " + (page + 1) + "/" + totalPages(f) + " 页)", "ok");
        })
        .catch(function (e) { setStatus("加载失败: " + e.message, "error"); });
    }

    function totalPages(f) { return Math.max(1, Math.ceil(f.totalCount / PAGE_SIZE)); }

    function removeFolder(folderId) {
        state.folders = state.folders.filter(function (f) { return f.id !== folderId; });
        if (state.activeFid === folderId) { state.activeFid = null; state.activeIid = null; dom.imgMain.src = ""; dom.mainPanel.classList.remove("has-image"); }
        if (!state.folders.length && !state.results.length) { dom.workspace.style.display = "none"; dom.noData.style.display = ""; }
        buildAllStrips();
    }

    // ---- Image display -----------------------------------------------------
    function showImage(iid) {
        var found = findImage(iid);
        if (!found) return;
        state.activeFid = found.folder ? found.folder.id : null;
        state.activeIid = iid;
        var img = found.img;
        // If showing an original image, check if user was previously viewing a result
        if (!img._originId && !img.isResult) {
            var vs = state.viewState[img.id];
            if (vs && vs.viewing === "result") {
                var cached = getCachedResult(img.id, vs.algoKey);
                if (cached) { iid = cached.id; img = cached; state.activeIid = iid; }
            }
        }
        // Save view state when viewing a result
        if (img._originId) {
            state.viewState[img._originId] = { viewing: "result", algoKey: img._algoKey || state.activeAlgo };
        } else if (!img.isResult) {
            state.viewState[img.id] = { viewing: "original", algoKey: "" };
        }
        dom.imgMain.src = img.uri;
        dom.mainTitle.textContent = img.name;
        dom.mainTime.textContent = img.width ? img.width + "×" + img.height : "";
        dom.mainPanel.classList.add("has-image");
        dom.saveFilename.value = img.name || "image.png";
        state.cropInitDone = false;
        if (state.cropMode) updateCropOverlay();
        highlightThumb();
        updateAlgoButtons();
    }

    // ---- Build all folder strips -------------------------------------------
    function buildAllStrips() {
        dom.stripsCtr.innerHTML = "";
        state.folders.forEach(function (f) { buildFolderStrip(f); });
    }

    function buildFolderStrip(f) {
        var strip = document.createElement("div");
        strip.className = "folder-strip";
        strip.setAttribute("data-fid", f.id);

        // Header
        var hdr = document.createElement("div"); hdr.className = "folder-strip-header";
        var nm = document.createElement("span"); nm.className = "fs-name"; nm.textContent = "📁 " + f.name;
        var cnt = document.createElement("span"); cnt.className = "fs-count";
        cnt.textContent = f.totalCount + " 张 | 第 " + (f.page + 1) + "/" + totalPages(f) + " 页";
        var prev = document.createElement("button"); prev.textContent = "◀"; prev.title = "上一页";
        prev.addEventListener("click", function () { if (f.page > 0) loadFolderPage(f.id, f.page - 1); });
        var next = document.createElement("button"); next.textContent = "▶"; next.title = "下一页";
        next.addEventListener("click", function () { if (f.page < totalPages(f) - 1) loadFolderPage(f.id, f.page + 1); });
        var rm = document.createElement("button"); rm.className = "fs-remove"; rm.textContent = "×"; rm.title = "移除文件夹";
        rm.addEventListener("click", function () { removeFolder(f.id); });
        hdr.appendChild(nm); hdr.appendChild(cnt);
        hdr.appendChild(prev); hdr.appendChild(next); hdr.appendChild(rm);

        // Thumbnail row
        var row = document.createElement("div"); row.className = "thumb-row";
        if (f.images.length) {
            f.images.forEach(function (img) { row.appendChild(buildThumb(img)); });
        } else {
            // Show placeholders from files list
            var start = f.page * PAGE_SIZE;
            var n = Math.min(PAGE_SIZE, f.files.length - start);
            for (var i = 0; i < n; i++) {
                row.appendChild(buildPlaceholder(f.files[start + i], f.id));
            }
        }
        strip.appendChild(hdr); strip.appendChild(row);
        dom.stripsCtr.appendChild(strip);
    }

    function buildPlaceholder(file, folderId) {
        var div = document.createElement("div");
        div.className = "thumb placeholder";
        var lbl = document.createElement("div"); lbl.className = "thumb-label";
        lbl.textContent = file.name; lbl.title = file.path;
        var wrap = document.createElement("div"); wrap.className = "thumb-img-wrap";
        div.appendChild(lbl); div.appendChild(wrap);
        div.addEventListener("click", function () {
            // Trigger lazy load of this page, then show this image
            var f = state.folders.find(function (x) { return x.id === folderId; });
            if (!f) return;
            // Load the page that contains this file
            var idx = f.files.indexOf(file);
            if (idx < 0) return;
            var pg = Math.floor(idx / PAGE_SIZE);
            // Load the page and show after
            loadFolderPageAndShow(f.id, pg, file.name);
        });
        return div;
    }

    function loadFolderPageAndShow(folderId, page, targetName) {
        var f = state.folders.find(function (x) { return x.id === folderId; });
        if (!f) return;
        f.page = page;
        var start = page * PAGE_SIZE;
        var names = f.files.slice(start, start + PAGE_SIZE).map(function (x) { return x.name; });
        if (!names.length) return;
        fetch("/api/load_folder", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: f.path, names: names }),
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.status !== "ok") return;
            f.images = [];
            data.images.forEach(function (img) {
                f.images.push({ id: uid(), name: img.name, path: img.path, uri: img.uri, width: 0, height: 0 });
            });
            buildAllStrips();
            var target = f.images.find(function (x) { return x.name === targetName; });
            if (target) showImage(target.id);
            setStatus(shortName(f.path) + ": " + f.totalCount + " 张 (第 " + (page + 1) + "/" + totalPages(f) + " 页)", "ok");
        });
    }

    function buildThumb(img) {
        var div = document.createElement("div");
        div.className = "thumb" + (img.isResult ? " result-thumb" : "");
        div.setAttribute("data-iid", img.id);
        div.setAttribute("data-name", img.name);  // for paired highlight lookup
        // Checkbox only for multi-image algorithms, not for result images
        var algo = state.algorithms[state.activeAlgo];
        var multiSelect = algo && algo.n_images > 1 && !img.isResult;
        if (multiSelect) {
            var sel = document.createElement("div");
            sel.className = "thumb-sel" + (state.selectedIds.indexOf(img.id) >= 0 ? " checked" : "");
            sel.addEventListener("click", (function (id) { return function (e) { e.stopPropagation(); toggleMultiSel(id); }; })(img.id));
            div.appendChild(sel);
        }
        // Label
        var lbl = document.createElement("div"); lbl.className = "thumb-label";
        lbl.textContent = img.name; lbl.title = imageLabel(img);
        // Image
        var wrap = document.createElement("div"); wrap.className = "thumb-img-wrap";
        if (img.uri) { var el = document.createElement("img"); el.src = img.uri; wrap.appendChild(el); }
        div.appendChild(lbl); div.appendChild(wrap);
        // Click: in paired mode, load both images; otherwise normal showImage
        div.addEventListener("click", function () {
            if (state.prodMode && state.pairFiles.length && !img.isResult) {
                var found = findImage(img.id);
                if (found && found.folder && (found.folder.id === state.pairFolderA?.id || found.folder.id === state.pairFolderB?.id)) {
                    var pairIdx = state.pairFiles.findIndex(function (p) { return p.name === img.name; });
                    if (pairIdx >= 0) { state.pairCurrentName = null; loadPairImage(pairIdx); return; }
                }
            }
            showImage(img.id);
        });
        return div;
    }

    function highlightThumb() {
        $$("#strips-container .thumb").forEach(function (el) {
            el.classList.toggle("selected", el.getAttribute("data-iid") === state.activeIid);
        });
    }

    // ---- Algorithm result cache --------------------------------------------
    function cacheKey(imgId, algo) { return imgId + "--" + algo; }
    function getCachedResult(imgId, algo) {
        var rid = state.algoCache[cacheKey(imgId, algo)];
        if (!rid) return null;
        return state.results.find(function (r) { return r.id === rid; }) || null;
    }

    // ---- Algorithm buttons -------------------------------------------------
    // ---- Pipeline management ------------------------------------------------
    function updatePipelineUI() {
        dom.pipeList.innerHTML = "";
        if (!state.pipeline.length) {
            dom.btnClearPipe.style.display = "none";
            dom.btnRunAlgo.textContent = "▶ 运行";
            state.editStepIdx = -1;
            dom.btnAddPipe.textContent = "＋ 加入流水线";
            return;
        }
        dom.btnClearPipe.style.display = "";
        dom.btnRunAlgo.textContent = "▶ 运行流水线 (" + state.pipeline.length + "步)";
        dom.btnAddPipe.textContent = state.editStepIdx >= 0 ? "↻ 更新步骤" : "＋ 加入流水线";
        state.pipeline.forEach(function (step, i) {
            var div = document.createElement("div"); div.className = "pipeline-step";
            if (i === state.editStepIdx) div.classList.add("editing");
            div.title = "点击编辑参数";
            var idx = document.createElement("span"); idx.className = "ps-idx"; idx.textContent = (i + 1) + ".";
            var name = document.createElement("span"); name.className = "ps-name";
            name.textContent = step.label || step.algorithm;
            var rm = document.createElement("button"); rm.className = "ps-remove"; rm.textContent = "×";
            rm.title = "移除";
            rm.addEventListener("click", (function (si) { return function (e) { e.stopPropagation(); state.pipeline.splice(si, 1); if (state.editStepIdx === si) state.editStepIdx = -1; updatePipelineUI(); }; })(i));
            // Click to edit
            div.addEventListener("click", (function (si) { return function () { editPipelineStep(si); }; })(i));
            div.appendChild(idx); div.appendChild(name); div.appendChild(rm);
            dom.pipeList.appendChild(div);
        });
    }

    function editPipelineStep(idx) {
        if (state.editStepIdx === idx) { state.editStepIdx = -1; updatePipelineUI(); return; }
        var step = state.pipeline[idx];
        state.editStepIdx = idx;
        state.activeAlgo = step.algorithm;
        dom.algoSelect.value = step.algorithm;
        state.algoParams[step.algorithm] = Object.assign({}, step.params);
        updateAlgoUI();
        updatePipelineUI();
    }

    function addToPipeline() {
        var algo = state.algorithms[state.activeAlgo];
        if (!algo || algo.n_images !== 1) { setStatus("仅单图算法可加入流水线", "error"); return; }
        var params = Object.assign({}, state.algoParams[state.activeAlgo] || {});
        if (state.editStepIdx >= 0) {
            // Update existing step, keep selection
            state.pipeline[state.editStepIdx] = { algorithm: state.activeAlgo, params: params, label: algo.label };
            setStatus("步骤已更新: " + algo.label, "ok");
        } else {
            state.pipeline.push({ algorithm: state.activeAlgo, params: params, label: algo.label });
            setStatus("已加入: " + algo.label, "ok");
        }
        updatePipelineUI();
    }
    function clearPipeline() { state.pipeline = []; state.editStepIdx = -1; updatePipelineUI(); }

    dom.btnAddPipe.addEventListener("click", addToPipeline);
    dom.btnClearPipe.addEventListener("click", clearPipeline);

    // ---- Algorithm buttons -------------------------------------------------
    function updateAlgoButtons() {
        if (!state.activeIid) {
            dom.btnShowResult.disabled = true;
            dom.btnShowResult.classList.remove("has-result");
            dom.btnShowOrig.disabled = true;
            dom.algoInfo.textContent = "点击缩略图选中图片";
            return;
        }
        // Determine origin: if viewing a result, find its original image
        var cur = findImage(state.activeIid);
        var originIid = (cur && cur.img._originId) ? cur.img._originId : state.activeIid;
        var isViewingResult = !!(cur && cur.img._originId);
        var cached = originIid ? getCachedResult(originIid, (state.pipeline.length ? state.pipeline.map(function(s){return s.algorithm;}).join("--") : state.activeAlgo)) : null;

        if (cached) {
            dom.btnShowResult.disabled = false;
            dom.btnShowResult.classList.add("has-result");
            if (isViewingResult) {
                dom.btnShowOrig.textContent = "切回原图";
                dom.algoInfo.textContent = "当前: " + state.activeAlgo + " 结果";
            } else {
                dom.btnShowOrig.textContent = "查看结果";
                dom.algoInfo.textContent = "已有 " + state.activeAlgo + " 结果";
            }
        } else {
            dom.btnShowResult.disabled = true;
            dom.btnShowResult.classList.remove("has-result");
            dom.btnShowOrig.textContent = "切回原图";
            dom.algoInfo.textContent = "尚未运行 " + state.activeAlgo;
        }
        dom.btnShowOrig.disabled = false;
    }

    function toggleView() {
        var cur = findImage(state.activeIid);
        if (cur && cur.img._originId) {
            // Viewing result → go back to original (clear viewState to avoid loop)
            delete state.viewState[cur.img._originId];
            showImage(cur.img._originId);
        } else {
            // Viewing original → go to cached result
            var algoKey = state.pipeline.length ? state.pipeline.map(function(s){return s.algorithm;}).join("--") : state.activeAlgo;
            var cached = getCachedResult(state.activeIid, algoKey);
            if (cached) showImage(cached.id);
        }
    }
    dom.btnShowResult.addEventListener("click", function () {
        var cur = findImage(state.activeIid);
        var originIid = (cur && cur.img._originId) ? cur.img._originId : state.activeIid;
        var cached = originIid ? getCachedResult(originIid, (state.pipeline.length ? state.pipeline.map(function(s){return s.algorithm;}).join("--") : state.activeAlgo)) : null;
        if (cached) showImage(cached.id);
    });
    dom.btnShowOrig.addEventListener("click", toggleView);

    // ---- Multi-select (only for algorithms needing 2+ images) --------------
    function toggleMultiSel(iid) {
        var p = state.selectedIds.indexOf(iid);
        if (p >= 0) state.selectedIds.splice(p, 1); else state.selectedIds.push(iid);
        buildAllStrips();
    }
    function clearMultiSel() { state.selectedIds = []; buildAllStrips(); }

    // ---- Algorithm panel ---------------------------------------------------
    function fetchAlgoSpecs() {
        fetch("/api/algorithm_specs").then(function (r) { return r.json(); }).then(function (data) {
            if (data.status !== "ok") return; state.algorithms = data.algorithms;
            dom.algoSelect.innerHTML = "";
            // Group algorithms by "group" field
            var groups = {};
            Object.keys(state.algorithms).forEach(function (k) {
                var g = state.algorithms[k].group || "其他";
                if (!groups[g]) groups[g] = [];
                groups[g].push(k);
            });
            var groupOrder = ["单图算法", "多图算法"];
            groupOrder.forEach(function (gname) {
                if (!groups[gname]) return;
                var og = document.createElement("optgroup");
                og.label = gname;
                groups[gname].forEach(function (k) {
                    var o = document.createElement("option"); o.value = k; o.textContent = state.algorithms[k].label; og.appendChild(o);
                });
                dom.algoSelect.appendChild(og);
            });
            // Any remaining groups
            Object.keys(groups).forEach(function (gname) {
                if (groupOrder.indexOf(gname) >= 0) return;
                var og = document.createElement("optgroup"); og.label = gname;
                groups[gname].forEach(function (k) {
                    var o = document.createElement("option"); o.value = k; o.textContent = state.algorithms[k].label; og.appendChild(o);
                });
                dom.algoSelect.appendChild(og);
            });
            dom.algoSelect.value = state.activeAlgo; updateAlgoUI(); fetchPresets();
        });
    }

    function updateAlgoUI() {
        var algo = state.algorithms[state.activeAlgo]; if (!algo) return;
        if (!state.algoParams[state.activeAlgo]) { var p = {}; algo.specs.forEach(function (s) { p[s.id] = s.default; }); state.algoParams[state.activeAlgo] = p; }
        var params = state.algoParams[state.activeAlgo]; dom.algoParams.innerHTML = "";
        algo.specs.forEach(function (s) {
            var val = params[s.id] !== undefined ? params[s.id] : s.default;
            var row = document.createElement("div"); row.className = "algo-slider";
            var lr = document.createElement("div"); lr.className = "as-label";
            var lb = document.createElement("span"); lb.textContent = s.label;
            var vs = document.createElement("span"); vs.className = "as-val";
            vs.textContent = parseFloat(val).toFixed(s.step < 1 ? 2 : 0);
            vs.title = "点击输入精确值"; vs.style.cursor = "pointer";
            lr.appendChild(lb); lr.appendChild(vs);
            var inp = document.createElement("input"); inp.type = "range"; inp.min = s.min; inp.max = s.max; inp.step = s.step;
            inp.value = val;
            inp.addEventListener("input", function () { vs.textContent = parseFloat(inp.value).toFixed(s.step < 1 ? 2 : 0); params[s.id] = parseFloat(inp.value); });
            vs.addEventListener("click", function () {
                var ni = document.createElement("input"); ni.type = "number";
                ni.value = params[s.id]; ni.step = s.step; ni.min = s.min; ni.max = s.max;
                ni.style.cssText = "width:60px;padding:1px 3px;font-size:0.7rem;background:var(--bg);color:var(--accent2);border:1px solid var(--accent2);border-radius:3px;font-family:Consolas,monospace;text-align:right;";
                vs.parentNode.replaceChild(ni, vs); ni.focus(); ni.select();
                function commit() { var v = parseFloat(ni.value); if (!isNaN(v)) { params[s.id] = Math.max(s.min, Math.min(s.max, v)); inp.value = params[s.id]; } vs.textContent = parseFloat(params[s.id]).toFixed(s.step < 1 ? 2 : 0); ni.parentNode.replaceChild(vs, ni); }
                ni.addEventListener("blur", commit);
                ni.addEventListener("keydown", function (e) { if (e.key === "Enter") commit(); });
            });
            row.appendChild(lr); row.appendChild(inp); dom.algoParams.appendChild(row);
        });
        updateAlgoButtons();
    }

    function runAlgorithm() {
        var hasPipeline = state.pipeline.length > 0;
        if (!hasPipeline) {
            // Check single algo validity
            var algo = state.algorithms[state.activeAlgo]; if (!algo) return;
            if (algo.n_images > 1 && state.selectedIds.length < (algo.n_images === -1 ? 2 : algo.n_images)) {
                setStatus("请勾选至少 2 张图片", "error"); return;
            }
        }
        if (!state.activeIid) { setStatus("请先点击缩略图选中图片", "error"); return; }
        var found = findImage(state.activeIid);
        if (!found) { setStatus("请选中图片", "error"); return; }
        // Always trace back to the true original image (handle chain of results)
        var depth = 0;
        while (found.img._originId && depth < 10) {
            var orig = findImage(found.img._originId);
            if (!orig) break;
            found = orig;
            depth++;
        }

        var inputImgs;
        if (hasPipeline) {
            inputImgs = [found.img];
        } else if (state.selectedIds.length > 0) {
            var all = allLoadedImages();
            inputImgs = all.filter(function (img) { return state.selectedIds.indexOf(img.id) >= 0 && !img.isResult; });
        } else {
            inputImgs = [found.img];
        }

        var uris = inputImgs.map(function (x) { return x.uri; });
        var ov = $("#computing-overlay"); if (ov) ov.style.display = "";
        dom.btnRunAlgo.disabled = true;

        var body;
        if (hasPipeline) {
            body = JSON.stringify({ images: uris, pipeline: state.pipeline });
            setStatus("正在运行流水线 (" + state.pipeline.length + "步)...");
        } else {
            body = JSON.stringify({ images: uris, algorithm: state.activeAlgo, params: state.algoParams[state.activeAlgo] || {} });
            setStatus("正在运行 " + state.algorithms[state.activeAlgo].label + "...");
        }

        fetch("/api/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: body })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            dom.btnRunAlgo.disabled = false; if (ov) ov.style.display = "none";
            if (data.status !== "ok") { setStatus(data.message, "error"); return; }
            var originIid = inputImgs[0].id;
            var ck = hasPipeline
                ? state.pipeline.map(function (s) { return s.algorithm; }).join("--")
                : state.activeAlgo;
            var r = { id: uid(), name: inputImgs[0].name, path: "[result]", uri: data.result_uri, width: 0, height: 0, isResult: true, _originId: originIid, _algoKey: ck };
            state.results.push(r);
            inputImgs.forEach(function (img) { state.algoCache[cacheKey(img.id, ck)] = r.id; });
            showImage(r.id);
            setStatus((hasPipeline ? "流水线" : state.algorithms[state.activeAlgo].label) + " 完成 — " + data.time_ms + "ms", "ok");
        })
        .catch(function (e) { dom.btnRunAlgo.disabled = false; if (ov) ov.style.display = "none"; setStatus("失败: " + e.message, "error"); });
    }

    // ---- Save & Presets (minimal) ------------------------------------------
    dom.btnSave.addEventListener("click", function () {
        if (!hasImage()) return;
        fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image_data: dom.imgMain.src, filename: dom.saveFilename.value || "img.png", batch_name: dom.batchName.value || "saved" }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { setStatus(d.status === "ok" ? "已保存 → output/" + d.batch + "/" + d.filename : d.message, d.status === "ok" ? "ok" : "error"); });
    });

    function fetchPresets() {
        fetch("/api/presets").then(function (r) { return r.json(); }).then(function (data) {
            dom.presetSel.innerHTML = '<option value="">-- 加载预设 --</option>';
            dom.batchPreset.innerHTML = '<option value="">-- 选择预设 --</option>';
            if (data.status !== "ok") return;
            Object.keys(data.presets).forEach(function (n) {
                var o = document.createElement("option"); o.value = n; o.textContent = n; dom.presetSel.appendChild(o);
                if (data.presets[n].pipeline) {
                    var o2 = document.createElement("option"); o2.value = n; o2.textContent = n + " (" + data.presets[n].pipeline.length + "步)"; dom.batchPreset.appendChild(o2);
                }
            });
        }).catch(function () {});
    }

    // ---- Batch processing --------------------------------------------------
    dom.btnBatchRun.addEventListener("click", function () {
        var presetName = dom.batchPreset.value;
        if (!presetName) { setStatus("请选择流水线预设", "error"); return; }
        var src = dom.batchSrcDir.value.trim(), dst = dom.batchDstDir.value.trim();
        if (!src) { setStatus("请输入源文件夹", "error"); return; }
        if (!dst) { setStatus("请输入导出目录", "error"); return; }
        fetch("/api/presets").then(function (r) { return r.json(); }).then(function (data) {
            var preset = data.presets[presetName];
            if (!preset || !preset.pipeline) { setStatus("预设无流水线", "error"); return; }
            dom.btnBatchRun.disabled = true; dom.batchStatus.textContent = "正在处理...";
            fetch("/api/batch_process", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pipeline: preset.pipeline, source_dir: src, output_dir: dst }),
            })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                dom.btnBatchRun.disabled = false;
                if (d.status !== "ok") { dom.batchStatus.textContent = d.message; return; }
                dom.batchStatus.textContent = "完成: " + d.processed + "/" + d.total + " (" + (d.time_ms/1000).toFixed(1) + "s)";
                setStatus("批量完成: " + d.processed + " 张 → " + d.output_dir, "ok");
            })
            .catch(function (e) { dom.btnBatchRun.disabled = false; dom.batchStatus.textContent = ""; });
        });
    });
    dom.presetSel.addEventListener("change", function () {
        var n = dom.presetSel.value; if (!n) return;
        fetch("/api/presets").then(function (r) { return r.json(); }).then(function (data) {
            var p = data.presets[n]; if (!p) return;
            if (p.pipeline && p.pipeline.length) {
                state.pipeline = JSON.parse(JSON.stringify(p.pipeline));
                state.editStepIdx = -1;
                updatePipelineUI();
                setStatus("已加载流水线预设: " + n + " (" + state.pipeline.length + "步)", "ok");
            } else if (p.algorithm && state.algorithms[p.algorithm]) {
                // Legacy: single-algo preset
                state.activeAlgo = p.algorithm; dom.algoSelect.value = p.algorithm;
                state.algoParams[p.algorithm] = Object.assign({}, p.params || {}); updateAlgoUI();
                setStatus("已加载预设: " + n, "ok");
            }
        });
    });
    dom.btnPreset.addEventListener("click", function () {
        if (!state.pipeline.length) { setStatus("流水线为空，请先加入步骤", "error"); return; }
        var n = prompt("流水线预设名称:"); if (!n || !n.trim()) return;
        fetch("/api/presets", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: n.trim(), pipeline: state.pipeline }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.status === "ok") { setStatus("流水线预设已保存", "ok"); fetchPresets(); } });
    });

    // ---- Events ------------------------------------------------------------
    dom.btnLoad.addEventListener("click", function () {
        var p = dom.folderPath.value.trim(); if (!p) return; addFolderByPath(p);
    });
    dom.btnBrowse.addEventListener("click", function () { openBrowser(dom.folderPath); });
    // Batch panel browse buttons
    dom.batchSrcDir.parentElement.querySelector(".btn-browse-dir").addEventListener("click", function () { openBrowser(dom.batchSrcDir); });
    dom.batchDstDir.parentElement.querySelector(".btn-browse-dir").addEventListener("click", function () { openBrowser(dom.batchDstDir); });
    dom.folderPath.addEventListener("keydown", function (e) { if (e.key === "Enter") { var p = dom.folderPath.value.trim(); if (p) addFolderByPath(p); } });
    dom.algoSelect.addEventListener("change", function () { state.activeAlgo = dom.algoSelect.value; state.selectedIds = []; state.editStepIdx = -1; updateAlgoUI(); updatePipelineUI(); buildAllStrips(); });
    dom.btnRunAlgo.addEventListener("click", runAlgorithm);
    dom.btnAlgoInfo.addEventListener("click", function () {
        var algo = state.algorithms[state.activeAlgo];
        if (!algo || !algo.info) return;
        dom.algoInfoTitle.textContent = "📖 " + algo.label;
        var html = "";
        var info = algo.info;
        // Support both old string format and new object format
        if (typeof info === "string") {
            html = info;
        } else {
            if (info.about) html += info.about;
            if (info.params && Object.keys(info.params).length) {
                html += "<hr style='margin:10px 0;border-color:var(--border)'>";
                html += "<h3 style='font-size:0.9rem;color:var(--accent2);margin-bottom:8px;'>参数详解</h3>";
                // Match specs to get param labels
                var specMap = {};
                algo.specs.forEach(function (s) { specMap[s.id] = s.label; });
                Object.keys(info.params).forEach(function (pid) {
                    var label = specMap[pid] || pid;
                    html += "<div style='margin-bottom:10px;padding:6px 8px;background:rgba(83,168,182,0.06);border-radius:4px;border-left:2px solid var(--accent2);'>";
                    html += "<div style='font-weight:600;color:var(--text);margin-bottom:3px;'>" + label + "</div>";
                    html += "<div style='font-size:0.78rem;line-height:1.6;color:var(--text-dim);'>" + info.params[pid] + "</div>";
                    html += "</div>";
                });
            }
        }
        dom.algoInfoBody.innerHTML = html;
        dom.algoInfoModal.style.display = "";
    });
    dom.algoInfoClose.addEventListener("click", function () { dom.algoInfoModal.style.display = "none"; });
    dom.algoInfoModal.querySelector(".browse-overlay").addEventListener("click", function () { dom.algoInfoModal.style.display = "none"; });

    // ---- Drag-drop ----------------------------------------------------------
    document.addEventListener("dragenter", function (e) { e.preventDefault(); });
    document.addEventListener("dragover", function (e) { e.preventDefault(); });
    document.addEventListener("drop", function (e) {
        e.preventDefault();
        var items = e.dataTransfer.items;
        if (!items || !items.length) return;
        // Check for directory entries
        var dirEntries = [], fileEntries = [];
        for (var i = 0; i < items.length; i++) {
            var en = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
            if (en && en.isDirectory) dirEntries.push(en);
            else if (en && en.isFile) fileEntries.push(en);
        }
        if (dirEntries.length) {
            // Recursively collect all files from dropped directories
            collectDirFiles(dirEntries);
        } else if (fileEntries.length) {
            // Individual files from drag
            loadEntryFiles(fileEntries);
        } else {
            // Plain files (no entries API)
            var imgs = [];
            for (var j = 0; j < e.dataTransfer.files.length; j++) {
                if (e.dataTransfer.files[j].type.match(/^image\//)) imgs.push(e.dataTransfer.files[j]);
            }
            if (imgs.length) loadFilesDirect(imgs);
        }
    });

    /** Recursively collect all file entries from dropped directories */
    function collectDirFiles(dirEntries) {
        var allEntries = []; // {entry, name, relativePath}
        var pending = dirEntries.length;
        dirEntries.forEach(function (dirEntry) {
            readDirRecursive(dirEntry, dirEntry.name, function (entries) {
                allEntries = allEntries.concat(entries);
                pending--;
                if (pending === 0) {
                    if (!allEntries.length) { setStatus("文件夹中无图片", "error"); return; }
                    var imgs = allEntries.filter(function (x) { return /\.(png|bmp|jpg|jpeg)$/i.test(x.name); }).sort(function (a, b) { return a.name.localeCompare(b.name); });
                    if (!imgs.length) { setStatus("文件夹中无图片", "error"); return; }
                    // Create virtual folder with file entries (lazy: no image data yet)
                    var f = {
                        id: fid(), path: "[拖拽]", name: dirEntries.length === 1 ? dirEntries[0].name : "拖拽 (" + dirEntries.length + " 目录)",
                        files: imgs.map(function (x) { return { name: x.name, path: x.relativePath, _entry: x.entry }; }),
                        totalCount: imgs.length, images: [], page: 0, pageSize: PAGE_SIZE, _isVirtual: true,
                    };
                    insertFolderSorted(f, function () {
                        dom.noData.style.display = "none"; dom.workspace.style.display = "";
                        buildAllStrips();
                        loadFolderPage(f.id, 0);
                        setStatus("已扫描 " + f.name + ": " + f.totalCount + " 张", "ok");
                    });
                }
            });
        });
    }

    function readDirRecursive(dirEntry, baseName, callback) {
        var results = [];
        var reader = dirEntry.createReader();
        function readBatch() {
            reader.readEntries(function (batch) {
                if (!batch.length) { callback(results); return; }
                var pending = batch.length;
                batch.forEach(function (entry) {
                    if (entry.isFile) {
                        results.push({ entry: entry, name: entry.name, relativePath: baseName + "/" + entry.name });
                        pending--;
                        if (!pending) readBatch();
                    } else if (entry.isDirectory) {
                        readDirRecursive(entry, baseName + "/" + entry.name, function (sub) {
                            results = results.concat(sub);
                            pending--;
                            if (!pending) readBatch();
                        });
                    } else { pending--; if (!pending) readBatch(); }
                });
            });
        }
        readBatch();
    }

    /** Load File objects from entries and add as virtual folder */
    function loadEntryFiles(entries) {
        var imgs = entries.filter(function (x) { return /\.(png|bmp|jpg|jpeg)$/i.test(x.name); }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        if (!imgs.length) return;
        imgs = imgs.slice(0, 50);
        var results = [];
        var pending = imgs.length;
        imgs.forEach(function (entry) {
            entry.file(function (file) {
                var r = new FileReader();
                r.onload = function (e) { results.push({ name: file.name, path: file.name, uri: e.target.result, id: uid() }); pending--; if (!pending) done(); };
                r.readAsDataURL(file);
            });
        });
        function done() {
            var f = { id: fid(), path: "[拖拽]", name: "拖拽文件 (" + results.length + ")", files: [], totalCount: results.length, images: results, page: 0, pageSize: PAGE_SIZE };
            insertFolderSorted(f, function () {
                dom.noData.style.display = "none"; dom.workspace.style.display = "";
                buildAllStrips();
                if (results.length > 0) showImage(results[0].id);
                setStatus("已加载 " + results.length + " 张", "ok");
            });
        }
    }

    function loadFilesDirect(files) {
        if (!files.length) return;
        files = [].slice.call(files).sort(function (a, b) { return a.name.localeCompare(b.name); });
        var results = [];
        var pending = files.length;
        files.forEach(function (file) {
            var r = new FileReader();
            r.onload = function (e) { results.push({ name: file.name, path: file.name, uri: e.target.result, id: uid() }); pending--; if (!pending) done(); };
            r.readAsDataURL(file);
        });
        function done() {
            var f = { id: fid(), path: "[拖拽]", name: "拖拽 (" + results.length + ")", files: [], totalCount: results.length, images: results, page: 0, pageSize: PAGE_SIZE };
            insertFolderSorted(f, function () {
                dom.noData.style.display = "none"; dom.workspace.style.display = "";
                buildAllStrips();
                if (results.length > 0) showImage(results[0].id);
                setStatus("已加载 " + results.length + " 张", "ok");
            });
        }
    }

    // ---- Zoom & Pan --------------------------------------------------------
    var wrap = dom.mainPanel.querySelector(".img-wrap-large");
    function applyZoom() {
        if (!dom.imgMain) return;
        var t = "scale(" + state.zoom.scale + ") translate(" + state.zoom.panX + "px, " + state.zoom.panY + "px)";
        dom.imgMain.style.transform = t;
        dom.imgMain.style.transition = state.zoom.panning ? "none" : "transform 0.1s ease-out";
        if (dom.cropOverlay) { dom.cropOverlay.style.transform = t; dom.cropOverlay.style.transition = dom.imgMain.style.transition; }
        var p = $("#zoom-pct"); if (p) p.textContent = Math.round(state.zoom.scale * 100) + "%";
        if (state.cropMode) updateCropOverlay();
    }
    $("#zoom-in").addEventListener("click", function () { state.zoom.scale = Math.min(5, state.zoom.scale + 0.25); applyZoom(); });
    $("#zoom-out").addEventListener("click", function () { state.zoom.scale = Math.max(0.25, state.zoom.scale - 0.25); applyZoom(); });
    $("#zoom-reset").addEventListener("click", function () { state.zoom.scale = 1; state.zoom.panX = 0; state.zoom.panY = 0; applyZoom(); });
    $("#zoom-fit").addEventListener("click", function () { state.zoom.scale = 1; state.zoom.panX = 0; state.zoom.panY = 0; applyZoom(); });
    wrap.addEventListener("wheel", function (e) { e.preventDefault(); state.zoom.scale = Math.max(0.25, Math.min(5, state.zoom.scale + (e.deltaY > 0 ? -0.15 : 0.15))); applyZoom(); }, { passive: false });
    wrap.addEventListener("mousedown", function (e) {
        if (state.cropMode && e.target.closest("#crop-overlay")) return;
        state.zoom.panning = true; state.zoom.lastX = e.clientX; state.zoom.lastY = e.clientY;
        wrap.classList.add("grabbing"); e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
        if (state.cropDragging) { cropMove(e); return; }
        if (!state.zoom.panning) return;
        state.zoom.panX += (e.clientX - state.zoom.lastX) / state.zoom.scale;
        state.zoom.panY += (e.clientY - state.zoom.lastY) / state.zoom.scale;
        state.zoom.lastX = e.clientX; state.zoom.lastY = e.clientY; applyZoom();
    });
    document.addEventListener("mouseup", function () {
        if (state.cropDragging) { state.cropDragging = null; return; }
        if (state.zoom.panning) { state.zoom.panning = false; wrap.classList.remove("grabbing"); }
    });

    // ---- Crop (compact, same logic) ----------------------------------------
    function initCropBox() {
        if (!hasImage()) return;
        var iw = dom.imgMain.naturalWidth, ih = dom.imgMain.naturalHeight; if (!iw || !ih) return;
        var s = Math.min(256, Math.floor(Math.min(iw, ih) * 0.5));
        state.cropBox = { x: Math.floor((iw - s) / 2), y: Math.floor((ih - s) / 2), w: s, h: s };
        state.cropAspectLocked = true; dom.cropAspectLock.checked = true;
        state.cropAspectRatio = 1.0; state.cropInitDone = true;
    }
    function updateCropOverlay() {
        if (!hasImage() || !state.cropMode) return; if (!state.cropInitDone) initCropBox(); if (!state.cropInitDone) return;
        var iw = dom.imgMain.naturalWidth, ih = dom.imgMain.naturalHeight, lw = dom.imgMain.offsetWidth, lh = dom.imgMain.offsetHeight;
        if (!iw || !ih || !lw || !lh) return;
        dom.cropOverlay.style.left = dom.imgMain.offsetLeft + "px"; dom.cropOverlay.style.top = dom.imgMain.offsetTop + "px";
        dom.cropOverlay.style.width = lw + "px"; dom.cropOverlay.style.height = lh + "px";
        dom.cropOverlay.style.transform = dom.imgMain.style.transform || ""; dom.cropOverlay.style.transition = dom.imgMain.style.transition || "";
        var sx = lw / iw, sy = lh / ih, cb = state.cropBox;
        dom.cropBoxEl.style.left = (cb.x * sx) + "px"; dom.cropBoxEl.style.top = (cb.y * sy) + "px";
        dom.cropBoxEl.style.width = (cb.w * sx) + "px"; dom.cropBoxEl.style.height = (cb.h * sy) + "px";
        dom.cropX.value = cb.x; dom.cropY.value = cb.y; dom.cropW.value = cb.w; dom.cropH.value = cb.h;
    }
    function clampCrop() {
        var iw = dom.imgMain.naturalWidth, ih = dom.imgMain.naturalHeight, cb = state.cropBox;
        cb.x = Math.max(0, Math.min(iw - 10, cb.x)); cb.y = Math.max(0, Math.min(ih - 10, cb.y));
        cb.w = Math.max(10, Math.min(iw - cb.x, cb.w)); cb.h = Math.max(10, Math.min(ih - cb.y, cb.h));
        if (state.cropAspectLocked) { cb.h = Math.round(cb.w / state.cropAspectRatio); if (cb.y + cb.h > ih) { cb.h = ih - cb.y; cb.w = Math.round(cb.h * state.cropAspectRatio); } }
    }
    function toggleCrop(f) { state.cropMode = f !== undefined ? f : !state.cropMode; if (state.cropMode) { if (!hasImage()) { state.cropMode = false; return; } dom.cropOverlay.style.display = ""; dom.cropPanel.style.display = ""; dom.cropToggle.classList.add("active-crop"); state.cropInitDone = false; initCropBox(); updateCropOverlay(); } else { dom.cropOverlay.style.display = "none"; dom.cropPanel.style.display = "none"; dom.cropToggle.classList.remove("active-crop"); } }
    dom.cropToggle.addEventListener("click", function () { toggleCrop(); });
    dom.cropOverlay.addEventListener("mousedown", function (e) { var h = e.target.closest(".crop-handle"); if (h) { state.cropDragging = h.getAttribute("data-handle"); state.cropLastMouse = { x: e.clientX, y: e.clientY }; e.preventDefault(); e.stopPropagation(); } else if (e.target.closest(".crop-box")) { state.cropDragging = "move"; state.cropLastMouse = { x: e.clientX, y: e.clientY }; e.preventDefault(); e.stopPropagation(); } });
    function cropMove(e) {
        if (!state.cropDragging || !state.cropMode) return;
        var iw = dom.imgMain.naturalWidth, ih = dom.imgMain.naturalHeight, lw = dom.imgMain.offsetWidth, lh = dom.imgMain.offsetHeight;
        if (!iw || !ih || !lw || !lh) return;
        var tsx = (lw / iw) * state.zoom.scale, tsy = (lh / ih) * state.zoom.scale;
        var dx = (e.clientX - state.cropLastMouse.x) / tsx, dy = (e.clientY - state.cropLastMouse.y) / tsy;
        state.cropLastMouse = { x: e.clientX, y: e.clientY };
        var cb = state.cropBox, d = state.cropDragging;
        if (d === "move") { cb.x = Math.max(0, Math.min(iw - cb.w, cb.x + dx)); cb.y = Math.max(0, Math.min(ih - cb.h, cb.y + dy)); }
        else if (d === "se") { cb.w = Math.max(10, Math.min(iw - cb.x, cb.w + dx)); cb.h = Math.max(10, Math.min(ih - cb.y, cb.h + dy)); }
        else if (d === "sw") { var w1 = Math.max(10, Math.min(cb.x + cb.w, cb.w - dx)); cb.x += cb.w - w1; cb.w = w1; cb.h = Math.max(10, Math.min(ih - cb.y, cb.h + dy)); }
        else if (d === "ne") { cb.w = Math.max(10, Math.min(iw - cb.x, cb.w + dx)); var h1 = Math.max(10, Math.min(cb.y + cb.h, cb.h - dy)); cb.y += cb.h - h1; cb.h = h1; }
        else if (d === "nw") { var w2 = Math.max(10, Math.min(cb.x + cb.w, cb.w - dx)); cb.x += cb.w - w2; cb.w = w2; var h2 = Math.max(10, Math.min(cb.y + cb.h, cb.h - dy)); cb.y += cb.h - h2; cb.h = h2; }
        else if (d === "n") { var h3 = Math.max(10, Math.min(cb.y + cb.h, cb.h - dy)); cb.y += cb.h - h3; cb.h = h3; }
        else if (d === "s") { cb.h = Math.max(10, Math.min(ih - cb.y, cb.h + dy)); }
        else if (d === "e") { cb.w = Math.max(10, Math.min(iw - cb.x, cb.w + dx)); }
        else if (d === "w") { var w3 = Math.max(10, Math.min(cb.x + cb.w, cb.w - dx)); cb.x += cb.w - w3; cb.w = w3; }
        if (state.cropAspectLocked && d !== "move") { cb.h = Math.round(cb.w / state.cropAspectRatio); if (cb.y + cb.h > ih) { cb.h = ih - cb.y; cb.w = Math.round(cb.h * state.cropAspectRatio); } if (cb.x + cb.w > iw) { cb.w = iw - cb.x; cb.h = Math.round(cb.w / state.cropAspectRatio); } }
        clampCrop(); updateCropOverlay();
    }
    function cropKey(e) { if (!state.cropMode || !hasImage()) return false; var s = e.shiftKey ? 10 : 1, cb = state.cropBox, m = false; switch (e.key) { case "ArrowLeft": cb.x = Math.max(0, cb.x - s); m = true; break; case "ArrowRight": cb.x = Math.min(dom.imgMain.naturalWidth - cb.w, cb.x + s); m = true; break; case "ArrowUp": cb.y = Math.max(0, cb.y - s); m = true; break; case "ArrowDown": cb.y = Math.min(dom.imgMain.naturalHeight - cb.h, cb.y + s); m = true; break; case "Escape": toggleCrop(false); return true; } if (m) { e.preventDefault(); clampCrop(); updateCropOverlay(); return true; } return false; }
    document.addEventListener("keydown", function (e) { if ((e.target.tagName === "INPUT" && e.target.type === "text" && !e.target.closest("#crop-panel")) || e.target.tagName === "TEXTAREA") return; if (state.cropMode && cropKey(e)) return; if (e.key === "Escape") {
            if (dom.algoInfoModal && dom.algoInfoModal.style.display !== "none") { dom.algoInfoModal.style.display = "none"; return; }
            if (domBrowse.modal && domBrowse.modal.style.display !== "none") { closeBrowser(); return; }
        } });
    dom.cropAspectLock.addEventListener("change", function () { state.cropAspectLocked = dom.cropAspectLock.checked; if (state.cropAspectLocked) { state.cropAspectRatio = state.cropBox.w / state.cropBox.h; clampCrop(); updateCropOverlay(); } });
    function ciCb() { var cb = state.cropBox; cb.x = parseInt(dom.cropX.value) || 0; cb.y = parseInt(dom.cropY.value) || 0; cb.w = parseInt(dom.cropW.value) || 10; cb.h = parseInt(dom.cropH.value) || 10; clampCrop(); updateCropOverlay(); }
    dom.cropX.addEventListener("change", ciCb); dom.cropY.addEventListener("change", ciCb); dom.cropW.addEventListener("change", ciCb); dom.cropH.addEventListener("change", ciCb);
    dom.btnCropSave.addEventListener("click", function () {
        if (!hasImage() || !state.cropMode) return;
        var cb = state.cropBox, c = document.createElement("canvas"); c.width = cb.w; c.height = cb.h;
        c.getContext("2d").drawImage(dom.imgMain, cb.x, cb.y, cb.w, cb.h, 0, 0, cb.w, cb.h);
        var u; try { u = c.toDataURL("image/png"); } catch (ex) { return; }
        fetch("/api/save_crop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image_data: u, filename: "crop_" + cb.w + "x" + cb.h + "_" + Date.now() + ".png", batch_name: dom.cropBatchName.value || "crops" }) })
        .then(function (r) { return r.json(); }).then(function (d) { setStatus(d.status === "ok" ? "已保存 → output/" + d.batch + "/" + d.filename : d.message, d.status === "ok" ? "ok" : "error"); });
    });
    dom.imgMain.addEventListener("load", function () { if (state.cropMode) setTimeout(function () { state.cropInitDone = false; initCropBox(); updateCropOverlay(); }, 50); });

    // ---- Directory browser -------------------------------------------------
    var bt = null, bcp = "", bsp = "";
    var db = { modal: $("#browse-modal"), crumbs: $("#browse-crumbs"), list: $("#browse-list"), sel: $("#browse-selected"), cfm: $("#browse-confirm"), cls: $("#browse-close") };
    function openBrowser(t) { bt = t; bcp = ""; bsp = ""; db.sel.textContent = "未选择目录"; db.cfm.disabled = true; db.modal.style.display = ""; nav(""); }
    function closeBrowser() { db.modal.style.display = "none"; bt = null; }
    function nav(p) { var u = "/api/browse"; if (p) u += "?path=" + encodeURIComponent(p); fetch(u).then(function (r) { return r.json(); }).then(function (d) { if (d.status !== "ok") return; bcp = d.path; db.crumbs.innerHTML = ""; if (!d.path) { var s = document.createElement("span"); s.textContent = "此电脑"; s.style.cssText = "cursor:default;color:var(--text-dim)"; db.crumbs.appendChild(s); } else { var parts = d.path.split("\\").filter(Boolean), a = ""; parts.forEach(function (part, i) { a = i === 0 ? part + "\\" : a + "\\" + part; if (i > 0) { var sep = document.createElement("span"); sep.textContent = " ▸ "; sep.style.cssText = "cursor:default;color:var(--text-dim)"; db.crumbs.appendChild(sep); } var sp = document.createElement("span"); sp.textContent = part + (i === 0 ? "" : ""); var ac = a; sp.addEventListener("click", function () { nav(ac); }); db.crumbs.appendChild(sp); }); } db.list.innerHTML = ""; if (d.parent && d.path) db.list.appendChild(bi("📂", ".. (上级)", d.parent, false, 0)); if (d.drives) d.drives.forEach(function (dr) { db.list.appendChild(bi("💽", dr.name, dr.path, false, 0)); }); d.dirs.forEach(function (dr) { db.list.appendChild(bi(dr.has_pngs ? "📁" : "📂", dr.name, dr.path, dr.has_pngs, dr.png_count || 0)); }); }).catch(function () {}); }
    function bi(icon, name, path, hp, cnt) { var d = document.createElement("div"); d.className = "browse-item"; if (path === bsp) d.classList.add("selected"); d.innerHTML = '<span class="b-icon">' + icon + '</span><span class="b-name">' + name + '</span>' + (cnt > 0 ? '<span class="b-pngs has">' + cnt + ' imgs</span>' : ""); d.addEventListener("dblclick", function (e) { e.preventDefault(); nav(path); }); d.addEventListener("click", function (e) { e.preventDefault(); bsp = path; db.sel.textContent = path; db.cfm.disabled = false; $$("#browse-list .browse-item").forEach(function (el) { el.classList.remove("selected"); }); d.classList.add("selected"); }); return d; }
    db.cfm.addEventListener("click", function () { if (bsp && bt) bt.value = bsp; closeBrowser(); });
    db.cls.addEventListener("click", closeBrowser);
    db.modal.querySelector(".browse-overlay").addEventListener("click", closeBrowser);

    // ---- Mode switching ---------------------------------------------------
    function switchMode(prod) {
        state.prodMode = prod;
        if (state.cropMode) toggleCrop(false);
        dom.tabSim.classList.toggle("active", !prod);
        dom.tabProd.classList.toggle("active", prod);

        // Find sections by traversing from known IDs
        var algoSection = dom.algoSelect.closest(".side-section");
        var saveSection = dom.btnSave.closest(".side-section");
        var batchSection = dom.batchPreset.closest(".side-section");

        // Simulation-only
        if (algoSection) algoSection.style.display = prod ? "none" : "";
        if (saveSection) saveSection.style.display = prod ? "none" : "";

        // Production-only
        if (batchSection) batchSection.style.display = prod ? "" : "none";
        if (dom.pairCropPanel) dom.pairCropPanel.style.display = prod ? "" : "none";
        if (dom.cropPanel) dom.cropPanel.style.display = prod ? "" : "none";
        dom.cropToggle.style.display = prod ? "" : "none";

        buildAllStrips();
        if (prod) checkPairCropReady();
    }
    dom.tabSim.addEventListener("click", function () { switchMode(false); });
    dom.tabProd.addEventListener("click", function () { switchMode(true); });

    // ---- Paired cropping (auto-detect from loaded folders) -----------------
    function _loadOneImage(folder, fileName, callback) {
        // Load a single image from a folder, returns data URI via callback
        if (!folder._isVirtual) {
            fetch("/api/load_folder", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: folder.path, names: [fileName] }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { callback(d.status === "ok" && d.images.length ? d.images[0].uri : null); });
        } else {
            var entry = folder.files.find(function (x) { return x.name === fileName; });
            if (!entry || !entry._entry) { callback(null); return; }
            entry._entry.file(function (fl) {
                var r = new FileReader();
                r.onload = function (e) { callback(e.target.result); };
                r.readAsDataURL(fl);
            });
        }
    }

    function checkPairCropReady() {
        // Include both real and virtual folders, exclude results
        var realFolders = state.folders.filter(function (f) { return f.path.indexOf("[result]") !== 0; });
        if (!state.prodMode || realFolders.length !== 2) {
            dom.btnPairCrop.style.display = "none";
            dom.pairInfo.style.display = "none";
            dom.pairAutoStatus.innerHTML = realFolders.length === 0
                ? '<span style=\"color:var(--text-dim);\">加载两个文件夹后自动检测配对</span>'
                : '<span style=\"color:var(--warn);\">需要恰好 2 个文件夹 (当前 ' + realFolders.length + ' 个)</span>';
            state.pairFiles = [];
            return;
        }
        var f0 = realFolders[0], f1 = realFolders[1];
        var names0 = {}; f0.files.forEach(function (x) { names0[x.name] = x; });
        var names1 = {}; f1.files.forEach(function (x) { names1[x.name] = x; });
        var common = Object.keys(names0).filter(function (n) { return names1[n]; }).sort();
        if (!common.length) {
            dom.pairAutoStatus.innerHTML = '<span style=\"color:var(--accent);\">✗ ' + f0.name + ' 与 ' + f1.name + ' 无同名文件</span>';
            dom.btnPairCrop.style.display = "none";
            dom.pairInfo.style.display = "none";
            state.pairFiles = [];
            return;
        }
        // Load first pair to detect which folder is HQ (larger) vs LQ (smaller)
        dom.pairAutoStatus.innerHTML = '<span style=\"color:var(--text-dim);\">检测图像分辨率...</span>';
        var pending = 2, uri0 = null, uri1 = null;
        function bothLoaded() {
            if (--pending) return;
            if (!uri0 || !uri1) { dom.pairAutoStatus.innerHTML = '<span style=\"color:var(--warn);\">无法加载图像</span>'; return; }
            var img0 = new Image(), img1 = new Image(), loaded = 0;
            function dimsReady() {
                if (++loaded < 2) return;
                var w0 = img0.naturalWidth, h0 = img0.naturalHeight;
                var w1 = img1.naturalWidth, h1 = img1.naturalHeight;
                var area0 = w0 * h0, area1 = w1 * h1;
                // Larger image = HQ, smaller = LQ
                var hqFolder, lqFolder, hqNames, lqNames;
                if (area0 >= area1) {
                    hqFolder = f0; lqFolder = f1; hqNames = names0; lqNames = names1;
                    state.pairScale = Math.round(w0 / w1);
                } else {
                    hqFolder = f1; lqFolder = f0; hqNames = names1; lqNames = names0;
                    state.pairScale = Math.round(w1 / w0);
                }
                dom.pairScale.value = state.pairScale;
                state.pairLqDir = lqFolder.path; state.pairHqDir = hqFolder.path;
                state.pairFolderA = lqFolder; state.pairFolderB = hqFolder;
                state.pairFiles = common.map(function (n) {
                    return { name: n, lq_path: lqNames[n].path, hq_path: hqNames[n].path, lq_uri: null, hq_uri: null };
                });
                state.pairIdx = 0;
                // Store resolution for folder sort
                hqFolder._res = Math.max(w0, w1) * Math.max(h0, h1);
                lqFolder._res = Math.min(w0, w1) * Math.min(h0, h1);
                dom.pairAutoStatus.innerHTML = '<span style=\"color:var(--green);\">✓ 配对成功: ' + common.length + ' 对 | HQ: ' + hqFolder.name + ' (' + Math.max(w0,w1) + '×' + Math.max(h0,h1) + ') | LQ: ' + lqFolder.name + ' (' + Math.min(w0,w1) + '×' + Math.min(h0,h1) + ') | scale=' + state.pairScale + '×</span>';
                dom.pairInfo.style.display = ""; dom.btnPairCrop.style.display = "";
                dom.pairInfo.textContent = common.length + " 对";
                loadPairImage(0);
            }
            img0.onload = dimsReady; img1.onload = dimsReady;
            img0.src = uri0; img1.src = uri1;
        }
        _loadOneImage(f0, common[0], function (u) { uri0 = u; bothLoaded(); });
        _loadOneImage(f1, common[0], function (u) { uri1 = u; bothLoaded(); });
    }

    // Highlight BOTH paired thumbnails (folder A and folder B) by filename
    function highlightPairThumb() {
        $$("#strips-container .thumb").forEach(function (el) { el.classList.remove("paired"); });
        if (!state.pairFolderA || !state.pairFolderB || !state.pairFiles.length) return;
        var name = state.pairFiles[state.pairIdx].name;
        $$("#strips-container .thumb").forEach(function (el) {
            if (el.getAttribute("data-name") === name) el.classList.add("paired");
        });
    }

    // Re-check whenever folders change
    var _origBuildAllStrips = buildAllStrips;
    buildAllStrips = function () { _origBuildAllStrips(); if (state.prodMode) checkPairCropReady(); highlightPairThumb(); };

    function loadPairImage(idx) {
        if (idx < 0 || idx >= state.pairFiles.length) return;
        state.pairIdx = idx;
        var p = state.pairFiles[idx];
        dom.pairInfo.textContent = (idx + 1) + "/" + state.pairFiles.length + "  " + p.name;
        dom.pairInfo.style.display = "";

        function loadFromFolder(folder, fileEntry, callback) {
            // Server folder: load via API
            if (!folder._isVirtual) {
                fetch("/api/load_folder", { method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: folder.path, names: [p.name] }) })
                .then(function (r) { return r.json(); })
                .then(function (d) { callback(d.status === "ok" && d.images.length ? d.images[0].uri : null); });
                return;
            }
            // Virtual folder: load from entry reference
            var entry = fileEntry._entry;
            if (!entry) { callback(null); return; }
            entry.file(function (fl) {
                var r = new FileReader();
                r.onload = function (e) { callback(e.target.result); };
                r.readAsDataURL(fl);
            });
        }

        var fA = state.pairFolderA, fB = state.pairFolderB;
        var entryA = fA.files.find(function (x) { return x.name === p.name; });
        var entryB = fB.files.find(function (x) { return x.name === p.name; });

        // Load HQ (folder B, always the larger image) into main panel
        loadFromFolder(fB, entryB, function (uriB) {
            if (!uriB) return;
            p.hq_uri = uriB;
            state.activeFid = fB.id;
            state.pairCurrentName = p.name;
            // Set activeIid from HQ folder so highlightThumb finds it
            var hqImg = fB.images.find(function (x) { return x.name === p.name; });
            if (hqImg) state.activeIid = hqImg.id;
            dom.imgMain.src = p.hq_uri;
            dom.mainTitle.textContent = "HQ: " + fB.name + "/" + p.name + "  |  LQ: " + fA.name + "/" + p.name;
            dom.mainPanel.classList.add("has-image");
            dom.saveFilename.value = p.name;
            highlightThumb();
            highlightPairThumb();
            // Load LQ (folder A) as reference for paired crop
            loadFromFolder(fA, entryA, function (uriA) {
                if (uriA) p.lq_uri = uriA;
            });
        });
    }
    // Pair navigation now handled by thumbnail clicks — see buildThumb()

    dom.btnPairCrop.addEventListener("click", function () {
        if (!hasImage() || !state.cropMode) { dom.pairStatus.textContent = "请先点击 ✂ 进入裁剪模式"; return; }
        var p = state.pairFiles[state.pairIdx]; if (!p) return;
        if (!p.hq_uri || !p.lq_uri) { dom.pairStatus.textContent = "等待图像加载..."; return; }
        if (!state.pairCurrentName || state.pairCurrentName !== p.name) { dom.pairStatus.textContent = "请先导航到当前配对"; return; }
        var outDir = dom.pairOutDir.value.trim();
        if (!outDir) { dom.pairStatus.textContent = "请先选择输出目录"; return; }
        if (!state.pairLabel) { dom.pairStatus.textContent = "请先选择或创建标签"; return; }

        var cb = state.cropBox, scale = state.pairScale;
        var baseName = p.name.replace(/\.[^.]+$/, "");
        var countKey = baseName + "_" + state.pairLabel;
        var idx = state.pairCropCounts[countKey] || 0;
        var saveName = baseName + "_" + state.pairLabel + "_" + idx;
        state.pairCropCounts[countKey] = idx + 1;

        // Crop HQ from main panel
        var cHQ = document.createElement("canvas"); cHQ.width = cb.w; cHQ.height = cb.h;
        cHQ.getContext("2d").drawImage(dom.imgMain, cb.x, cb.y, cb.w, cb.h, 0, 0, cb.w, cb.h);
        var uriHQ; try { uriHQ = cHQ.toDataURL("image/png"); } catch(e) { dom.pairStatus.textContent = "裁剪 HQ 失败"; return; }

        // Crop LQ from stored URI
        var cbLQ = { x: Math.round(cb.x / scale), y: Math.round(cb.y / scale), w: Math.round(cb.w / scale), h: Math.round(cb.h / scale) };
        dom.pairStatus.textContent = "正在保存 " + saveName + "...";
        var lqImg = new Image();
        lqImg.onload = function () {
            var cLQ = document.createElement("canvas"); cLQ.width = cbLQ.w; cLQ.height = cbLQ.h;
            cLQ.getContext("2d").drawImage(lqImg, cbLQ.x, cbLQ.y, cbLQ.w, cbLQ.h, 0, 0, cbLQ.w, cbLQ.h);
            var uriLQ; try { uriLQ = cLQ.toDataURL("image/png"); } catch(e) { dom.pairStatus.textContent = "裁剪 LQ 失败"; return; }
            var pending = 2, ok = 0;
            function saved() { pending--; if (!pending) { dom.pairStatus.textContent = "✓ 已保存 " + saveName + " (HQ+LQ, #" + idx + ")"; } }
            var hqBody = { batch_name: state.pairLabel + "/HQ", base_dir: outDir };
            var lqBody = { batch_name: state.pairLabel + "/LQ", base_dir: outDir };
            fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({ image_data: uriHQ, filename: saveName + ".png" }, hqBody)) })
            .then(function (r) { return r.json(); }).then(function (d) { if (d.status === "ok") ok++; saved(); });
            fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({ image_data: uriLQ, filename: saveName + ".png" }, lqBody)) })
            .then(function (r) { return r.json(); }).then(function (d) { if (d.status === "ok") ok++; saved(); });
        };
        lqImg.onerror = function () { dom.pairStatus.textContent = "LQ 图像加载失败"; };
        lqImg.src = p.lq_uri;
    });

    // ---- Label management ---------------------------------------------------
    function updateLabelDropdown() {
        var sel = dom.pairLabelSelect;
        sel.innerHTML = '<option value="">-- 选择标签 --</option>';
        state.pairLabels.forEach(function (l) {
            var opt = document.createElement("option"); opt.value = l; opt.textContent = l;
            if (l === state.pairLabel) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    dom.btnPairLabelAdd.addEventListener("click", function () {
        var label = dom.pairLabelInput.value.trim();
        if (!label) return;
        if (state.pairLabels.indexOf(label) < 0) {
            state.pairLabels.push(label);
            state.pairLabels.sort();
        }
        state.pairLabel = label;
        updateLabelDropdown();
        dom.pairLabelInput.value = "";
        dom.pairStatus.textContent = "标签: " + label;
    });

    dom.pairLabelInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") dom.btnPairLabelAdd.click();
    });

    dom.pairLabelSelect.addEventListener("change", function () {
        state.pairLabel = dom.pairLabelSelect.value;
        if (state.pairLabel) dom.pairStatus.textContent = "标签: " + state.pairLabel;
    });

    // ---- Output dir browse --------------------------------------------------
    dom.btnPairOutBrowse.addEventListener("click", function () {
        openBrowser(dom.pairOutDir);
    });

    dom.pairOutDir.addEventListener("input", function () {
        state.pairOutputDir = dom.pairOutDir.value.trim();
    });

    // ---- Init --------------------------------------------------------------
    dom.workspace.style.display = "none"; dom.noData.style.display = "";
    dom.saveFilename.value = "image.png"; dom.batchName.value = "saved"; dom.cropBatchName.value = "crops";
    switchMode(false);  // start in simulation mode
    updateLabelDropdown();
    setStatus("就绪 — 输入文件夹路径加载，或拖拽文件夹/图片"); fetchAlgoSpecs();
})();
