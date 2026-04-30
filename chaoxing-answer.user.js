// ==UserScript==
// @name         学习通自动答题助手
// @namespace    https://github.com/chaoxing-helper
// @version      3.7.0
// @description  抓取学习通题目，调用 AI 自动答题
// @author       chaoxing-helper
// @match        *://*.chaoxing.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      api.anthropic.com
// @connect      generativelanguage.googleapis.com
// @connect      dashscope.aliyuncs.com
// @connect      open.bigmodel.cn
// @connect      api.moonshot.cn
// @connect      api.baichuan-ai.com
// @connect      api.minimax.chat
// @connect      spark-api.xf-yun.com
// @inject-into  page
// @noframes
// @run-at       document-body
// @license      MIT
// ==/UserScript==

(function() {
    "use strict";

    /* 防止同一页面多次加载 */
    if (document.documentElement.getAttribute("data-cx-helper-loaded")) return;
    document.documentElement.setAttribute("data-cx-helper-loaded", "1");

    console.log("[学习通助手] 脚本开始加载");



    var DELAY_MS = parseInt(GM_getValue("cx_delay", 1500), 10);
    var MAX_TOKENS = parseInt(GM_getValue("cx_maxtokens", 2048), 10);
    var isRunning = false;
    var answeredCount = 0;
    var totalQuestions = 0;
    var currentRequest = null;
    var panel = null;

    /* 所有供应商配置 */
    var PROVIDER_CONFIG = {
        "deepseek": { name: "DeepSeek", base: "https://api.deepseek.com/v1" },
        "openai":   { name: "OpenAI", base: "https://api.openai.com/v1" },
        "anthropic":{ name: "Anthropic", base: "https://api.anthropic.com/v1" },
        "google":   { name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta" },
        "qwen":     { name: "通义千问", base: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
        "zhipu":    { name: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4" },
        "moonshot": { name: "月之暗面", base: "https://api.moonshot.cn/v1" },
        "baichuan": { name: "百川", base: "https://api.baichuan-ai.com/v1" },
        "minimax":  { name: "MiniMax", base: "https://api.minimax.chat/v1" },
        "spark":    { name: "讯飞星火", base: "https://spark-api.xf-yun.com/v3.5/chat" }
    };
    /* 模型 → 供应商映射 */
    var MODEL_PROVIDER_MAP = {
        "deepseek-chat":"deepseek","deepseek-reasoner":"deepseek",
        "gpt-4o":"openai","gpt-4o-mini":"openai","gpt-4-turbo":"openai","gpt-3.5-turbo":"openai",
        "claude-3-opus":"anthropic","claude-3-sonnet":"anthropic","claude-3-haiku":"anthropic","claude-3-5-sonnet":"anthropic",
        "gemini-pro":"google","gemini-1.5-pro":"google","gemini-1.5-flash":"google","gemini-2.0-flash":"google",
        "qwen-turbo":"qwen","qwen-plus":"qwen","qwen-max":"qwen",
        "glm-4":"zhipu","glm-4v":"zhipu","glm-3-turbo":"zhipu",
        "ernie-4.0":"openai","ernie-3.5":"openai","ernie-bot-turbo":"openai",
        "moonshot-v1":"moonshot","moonshot-v1-8k":"moonshot",
        "baichuan3":"baichuan","baichuan2-53b":"baichuan",
        "minimax-abab6.5":"minimax","minimax-abab5.5":"minimax",
        "spark-3.0":"spark","spark-4.0":"spark"
    };
    /* 供应商 ID 列表（按展示顺序） */
    var PROVIDER_ORDER = ["deepseek","openai","anthropic","google","qwen","zhipu","moonshot","baichuan","minimax","spark"];

    /* 按题型模型配置 */
    var MODEL_LIST = Object.keys(MODEL_PROVIDER_MAP);
    var TYPE_MODELS = {};
    function loadTypeModels() {
        var types = ["单选题","多选题","判断题","填空题","简答题"];
        types.forEach(function(t) {
            TYPE_MODELS[t] = GM_getValue("model_type_" + t, "deepseek-chat");
        });
    }
    loadTypeModels();

    /* 题目存储 */
    var _currentCourse = "";
    var _currentAssignment = "";
    function detectCourseInfo() {
        /* 课程名 — 从页面标题提取最可靠 */
        var title = document.title;
        var course = "", assign = "";

        /* 标题优先：尝试多种格式 */
        /* 格式1: 《课程名》作业名 */
        var m1 = title.match(/[《]([^》]+)[》]\s*(.+)/);
        if (m1) { course = m1[1].trim(); assign = m1[2].trim(); }
        /* 格式2: 课程名-作业名-学习通 或 课程名_作业名 */
        if (!course) {
            var parts = title.split(/[-—_―]/).map(function(s) { return s.trim(); }).filter(function(s) { return s; });
            if (parts.length >= 2 && parts[parts.length-1] !== "学习通" && parts[parts.length-1] !== "超星") {
                /* 最后一个是非平台名的部分可能是作业；第一个是课程 */
                var last = parts[parts.length-1];
                if (last === "学习通" || last === "超星") parts.pop();
                if (parts.length >= 2) {
                    course = parts[0];
                    assign = parts.slice(1).join(" - ");
                } else if (parts.length === 1) {
                    assign = parts[0];
                }
            } else {
                assign = title;
            }
        }
        /* 格式3: 纯作业名（无课程） */
        if (!course) {
            /* 尝试从页面 DOM 找课程名 */
            var cEl = document.querySelector(".courseName, .course-name, .courseTitle, .course-title, .crumb-1, .breadcrumb li:first-child a, .breadcrumb li:first-child, .nav-item.active, .cur, .main-title, .top-title, .head-title, [class*=course_], [class*=course-], .course_info .name, .teach-title, .class-name, .className, .course .name, .curriculum, .cla-name, .clazz-name");
            if (cEl) course = cEl.textContent.trim();
        }
        if (!course) {
            /* URL courseId 匹配页面脚本 */
            var cid = (location.search.match(/[?&]courseId[=:](\d+)/) || [])[1];
            if (cid) {
                var allScripts = document.querySelectorAll("script");
                for (var si = 0; si < allScripts.length; si++) {
                    var sc = allScripts[si].textContent;
                    var mc = sc.match(/course[Name\s]*[:=]\s*["']([^"']+)["']/i);
                    if (mc && sc.indexOf(cid) > -1) { course = mc[1]; break; }
                }
            }
        }
        if (!course) course = GM_getValue("cx_last_course", "");

        /* 作业名：如果标题没提取到，从 DOM 提取 */
        if (!assign) {
            var aEl = document.querySelector(".Zy_TItle, .title, .paperTitle, .assignmentName, .testName, .examName, .crumb-2, .breadcrumb li:last-child, .breadcrumb li:last-child a, .prompt, .mark_name, .colorShallow, h1, h2, h3");
            if (aEl) {
                var t = aEl.textContent.trim();
                /* 排除长度过长的（可能是题目文本） */
                if (t.length < 60) assign = t;
            }
        }
        if (!assign) assign = title.replace(/[《》]/g, "").trim();

        _currentCourse = course;
        _currentAssignment = assign || "未命名作业";
        if (course) GM_setValue("cx_last_course", course);
        log("检测到课程: " + (_currentCourse || "未识别") + " / 作业: " + _currentAssignment);
    }

    function saveAnsweredQuestion(qData, answer, model) {
        var list = GM_getValue("saved_questions", []);
        list.push({
            time: new Date().toLocaleString(),
            course: _currentCourse,
            assignment: _currentAssignment,
            question: qData.question,
            options: qData.options,
            type: qData.question_type,
            images: qData.images.length,
            answer: answer,
            model: model
        });
        if (list.length > 500) list = list.slice(-500);
        GM_setValue("saved_questions", list);
    }
    function getSavedQuestions() {
        return GM_getValue("saved_questions", []);
    }

    /* ===== 注入样式 ===== */
    function injectStyles() {
        var style = document.createElement("style");
        style.textContent = [
            "#cx-panel{position:fixed;top:80px;right:20px;z-index:999999;width:340px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.25);font:14px/1.5 'Microsoft YaHei','PingFang SC',sans-serif;color:#333;overflow:hidden;display:block;}",
            "#cx-panel *{box-sizing:border-box;margin:0;padding:0;line-height:1.5;}",
            "#cx-panel .hd{background:linear-gradient(135deg,#4A90D9,#357ABD);color:#fff;padding:14px 18px;font-size:16px;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;}",
            "#cx-panel .hd .close{cursor:pointer;font-size:20px;opacity:.7;}",
            "#cx-panel .hd .close:hover{opacity:1;}",
            "#cx-panel .bd{padding:14px 18px;}",
            "#cx-panel .row{display:flex;justify-content:space-between;align-items:center;margin:6px 0;}",
            "#cx-panel label{font-size:13px;color:#666;flex-shrink:0;margin-right:8px;}",
            "#cx-panel .key-input{width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;outline:none;box-sizing:border-box;}",
            "#cx-panel .key-input:focus{border-color:#4A90D9;}",
            "#cx-panel .btn-row{display:flex;gap:6px;justify-content:flex-end;margin:4px 0 8px;}",
            "#cx-panel .btn-sm{border:none;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer;background:#4A90D9;color:#fff;}",
            "#cx-panel .btn-sm:hover{background:#357ABD;}",
            "#cx-panel .status{padding:6px 12px;border-radius:6px;font-size:13px;margin:8px 0;text-align:center;}",
            "#cx-panel .status.ok{background:#d4edda;color:#155724;}",
            "#cx-panel .status.warn{background:#fff3cd;color:#856404;}",
            "#cx-panel .status.err{background:#f8d7da;color:#721c24;}",
            "#cx-panel .progress{font-size:14px;margin:6px 0;}",
            "#cx-panel .action-row{display:flex;gap:6px;margin:8px 0 0;}",
            "#cx-panel .action-row .btn{flex:1;text-align:center;border:none;border-radius:6px;padding:8px 0;font-size:14px;font-weight:700;cursor:pointer;}",
            "#cx-panel .btn-primary{background:#4A90D9;color:#fff;}",
            "#cx-panel .btn-primary:hover{background:#357ABD;}",
            "#cx-panel .btn-primary:disabled{background:#a0c4e8;cursor:not-allowed;}",
            "#cx-panel .btn-danger{background:#e74c3c;color:#fff;}",
            "#cx-panel .btn-danger:hover{background:#c0392b;}",
            "#cx-panel .btn-danger:disabled{background:#f0a8a0;cursor:not-allowed;}",
            "#cx-panel .log{max-height:200px;overflow-y:auto;border-top:1px solid #eee;padding:8px 16px;font-size:12px;background:#fafafa;}",
            "#cx-panel .log div{padding:2px 0;border-bottom:1px solid #f5f5f5;}",
            "#cx-panel .log .time{color:#999;margin-right:6px;}",
            ".cx-highlight{outline:3px solid #4A90D9 !important;outline-offset:2px;}",
            ".cx-done{outline:3px solid #28a745 !important;outline-offset:2px;}",
        ].join(" ");
        document.head.appendChild(style);
    }

    /* ===== 工具函数 ===== */
    function log(msg) {
        var el = document.getElementById("cx-log");
        if (!el) return;
        var t = new Date().toLocaleTimeString();
        var d = document.createElement("div");
        d.innerHTML = "<span class=\"time\">[" + t + "]</span>" + msg;
        el.appendChild(d);
        el.scrollTop = el.scrollHeight;
    }

    function setStatus(text, type) {
        var s = document.getElementById("cx-status");
        if (!s) return;
        s.textContent = text;
        s.className = "status " + (type || "warn");
    }

    function updateProgress() {
        var el = document.getElementById("cx-progress");
        if (el) el.textContent = "进度：" + answeredCount + " / " + totalQuestions;
    }

    /* ===== Token 用量统计 ===== */
    function getUsage() {
        var d = GM_getValue("cx_usage_data");
        return d || { prompt:0, completion:0, questions:0, sessions:0, total_questions:0 };
    }
    function saveUsage(p, c) {
        var d = getUsage();
        d.prompt = (d.prompt || 0) + p;
        d.completion = (d.completion || 0) + c;
        d.questions = (d.questions || 0) + 1;
        d.total_questions = (d.total_questions || 0) + 1;
        d.last_time = Date.now();
        GM_setValue("cx_usage_data", d);
    }
    function saveModelUsage(model, p, c) {
        var mu = GM_getValue("model_usage", {});
        if (!mu[model]) mu[model] = { prompt:0, completion:0 };
        mu[model].prompt += p;
        mu[model].completion += c;
        GM_setValue("model_usage", mu);
    }
    function saveUsageLog(model, p, c) {
        var logs = GM_getValue("usage_logs", []);
        logs.push({ time: Date.now(), prompt: p, completion: c, model: model });
        if (logs.length > 200) logs = logs.slice(-200);
        GM_setValue("usage_logs", logs);
    }
    function resetUsage() {
        var d = getUsage();
        d.sessions = (d.sessions || 0) + 1;
        d.prompt = 0;
        d.completion = 0;
        d.questions = 0;
        d.last_time = Date.now();
        GM_setValue("cx_usage_data", d);
    }
    function formatTime(ts) {
        if (!ts) return "暂无";
        var d = new Date(ts);
        return d.toLocaleString();
    }

/* ===== 面板创建 ===== */
    function createPanel() {
        if (document.getElementById("cx-panel")) return;

        /* 统计已配置 Key 的供应商数量 */
        function countConfiguredProviders() {
            var n = 0;
            for (var pi = 0; pi < PROVIDER_ORDER.length; pi++) {
                if (getProviderKey(PROVIDER_ORDER[pi])) n++;
            }
            return n;
        }

        panel = document.createElement("div");
        panel.id = "cx-panel";
        panel.innerHTML =
            '<div class="hd"><span>学习通答题助手</span><span class="close" id="cx-close">&times;</span></div>' +
            '<div class="bd">' +
                '<div class="status warn" id="cx-status">就绪</div>' +
                '<div class="progress" id="cx-progress">进度：0 / 0</div>' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;padding:8px;background:#f5f5f5;border-radius:6px;font-size:12px">' +
                    '<span id="cx-key-status">已配置 ' + countConfiguredProviders() + ' / ' + PROVIDER_ORDER.length + ' 个供应商 Key</span>' +
                    '<button class="btn-sm" id="cx-manage-keys" style="background:#6c757d">管理</button>' +
                '</div>' +
                '<div class="action-row">' +
                    '<button class="btn btn-primary" id="cx-start">开始答题</button>' +
                    '<button class="btn btn-danger" id="cx-stop" disabled>停止</button>' +
                '</div>' +
                '<div style="margin-top:6px;text-align:center">' +
                    '<button class="btn-sm" id="cx-debug" style="background:#6c757d">调试</button>' +
                    '<button class="btn-sm" id="cx-stats" style="background:#28a745;margin-left:4px">统计</button>' +
                '</div>' +
            '</div>' +
            '<div class="log" id="cx-log"><div>就绪，在统计界面中配置各供应商 Key 后开始</div></div>';

        document.body.appendChild(panel);
        console.log("[学习通助手] 面板已添加到页面");

        document.getElementById("cx-close").onclick = function() { panel.remove(); };
        document.getElementById("cx-manage-keys").onclick = function() {
            openStatsPage();
            setTimeout(function() {
                var ni = document.querySelector('#cx-stats-modal .ni[data-tab="models"]');
                if (ni) ni.click();
            }, 50);
        };
        document.getElementById("cx-start").onclick = startAnswering;
        document.getElementById("cx-stop").onclick = stopAnswering;
        document.getElementById("cx-debug").onclick = debugQuestions;
        document.getElementById("cx-stats").onclick = openStatsPage;

        /* ===== 面板拖拽 ===== */
        (function() {
            var header = panel.querySelector(".hd");
            var isDragging = false, startX, startY, origX, origY;
            header.onmousedown = function(e) {
                if (e.target.id === "cx-close") return;
                isDragging = true;
                var rect = panel.getBoundingClientRect();
                startX = e.clientX;
                startY = e.clientY;
                origX = rect.left;
                origY = rect.top;
                panel.style.left = origX + "px";
                panel.style.right = "auto";
                panel.style.top = origY + "px";
                document.onmousemove = function(ev) {
                    if (!isDragging) return;
                    panel.style.left = (origX + ev.clientX - startX) + "px";
                    panel.style.top = (origY + ev.clientY - startY) + "px";
                };
                document.onmouseup = function() {
                    isDragging = false;
                    document.onmousemove = null;
                    document.onmouseup = null;
                };
                e.preventDefault();
            };
        })();

        log("脚本加载成功");
    }

    /* ===== 生成题型模型选择 HTML ===== */
    function makeTypeSelects() {
        var out = "";
        var tlist = ["单选题","多选题","判断题","填空题","简答题"];
        for (var ti = 0; ti < tlist.length; ti++) {
            var t = tlist[ti];
            var cur = GM_getValue("model_type_" + t, "deepseek-chat");
            var curProvId = MODEL_PROVIDER_MAP[cur] || "deepseek";
            var curProvName = PROVIDER_CONFIG[curProvId] ? PROVIDER_CONFIG[curProvId].name : curProvId;
            out += '<div class="ms-row">'
                + '<span class="l">' + t + '</span>'
                + '<select class="type-model" data-type="' + t + '">';
            for (var mi = 0; mi < MODEL_LIST.length; mi++) {
                var m = MODEL_LIST[mi];
                var provId = MODEL_PROVIDER_MAP[m] || "deepseek";
                var provName = PROVIDER_CONFIG[provId] ? PROVIDER_CONFIG[provId].name : provId;
                out += '<option value="' + m + '"';
                if (m === cur) out += ' selected';
                out += '>' + m + ' — ' + provName + '</option>';
            }
            out += '</select>'
                + '<span class="h">' + curProvName + '</span>'
                + '</div>';
        }
        return out;
    }

    /* ===== 统计页面（站内弹层） ===== */
    function openStatsPage() {
        function escHtml(s) {
            return String(s == null ? "" : s)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
        }
        function csvEsc(s) {
            return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
        }
        function makeProviderKeyInputs() {
            var h = '<div class="mk-grid">';
            for (var pi = 0; pi < PROVIDER_ORDER.length; pi++) {
                var pid = PROVIDER_ORDER[pi];
                var pc = PROVIDER_CONFIG[pid];
                var savedKey = GM_getValue("cx_key_" + pid, "") || (pid === "deepseek" ? (GM_getValue("deepseek_key", "") || "") : "");
                var hasVal = savedKey ? ' has-val' : '';
                h += '<div class="mk-card">'
                    + '<div class="mk-card-h"><span class="n">' + pc.name + '</span><span class="s">' + pc.base.replace(/^https?:\/\//,'') + '</span></div>'
                    + '<div class="mk-card-b">'
                    + '<input class="prov-key-s' + hasVal + '" data-prov="' + pid + '" type="password" value="' + savedKey.replace(/"/g,"&quot;") + '" placeholder="' + (hasVal ? '••••••••' : '输入 API Key') + '" />'
                    + '<button class="bt prov-test-s" data-prov="' + pid + '">测试</button>'
                    + '</div></div>';
            }
            h += '</div>';
            return h;
        }

        var old = document.getElementById("cx-stats-modal");
        if (old) { old.style.display = "flex"; return; }

        var d = getUsage();
        var totalTk = (d.prompt || 0) + (d.completion || 0);
        var costInput = ((d.prompt || 0) / 1000000) * 0.5;
        var costOutput = ((d.completion || 0) / 1000000) * 2;
        var costTotal = costInput + costOutput;
        var pctIn = totalTk > 0 ? ((d.prompt || 0) / totalTk * 100).toFixed(1) : "0.0";
        var pctOut = totalTk > 0 ? ((d.completion || 0) / totalTk * 100).toFixed(1) : "0.0";
        var avgIn = d.questions > 0 ? ((d.prompt || 0) / d.questions).toFixed(0) : "0";
        var avgOut = d.questions > 0 ? ((d.completion || 0) / d.questions).toFixed(0) : "0";
        var avgCost = d.questions > 0 ? (costTotal / d.questions).toFixed(4) : "0.0000";
        var savedQs = getSavedQuestions();
        var modelSelectHtml = makeTypeSelects();

        if (!document.getElementById("cx-stats-style")) {
            var st = document.createElement("style");
            st.id = "cx-stats-style";
            st.textContent = [
                "#cx-stats-modal{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}",
                "#cx-stats-modal *{box-sizing:border-box}",
                "#cx-stats-modal .w{width:min(1100px,96vw);height:min(760px,92vh);background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
                "#cx-stats-modal .h{height:54px;padding:0 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #21262d;background:#161b22}",
                "#cx-stats-modal .h .t{font-size:16px;font-weight:700}",
                "#cx-stats-modal .x{cursor:pointer;border:none;background:transparent;color:#8b949e;font-size:22px;line-height:1}",
                "#cx-stats-modal .b{flex:1;display:flex;min-height:0}",
                "#cx-stats-modal .nav{width:180px;border-right:1px solid #21262d;background:#161b22;padding:10px}",
                "#cx-stats-modal .ni{padding:10px 12px;border-radius:8px;color:#8b949e;cursor:pointer;font-size:13px;font-weight:600;margin-bottom:6px}",
                "#cx-stats-modal .ni.on{background:rgba(88,166,255,.12);color:#e6edf3}",
                "#cx-stats-modal .main{flex:1;min-width:0;overflow:auto;padding:16px}",
                "#cx-stats-modal .tab{display:none}",
                "#cx-stats-modal .tab.on{display:block}",
                "#cx-stats-modal .gr{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px}",
                "#cx-stats-modal .cd{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:12px}",
                "#cx-stats-modal .lb{font-size:12px;color:#8b949e;margin-bottom:4px}",
                "#cx-stats-modal .nm{font-size:22px;font-weight:800}",
                "#cx-stats-modal .pn{background:#161b22;border:1px solid #21262d;border-radius:10px;margin-bottom:12px;overflow:hidden}",
                "#cx-stats-modal .ph{padding:10px 14px;border-bottom:1px solid #21262d;font-size:14px;font-weight:700}",
                "#cx-stats-modal .pb{padding:12px 14px}",
                "#cx-stats-modal .sr{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(33,38,45,.5)}",
                "#cx-stats-modal .sr:last-child{border-bottom:none}",
                "#cx-stats-modal .srr{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid rgba(33,38,45,.5)}",
                "#cx-stats-modal .srr:last-child{border-bottom:none}",
                "#cx-stats-modal .srr .d{font-size:12px;color:#8b949e;margin-top:2px}",
                "#cx-stats-modal .srr select,#cx-stats-modal .srr input{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 10px}",
                "#cx-stats-modal .srr select{min-width:180px}",
                "#cx-stats-modal .srr input[type=number]{width:120px}",
                "#cx-stats-modal .fx{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}",
                "#cx-stats-modal button.bt{border:1px solid #30363d;background:#161b22;color:#e6edf3;border-radius:6px;padding:6px 12px;cursor:pointer}",
                "#cx-stats-modal button.bt.red{border-color:rgba(248,81,73,.45);color:#f85149}",
                "#cx-stats-modal .qi{padding:10px 0;border-bottom:1px solid rgba(33,38,45,.5)}",
                "#cx-stats-modal .qi:last-child{border-bottom:none}",
                "#cx-stats-modal .qm{font-size:12px;color:#8b949e;margin-top:4px}",
                "#cx-stats-modal .ta{width:100%;min-height:100px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:10px;font-family:Consolas,monospace;resize:vertical}",
                "#cx-stats-modal table{width:100%;border-collapse:collapse;font-size:13px}",
                "#cx-stats-modal th,#cx-stats-modal td{padding:8px;border-bottom:1px solid rgba(33,38,45,.6);text-align:left}",
                "#cx-stats-modal th:last-child,#cx-stats-modal td:last-child{text-align:right}",
                /* 现代化组件 */
                "#cx-stats-modal .mk-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
                "#cx-stats-modal .mk-card{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:10px 12px;transition:border-color .2s}",
                "#cx-stats-modal .mk-card:hover{border-color:#30363d}",
                "#cx-stats-modal .mk-card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}",
                "#cx-stats-modal .mk-card-h .n{font-size:13px;font-weight:600;color:#e6edf3}",
                "#cx-stats-modal .mk-card-h .s{font-size:11px;color:#8b949e}",
                "#cx-stats-modal .mk-card-b{display:flex;gap:6px}",
                "#cx-stats-modal .mk-card-b input{flex:1;min-width:0;padding:6px 10px;font-size:13px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;outline:none;transition:border-color .2s}",
                "#cx-stats-modal .mk-card-b input:focus{border-color:#58a6ff}",
                "#cx-stats-modal .mk-card-b input.has-val{border-color:rgba(88,166,255,.3)}",
                "#cx-stats-modal .mk-card-b .bt{padding:5px 14px;font-size:12px;white-space:nowrap;border:1px solid #30363d;background:#161b22;color:#e6edf3;border-radius:6px;cursor:pointer;transition:all .15s}",
                "#cx-stats-modal .mk-card-b .bt:hover{border-color:#58a6ff;color:#58a6ff}",
                "#cx-stats-modal .mk-card-b .bt.ok{border-color:#3fb950;color:#3fb950}",
                "#cx-stats-modal .ms-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(33,38,45,.5)}",
                "#cx-stats-modal .ms-row:last-child{border-bottom:none}",
                "#cx-stats-modal .ms-row .l{font-size:13px;font-weight:600;color:#e6edf3;min-width:56px}",
                "#cx-stats-modal .ms-row select{flex:1;padding:6px 10px;font-size:13px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;outline:none;cursor:pointer;transition:border-color .2s;-webkit-appearance:none;appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238b949e' d='M6 8L1 3h10z'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 8px center;padding-right:28px}",
                "#cx-stats-modal .ms-row select:focus{border-color:#58a6ff}",
                "#cx-stats-modal .ms-row .h{font-size:11px;color:#8b949e;white-space:nowrap}"
            ].join("");
            document.head.appendChild(st);
        }

        var questionRows = "";
        if (savedQs.length === 0) {
            questionRows = '<div style="padding:24px 0;text-align:center;color:#8b949e">暂无题目记录</div>';
        } else {
            for (var qi = savedQs.length - 1; qi >= 0; qi--) {
                var q = savedQs[qi];
                var courseTag = q.course ? ' <span style="color:#58a6ff">' + escHtml(q.course) + '</span>' : '';
                var assignTag = q.assignment ? ' <span style="color:#8b949e">› ' + escHtml(q.assignment) + '</span>' : '';
                questionRows += '<div class="qi"><div>[' + (qi + 1) + '] [' + escHtml(q.type || "") + '] '
                    + escHtml((q.question || "").substring(0, 100)) + '</div>'
                    + '<div class="qm">' + escHtml(q.time || "") + courseTag + assignTag
                    + ' · ' + escHtml(q.model || "")
                    + ' · 答案: ' + escHtml((q.answer || "").substring(0, 60)) + '</div></div>';
            }
        }

        var modal = document.createElement("div");
        modal.id = "cx-stats-modal";
        modal.innerHTML = ''
            + '<div class="w">'
            + '<div class="h"><div class="t">答题助手控制台 v3.5.5</div><button class="x" id="cx-sm-close">×</button></div>'
            + '<div class="b">'
            + '<div class="nav">'
            + '<div class="ni on" data-tab="dash">仪表盘</div>'
            + '<div class="ni" data-tab="token">Token 分析</div>'
            + '<div class="ni" data-tab="questions">题目导出</div>'
            + '<div class="ni" data-tab="models">模型配置</div>'
            + '<div class="ni" data-tab="settings">系统设置</div>'
            + '<div class="ni" data-tab="help">使用说明</div>'
            + '</div>'
            + '<div class="main">'
            + '<div class="tab on" id="cx-tab-dash">'
            + '<div class="gr">'
            + '<div class="cd"><div class="lb">总 Token</div><div class="nm">' + totalTk.toLocaleString() + '</div></div>'
            + '<div class="cd"><div class="lb">本轮题数</div><div class="nm">' + (d.questions || 0) + '</div></div>'
            + '<div class="cd"><div class="lb">累计题数</div><div class="nm">' + (d.total_questions || 0) + '</div></div>'
            + '<div class="cd"><div class="lb">预估费用</div><div class="nm">¥' + costTotal.toFixed(4) + '</div></div>'
            + '</div>'
            + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
            + '<div class="pn" style="flex:1;min-width:240px"><div class="ph" style="font-size:13px">Token 占比</div><div class="pb" style="text-align:center;padding:8px"><canvas id="cx-pie-chart" width="280" height="200"></canvas></div></div>'
            + '<div class="pn" style="flex:2;min-width:300px"><div class="ph" style="font-size:13px">各题 Token 消耗</div><div class="pb" style="text-align:center;padding:8px"><canvas id="cx-line-chart" width="460" height="200"></canvas></div></div>'
            + '</div>'
            + '</div>'
            + '<div class="tab" id="cx-tab-token">'
            + '<div class="pn"><div class="ph">Token 详情</div><div class="pb"><table><tr><th>项目</th><th>值</th></tr>'
            + '<tr><td>本轮输入</td><td>' + (d.prompt || 0).toLocaleString() + '</td></tr>'
            + '<tr><td>本轮输出</td><td>' + (d.completion || 0).toLocaleString() + '</td></tr>'
            + '<tr><td>本轮总计</td><td>' + totalTk.toLocaleString() + '</td></tr>'
            + '<tr><td>平均输入/次</td><td>' + avgIn + '</td></tr>'
            + '<tr><td>平均输出/次</td><td>' + avgOut + '</td></tr>'
            + '<tr><td>平均费用/题</td><td>¥' + avgCost + '</td></tr>'
            + '</table></div></div>'
            + '</div>'
            + '<div class="tab" id="cx-tab-questions">'
            + '<div class="pn"><div class="ph">已保存题目（' + savedQs.length + '）</div><div class="pb">'
            + '<div class="fx">'
            + '<button class="bt" id="cx-exp-json">JSON</button>'
            + '<button class="bt" id="cx-exp-csv">CSV</button>'
            + '<button class="bt" id="cx-exp-txt">TXT</button>'
            + '<button class="bt" id="cx-exp-html" style="background:rgba(88,166,255,.12);border-color:#58a6ff;color:#58a6ff">HTML</button>'
            + '<button class="bt red" id="cx-clear-qs">清空</button>'
            + '</div>'
            + '<textarea class="ta" id="cx-exp-box" placeholder="导出内容显示在这里"></textarea>'
            + '<div style="margin-top:10px">' + questionRows + '</div>'
            + '</div></div>'
            + '</div>'
            + '<div class="tab" id="cx-tab-models">'
            + '<div class="pn" style="margin-bottom:8px"><div class="ph" style="padding:8px 14px;font-size:13px">API Keys</div><div class="pb" style="padding:8px 14px">'
            + makeProviderKeyInputs()
            + '<div class="fx" style="margin-top:8px"><button class="bt" id="cx-save-keys" style="background:rgba(88,166,255,.15);border-color:#58a6ff;color:#58a6ff;padding:4px 12px;font-size:12px">保存 Key</button></div>'
            + '</div></div>'
            + '<div class="pn"><div class="ph" style="padding:8px 14px;font-size:13px">按题型选择模型</div><div class="pb" style="padding:8px 14px" id="cx-model-wrap">' + modelSelectHtml + '</div></div>'
            + '</div>'
            + '<div class="tab" id="cx-tab-settings">'
            + '<div class="pn" style="margin-bottom:8px"><div class="ph" style="font-size:13px">系统参数</div><div class="pb">'
            + '<div class="srr"><div><div>答题间隔</div><div class="d">单位毫秒</div></div><div><input type="number" id="cx-s-delay" min="500" max="10000" step="100" value="' + DELAY_MS + '"></div></div>'
            + '<div class="srr"><div><div>最大 Token</div><div class="d">单次请求上限</div></div><div><input type="number" id="cx-s-maxtokens" min="256" max="8192" step="128" value="' + MAX_TOKENS + '"></div></div>'
            + '<div class="srr"><div><div>当前课程</div><div class="d">手动设置课程名</div></div><div><input type="text" id="cx-s-course" value="' + (GM_getValue("cx_last_course", "") || "").replace(/"/g,"&quot;") + '" placeholder="留空则自动检测" style="flex:1;min-width:120px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font-size:13px" /></div></div>'
            + '<div class="srr"><div><div>重置统计数据</div><div class="d">清空 token 用量与记录</div></div><div><button class="bt red" id="cx-reset-stats">重置</button></div></div>'
            + '</div></div>'
            + '<div class="pn"><div class="ph" style="font-size:13px">提示词设置</div><div class="pb">'
            + '<textarea id="cx-s-prompt" style="width:100%;min-height:80px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:8px;font-size:12px;font-family:inherit;resize:vertical;box-sizing:border-box">' + (GM_getValue("system_prompt", "") || getDefaultPrompt()).replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</textarea>'
            + '<div class="fx" style="margin-top:6px"><button class="bt" id="cx-save-sprompt" style="background:rgba(88,166,255,.15);border-color:#58a6ff;color:#58a6ff;padding:4px 12px;font-size:12px">保存提示词</button></div>'
            + '</div></div>'
            + '</div>'
            + '<div class="tab" id="cx-tab-help">'
            + '<div class="pn" style="margin-bottom:8px"><div class="ph" style="font-size:13px">📖 使用说明</div><div class="pb" style="font-size:12px;line-height:1.8">'
            + '<div style="margin-bottom:12px"><div style="color:#58a6ff;font-weight:600;margin-bottom:4px">🚀 快速开始</div><div style="color:#e6edf3">① 打开学习通作业页面<br>② 页面右侧会出现「学习通答题助手」面板<br>③ 点击「统计」→「模型配置」填入 API Key<br>④ 返回主面板，点击「开始答题」即可自动答题<br>⑤ 可随时点击「停止」按钮中断答题进程</div></div>'
            + '<div style="margin-bottom:12px"><div style="color:#3fb950;font-weight:600;margin-bottom:4px">🔧 核心功能</div><div style="color:#8b949e">✅ 支持10+ AI供应商（DeepSeek/OpenAI/Claude等），按题型自动切换<br>✅ 智能识别课程/作业信息，支持手动修改<br>✅ 支持单选/多选/判断/填空/简答等全题型<br>✅ 答题记录自动保存，支持 JSON/CSV/TXT/HTML 导出<br>✅ Token用量统计与可视化（环形图/折线图）</div></div>'
            + '<div style="margin-bottom:12px"><div style="color:#f0883e;font-weight:600;margin-bottom:4px">🤖 推荐模型</div><div style="color:#8b949e;font-family:monospace;font-size:11px">📍 DeepSeek: deepseek-chat (推荐), deepseek-reasoner<br>📍 OpenAI: gpt-4o, gpt-4o-mini<br>📍 Claude: claude-3-opus, claude-3-5-sonnet<br>📍 Gemini: gemini-1.5-pro, gemini-2.0-flash<br>📍 通义千问: qwen-turbo, qwen-plus, qwen-max<br>📍 智谱GLM: glm-4, glm-4v / 月之暗面: moonshot-v1</div></div>'
            + '<div style="margin-bottom:12px"><div style="color:#d2a8ff;font-weight:600;margin-bottom:4px">💡 使用技巧</div><div style="color:#8b949e">• 答题间隔建议 1500-3000ms，避免请求过快被限制<br>• 判断/单选题可用便宜模型，简答题用更强的模型<br>• 题目和答案会自动保存，可在「题目导出」中查看历史记录<br>• 点击「调试」按钮可预览AI答案，不自动填写<br>• 可在「系统设置」中修改提示词，引导AI生成更准答案</div></div>'
            + '<div><div style="color:#ef4444;font-weight:600;margin-bottom:4px">⚠️ 注意事项</div><div style="color:#f85149;font-size:11px">• 本脚本仅供个人学习交流，请遵守学校及平台相关规定<br>• API Key 仅保存在本地浏览器，不会上传到任何服务器<br>• 多选题请确认答案选项完整，避免漏选错选<br>• 建议先在练习题中测试，确认效果后再用于正式作业</div></div>'
            + '</div></div>'
            + '</div>'
            + '</div></div></div>';

        document.body.appendChild(modal);

        function switchTab(tab) {
            modal.querySelectorAll(".ni").forEach(function(el) { el.classList.toggle("on", el.getAttribute("data-tab") === tab); });
            modal.querySelectorAll(".tab").forEach(function(el) { el.classList.toggle("on", el.id === "cx-tab-" + tab); });
            var main = modal.querySelector(".main");
            if (main) main.scrollTop = 0;
        }

        modal.querySelectorAll(".ni").forEach(function(el) {
            el.addEventListener("click", function() { switchTab(this.getAttribute("data-tab")); });
        });
        modal.querySelector("#cx-sm-close").addEventListener("click", function() { modal.remove(); });
        modal.addEventListener("click", function(e) { if (e.target === modal) modal.remove(); });

        var expBox = modal.querySelector("#cx-exp-box");
        function doExport(fmt) {
            if (!expBox) return;
            if (fmt === "json") {
                expBox.value = JSON.stringify(savedQs, null, 2);
            } else if (fmt === "csv") {
                var header = "时间,课程,作业,题型,题目,选项,答案,模型\n";
                var rows = savedQs.map(function(q) {
                    return [csvEsc(q.time), csvEsc(q.course || ""), csvEsc(q.assignment || ""), csvEsc(q.type), csvEsc(q.question), csvEsc((q.options || []).join("; ")), csvEsc(q.answer), csvEsc(q.model)].join(",");
                }).join("\n");
                expBox.value = header + rows;
            } else if (fmt === "html") {
                var html = buildHTMLExport(savedQs, d);
                downloadFile("学习通答题记录.html", html, "text/html");
                log("HTML 文件已下载");
                return;
            } else {
                expBox.value = savedQs.map(function(q, i) {
                    return "#" + (i + 1) + " [" + (q.type || "") + "]"
                        + "\n课程: " + (q.course || "-") + " / 作业: " + (q.assignment || "-")
                        + "\n题目: " + (q.question || "")
                        + "\n选项: " + ((q.options || []).join(" | ")) + "\n答案: " + (q.answer || "")
                        + "\n模型: " + (q.model || "") + "\n时间: " + (q.time || "") + "\n---";
                }).join("\n");
            }
            expBox.focus();
            expBox.select();
        }
        function buildHTMLExport(qs, stats) {
            var totalTk = (stats.prompt || 0) + (stats.completion || 0);
            var now = new Date().toLocaleString();

            /* 按课程 > 作业分层 */
            var tree = {};
            qs.forEach(function(q) {
                var c = q.course || "未分类";
                var a = q.assignment || "未命名作业";
                if (!tree[c]) tree[c] = {};
                if (!tree[c][a]) tree[c][a] = [];
                tree[c][a].push(q);
            });

            function esc(s) { return escHtml(s); }

            function buildCard(q, idx) {
                var opts = (q.options && q.options.length) ? '<div class="opts">' + q.options.map(function(o) { return '<div class="opt">' + esc(o) + '</div>'; }).join("") + '</div>' : '';
                var imgs = q.images ? '<span class="tag img-tag">' + q.images + ' 张图片</span>' : '';
                var ans = q.answer ? '<div class="ans"><span class="al">答案</span><span class="av">' + esc(q.answer) + '</span></div>' : '';
                return '<div class="card"><div class="ch"><span class="ci">#' + idx + '</span><span class="ct tag ' + (q.type || 'unk') + '">' + esc(q.type || "未知") + '</span>' + imgs + '<span class="cm">' + esc(q.model || "") + '</span></div><div class="cq">' + esc(q.question) + '</div>' + opts + ans + '<div class="ctm"><span class="tm">' + esc(q.time || "") + '</span></div></div>';
            }

            function buildSection(courseName, assignments) {
                var total = 0;
                var html = '';
                var aNames = Object.keys(assignments);
                aNames.forEach(function(aName) {
                    var items = assignments[aName];
                    total += items.length;
                    html += '<details class="asection" open><summary class="ash"><span class="asn">' + esc(aName) + '</span><span class="asc">' + items.length + ' 题</span></summary>';
                    items.forEach(function(q, i) { html += buildCard(q, i + 1); });
                    html += '</details>';
                });
                return '<div class="csection"><div class="csh"><span class="csn">' + esc(courseName) + '</span><span class="csc">' + total + ' 题</span></div>' + html + '</div>';
            }

            var bodyContent = '';
            var cNames = Object.keys(tree);
            if (cNames.length === 0) {
                bodyContent = '<div class="empty">暂无答题记录</div>';
            } else {
                cNames.forEach(function(cName) { bodyContent += buildSection(cName, tree[cName]); });
            }

            return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>学习通答题记录</title><style>'
                + '*,*:before,*:after{box-sizing:border-box;margin:0;padding:0}'
                + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#0d1117;color:#e6edf3;padding:32px 24px;max-width:900px;margin:0 auto}'
                + '.hdr{margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid #21262d}'
                + '.hdr h1{font-size:24px;font-weight:800;margin-bottom:8px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}'
                + '.hdr .sub{font-size:13px;color:#8b949e;display:flex;gap:20px;flex-wrap:wrap}'
                + '.csection{margin-bottom:24px}'
                + '.csh{display:flex;align-items:center;gap:12px;padding:12px 16px;background:linear-gradient(135deg,rgba(59,130,246,.08),rgba(139,92,246,.05));border:1px solid rgba(59,130,246,.15);border-radius:10px;margin-bottom:10px}'
                + '.csn{font-size:16px;font-weight:700;color:#e6edf3}'
                + '.csc{font-size:12px;color:#8b949e;background:#0d1117;padding:2px 10px;border-radius:12px;border:1px solid #21262d}'
                + '.asection{background:#161b22;border:1px solid #21262d;border-radius:10px;margin-bottom:10px;overflow:hidden}'
                + '.asection[open]{padding-bottom:8px}'
                + '.ash{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;list-style:none;user-select:none}'
                + '.ash::-webkit-details-marker{display:none}'
                + '.ash:before{content:"▶";font-size:10px;color:#8b949e;transition:transform .2s;margin-right:2px}'
                + 'details[open]>.ash:before{transform:rotate(90deg)}'
                + '.asn{font-size:14px;font-weight:600;color:#e6edf3;flex:1}'
                + '.asc{font-size:11px;color:#8b949e;background:#0d1117;padding:1px 8px;border-radius:10px}'
                + '.card{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:14px 16px;margin:6px 10px;transition:border-color .15s}'
                + '.card:hover{border-color:#30363d}'
                + '.ch{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}'
                + '.ci{font-size:12px;font-weight:600;color:#8b949e;min-width:24px}'
                + '.tag{display:inline-block;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:600}'
                + '.tag.单选题{background:rgba(59,130,246,.12);color:#60a5fa}'
                + '.tag.多选题{background:rgba(139,92,246,.12);color:#a78bfa}'
                + '.tag.判断题{background:rgba(16,185,129,.12);color:#34d399}'
                + '.tag.填空题{background:rgba(245,158,11,.12);color:#fbbf24}'
                + '.tag.简答题{background:rgba(239,68,68,.12);color:#f87171}'
                + '.img-tag{background:rgba(236,72,153,.12);color:#f472b6}'
                + '.cm{font-size:10px;color:#8b949e;margin-left:auto}'
                + '.cq{font-size:14px;line-height:1.6;margin-bottom:8px;color:#f0f6fc}'
                + '.opts{margin-bottom:8px}'
                + '.opt{padding:6px 10px;margin:3px 0;background:#0d1117;border:1px solid rgba(33,38,45,.6);border-radius:5px;font-size:12px;line-height:1.5;color:#e6edf3}'
                + '.ans{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.15);border-radius:6px;margin-bottom:4px}'
                + '.al{font-size:10px;font-weight:700;color:#34d399;text-transform:uppercase;letter-spacing:.5px}'
                + '.av{font-size:13px;color:#e6edf3}'
                + '.ctm{font-size:10px;color:#8b949e;margin-top:4px}'
                + '.empty{padding:60px 0;text-align:center;color:#8b949e;font-size:16px}'
                + '</style></head><body>'
                + '<div class="hdr"><h1>学习通答题记录</h1><div class="sub"><span>📚 共 ' + qs.length + ' 题</span><span>📊 ' + totalTk.toLocaleString() + ' Token</span><span>📁 ' + Object.keys(tree).length + ' 个课程</span><span>🕐 ' + now + '</span></div></div>'
                + bodyContent
                + '</body></html>';
        }
        function downloadFile(filename, content, mimeType) {
            var blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click();
            setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
        }

        var btnJson = modal.querySelector("#cx-exp-json");
        var btnCsv = modal.querySelector("#cx-exp-csv");
        var btnTxt = modal.querySelector("#cx-exp-txt");
        var btnHtml = modal.querySelector("#cx-exp-html");
        if (btnJson) btnJson.onclick = function() { doExport("json"); };
        if (btnCsv) btnCsv.onclick = function() { doExport("csv"); };
        if (btnTxt) btnTxt.onclick = function() { doExport("txt"); };
        if (btnHtml) btnHtml.onclick = function() { doExport("html"); };

        var clearQsBtn = modal.querySelector("#cx-clear-qs");
        if (clearQsBtn) clearQsBtn.onclick = function() {
            if (!confirm("确定清空所有题目记录？")) return;
            GM_setValue("saved_questions", []);
            log("题目记录已清空");
            modal.remove();
            openStatsPage();
            switchTab("questions");
        };

        /* API Keys 保存 & 测试 */
        var saveKeysBtn = modal.querySelector("#cx-save-keys");
        if (saveKeysBtn) saveKeysBtn.onclick = function() {
            modal.querySelectorAll(".prov-key-s").forEach(function(inp) {
                var pid = inp.getAttribute("data-prov");
                var val = inp.value.trim();
                if (val) {
                    GM_setValue("cx_key_" + pid, val);
                    inp.classList.add("has-val");
                    inp.placeholder = "••••••••";
                } else {
                    inp.classList.remove("has-val");
                    inp.placeholder = "输入 API Key";
                }
            });
            log("所有 API Key 已保存");
        };
        modal.querySelectorAll(".prov-test-s").forEach(function(btn) {
            btn.onclick = function() {
                var pid = this.getAttribute("data-prov");
                var inp = modal.querySelector('.prov-key-s[data-prov="' + pid + '"]');
                if (inp && inp.value.trim()) GM_setValue("cx_key_" + pid, inp.value.trim());
                this.textContent = "测试中";
                testProviderKey(pid);
                var self = this;
                /* 恢复按钮文字 */
                setTimeout(function() { if (self.textContent === "测试中") self.textContent = "测试"; }, 3000);
            };
        });

        modal.querySelectorAll(".type-model").forEach(function(sel) {
            sel.addEventListener("change", function() {
                var t = this.getAttribute("data-type");
                var v = this.value;
                GM_setValue("model_type_" + t, v);
                TYPE_MODELS[t] = v;
                log(t + " 模型已设为 " + v);
                /* 更新右侧供应商提示 */
                var row = this.closest(".ms-row");
                if (row) {
                    var provId = MODEL_PROVIDER_MAP[v] || "deepseek";
                    var provName = PROVIDER_CONFIG[provId] ? PROVIDER_CONFIG[provId].name : provId;
                    var hint = row.querySelector(".h");
                    if (hint) hint.textContent = provName;
                }
            });
        });

        var delayInput = modal.querySelector("#cx-s-delay");
        if (delayInput) delayInput.addEventListener("change", function() {
            var v = parseInt(this.value, 10);
            if (isNaN(v)) return;
            DELAY_MS = v;
            GM_setValue("cx_delay", v);
            log("答题间隔已设为 " + v + "ms");
        });

        var maxTkInput = modal.querySelector("#cx-s-maxtokens");
        if (maxTkInput) maxTkInput.addEventListener("change", function() {
            var v = parseInt(this.value, 10);
            if (isNaN(v)) return;
            MAX_TOKENS = v;
            GM_setValue("cx_maxtokens", v);
            log("最大 Token 已设为 " + v);
        });

        var resetBtn = modal.querySelector("#cx-reset-stats");
        if (resetBtn) resetBtn.onclick = function() {
            if (!confirm("确定重置所有统计数据？")) return;
            GM_setValue("cx_usage_data", { prompt:0, completion:0, questions:0, sessions:(d.sessions || 0) + 1, total_questions:0, last_time:Date.now() });
            GM_setValue("model_usage", {});
            GM_setValue("usage_logs", []);
            log("统计数据已重置");
            modal.remove();
            openStatsPage();
            switchTab("settings");
        };

        /* 课程名手动设置 */
        var courseInput = modal.querySelector("#cx-s-course");
        if (courseInput) courseInput.addEventListener("change", function() {
            var v = this.value.trim();
            if (v) { _currentCourse = v; GM_setValue("cx_last_course", v); log("课程名已设为: " + v); }
        });

        /* 保存提示词 */
        var spBtn = modal.querySelector("#cx-save-sprompt");
        if (spBtn) spBtn.onclick = function() {
            var v = modal.querySelector("#cx-s-prompt").value.trim();
            if (v) { GM_setValue("system_prompt", v); log("提示词已保存"); }
        };

        /* 绘制图表 */
        function drawCharts() {
            var pieCanvas = modal.querySelector("#cx-pie-chart");
            var lineCanvas = modal.querySelector("#cx-line-chart");
            if (!pieCanvas || !lineCanvas) return;

            /* ---- 饼形图（环形图） ---- */
            (function() {
                var ctx = pieCanvas.getContext("2d");
                var W = 280, H = 200, cx = 140, cy = 85, outerR = 65, innerR = 32;
                var data = [
                    { label: "输入", value: d.prompt || 0, color: "#3b82f6", sub: (d.prompt || 0).toLocaleString() },
                    { label: "输出", value: d.completion || 0, color: "#10b981", sub: (d.completion || 0).toLocaleString() }
                ];
                var total = data[0].value + data[1].value;
                ctx.clearRect(0, 0, W, H);
                if (total === 0) {
                    ctx.fillStyle = "#8b949e"; ctx.font = "14px sans-serif"; ctx.textAlign = "center";
                    ctx.fillText("暂无数据", cx, cy + 5);
                    return;
                }
                /* 外圈发光 */
                ctx.shadowColor = "rgba(59,130,246,0.15)";
                ctx.shadowBlur = 12;
                var startAngle = -Math.PI / 2;
                data.forEach(function(d) {
                    var sliceAngle = (d.value / total) * 2 * Math.PI;
                    ctx.beginPath();
                    ctx.moveTo(cx + innerR * Math.cos(startAngle), cy + innerR * Math.sin(startAngle));
                    ctx.arc(cx, cy, outerR, startAngle, startAngle + sliceAngle);
                    ctx.arc(cx, cy, innerR, startAngle + sliceAngle, startAngle, true);
                    ctx.closePath();
                    ctx.fillStyle = d.color;
                    ctx.fill();
                    /* 描边分割线 */
                    ctx.strokeStyle = "#0d1117"; ctx.lineWidth = 2;
                    ctx.stroke();
                    startAngle += sliceAngle;
                });
                ctx.shadowBlur = 0;
                /* 中心文字 */
                ctx.fillStyle = "#e6edf3"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(total.toLocaleString(), cx, cy - 6);
                ctx.fillStyle = "#8b949e"; ctx.font = "10px sans-serif";
                ctx.fillText("总 Token", cx, cy + 12);
                /* 图例 */
                var lx = 22, ly = 162;
                data.forEach(function(d) {
                    var pct = ((d.value / total) * 100).toFixed(1);
                    /* 彩色圆点 */
                    ctx.beginPath(); ctx.arc(lx + 5, ly + 5, 5, 0, 2 * Math.PI); ctx.fillStyle = d.color; ctx.fill();
                    ctx.fillStyle = "#e6edf3"; ctx.font = "11px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
                    var label = d.label + " " + pct + "%";
                    ctx.fillText(label, lx + 14, ly + 5);
                    lx += ctx.measureText(label).width + 24;
                });
            })();

            /* ---- 折线图 ---- */
            (function() {
                var logs = GM_getValue("usage_logs", []);
                var ctx = lineCanvas.getContext("2d");
                var W = 460, H = 200;
                var pad = { t: 18, r: 12, b: 24, l: 42 };
                var cw = W - pad.l - pad.r;
                var ch = H - pad.t - pad.b;
                ctx.clearRect(0, 0, W, H);
                var pts = logs.slice(-20);
                if (pts.length < 2) {
                    ctx.fillStyle = "#8b949e"; ctx.font = "13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    ctx.fillText(pts.length === 0 ? "暂无数据" : "数据不足", pad.l + cw / 2, pad.t + ch / 2);
                    return;
                }
                var vals = pts.map(function(p) { return (p.prompt || 0) + (p.completion || 0); });
                var maxVal = Math.max.apply(null, vals);
                if (maxVal === 0) maxVal = 1;
                var roundTo = maxVal > 1000 ? 100 : (maxVal > 100 ? 10 : 1);
                var yMax = Math.ceil(maxVal / roundTo) * roundTo;
                /* 网格线（极淡） */
                ctx.strokeStyle = "rgba(48,54,61,0.4)"; ctx.lineWidth = 1;
                for (var gy = 0; gy <= 4; gy++) {
                    var y = pad.t + (gy / 4) * ch;
                    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
                    ctx.fillStyle = "#8b949e"; ctx.font = "9px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
                    ctx.fillText(Math.round(yMax * (1 - gy / 4)), pad.l - 5, y);
                }
                /* 面积渐变 */
                var stepX = pts.length > 1 ? cw / (pts.length - 1) : cw;
                var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
                grad.addColorStop(0, "rgba(59,130,246,0.2)");
                grad.addColorStop(1, "rgba(59,130,246,0.01)");
                ctx.beginPath();
                ctx.moveTo(pad.l, pad.t + ch);
                vals.forEach(function(v, i) {
                    var x = pad.l + i * stepX;
                    var y = pad.t + ch * (1 - v / yMax);
                    i === 0 ? ctx.lineTo(x, y) : ctx.lineTo(x, y);
                });
                ctx.lineTo(pad.l + (pts.length - 1) * stepX, pad.t + ch);
                ctx.closePath();
                ctx.fillStyle = grad;
                ctx.fill();
                /* 折线 */
                ctx.beginPath();
                ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2.5;
                ctx.lineJoin = "round"; ctx.lineCap = "round";
                vals.forEach(function(v, i) {
                    var x = pad.l + i * stepX;
                    var y = pad.t + ch * (1 - v / yMax);
                    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                });
                ctx.stroke();
                /* 数据点 */
                vals.forEach(function(v, i) {
                    var x = pad.l + i * stepX;
                    var y = pad.t + ch * (1 - v / yMax);
                    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI);
                    ctx.fillStyle = "#3b82f6"; ctx.fill();
                    ctx.strokeStyle = "#0d1117"; ctx.lineWidth = 2;
                    ctx.stroke();
                });
                /* X 轴标签 */
                ctx.fillStyle = "#8b949e"; ctx.font = "9px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
                var labelStep = Math.max(1, Math.floor(pts.length / 6));
                for (var i = 0; i < pts.length; i++) {
                    if (i === 0 || i === pts.length - 1 || i % labelStep === 0) {
                        ctx.fillText("#" + (i + 1), pad.l + i * stepX, pad.t + ch + 4);
                    }
                }
                /* X 轴线 */
                ctx.strokeStyle = "rgba(48,54,61,0.6)"; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(pad.l, pad.t + ch); ctx.lineTo(W - pad.r, pad.t + ch); ctx.stroke();
            })();
        }

        /* 切到仪表盘时重绘图表 */
        var origSwitch = switchTab;
        switchTab = function(tab) {
            origSwitch(tab);
            if (tab === "dash") setTimeout(drawCharts, 50);
        };
        /* 初始绘制 */
        setTimeout(drawCharts, 100);
    }

    function getDefaultPrompt() {
        return "你是答题助手。根据题目只输出答案，不要任何解释、说明、分析。\n"
            + "单选题 → 只输出字母 A/B/C/D\n"
            + "多选题 → 只输出字母逗号分隔 A,B,C\n"
            + "判断题 → 只输出 正确 或 错误\n"
            + "填空题 → 只输出答案文本\n"
            + "简答题 → 只输出答案正文，不要附加说明";
    }

    function getSystemPrompt() {
        var saved = GM_getValue("system_prompt", "");
        if (saved) return saved;
        /* stats 页面中的提示词编辑框 */
        var ta = document.getElementById("cx-s-prompt");
        if (ta && ta.value.trim()) return ta.value.trim();
        return getDefaultPrompt();
    }

    /* ===== API Key 多供应商 ===== */
    function getProviderKey(providerId) {
        /* 优先从 stats 页面的输入框读取（未保存时） */
        var statsInput = document.querySelector('.prov-key-s[data-prov="' + providerId + '"]');
        if (statsInput) {
            var v = statsInput.value.trim();
            if (v) return v;
        }
        var saved = GM_getValue("cx_key_" + providerId, "");
        if (saved) return saved;
        if (providerId === "deepseek") return GM_getValue("deepseek_key", "") || "";
        return "";
    }

    function getProviderBase(providerId) {
        var pc = PROVIDER_CONFIG[providerId];
        return pc ? pc.base : "https://api.deepseek.com/v1";
    }

    function getModelProvider(modelName) {
        return MODEL_PROVIDER_MAP[modelName] || "deepseek";
    }

    function testProviderKey(providerId) {
        var key = getProviderKey(providerId);
        var pc = PROVIDER_CONFIG[providerId];
        if (!pc) { setStatus("未知供应商", "err"); return; }
        if (!key) { setStatus("请先输入 " + pc.name + " 的 Key", "err"); return; }
        setStatus("测试 " + pc.name + "...", "warn");
        var base = pc.base;
        var testBtn = document.querySelector('.prov-test-s[data-prov="' + providerId + '"]');
        if (testBtn) { testBtn.textContent = "···"; testBtn.classList.remove("ok"); }
        GM_xmlhttpRequest({
            method: "POST",
            url: base + "/chat/completions",
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
            data: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
            timeout: 15000,
            onload: function(r) {
                setStatus(pc.name + " ✓", "ok"); log(pc.name + " API 连接正常");
                if (testBtn) { testBtn.textContent = "✓"; testBtn.classList.add("ok"); setTimeout(function() { testBtn.textContent = "测试"; testBtn.classList.remove("ok"); }, 2000); }
            },
            onerror: function(r) {
                setStatus(pc.name + " 失败: " + r.status, "err"); log(pc.name + " API 测试失败: " + r.status);
                if (testBtn) testBtn.textContent = "测试";
            },
            ontimeout: function() {
                setStatus(pc.name + " 超时", "err"); log(pc.name + " API 测试超时");
                if (testBtn) testBtn.textContent = "测试";
            }
        });
    }

    function sleep(ms) {
        return new Promise(function(resolve) {
            var interval = 100;
            var elapsed = 0;
            var timer = setInterval(function() {
                elapsed += interval;
                if (!isRunning || elapsed >= ms) {
                    clearInterval(timer);
                    resolve();
                }
            }, interval);
        });
    }

    /* ===== 题目抓取 ===== */
    function getQuestionType(el) {
        var cs = el.querySelector(".colorShallow");
        if (cs) {
            var t = cs.textContent;
            if (t.indexOf("单选题") !== -1 || t.indexOf("A1") !== -1) return "单选题";
            if (t.indexOf("多选题") !== -1 || t.indexOf("X型") !== -1) return "多选题";
            if (t.indexOf("判断题") !== -1) return "判断题";
            if (t.indexOf("填空题") !== -1) return "填空题";
            if (t.indexOf("简答题") !== -1 || t.indexOf("论述题") !== -1 || t.indexOf("名词解释") !== -1 || t.indexOf("计算题") !== -1) return "简答题";
        }
        var mn = el.querySelector(".mark_name");
        if (mn) {
            var t = mn.textContent;
            if (t.indexOf("单选题") !== -1) return "单选题";
            if (t.indexOf("多选题") !== -1 || t.indexOf("X型题") !== -1) return "多选题";
            if (t.indexOf("判断题") !== -1) return "判断题";
            if (t.indexOf("填空题") !== -1) return "填空题";
            if (t.indexOf("简答题") !== -1 || t.indexOf("论述题") !== -1) return "简答题";
        }
        var radios = el.querySelectorAll('input[type="radio"]');
        var checks = el.querySelectorAll('input[type="checkbox"]');
        var tas = el.querySelectorAll("textarea");
        if (checks.length > 0) return "多选题";
        if (radios.length > 0) return radios.length <= 2 ? "判断题" : "单选题";
        if (tas.length > 0) return (el.textContent.indexOf("___") !== -1 || el.textContent.indexOf("（）") !== -1 || el.textContent.indexOf("()") !== -1) ? "填空题" : "简答题";
        return "未知";
    }

    function getQuestionText(el) {
        var sels = [".Cy_TItle .clearfix", ".Zy_TItle", ".qtContent", "h3", ".mark_name"];
        for (var i = 0; i < sels.length; i++) {
            var e = el.querySelector(sels[i]);
            if (e && e.textContent.trim()) {
                var t = e.textContent.trim();
                var b = e.querySelector(".colorShallow");
                if (b) t = t.replace(b.textContent, "").trim();
                return t;
            }
        }
        return el.textContent.replace(/\s+/g, " ").trim();
    }

    function getOptions(el) {
        var opts = [];
        /* 如果是简答题、填空题，不抓选项 */
        var type = getQuestionType(el);
        if (type === "简答题" || type === "填空题") return opts;
        var items = el.querySelectorAll(".answerBg, .Zy_ulTop li, .Cy_ulTop li, .mark_letter li, .Zy_ulBottom li, .qtDetail li");
        if (items.length > 0) {
            items.forEach(function(it) {
                var letter = it.querySelector(".num_option, .num_option_dx");
                var text = it.querySelector(".answer_p, .ctTk, .ctKt");
                if (text && text.textContent.trim()) {
                    opts.push((letter ? letter.textContent.trim() : "") + " " + text.textContent.trim());
                } else if (it.textContent.trim()) {
                    opts.push(it.textContent.trim());
                }
            });
            if (opts.length > 0) return opts;
        }
        el.querySelectorAll("label").forEach(function(l) { if (l.textContent.trim()) opts.push(l.textContent.trim()); });
        if (opts.length > 0) return opts;
        el.querySelectorAll("li").forEach(function(l) { if (l.textContent.trim()) opts.push(l.textContent.trim()); });
        return opts;
    }

    function extractImages(el) {
        var urls = [];
        el.querySelectorAll("img").forEach(function(img) {
            var src = img.src || img.getAttribute("data-original") || "";
            if (src && src.indexOf("data:") !== 0) {
                if (src.indexOf("//") === 0) src = "https:" + src;
                urls.push(src);
            }
        });
        return urls;
    }

    function scrapeAll() {
        var items = [];
        /* 优先用 questionLi，没有再用 TiMu */
        var qlis = document.querySelectorAll(".questionLi");
        var tmus = document.querySelectorAll(".TiMu");
        var seen = new Set();
        /* 收集所有 questionLi */
        qlis.forEach(function(el) {
            var key = el.textContent.substring(0, 50);
            if (!seen.has(key)) { seen.add(key); items.push(el); }
        });
        /* 补充没有被 questionLi 覆盖的 TiMu */
        tmus.forEach(function(el) {
            var hasQli = el.querySelector(".questionLi");
            if (!hasQli) {
                var key = el.textContent.substring(0, 50);
                if (!seen.has(key)) { seen.add(key); items.push(el); }
            }
        });
        return items.map(function(el, i) {
            return {
                index: i,
                element: el,
                question: getQuestionText(el) || ("第" + (i + 1) + "题"),
                options: getOptions(el),
                question_type: getQuestionType(el),
                images: extractImages(el)
            };
        });
    }

    /* ===== 答案清洗 ===== */
    function cleanAnswer(raw, qType) {
        var a = raw.trim();
        if (qType === "单选题" || qType === "判断题") {
            /* 单选/判断：只取第一个字母或关键词 */
            var m = a.match(/^[A-D正确错误对错]/);
            if (m) return m[0];
        } else if (qType === "多选题") {
            /* 多选：只取所有 ABCD 字母（忽略大小写） */
            var ms = a.toUpperCase().match(/[A-D]/g);
            if (ms) { log("cleanAnswer 多选题: " + ms.join(",")); return ms.join(","); }
            log("cleanAnswer 多选题未匹配到字母，原始: " + a.substring(0, 50));
        } else if (qType === "填空题") {
            return a;
        }
        /* 简答题：原样返回，让 AI 自己控制输出 */
        return a;
    }
    function imgToBase64(url) {
        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method: "GET", url: url, responseType: "blob", timeout: 10000,
                onload: function(r) {
                    var fr = new FileReader();
                    fr.onloadend = function() { resolve(fr.result); };
                    fr.readAsDataURL(r.response);
                },
                onerror: function() { resolve(null); },
                ontimeout: function() { resolve(null); }
            });
        });
    }

    /* ===== AI 调用 ===== */
    function callAI(qData) {
        return new Promise(function(resolve, reject) {
            var useModel = TYPE_MODELS[qData.question_type] || "deepseek-chat";
            var providerId = getModelProvider(useModel);
            var key = getProviderKey(providerId);
            if (!key) { reject(new Error("未配置 " + (PROVIDER_CONFIG[providerId] ? PROVIDER_CONFIG[providerId].name : providerId) + " 的 API Key")); return; }

            var baseUrl = getProviderBase(providerId);

            var contentParts = [{ type: "text", text: "题目：" + qData.question }];
            if (qData.options.length > 0) {
                contentParts.push({ type: "text", text: "选项：\n" + qData.options.join("\n") });
            }
            contentParts.push({ type: "text", text: "题型：" + qData.question_type + "\n请给出正确答案。" });

            var imgPromises = qData.images.map(function(url) { return imgToBase64(url); });
            Promise.all(imgPromises).then(function(b64s) {
                b64s.forEach(function(b64) { if (b64) contentParts.push({ type: "image_url", image_url: { url: b64 } }); });

            var req = GM_xmlhttpRequest({
                method: "POST",
                url: baseUrl + "/chat/completions",
                headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
                data: JSON.stringify({
                    model: useModel,
                    messages: [
                        { role: "system", content: getSystemPrompt() },
                        { role: "user", content: contentParts }
                    ],
                    max_tokens: MAX_TOKENS,
                    temperature: 0.3
                }),
                timeout: 60000,
                onload: function(r) {
                    currentRequest = null;
                    try {
                        var j = JSON.parse(r.responseText);
                        if (j.error) { reject(new Error(j.error.message)); return; }
                        /* 记录 token 用量 */
                        if (j.usage) {
                            var pt = j.usage.prompt_tokens || 0;
                            var ct = j.usage.completion_tokens || 0;
                            saveUsage(pt, ct);
                            saveModelUsage(useModel, pt, ct);
                            saveUsageLog(useModel, pt, ct);
                        }
                        resolve({ answer: j.choices[0].message.content.trim(), model: useModel });
                    } catch(e) { reject(new Error("解析响应失败: " + e.message)); }
                },
                onerror: function(r) { currentRequest = null; reject(new Error("网络错误: " + r.status)); },
                ontimeout: function() { currentRequest = null; reject(new Error("请求超时")); }
            });
            currentRequest = req;
            });
        });
    }

    /* ===== 强力触发事件 ===== */
    function fireEvents(el) {
        var evts = ["mousedown", "mouseup", "click", "change", "input"];
        evts.forEach(function(name) {
            try { el.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true })); } catch(e) {}
        });
        /* jQuery 触发 */
        try { if (typeof unsafeWindow.$ !== "undefined") { unsafeWindow.$(el).trigger("click").trigger("change"); } } catch(e) {}
        try { if (typeof $ !== "undefined") { $(el).trigger("click").trigger("change"); } } catch(e) {}
    }

    /* ===== 通用填入逻辑 ===== */
    function fillTextInput(el, values) {
        /* 尝试多方式填入 */
        var allInputs = el.querySelectorAll('input[type="text"], input:not([type])');
        if (allInputs.length > 0) {
            log("找到 " + allInputs.length + " 个 input");
            allInputs.forEach(function(inp, i) {
                inp.value = values[i] || values[0] || "";
                inp.style.display = "";
                inp.style.visibility = "visible";
                fireEvents(inp);
            });
            return;
        }
        /* contenteditable */
        var ces = el.querySelectorAll('[contenteditable="true"]');
        if (ces.length > 0) {
            var best = ces[ces.length - 1];
            best.innerHTML = (values[0] || "").replace(/\n/g, "<br>");
            fireEvents(best);
            log("通过 contentEditable 填入");
            return;
        }
        /* iframe */
        fillIframeBody(el, values[0] || "");
    }

    /* ===== iframe编辑器填入 ===== */
    function fillIframeBody(el, content) {
        var ifs = el.querySelectorAll("iframe");
        for (var fi = 0; fi < ifs.length; fi++) {
            var f = ifs[fi];
            try {
                var fDoc = f.contentDocument || f.contentWindow.document;
                if (fDoc) {
                    var fBody = fDoc.querySelector("body");
                    if (fBody) {
                        fBody.innerHTML = content.replace(/\n/g, "<br>");
                        log("通过 iframe[" + (f.id || fi) + "] body 填入");
                        return;
                    }
                }
            } catch(e) {}
        }
        log("未找到填入位置");
    }

    /* ===== 检测并填入 UEditor + 撑开高度 ===== */
    function fillUEditor(el, content) {
        var tas = el.querySelectorAll("textarea");
        var filled = false;
        tas.forEach(function(ta) {
            var taId = ta.id;
            if (!taId) return;
            try {
                var editor = null;
                try { editor = window.UE && window.UE.getEditor && window.UE.getEditor(taId); } catch(e) {}
                if (!editor) {
                    try {
                        if (window.UE && window.UE.instances && window.UE.instances[taId]) {
                            editor = window.UE.instances[taId];
                        }
                    } catch(e) {}
                }
                if (editor && typeof editor.setContent === "function") {
                    editor.setContent(content);
                    log("通过 UEditor[" + taId + "] 填入");
                    filled = true;
                }
            } catch(e) { log("UEditor 填入失败: " + e.message); }
        });
        if (!filled) {
            fillIframeBody(el, content);
        }
        /* 吃完内容后强制撑开编辑器高度 */
        setTimeout(function() {
            autoExpandEditor(el);
        }, 300);
    }

    /* ===== 强制撑开编辑器 ===== */
    function autoExpandEditor(el) {
        var ifrs = el.querySelectorAll("iframe[id^=ueditor], iframe[id^=cke], iframe");
        ifrs.forEach(function(f) {
            try {
                var fDoc = f.contentDocument || f.contentWindow.document;
                if (!fDoc) return;
                var fBody = fDoc.querySelector("body") || fDoc.body;
                if (!fBody) return;
                /* 获取内容真实高度 */
                var contentH = Math.max(fBody.scrollHeight, 200);
                /* 1. iframe body 设为自动 */
                fBody.style.cssText = (fBody.style.cssText || "") + ";height:auto !important;min-height:" + contentH + "px !important;overflow:visible !important;";
                fBody.style.height = "auto";
                fBody.style.minHeight = contentH + "px";
                fBody.style.overflow = "visible";
                /* 2. iframe 本身设高度 */
                f.style.height = contentH + "px";
                f.setAttribute("height", contentH);
                /* 3. iframe 父容器 */
                if (f.parentElement) {
                    f.parentElement.style.height = contentH + "px";
                    f.parentElement.style.overflow = "visible";
                    /* 4. 编辑器最外层容器 */
                    var outer = f.parentElement.parentElement || f.parentElement;
                    outer.style.height = "auto";
                    outer.style.minHeight = contentH + "px";
                    outer.style.overflow = "visible";
                    var outer2 = outer.parentElement;
                    if (outer2) {
                        outer2.style.height = "auto";
                        outer2.style.overflow = "visible";
                    }
                }
                log("编辑器已撑开至 " + contentH + "px");
            } catch(e) { log("撑开高度失败: " + e.message); }
        });
    }

    /* ===== 答案填入 ===== */
    function fillAnswer(el, answer, type) {
        log("填入: " + (type === "简答题" ? answer.substring(0, 80) + "..." : answer));
        var a = answer.trim();
        switch (type) {
            case "单选题": {
                var letter = a.toUpperCase();
                var options = el.querySelectorAll(".answerBg, .Cy_ulTop li, .Zy_ulTop li, .mark_letter li, .Zy_ulBottom li");
                options.forEach(function(opt) {
                    var txt = opt.textContent.trim();
                    if (txt.indexOf(letter) === 0 || txt.indexOf(letter + ".") === 0 || txt.indexOf(letter + "、") === 0) {
                        fireEvents(opt);
                        var radio = opt.querySelector('input[type="radio"]');
                        if (radio) { radio.checked = true; fireEvents(radio); }
                        var label = opt.querySelector("label");
                        if (label) fireEvents(label);
                    }
                });
                /* 后备：直接操作 radio */
                el.querySelectorAll('input[type="radio"]').forEach(function(r, i) {
                    if (String.fromCharCode(65 + i) === letter) {
                        r.checked = true;
                        fireEvents(r);
                        (r.closest("label") || r.parentElement || r).click();
                    }
                });
                break;
            }
            case "多选题": {
                var letters = a.toUpperCase().split(/[,，、\s]+/).filter(function(s) { return s; });
                log("多选题答案: [" + letters.join(",") + "]");
                letters.forEach(function(letter) {
                    /* 仿照单选题逻辑：按文本匹配选项容器 */
                    var options = el.querySelectorAll(".answerBg, .Cy_ulTop li, .Zy_ulTop li, .mark_letter li, .Zy_ulBottom li");
                    var matched = false;
                    options.forEach(function(opt) {
                        var txt = opt.textContent.trim();
                        if (txt.indexOf(letter) === 0 || txt.indexOf(letter + ".") === 0 || txt.indexOf(letter + "、") === 0) {
                            matched = true;
                            fireEvents(opt); opt.click();
                            var cb = opt.querySelector('input[type="checkbox"]');
                            if (cb) { cb.checked = true; fireEvents(cb); }
                            var label = opt.querySelector("label");
                            if (label) { fireEvents(label); label.click(); }
                            try { if (typeof unsafeWindow.$ !== "undefined") unsafeWindow.$(opt).trigger("click"); } catch(e){}
                        }
                    });
                    /* 后备：按索引操作 */
                    if (!matched) {
                        el.querySelectorAll('input[type="checkbox"]').forEach(function(c, i) {
                            if (String.fromCharCode(65 + i) === letter) {
                                c.checked = true; fireEvents(c);
                                (c.closest("label") || c.parentElement || c).click();
                            }
                        });
                    }
                    log("多选题 已选择 " + letter);
                });
                break;
            }
            case "判断题": {
                var isTrue = a.indexOf("正确") !== -1 || a.indexOf("对") !== -1 || a === "A" || a.toLowerCase() === "true";
                el.querySelectorAll(".answerBg, .Cy_ulTop li, .Zy_ulTop li").forEach(function(opt) {
                    var txt = opt.textContent;
                    if ((isTrue && (txt.indexOf("正确") !== -1 || txt.indexOf("对") !== -1)) ||
                        (!isTrue && (txt.indexOf("错误") !== -1 || txt.indexOf("错") !== -1))) {
                        fireEvents(opt);
                        var radio = opt.querySelector('input[type="radio"]');
                        if (radio) { radio.checked = true; fireEvents(radio); }
                        var label = opt.querySelector("label");
                        if (label) fireEvents(label);
                    }
                });
                el.querySelectorAll('input[type="radio"]').forEach(function(r) {
                    var t = (r.closest("label") || r.parentElement).textContent;
                    if ((isTrue && (t.indexOf("正确") !== -1 || t.indexOf("对") !== -1)) ||
                        (!isTrue && (t.indexOf("错误") !== -1 || t.indexOf("错") !== -1))) {
                        r.checked = true;
                        fireEvents(r);
                        (r.closest("label") || r.parentElement || r).click();
                    }
                });
                break;
            }
            case "填空题": {
                var vals = a.replace(/[（）()]/g, "").split(/[,，、;；]/).map(function(s) { return s.trim(); }).filter(function(s) { return s; });
                log("填空题答案: " + vals.join(" | "));
                setTimeout(function() {
                    fillTextInput(el, vals);
                }, 300);
                break;
            }
            case "简答题": {
                log("填入简答题答案...");
                setTimeout(function() {
                    fillUEditor(el, a);
                }, 300);
                break;
            }
        }
    }

    /* ===== 逐题处理 ===== */
    async function processOne(q) {
        log("第" + (q.index + 1) + "题 [" + q.question_type + "]");
        try {
            var result = await callAI(q);
            var answer = cleanAnswer(result.answer, q.question_type);
            log("答案: " + answer.substring(0, 100) + (answer.length > 100 ? "..." : ""));
            fillAnswer(q.element, answer, q.question_type);
            q.element.classList.remove("cx-highlight", "cx-done");
            saveAnsweredQuestion(q, answer, result.model);
            answeredCount++;
            updateProgress();
            return true;
        } catch (e) {
            log("失败: " + e.message);
            q.element.classList.remove("cx-highlight");
            return false;
        }
    }

    /* ===== 主流程 ===== */
    async function startAnswering() {
        if (isRunning) return;
        detectCourseInfo();
        /* 检测至少有一个供应商配置了 Key */
        var hasAnyKey = false;
        for (var pi = 0; pi < PROVIDER_ORDER.length; pi++) {
            if (getProviderKey(PROVIDER_ORDER[pi])) { hasAnyKey = true; break; }
        }
        if (!hasAnyKey) { setStatus("请先输入至少一个供应商的 API Key", "err"); return; }

        document.getElementById("cx-start").disabled = true;
        document.getElementById("cx-stop").disabled = false;
        isRunning = true;
        answeredCount = 0;

        var questions = scrapeAll();
        totalQuestions = questions.length;
        updateProgress();

        if (totalQuestions === 0) {
            log("未找到题目");
            setStatus("未找到题目", "err");
            isRunning = false;
            document.getElementById("cx-start").disabled = false;
            document.getElementById("cx-stop").disabled = true;
            return;
        }

        log("找到 " + totalQuestions + " 题，开始答题");
        setStatus("答题中...", "ok");
        resetUsage();

        for (var i = 0; i < questions.length; i++) {
            if (!isRunning) break;
            document.querySelectorAll(".cx-highlight").forEach(function(e) { e.classList.remove("cx-highlight"); });
            await processOne(questions[i]);
            if (i < questions.length - 1) await sleep(DELAY_MS);
        }

        if (isRunning) {
            log("全部完成！");
            setStatus("完成 ✓", "ok");
            try { GM_notification({ title: "学习通答题完成", text: "已完成 " + answeredCount + "/" + totalQuestions + " 题", timeout: 5000 }); } catch(e) {}
        }
        isRunning = false;
        document.getElementById("cx-start").disabled = false;
        document.getElementById("cx-stop").disabled = true;
    }

    function stopAnswering() {
        isRunning = false;
        if (currentRequest && typeof currentRequest.abort === "function") {
            try { currentRequest.abort(); } catch(e) {}
            currentRequest = null;
        }
        /* 清除所有高亮 */
        document.querySelectorAll(".cx-highlight, .cx-done").forEach(function(e) {
            e.classList.remove("cx-highlight", "cx-done");
        });
        setStatus("已停止", "warn");
        log("已手动停止");
        document.getElementById("cx-start").disabled = false;
        document.getElementById("cx-stop").disabled = true;
    }

    /* ===== 调试 ===== */
    function debugQuestions() {
        log("===== 调试信息 =====");
        var all = document.querySelectorAll(".questionLi, .TiMu");
        log("原始匹配: " + all.length + " 个元素");
        var used = scrapeAll();
        log("去重后: " + used.length + " 道题");
        all.forEach(function(el, i) {
            var hasQli = el.querySelector(".questionLi");
            log("[" + i + "] " + (el.className || "").substring(0, 40) + (hasQli ? " [内含questionLi]" : ""));
        });
        used.forEach(function(q, i) {
            log("题" + (i+1) + ": 题型=" + q.question_type + " 选项=" + q.options.length + " 图片=" + q.images.length);
        });
        /* 分析每题的可输入元素 */
        used.forEach(function(q, i) {
            var el = q.element;
            log("--- 题" + (i+1) + " 输入元素分析 ---");
            var tas = el.querySelectorAll("textarea");
            log("  textarea: " + tas.length + " 个");
            tas.forEach(function(t, ti) { log("    [" + ti + "] id=" + (t.id||"无") + " name=" + (t.name||"无") + " display=" + (t.style.display||"默认") + " visible=" + (t.style.visibility||"默认")); });
            var ifs = el.querySelectorAll("iframe");
            log("  iframe: " + ifs.length + " 个");
            ifs.forEach(function(f, fi) { log("    [" + fi + "] id=" + (f.id||"无") + " src=" + ((f.src||"").substring(0,60)||"无")); });
            var ces = el.querySelectorAll('[contenteditable="true"]');
            log("  contentEditable: " + ces.length + " 个");
            ces.forEach(function(c, ci) { log("    [" + ci + "] id=" + (c.id||"无") + " class=" + ((c.className||"").substring(0,30)||"无")); });
            var inputs = el.querySelectorAll('input[type="text"], input:not([type])');
            log("  text输入框: " + inputs.length + " 个");
        });
        log("===== 调试结束 =====");
        setStatus("调试完成", "ok");
    }

    /* ===== 初始化 ===== */
    function init() {
        console.log("[学习通助手] 开始初始化");
        try {
            injectStyles();
            createPanel();
            var n = document.querySelectorAll(".questionLi, .TiMu").length;
            if (n > 0) { log("检测到 " + n + " 道题"); setStatus("已检测 " + n + " 题", "ok"); }
            else { log("未检测到题目，请在考试/作业页面使用"); }
        } catch (e) {
            console.error("[学习通助手] 初始化失败:", e);
        }
    }

    /* document-body 下 body 已存在，直接初始化 */
    init();
    console.log("[学习通助手] 脚本初始化完成");

    /* 监听统计页面的消息 */
    window.addEventListener("message", function(ev) {
        var data = ev.data || "";
        if (data === "cx_reset_stats") {
            var d = getUsage();
            d.sessions = (d.sessions || 0) + 1;
            d.prompt = 0;
            d.completion = 0;
            d.questions = 0;
            d.total_questions = 0;
            d.last_time = Date.now();
            GM_setValue("cx_usage_data", d);
            log("统计数据已重置");
        } else if (data.indexOf("cx_set_delay:") === 0) {
            var v = parseInt(data.split(":")[1], 10);
            if (v > 0) { DELAY_MS = v; GM_setValue("cx_delay", v); log("答题间隔已设为 " + v + "ms"); }
        } else if (data.indexOf("cx_set_model:") === 0) {
            var m = data.split(":")[1];
            GM_setValue("cx_model", m); log("模型已设为 " + m);
        } else if (data.indexOf("cx_set_maxtokens:") === 0) {
            var mt = parseInt(data.split(":")[1], 10);
            if (mt > 0) { GM_setValue("cx_maxtokens", mt); log("最大 Token 已设为 " + mt); }
        } else if (data.indexOf("cx_set_model_type:") === 0) {
            var parts = data.split(":");
            var typeName = parts[1];
            var modelName = parts.slice(2).join(":");
            if (typeName && modelName) {
                GM_setValue("model_type_" + typeName, modelName);
                TYPE_MODELS[typeName] = modelName;
                log(typeName + " 模型已设为 " + modelName);
            }
        } else if (data === "cx_clear_questions") {
            GM_setValue("saved_questions", []);
            log("题目记录已清空");
        } else if (data.indexOf("cx_save_api:") === 0) {
            var parts = data.substring("cx_save_api:".length).split(":");
            var key = parts[0];
            var base = parts.slice(1).join(":");
            if (key && key.length > 5) { GM_setValue("cx_key_deepseek", key); GM_setValue("deepseek_key", key); log("API Key 已更新"); }
        } else if (data.indexOf("cx_test_key:") === 0) {
            var testKey = data.substring("cx_test_key:".length);
            if (testKey && testKey.length > 5) {
                GM_setValue("cx_key_deepseek", testKey);
                testProviderKey("deepseek");
            } else {
                log("测试失败: API Key 格式不正确");
            }
        }
    });

    // 控制台使用说明
    function showUsageGuide() {
        console.log('%c📚 学习通自动答题助手 使用说明 v3.7.0', 'color: #165DFF; font-size: 18px; font-weight: bold; padding: 8px 0;');
        console.log('%c----------------------------------------', 'color: #E5E7EB;');
        
        console.group('%c🔧 核心功能', 'color: #36D399; font-size: 15px; font-weight: bold;');
        console.log('%c✅ 支持10+AI供应商混合调用（DeepSeek/OpenAI/Anthropic等）', 'color: #333; line-height: 1.6;');
        console.log('%c✅ 自动识别课程/作业信息，支持手动覆盖', 'color: #333; line-height: 1.6;');
        console.log('%c✅ 单/多选题自动识别填写，适配多种页面结构', 'color: #333; line-height: 1.6;');
        console.log('%c✅ 答题记录按课程>作业分类导出（JSON/CSV/TXT/HTML）', 'color: #333; line-height: 1.6;');
        console.log('%c✅ 答题统计可视化（环形图/折线图）', 'color: #333; line-height: 1.6;');
        console.groupEnd();
        
        console.group('%c📖 使用方法', 'color: #F59E0B; font-size: 15px; font-weight: bold;');
        console.log('%c1. 配置API：打开统计面板 → API设置 → 填写对应供应商Key和模型', 'color: #333; line-height: 1.6;');
        console.log('%c2. 启动答题：进入学习通作业页面 → 点击「开始答题」按钮', 'color: #333; line-height: 1.6;');
        console.log('%c3. 查看统计：点击脚本图标 → 切换至统计面板', 'color: #333; line-height: 1.6;');
        console.log('%c4. 导出记录：统计面板 → 选择导出格式 → 自动下载', 'color: #333; line-height: 1.6;');
        console.groupEnd();
        
        console.group('%c⚠️ 注意事项', 'color: #EF4444; font-size: 15px; font-weight: bold;');
        console.log('%c• 请遵守学校及平台使用规定，合理使用', 'color: #333; line-height: 1.6;');
        console.log('%c• 多选题请确认答案选项完整，避免漏选', 'color: #333; line-height: 1.6;');
        console.log('%c• 课程信息可在「系统设置」中手动修改', 'color: #333; line-height: 1.6;');
        console.groupEnd();
        
        console.group('%c⌨️ 控制台快捷命令', 'color: #8B5CF6; font-size: 15px; font-weight: bold;');
        console.log('%c• chaoxingHelp()：再次查看本使用说明', 'color: #333; line-height: 1.6;');
        console.log('%c• chaoxingVersion：查看当前脚本版本', 'color: #333; line-height: 1.6;');
        console.groupEnd();
        
        console.log('%c----------------------------------------', 'color: #E5E7EB;');
        console.log('%c💡 如有问题，请检查控制台报错或联系开发者', 'color: #666; font-style: italic;');
    }

    // 脚本加载时自动显示一次说明
    setTimeout(showUsageGuide, 1000);

    // 暴露快捷命令到页面控制台
    window.chaoxingHelp = showUsageGuide;
    window.chaoxingVersion = function() {
        console.log('%c当前版本：v3.7.0', 'color: #165DFF; font-weight: bold;');
    };

})();
