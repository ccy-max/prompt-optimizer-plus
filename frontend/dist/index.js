// prompt-optimizer-plus v1.2.5 — 提示词优化插件前端
// v1.2.5: 导出文件名加日期时间(yyyyMMddHHmm)；全局滚动条统一细线风格（6px 圆角灰色，亮暗适配）（非 window.confirm）；模板列表显示供应商；分类下拉改 antd Select；Select hover 边框统一蓝色（hover去背景/分类模型移下方/三图标分色/删除二次确认/输入框加高/分类下拉统一/模型下拉蓝框）
// 演进历史（v0.1.x 开发期）：v0.1.7 清理调试日志；v0.1.6 弹窗头/底固定；v0.1.5 暗色跟随 QwenPaw；v0.1.4 去 AI 化；v0.1.3 修复闪烁/弹窗消失；v0.1.2 修复点编辑崩溃；v0.1.1 模型选择器
// 功能演进历史（v2.x 时代，id 曾为 prompt-optimizer）：
// v2.14: po-head 顶部浮动（sticky top）+ po-actions 底部贴合（sticky bottom），不随内容滚动
// v2.13: − 收起（保留状态，刷新丢弃）/ ✕ 关闭（彻底清除状态，重开全新）
// v2.12: 弹窗点外部不关闭（仅 ✕ 关闭，防误触中断）+ 面板状态全局缓存重开恢复 + 标题 ❓ 内置变量使用说明弹窗
// v2.11: 迭代优化（用上次结果再优化，originalPrompt 保持最初值 + 迭代次数显示）；当前输入框可编辑+空输入提示「原始提示词必填」；复制/填入成功提示
// v2.10: 内置变量注入（{{originalPrompt}}/{{userQuestion}}/{{conversationContext}}/{{toolsContext}}/{{lastOptimizedPrompt}} 等）+ 修复 include_context（apiHeaders 补传 X-Session-Id）
// v2.9: 新增配置导出/导入（JSON 文件，模板不带 model_id；GET /export + POST /import）
// v2.8: 模板拖拽排序（HTML5 drag&drop + reorder API 持久化）+ 默认模板可删除（后端记录 _deleted_builtins 防止重启重建）
// v2.7: 修复填入输入框彻底无反应 — PromptOptimizerPanel 局部 setInputText(state setter) 遮蔽了全局 DOM 写入函数，applyToInput 实际调的是 setState 而非写 DOM；重命名为 setInputTextState
// v2.6: 修正输入框类型误判 — QwenPaw sender 是 textarea[data-sender-input]，不是 Lexical contenteditable；改用原生 value setter 绕过 React 受控组件 + input/change 事件
// v2.5: 修复填入输入框无反应 — execCommand('insertText') 的 beforeinput data 为 null 导致 Lexical 插不进；改用 InputEvent(beforeinput, data) 手动派发 + 选区替换
// v2.4: 修复中文输入法 compositionend 报错 — 移除空转 MutationObserver，refresh() 加防重入锁 + 数据变化才 forceUpdate
// v2.3: 修复填入输入框Bug — 输入框是 Lexical 富文本编辑器(contenteditable)，不是 textarea
(function () {
  "use strict";
  var PLUGIN_ID = "prompt-optimizer-plus";
  var apiBase = "/api/prompt-optimizer-plus";
  var cachedTemplates = [];
  var cachedModels = [];
  var cachedVariables = [];  // 自定义变量缓存（跨 Popover 保持）
  var cachedPendingResult = null;
  var cachedLastOptimized = "";   // v2.10: 上次优化结果，作为 {{lastOptimizedPrompt}} 注入（跨 Popover 保持）
  var cachedPanelState = null;    // v2.12: 面板状态缓存（输入/结果/选中/迭代），重开弹窗自动恢复
  var styleEl = null;
  var refreshBusy = false;
  var lastDataKey = null;
  var payloadTransformRegistered = false;
  var payloadTransformDisposable = null;
  var senderPrefixRegistered = false;
  var senderPrefixDisposable = null;
  var refreshSenderPrefix = null;
  var pollTimer = null;

  function agentId() {
    try {
      var storage = sessionStorage.getItem("qwenpaw-agent-storage") ||
                    localStorage.getItem("qwenpaw-agent-storage");
      if (storage) {
        var parsed = JSON.parse(storage);
        var val = parsed && parsed.state && parsed.state.selectedAgent;
        if (typeof val === "string") { var t = val.trim(); if (t && t !== "[object Object]") return t; }
        if (val && typeof val === "object") return val.id || val.agent_id || "default";
      }
    } catch (e) { return "default"; }
    return "default";
  }

  function apiHeaders() {
    var h = { "Content-Type": "application/json" };
    var aid = agentId(); if (aid) h["X-Agent-Id"] = aid;
    // v2.10: 补传当前会话 ID，后端 _fetch_context 依赖它取上下文（修复「包含上下文」失效）
    try { if (window.currentSessionId) h["X-Session-Id"] = String(window.currentSessionId); } catch (e) {}
    try { var token = localStorage.getItem("qwenpaw_auth_token"); if (token) h.Authorization = "Bearer " + token; } catch (e) {}
    return h;
  }

  // --- 输入框操作（参照 QwenPaw 官方写入方式）---
  // QwenPaw 输入框是 Lexical contenteditable，不是 textarea
  // 写入方式：focus → selectAll → execCommand('insertText')
  // 读取方式：contenteditable.textContent

  // ★ 缓存 contenteditable 元素引用（Popover 打开前缓存）
  var _cachedEditable = null;

  function _findEditable() {
    // 1. 主输入框：textarea[data-sender-input]（当前 QwenPaw sender 就是 textarea）
    var ta = document.querySelector('textarea[data-sender-input="true"]');
    if (ta) return ta;
    ta = document.querySelector("textarea.qwenpaw-sender-input");
    if (ta) return ta;
    ta = document.querySelector('[data-sender-root="true"] textarea');
    if (ta) return ta;
    // 2. 兜底：Lexical contenteditable（部分 agent 可能用富文本输入框）
    var all = document.querySelectorAll("[contenteditable='true']");
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute("role") === "textbox" && all[i].offsetParent !== null) return all[i];
    }
    for (var j = 0; j < all.length; j++) {
      if (all[j].offsetParent !== null) return all[j];
    }
    return all[all.length - 1] || null;
  }

  function getEditable() {
    if (_cachedEditable && _cachedEditable.isConnected) return _cachedEditable;
    _cachedEditable = _findEditable();
    return _cachedEditable;
  }

  // ★ 在 Popover 打开前缓存 contenteditable 元素
  function cacheEditable() {
    var el = _findEditable();
    if (el) _cachedEditable = el;
    return el;
  }

  function isTextarea(el) {
    return !!(el && el.tagName && el.tagName.toLowerCase() === "textarea");
  }

  // --- 获取输入框内容 ---
  function getInputText() {
    var el = getEditable();
    if (!el) return "";
    if (isTextarea(el)) return el.value || "";
    return el.textContent || "";
  }

  // --- 设置输入框内容 ---
  function setInputText(text) {
    var el = getEditable();
    if (!el) {
      return false;
    }

    // 主路径：textarea（React 受控组件）
    if (isTextarea(el)) {
      try {
        el.focus();
        // 用原生 value setter 绕过 React 受控组件的 value tracker，
        // 否则 React 会在下次渲染时用旧 state 覆盖掉程序化写入的值
        var nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        ).set;
        nativeSetter.call(el, text);
        // 触发 input + change，让 React 的 onChange 更新内部 state
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (e) {
        return false;
      }
    }

    // 兜底：contenteditable（Lexical 富文本）
    try {
      el.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      var ev = new InputEvent("beforeinput", {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      el.dispatchEvent(ev);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function fetchTemplates() {
    try { var r = await fetch(apiBase + "/templates?_=" + Date.now(), { headers: apiHeaders(), cache: "no-store" }); if (!r.ok) return []; var d = await r.json(); return d.templates || []; } catch (e) { return []; }
  }
  async function fetchModels() {
    try { var r = await fetch(apiBase + "/models?_=" + Date.now(), { headers: apiHeaders(), cache: "no-store" }); if (!r.ok) return []; var d = await r.json(); return d.models || []; } catch (e) { return []; }
  }
  async function createTemplate(data) {
    try { var r = await fetch(apiBase + "/templates", { method: "POST", headers: apiHeaders(), body: JSON.stringify(data) }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } catch (e) { return null; }
  }
  async function updateTemplate(id, data) {
    try { var r = await fetch(apiBase + "/templates/" + encodeURIComponent(id), { method: "PUT", headers: apiHeaders(), body: JSON.stringify(data) }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } catch (e) { return null; }
  }
  async function deleteTemplate(id) {
    try { var r = await fetch(apiBase + "/templates/" + encodeURIComponent(id), { method: "DELETE", headers: apiHeaders() }); return r.ok; } catch (e) { return false; }
  }
  async function reorderTemplates(ids) {
    try { var r = await fetch(apiBase + "/templates/reorder", { method: "POST", headers: apiHeaders(), body: JSON.stringify({ template_ids: ids }) }); return r.ok; } catch (e) { return false; }
  }
  async function optimizePrompt(params) {
    try { var r = await fetch(apiBase + "/optimize", { method: "POST", headers: apiHeaders(), body: JSON.stringify(params) }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function fetchSettings() {
    try { var r = await fetch(apiBase + "/settings", { headers: apiHeaders(), cache: "no-store" }); if (!r.ok) return null; var d = await r.json(); return d.settings || null; } catch (e) { return null; }
  }
  async function saveSettings(settings) {
    try { var r = await fetch(apiBase + "/settings", { method: "PUT", headers: apiHeaders(), body: JSON.stringify(settings) }); return r.ok; } catch (e) { return false; }
  }

  // v1.4.0: 项目感知 API
  async function fetchProjectInfo(refresh) {
    try { var r = await fetch(apiBase + "/project-info" + (refresh ? "?refresh=1" : ""), { headers: apiHeaders(), cache: "no-store" }); if (!r.ok) return null; var d = await r.json(); return d.project || null; } catch (e) { return null; }
  }
  async function rescanProject() {
    try { var r = await fetch(apiBase + "/project/rescan", { method: "POST", headers: apiHeaders() }); if (!r.ok) return null; var d = await r.json(); return d.project || null; } catch (e) { return null; }
  }

  // --- 自定义变量 API ---
  async function fetchVariables() {
    try { var r = await fetch(apiBase + "/variables?_=" + Date.now(), { headers: apiHeaders(), cache: "no-store" }); if (!r.ok) return []; var d = await r.json(); return d.variables || []; } catch (e) { return []; }
  }
  async function createVariable(data) {
    try { var r = await fetch(apiBase + "/variables", { method: "POST", headers: apiHeaders(), body: JSON.stringify(data) }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } catch (e) { return { ok: false, error: String(e) }; }
  }
  async function updateVariable(id, data) {
    try { var r = await fetch(apiBase + "/variables/" + encodeURIComponent(id), { method: "PUT", headers: apiHeaders(), body: JSON.stringify(data) }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } catch (e) { return { ok: false, error: String(e) }; }
  }
  async function deleteVariable(id) {
    try { var r = await fetch(apiBase + "/variables/" + encodeURIComponent(id), { method: "DELETE", headers: apiHeaders() }); return r.ok; } catch (e) { return false; }
  }

  // 7 个内置变量名（用于编辑器的插入列表，用户不可创建同名）
  var BUILTIN_VARS = [
    {name:"originalPrompt",label:"原始提示词",desc:"用户最初的原始提示词"},
    {name:"userQuestion",label:"用户问题",desc:"用户问题或输入"},
    {name:"currentPrompt",label:"当前提示词",desc:"当前使用的提示词（本轮输入）"},
    {name:"iterateInput",label:"迭代输入",desc:"本轮迭代的输入内容"},
    {name:"lastOptimizedPrompt",label:"上次优化结果",desc:"上一次优化的结果"},
    {name:"conversationContext",label:"会话上下文",desc:"当前会话上下文（JSON）"},
    {name:"toolsContext",label:"工具列表",desc:"当前 agent 可用工具（JSON）"}
  ];

  function buildProviderTree(models) {
    var tree = {};
    models.forEach(function(m) {
      var pid = m.provider || "unknown";
      if (!tree[pid]) { tree[pid] = { name: m.provider_name || pid, models: [] }; }
      tree[pid].models.push({ id: m.id, name: m.name, is_active: m.is_active, is_free: m.is_free });
    });
    return tree;
  }

  // v0.1.2: React 错误边界 — 任何子组件渲染崩溃只显示错误提示，不导致整个插件消失
  function makeErrorBoundary(React) {
    return class extends React.Component {
      constructor(props) { super(props); this.state = { hasError:false, message:"" }; }
      static getDerivedStateFromError(err) {
        return { hasError:true, message: (err && err.message) ? err.message : String(err) };
      }
      componentDidCatch(err, info) {
        try { console.error("[prompt-optimizer-plus] 渲染错误:", err, info); } catch (e) {}
      }
      render() {
        if (this.state.hasError) {
          return React.createElement("div", { className:"po-error-boundary" },
            "⚠️ 插件渲染出错：" + this.state.message);
        }
        return this.props.children;
      }
    };
  }

  // v0.1.2: ErrorBoundary class 必须只创建一次并复用 — 若每次渲染都新建 class，
  // React 会认为 content 组件类型变化，把整个面板卸载重挂载（state 全丢、弹窗消失）
  var _errorBoundaryClass = null;
  function getErrorBoundary(React) {
    if (!_errorBoundaryClass) _errorBoundaryClass = makeErrorBoundary(React);
    return _errorBoundaryClass;
  }

  function getIcon() { return ""; }

  function injectStyles() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.textContent = [
      ".po-panel{width:min(480px,calc(100vw - 24px));max-height:calc(100vh - 120px);overflow-y:auto;box-sizing:border-box;background:#fff;border:1px solid #e7e9ed;border-radius:8px;box-shadow:0 18px 44px rgba(26,38,54,.2);font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#273142}",
      ".po-panel *{box-sizing:border-box}.po-panel::-webkit-scrollbar,.po-field-textarea::-webkit-scrollbar,.po-result-text::-webkit-scrollbar,.po-modal::-webkit-scrollbar,.po-templates::-webkit-scrollbar,.po-var-list::-webkit-scrollbar,.po-modal-body::-webkit-scrollbar,.po-help::-webkit-scrollbar,.po-help-code::-webkit-scrollbar{width:2px}.po-panel::-webkit-scrollbar-track,.po-field-textarea::-webkit-scrollbar-track,.po-result-text::-webkit-scrollbar-track,.po-modal::-webkit-scrollbar-track,.po-templates::-webkit-scrollbar-track,.po-var-list::-webkit-scrollbar-track,.po-modal-body::-webkit-scrollbar-track,.po-help::-webkit-scrollbar-track,.po-help-code::-webkit-scrollbar-track{background:transparent}.po-panel::-webkit-scrollbar-thumb,.po-field-textarea::-webkit-scrollbar-thumb,.po-result-text::-webkit-scrollbar-thumb,.po-modal::-webkit-scrollbar-thumb,.po-templates::-webkit-scrollbar-thumb,.po-var-list::-webkit-scrollbar-thumb,.po-modal-body::-webkit-scrollbar-thumb,.po-help::-webkit-scrollbar-thumb,.po-help-code::-webkit-scrollbar-thumb{background:#c5cbd3;border-radius:3px}.po-panel::-webkit-scrollbar-thumb:hover,.po-field-textarea::-webkit-scrollbar-thumb:hover,.po-result-text::-webkit-scrollbar-thumb:hover,.po-modal::-webkit-scrollbar-thumb:hover,.po-templates::-webkit-scrollbar-thumb:hover,.po-var-list::-webkit-scrollbar-thumb:hover,.po-modal-body::-webkit-scrollbar-thumb:hover,.po-help::-webkit-scrollbar-thumb:hover,.po-help-code::-webkit-scrollbar-thumb:hover{background:#9aa6b5}.po-panel{scrollbar-width:thin;scrollbar-color:#c5cbd3 transparent}",
      ".po-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 12px;border-bottom:1px solid #edf0f3;position:sticky;top:0;z-index:5;background:#fff}",
      ".po-heading{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:650;color:#202938}",
      ".po-heading-mark{width:8px;height:8px;border-radius:50%;background:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.12)}",
      ".po-head-actions{display:flex;align-items:center;gap:2px}",
      ".po-head-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:4px;background:none;cursor:pointer;font-size:14px;line-height:1;color:#86909c;transition:background .15s,color .15s}",
      ".po-head-btn:hover{background:#eef1f5;color:#2563eb}",
      ".po-close{background:none;border:none;cursor:pointer;font-size:16px;color:#86909c;padding:4px;line-height:1}",
      ".po-close:hover{color:#273142}",
      ".po-section{padding:12px 16px;border-bottom:1px solid #edf0f3}",
      ".po-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}",
      ".po-section-head-actions{display:flex;align-items:center;gap:6px}",
      ".po-section-title{font-size:11px;font-weight:750;letter-spacing:.08em;color:#526073}",
      ".po-add-btn{height:24px;padding:0 8px;border:1px solid #e2e6eb;border-radius:4px;background:#fff;color:#273142;cursor:pointer;font:inherit;font-weight:500;font-size:11px;transition:border-color .15s,color .15s}.po-add-btn:hover{border-color:#2563eb;color:#2563eb}",
      "",
      "",
      ".po-tpl{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e2e6eb;border-radius:6px;cursor:pointer;transition:all .15s}",
      ".po-tpl:hover{border-color:#2563eb}",
      ".po-tpl-icon{font-size:16px;flex-shrink:0}",
      ".po-tpl-drag{color:#b7c0ca;font-size:13px;cursor:grab;flex-shrink:0;user-select:none;padding:0 2px;line-height:1}",
      ".po-tpl-drag:hover{color:#2563eb}",
      ".po-tpl-drag:active{cursor:grabbing}",
      ".po-tpl.po-drag-over{border-color:#2563eb;background:#faf5ff;box-shadow:inset 0 2px 0 #2563eb}",
      ".po-tpl-info{flex:1;min-width:0}",
      ".po-tpl-name{font-size:12px;font-weight:600;color:#273142;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".po-tpl-model{font-size:10px;color:#8a94a2}",
      ".po-tpl-actions{display:flex;gap:4px;flex-shrink:0}",
      ".po-tpl-btn{height:22px;padding:0 6px;border:1px solid #e2e6eb;border-radius:3px;background:#fff;color:#526073;cursor:pointer;font:inherit;font-size:10px;font-weight:600;transition:all .15s}",
      ".po-tpl-btn:hover{border-color:#2563eb;color:#2563eb}",
      ".po-tpl-btn.po-opt-btn{border-color:#2563eb;color:#2563eb}",
      ".po-tpl-btn.po-opt-btn:hover{background:#2563eb;color:#fff}",
      ".po-tpl-btn.po-del-btn:hover{border-color:#e53e3e;color:#e53e3e}",
      ".po-settings{padding:12px 16px;border-bottom:1px solid #edf0f3}",
      ".po-setting-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}",
      ".po-setting-label{font-size:11px;font-weight:600;color:#526073;min-width:70px}",
      ".po-checkbox{display:flex;align-items:center;gap:4px;font-size:11px;color:#526073;cursor:pointer}",
      ".po-checkbox input{accent-color:#2563eb}",
      ".po-input-sm{width:50px;height:22px;padding:0 4px;border:1px solid #e2e6eb;border-radius:3px;font:inherit;font-size:11px;text-align:center}",
      ".po-cascade{display:flex;gap:6px;flex:1;min-width:0}",
      ".po-cascade-select{flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid #e2e6eb;border-radius:4px;font:inherit;font-size:11px;color:#273142;background:#fff}",
      ".po-cascade-select:disabled{opacity:.5;cursor:not-allowed;background:#f5f5f5}",
      ".po-model-select{width:100%}.po-model-select .ant-select-selector{border-radius:6px!important;font-size:12px;border-color:#e2e6eb!important;min-height:26px!important}.po-model-select .ant-select-selection-overflow,.po-model-select .ant-select-selection-item,.po-model-select .ant-select-selection-placeholder{font-size:11px!important;line-height:24px!important}.po-model-select.ant-select-focused .ant-select-selector{border-color:#2563eb!important;box-shadow:0 0 0 2px rgba(37,99,235,.1)!important}.po-model-select:hover .ant-select-selector{border-color:#2563eb!important}.po-model-select.ant-select-focused .ant-select-selector{border-color:#2563eb!important}.po-model-select .ant-select-selection-search-input{font-size:11px!important;height:24px!important}.po-model-select .ant-select-selection-item{font-size:11px!important;line-height:24px!important}.po-model-select-dropdown .ant-select-item{font-size:11px}.po-model-select-dropdown .ant-select-item-option-content{white-space:normal;line-height:1.3}",
      ".po-result{padding:12px 16px;border-bottom:1px solid #edf0f3}",
      ".po-result-title{font-size:11px;font-weight:750;letter-spacing:.08em;color:#526073;margin-bottom:8px;display:flex;align-items:center;gap:6px}",
      ".po-result-card{padding:8px 10px;border:1px solid #e2e6eb;border-radius:6px;margin-bottom:6px;background:#fafbfc}",
      ".po-result-label{font-size:10px;font-weight:700;color:#8a94a2;margin-bottom:4px}",
      ".po-result-text{font-size:11px;color:#273142;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#c5cbd3 transparent}",
      ".po-result-meta{font-size:10px;color:#8a94a2;margin-top:4px}",
      ".po-req-detail{margin-top:6px;padding:10px;border:1px solid #e2e6eb;border-radius:6px;background:#fafbfc;font-size:11px;line-height:1.6}",
      "html.dark-mode .po-req-detail{border-color:#3a4553;background:#1d2430}",
      ".po-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:10px 16px;background:#fbfcfd;position:sticky;bottom:0;z-index:5;border-top:1px solid #edf0f3}",
      ".po-action{height:28px;padding:0 10px;border:1px solid #dfe4ea;border-radius:4px;background:#fff;color:#526073;cursor:pointer;font:inherit;font-weight:600;font-size:11px;transition:all .15s}",
      ".po-action:hover{border-color:#b7c0ca;color:#273142}",
      ".po-action.po-primary{border-color:#2563eb;background:#2563eb;color:#fff}",
      ".po-action.po-primary:hover{background:#1d4ed8}",
      ".po-action:disabled{cursor:wait;opacity:.65}",
      ".po-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center}",
      ".po-modal{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow-y:auto;scrollbar-width:thin;background:#fff;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.2);font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#273142}",
      ".po-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #edf0f3;position:sticky;top:0;z-index:5;background:#fff}",
      ".po-modal-title{font-size:14px;font-weight:650;color:#202938}",
      ".po-modal-body{padding:16px}",
      ".po-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #edf0f3;position:sticky;bottom:0;z-index:5;background:#fff}",
      ".po-field{margin-bottom:12px}",
      ".po-field-label{display:block;font-size:11px;font-weight:600;color:#526073;margin-bottom:4px}",
      ".po-field-input{width:100%;height:28px;padding:0 8px;border:1px solid #e2e6eb;border-radius:4px;font:inherit;font-size:12px;color:#273142}",
      ".po-field-input:focus{outline:none;border-color:#2563eb}",
      ".po-field-textarea{width:100%;min-height:120px;scrollbar-width:thin;padding:6px 8px;border:1px solid #e2e6eb;border-radius:4px;font:inherit;font-size:12px;resize:vertical;color:#273142;background:#f8f9fa}",
      ".po-field-textarea:focus{outline:none;border-color:#2563eb}",
      ".po-field-hint{font-size:10px;color:#8a94a2;margin-top:2px}",
      ".po-field-select{height:32px;padding:0 10px;border:1px solid #e2e6eb;border-radius:6px;font:inherit;font-size:12px;color:#273142;background:#fff;cursor:pointer;transition:border-color .15s}.po-field-select:hover{border-color:#b7c0ca}.po-field-select:focus{outline:none;border-color:#2563eb}",
      ".po-loading{display:flex;align-items:center;justify-content:center;padding:24px;color:#8a94a2;font-size:12px}",
      ".po-spinner{display:inline-block;width:16px;height:16px;border:2px solid #e2e6eb;border-top-color:#2563eb;border-radius:50%;animation:po-spin .6s linear infinite;margin-right:8px}",
      "@keyframes po-spin{to{transform:rotate(360deg)}}",
      ".po-empty{text-align:center;padding:20px;color:#8a94a2;font-size:12px}",
      ".po-input-preview{padding:6px 8px;border:1px solid #e2e6eb;border-radius:4px;background:#f8f9fa;font-size:11px;color:#526073;max-height:60px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:8px}",
      ".po-input-edit{width:100%;box-sizing:border-box;padding:10px;border:1px solid #e2e6eb;border-radius:4px;background:#f8f9fa;font:inherit;font-size:12px;color:#273142;resize:vertical;min-height:72px;margin-bottom:8px}.po-input-edit:focus{outline:none;border-color:#2563eb}",
      ".po-error-boundary{padding:20px;text-align:center;color:#e53e3e;font-size:12px;line-height:1.5}",
      ".po-help{font-size:12px;color:#273142}.po-help-h{font-weight:600;margin:12px 0 6px;color:#202938}.po-help-h:first-child{margin-top:0}.po-help-table{width:100%;border-collapse:collapse;font-size:11.5px}.po-help-table th,.po-help-table td{border:1px solid #e2e6eb;padding:5px 8px;text-align:left}.po-help-table th{background:#f6f7f9;color:#526073;font-weight:600}.po-help-table td:first-child{color:#2563eb;font-family:monospace;white-space:nowrap}.po-help-code{background:#f6f7f9;border:1px solid #e2e6eb;border-radius:4px;padding:8px 10px;font-family:monospace;font-size:11px;white-space:pre-wrap;color:#273142;line-height:1.6}.po-help-tip{color:#8a94a2;font-size:11px;margin-top:6px}.po-var-toolbar{display:flex;align-items:center;gap:6px}.po-var-item-opt{padding:4px 8px;cursor:pointer;border-radius:4px;line-height:1.3;transition:background .15s}.po-var-item-opt:hover{background:#f0f5ff}.po-field-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}.po-var-tab{padding:2px 10px;border:1px solid #e2e6eb;border-radius:4px;background:#fff;cursor:pointer;color:#273142;font-size:11px;font-weight:400;transition:all .15s}.po-var-tab:hover{border-color:#b7c0ca}.po-var-tab-active{border-color:#2563eb!important;font-weight:600!important}.po-var-list{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}.po-var-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid #e2e6eb;border-radius:4px;background:#f8f9fa}.po-var-info{flex:1;min-width:0}.po-var-name{font-size:12px;font-weight:600;color:#2563eb;font-family:monospace}.po-var-value{font-size:11px;color:#526073;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.po-var-sub{font-size:11px;color:#8a94a2;margin-top:2px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.po-head-var-btn{width:auto !important;padding:0 8px !important;font-size:12px !important;font-weight:500}",
      ".po-popover-shadow .ant-popover-inner{box-shadow:0 6px 20px rgba(0,0,0,.12) !important;border:1px solid #e2e6eb !important}",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "html.dark-mode .po-panel::-webkit-scrollbar-thumb,html.dark-mode .po-field-textarea::-webkit-scrollbar-thumb,html.dark-mode .po-result-text::-webkit-scrollbar-thumb,html.dark-mode .po-modal::-webkit-scrollbar-thumb,html.dark-mode .po-templates::-webkit-scrollbar-thumb,html.dark-mode .po-var-list::-webkit-scrollbar-thumb,html.dark-mode .po-modal-body::-webkit-scrollbar-thumb,html.dark-mode .po-help::-webkit-scrollbar-thumb,html.dark-mode .po-help-code::-webkit-scrollbar-thumb{background:#3a4553}html.dark-mode .po-panel::-webkit-scrollbar-thumb:hover,html.dark-mode .po-field-textarea::-webkit-scrollbar-thumb:hover,html.dark-mode .po-result-text::-webkit-scrollbar-thumb:hover,html.dark-mode .po-modal::-webkit-scrollbar-thumb:hover,html.dark-mode .po-templates::-webkit-scrollbar-thumb:hover,html.dark-mode .po-var-list::-webkit-scrollbar-thumb:hover,html.dark-mode .po-modal-body::-webkit-scrollbar-thumb:hover,html.dark-mode .po-help::-webkit-scrollbar-thumb:hover,html.dark-mode .po-help-code::-webkit-scrollbar-thumb:hover{background:#4a5568}html.dark-mode .po-panel{scrollbar-color:#3a4553 transparent}html.dark-mode .po-panel{background:#171c25;border-color:#313a47;box-shadow:0 18px 44px rgba(0,0,0,.5);color:#e7ecf3}html.dark-mode .po-head,html.dark-mode .po-section,html.dark-mode .po-settings,html.dark-mode .po-result,html.dark-mode .po-modal-head,html.dark-mode .po-modal-foot{border-color:#303946;background:#171c25}html.dark-mode .po-heading,html.dark-mode .po-modal-title{color:#eef2f7}html.dark-mode .po-section-title,html.dark-mode .po-setting-label,html.dark-mode .po-field-label{color:#c3cdda}html.dark-mode .po-tpl{border-color:#3a4553;background:#1d2430}html.dark-mode .po-tpl:hover{border-color:#2563eb;background:#1e2a44}html.dark-mode .po-tpl-name{color:#eef2f7}html.dark-mode .po-tpl-drag{color:#718095}html.dark-mode .po-tpl.po-drag-over{border-color:#2563eb;background:#1e2a44}html.dark-mode .po-tpl-model,html.dark-mode .po-tpl-btn,html.dark-mode .po-field-hint{color:#9aa6b5}html.dark-mode .po-tpl-btn{border-color:#3a4553;background:#1d2430;color:#aeb9c6}html.dark-mode .po-tpl-btn:hover{border-color:#2563eb;color:#c4b5fd}html.dark-mode .po-add-btn{border-color:#3a4553;background:#1d2430;color:#c3cdda}html.dark-mode .po-add-btn:hover{border-color:#2563eb;color:#c4b5fd}html.dark-mode .po-cascade-select,html.dark-mode .po-field-input,html.dark-mode .po-field-textarea,html.dark-mode .po-field-select{border-radius:6px}html.dark-mode .po-field-select,html.dark-mode .po-input-sm{border-color:#3a4553;background:#1d2430;color:#e7ecf3}html.dark-mode .po-cascade-select:disabled{background:#151a23}html.dark-mode .po-result-card{border-color:#3a4553;background:#1d2430}html.dark-mode .po-result-text{color:#e7ecf3;scrollbar-color:#3a4553 transparent}html.dark-mode .po-head{background:#171c25}html.dark-mode .po-actions{background:#1a202a;border-color:#303946}html.dark-mode .po-action{border-color:#3c4755;background:#202833;color:#b7c1ce}html.dark-mode .po-action:hover{border-color:#718095;color:#f4f7fa}html.dark-mode .po-action.po-primary{border-color:#2563eb;background:#2563eb;color:#fff}html.dark-mode .po-action.po-primary:hover{background:#1d4ed8}html.dark-mode .po-modal{background:#171c25;border-color:#313a47}html.dark-mode .po-close{color:#9aa6b5}html.dark-mode .po-close:hover{color:#eef2f7}html.dark-mode .po-loading,html.dark-mode .po-empty{color:#9aa6b5}html.dark-mode .po-input-preview,html.dark-mode .po-input-edit{background:#1d2430;border-color:#3a4553;color:#c3cdda}html.dark-mode .po-input-edit:focus{border-color:#2563eb}html.dark-mode .po-head-btn{color:#9aa6b5}html.dark-mode .po-head-btn:hover{background:#2a3342;color:#60a5fa}html.dark-mode .po-help{color:#c3cdda}html.dark-mode .po-help-h{color:#eef2f7}html.dark-mode .po-help-table th,html.dark-mode .po-help-table td{border-color:#3a4553}html.dark-mode .po-help-table th{background:#1d2430;color:#9aa6b5}html.dark-mode .po-help-table td:first-child{color:#c4b5fd}html.dark-mode .po-help-code{background:#1d2430;border-color:#3a4553;color:#c3cdda}html.dark-mode .po-help-tip{color:#8a94a2}html.dark-mode .po-var-item{border-color:#3a4553;background:#1d2430}html.dark-mode .po-var-name{color:#c4b5fd}html.dark-mode .po-var-value{color:#9aa6b5}html.dark-mode .po-var-sub{color:#8a94a2}html.dark-mode .po-var-item-opt:hover{background:#1e2a44}html.dark-mode .po-var-tab{border-color:#3a4553;background:#1d2430;color:#c3cdda}html.dark-mode .po-var-tab:hover{border-color:#5a6a7a}html.dark-mode .po-var-tab-active{border-color:#2563eb!important}html.dark-mode .po-tpl{border-color:#3a4553;background:#1d2430}html.dark-mode .po-tpl:hover{border-color:#2563eb}html.dark-mode .po-tpl-name{color:#eef2f7}html.dark-mode .po-tpl-opt-btn{color:#9aa6b5}html.dark-mode .po-tpl-opt-btn:hover{background:#2a3342}html.dark-mode .po-tpl-opt-btn.po-opt:hover{color:#4ade80}html.dark-mode .po-tpl-opt-btn.po-edit:hover{color:#60a5fa}html.dark-mode .po-tpl-opt-btn.po-del:hover{color:#f87171}.po-templates{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;scrollbar-width:thin;overflow-x:hidden}.po-tpl{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e2e6eb;border-radius:8px;cursor:pointer;transition:all .15s;background:#fff}.po-tpl:hover{border-color:#2563eb}.po-tpl.po-drag-over{border-color:#2563eb;background:#f0f5ff;box-shadow:inset 0 2px 0 #2563eb}.po-tpl-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.po-tpl-name{font-size:12px;font-weight:600;color:#273142;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}.po-tpl-meta{font-size:10px;color:#8a94a2;display:flex;gap:4px;align-items:center}.po-tpl-model{color:#2563eb}.po-tpl-actions{display:flex;gap:4px;flex-shrink:0;align-items:center}.po-tpl-drag{cursor:grab;flex-shrink:0;user-select:none;padding:0 2px;line-height:1;color:#b7c0ca}.po-tpl-drag:hover{color:#2563eb}.po-tpl-drag:active{cursor:grabbing}.po-tpl-opt-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:4px;background:none;cursor:pointer;line-height:1;color:#86909c;transition:background .15s,color .15s}.po-tpl-opt-btn:hover{background:#eef1f5}.po-tpl-opt-btn.po-opt:hover{color:#16a34a}.po-tpl-opt-btn.po-edit:hover{color:#2563eb}.po-tpl-opt-btn.po-del:hover{color:#e53e3e}html.dark-mode .po-popover-shadow .ant-popover-inner{border-color:#3a4553 !important}",
    ].join("\n");
    document.head.appendChild(styleEl);
  }

  function registerPayloadTransform() {
    if (payloadTransformRegistered) return true;
    var chat = window.QwenPaw && window.QwenPaw.chat;
    if (!chat || !chat.requestPayload || !chat.requestPayload.add) return false;
    payloadTransformDisposable = chat.requestPayload.add(PLUGIN_ID, function (ctx) {
      var payload = ctx.payload;
      if (!cachedPendingResult) return payload;
      var messages = payload.messages;
      if (messages && messages.length > 0) {
        for (var i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            messages[i].content = cachedPendingResult.optimized_text;
            break;
          }
        }
      }
      return payload;
    });
    payloadTransformRegistered = true;
    return true;
  }

  function registerSenderPrefix() {
    if (senderPrefixRegistered) return true;
    var ns = window.QwenPaw; var host = ns && ns.host; var sender = ns && ns.chat && ns.chat.sender;
    if (!host || !host.React || !host.antd || !sender || !sender.addPrefix) return false;
    var React = host.React; var antd = host.antd; var h = React.createElement;

    function PromptOptimizerChip() {
      var os = React.useState(false); var open = os[0]; var setOpen = os[1];
      var fu = React.useReducer(function(v){return v+1;},0)[1];
      // v1.3.1: remountKey 用于 ✕ 关闭时强制重挂载面板（全新开始）
      var rk = React.useState(0); var remountKey = rk[0]; var bumpRemount = rk[1];
      React.useEffect(function(){ refreshSenderPrefix=fu; return function(){if(refreshSenderPrefix===fu)refreshSenderPrefix=null;}; },[]);

      function handleOpenChange(visible) {
        // v2.12: 只允许打开（点 chip）；关闭一律忽略（点外部/再点 chip 都不关），
        // 仅面板内 − / ✕ 按钮能关闭 — 防止优化中误触外部导致面板关闭、状态丢失
        if (visible) { cacheEditable(); setOpen(true); }
      }

      // v2.13: − 缩小 = 关闭但保留状态（重开恢复）；✕ 关闭 = 彻底清除状态（重开全新）
      function clearPanelState() {
        cachedPanelState = null;
        cachedLastOptimized = "";
        cachedPendingResult = null;
      }

      var ErrorBoundary = getErrorBoundary(React);
      var antdIcons = host.antdIcons || null;

      return h(antd.Popover, {
        // v1.3.1: destroyOnHidden=false — 缩小时只隐藏不卸载面板，
        // 保留 loading 动画、优化结果、正在执行的 fetch promise 等全部 React state。
        // ✕ 关闭时通过 remountKey 变化强制重挂载，实现"全新开始"。
        content: h(ErrorBoundary, {React:React, key:remountKey},
          h(PromptOptimizerPanel, { React:React, antd:antd, antdIcons:antdIcons,
            onClose:function(){ clearPanelState(); bumpRemount(remountKey+1); setOpen(false); },
            onMinimize:function(){ setOpen(false); }
          })
        ),
        trigger:"click", placement:"topLeft", open:open, onOpenChange:handleOpenChange, destroyOnHidden:false,
        overlayInnerStyle:{padding:0}, styles:{body:{padding:0}},
      }, h(antd.Button, { type:"text", size:"small", title:"提示词优化", style:{paddingInline:6,fontSize:12,whiteSpace:"nowrap"} }, "✨ 优化"));
    }

    senderPrefixDisposable = sender.addPrefix(PLUGIN_ID, h(PromptOptimizerChip), { id: PLUGIN_ID+".composer", order: 210 });
    senderPrefixRegistered = true;
    return true;
  }

  function CascadeModelSelect(props) {
    var React = props.React, antd = props.antd, h = React.createElement;
    var models = props.models || [];
    var value = props.value || "";
    var onChange = props.onChange;

    var tree = React.useMemo(function() { return buildProviderTree(models); }, [models]);
    var providerIds = Object.keys(tree).sort();

    // 从当前值解析所属供应商（"provider/model" → "provider"）
    var parts = value ? value.split("/", 2) : [];
    var valueProvider = parts[0] || "";

    var selState = React.useState(valueProvider || "");
    var selProvider = selState[0];
    var setSelProvider = selState[1];

    // value 外部变化（如加载模板默认模型）时同步供应商；
    // value 为空（用户主动清空模型/换供应商）时不要重置供应商
    React.useEffect(function() {
      var p = value ? String(value).split("/", 2)[0] : "";
      if (p && p !== selProvider) setSelProvider(p);
    }, [value]);

    function filterOption(input, option) {
      var label = option && option.label ? String(option.label) : "";
      if (!label && option && option.children) label = String(option.children);
      return label.toLowerCase().indexOf(String(input || "").toLowerCase()) >= 0;
    }

    // 供应商下拉：默认模型 + 各有效供应商
    var providerOpts = [h(antd.Select.Option, { value:"", key:"__default", label:"默认模型（当前会话模型）" }, "默认模型")].concat(
      providerIds.map(function(pid) {
        var p = tree[pid];
        return h(antd.Select.Option, { value:pid, key:pid, label:p.name + "（" + p.models.length + "）" }, p.name + "（" + p.models.length + "）");
      })
    );

    // 模型下拉：默认模型 + 选中供应商的模型
    var modelOpts;
    if (!selProvider) {
      modelOpts = [h(antd.Select.Option, { value:"__none", key:"__none", disabled:true, label:"请先选择供应商" }, "请先选择供应商")];
    } else {
      modelOpts = [h(antd.Select.Option, { value:"", key:"__default", label:"默认模型" }, "默认模型")].concat(
        (tree[selProvider] ? tree[selProvider].models : []).map(function(m) {
          var suffix = "";
          return h(antd.Select.Option, { value:m.id, key:m.id, label:m.name + suffix }, m.name + suffix);
        })
      );
    }

    // 模型下拉的当前值：
    // - 未选供应商 → undefined（antd「未选择」，显示 placeholder，避免 value="" 匹配不到 option 触发异常）
    // - 已选供应商且 value 属于该供应商 → 显示该模型
    // - 已选供应商但未选模型 → ""（选中「默认模型」option）
    var modelValue;
    if (!selProvider) {
      modelValue = undefined;
    } else {
      modelValue = (value && valueProvider === selProvider) ? value : "";
    }

    return h("div", { className:"po-cascade" },
      h(antd.Select, {
        className:"po-model-select po-model-provider",
        value: selProvider || "",
        onChange: function(v){ setSelProvider(v || ""); onChange(""); },
        placeholder:"选择供应商…",
        showSearch:true, optionFilterProp:"label", filterOption:filterOption,
        dropdownMatchSelectWidth:false,
        style:{ flex:"0 0 46%" },
      }, providerOpts),
      h(antd.Select, {
        className:"po-model-select po-model-item",
        value: modelValue,
        onChange: function(v){ onChange(v || ""); },
        placeholder:"选择模型…",
        showSearch:true, optionFilterProp:"label", filterOption:filterOption,
        dropdownMatchSelectWidth:false,
        virtual:true,  // v1.3.0: 模型列表可达数百项，开启虚拟滚动
        disabled: !selProvider,
        style:{ flex:"1 1 auto" },
      }, modelOpts)
    );
  }

  function PromptOptimizerPanel(props) {
    var React=props.React, antd=props.antd, antdIcons=props.antdIcons||null, h=React.createElement;
    // v2.12: 从全局缓存恢复面板状态（重开弹窗不丢输入/结果/选中/迭代）
    var _cs = cachedPanelState || {};
    var ts=React.useState(cachedTemplates), templates=ts[0], setTemplates=ts[1];
    var ms=React.useState(cachedModels), models=ms[0], setModels=ms[1];
    var vs=React.useState(cachedVariables), variables=vs[0], setVariables=vs[1];
    var vms=React.useState(false), varManagerOpen=vms[0], setVarManagerOpen=vms[1]; // 变量管理弹窗
    var rs=React.useState(_cs.result || null), result=rs[0], setResult=rs[1];
    var ls=React.useState(false), loading=ls[0], setLoading=ls[1];
    var es=React.useState(null), editing=es[0], setEditing=es[1];
    var ss=React.useState({model_id:"",include_context:false,context_rounds:5,settings_priority:true}), settings=ss[0], setSettings=ss[1];
    var sel=React.useState(_cs.selected || null), selected=sel[0], setSelected=sel[1];
    var is=React.useState(_cs.inputText || ""), inputText=is[0], setInputTextState=is[1];
    var oriRef = React.useRef(_cs.oriInput || "");   // v2.11: 最初原始输入（迭代时保持不变，供 {{originalPrompt}}）
    var ic=React.useState(_cs.iterCount || 0), iterCount=ic[0], setIterCount=ic[1]; // 迭代轮数
    var hs=React.useState(false), helpOpen=hs[0], setHelpOpen=hs[1]; // v2.12: 内置变量帮助弹窗
    var rds=React.useState(null), reqDetails=rds[0], setReqDetails=rds[1]; // v1.3.2: 优化请求详情
    var dos=React.useState(false), detailsOpen=dos[0], setDetailsOpen=dos[1];
    var cts=React.useState(false), ctxSettingsOpen=cts[0], setCtxSettingsOpen=cts[1]; // v1.3.4: 上下文截取设置
    // v1.4.0: 设置 Tab（trunc=上下文截取, project=项目感知）+ 项目信息
    var cst=React.useState("trunc"), ctxSettingsTab=cst[0], setCtxSettingsTab=cst[1];
    var pjs=React.useState(null), projectInfo=pjs[0], setProjectInfo=pjs[1];
    var psl=React.useState(false), projectScanLoading=psl[0], setProjectScanLoading=psl[1];
    // v1.3.4: 截取设置的表单 state（必须在条件块外声明，不能条件性调用 hooks）
    var _ctxInitForm={
      ctx_trunc_head: settings.ctx_trunc_head!==undefined?settings.ctx_trunc_head:true,
      ctx_trunc_middle: settings.ctx_trunc_middle!==undefined?settings.ctx_trunc_middle:false,
      ctx_trunc_tail: settings.ctx_trunc_tail!==undefined?settings.ctx_trunc_tail:true,
      ctx_trunc_head_b: settings.ctx_trunc_head_b||500,
      ctx_trunc_middle_b: settings.ctx_trunc_middle_b||1000,
      ctx_trunc_tail_b: settings.ctx_trunc_tail_b||500,
      ctx_trunc_unit: settings.ctx_trunc_unit||"char",
      ctx_trunc_marker: settings.ctx_trunc_marker!==undefined?settings.ctx_trunc_marker:true,
      // v1.4.0: 项目感知
      include_project: settings.include_project!==undefined?settings.include_project:true,
    };
    var _ctxFS=React.useState(_ctxInitForm),_cf=_ctxFS[0],_setCF=_ctxFS[1];
    function _ctxUF(k,v){var n=Object.assign({},_cf);n[k]=v;_setCF(n);}
    // v1.4.0: 加载项目信息 / 重新扫描
    function _loadProjectInfo(refresh){
      setProjectScanLoading(true);
      var p = refresh ? rescanProject() : fetchProjectInfo(false);
      (p||Promise.resolve(null)).then(function(pj){ setProjectInfo(pj||null); setProjectScanLoading(false); }).catch(function(){ setProjectScanLoading(false); });
    }

    // v2.12: 面板状态变化 → 写回全局缓存（重开恢复）
    React.useEffect(function(){
      cachedPanelState = { inputText: inputText, result: result, selected: selected, iterCount: iterCount, oriInput: oriRef.current };
    },[inputText, result, selected, iterCount]);

    // --- 拖拽排序 ---
    var dragIdRef = React.useRef(null);
    var dv=React.useState(null), dragOverId=dv[0], setDragOverId=dv[1];

    function onTplDragStart(e, tplId) {
      dragIdRef.current = tplId;
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", tplId); } catch (err) {}
    }
    function onTplDragOver(e, tplId) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (err) {}
      if (dragOverId !== tplId) setDragOverId(tplId);
    }
    function onTplDragLeave() {
      if (dragOverId !== null) setDragOverId(null);
    }
    function onTplDrop(e, targetId) {
      e.preventDefault();
      var sourceId = dragIdRef.current;
      try { var dt = e.dataTransfer.getData("text/plain"); if (dt) sourceId = dt; } catch (err) {}
      dragIdRef.current = null;
      setDragOverId(null);
      if (!sourceId || sourceId === targetId) return;
      var arr = templates.slice();
      var fromIdx = arr.findIndex(function(t){return t.id === sourceId;});
      var toIdx = arr.findIndex(function(t){return t.id === targetId;});
      if (fromIdx < 0 || toIdx < 0) return;
      var item = arr.splice(fromIdx, 1)[0];
      arr.splice(toIdx, 0, item);
      setTemplates(arr);
      cachedTemplates = arr;
      reorderTemplates(arr.map(function(t){return t.id;}));
    }
    function onTplDragEnd() {
      dragIdRef.current = null;
      setDragOverId(null);
    }

    React.useEffect(function(){
      fetchTemplates().then(function(t){cachedTemplates=t;setTemplates(t);});
      fetchModels().then(function(m){cachedModels=m;setModels(m);});
      fetchVariables().then(function(v){cachedVariables=v;setVariables(v);});
      fetchSettings().then(function(s){
        if(s) setSettings({model_id:s.model_id||"",include_context:s.include_context||false,context_rounds:s.context_rounds||5,settings_priority:s.settings_priority!==false});
      });
    },[]);

    React.useEffect(function(){
      // v2.12: 仅当无缓存输入时，才从主输入框同步内容
      if (!cachedPanelState || !cachedPanelState.inputText) {
        var text = getInputText();
        if (text) setInputTextState(text);
      }
    },[]);

    function updateSettings(newSettings) { setSettings(newSettings); saveSettings(newSettings); }

    async function doOptimize(tid) {
      var tpl=templates.find(function(t){return t.id===tid;}); if(!tpl)return;
      var currentInput = inputText || getInputText() || "";
      if (!currentInput) {
        try { antd.message.warning("原始提示词必填"); } catch(e) { alert("原始提示词必填"); }
        return;
      }
      oriRef.current = currentInput;
      setIterCount(0);
      setLoading(true); setResult(null); setSelected(tid);
      setDetailsOpen(false);
      var params={
        user_input: currentInput,
        template_id: tid,
        model_id: settings.model_id || "",
        include_context: !!settings.include_context,
        context_rounds: settings.context_rounds || 5,
        settings_priority: settings.settings_priority!==false,  // v1.4.1
        original_prompt: currentInput,
        last_optimized_prompt: cachedLastOptimized || "",
        current_prompt: currentInput,
        iterate_input: currentInput,
      };
      var resp=await optimizePrompt(params); setLoading(false);
      // v1.3.2: 用后端返回的渲染后提示词填充请求详情
      var _d=resp.debug||{};
      setReqDetails({
        template_name: tpl.name, model_id: settings.model_id || tpl.model_id || "",
        rendered_system_prompt: _d.rendered_system_prompt||tpl.system_prompt,
        rendered_user_prompt: _d.rendered_user_prompt||tpl.user_prompt,
        custom_variables: _d.custom_variables||null,
        project_info: _d.project_info||null,  // v1.4.0
        user_input: currentInput, include_context: settings.include_context || tpl.include_context,
        context_rounds: settings.context_rounds || tpl.context_rounds,
      });
      if(resp.ok && resp.result) {
        setResult(resp.result);
        setInputTextState(currentInput);
        if (resp.result.optimized_text) cachedLastOptimized = resp.result.optimized_text;
      }
      else setResult({original_input:currentInput, optimized_text:"", template_name:tpl.name, model_used:"", error:"优化失败："+(resp.error||"未知错误")});
    }

    // v2.11: 迭代优化 — 用当前结果作为输入再优化，originalPrompt 保持最初值
    async function doIterate() {
      if(!result || !result.optimized_text) return;
      var tpl = templates.find(function(t){return t.id === selected;});
      if(!tpl) return;
      var nextInput = result.optimized_text;
      setLoading(true); setResult(null);
      setDetailsOpen(false);
      var params={
        user_input: nextInput,
        template_id: selected,
        model_id: settings.model_id || "",
        include_context: !!settings.include_context,
        context_rounds: settings.context_rounds || 5,
        settings_priority: settings.settings_priority!==false,  // v1.4.1
        original_prompt: oriRef.current || nextInput,
        last_optimized_prompt: result.optimized_text,
        current_prompt: nextInput,
        iterate_input: nextInput,
      };
      var resp = await optimizePrompt(params); setLoading(false);
      var _d=resp.debug||{};
      setReqDetails({
        template_name: tpl.name, model_id: settings.model_id || tpl.model_id || "",
        rendered_system_prompt: _d.rendered_system_prompt||tpl.system_prompt,
        rendered_user_prompt: _d.rendered_user_prompt||tpl.user_prompt,
        custom_variables: _d.custom_variables||null,
        project_info: _d.project_info||null,  // v1.4.0
        user_input: nextInput, include_context: settings.include_context || tpl.include_context,
        context_rounds: settings.context_rounds || tpl.context_rounds,
        iterate: true, original_prompt: oriRef.current || nextInput,
      });
      if(resp.ok && resp.result) {
        setResult(resp.result);
        setIterCount(iterCount + 1);
        if (resp.result.optimized_text) cachedLastOptimized = resp.result.optimized_text;
      } else {
        setResult({original_input: nextInput, optimized_text:"", template_name:tpl.name, model_used:"", error:"优化失败："+(resp.error||"未知错误")});
      }
    }

    function applyToInput() {
      if(!result || !result.optimized_text) { return; }
      var ok = setInputText(result.optimized_text);
      if (ok) {
        cachedPendingResult = { optimized_text: result.optimized_text };
        try { antd.message.success("已填入输入框"); } catch(e) { alert("已填入输入框"); }
        props.onClose();
      }
    }

    function copyResult() {
      if(!result || !result.optimized_text) return;
      navigator.clipboard.writeText(result.optimized_text).then(function(){
        try { antd.message.success("复制成功"); } catch(e) { alert("复制成功"); }
      }).catch(function(){
        try { antd.message.error("复制失败"); } catch(e) { alert("复制失败"); }
      });
    }

    async function doDelete(id) { await deleteTemplate(id); var u=await fetchTemplates(); cachedTemplates=u; setTemplates(u); }

    async function exportConfig() {
      try {
        var r = await fetch(apiBase + "/export", { headers: apiHeaders() });
        if (!r.ok) throw new Error("HTTP " + r.status);
        var data = await r.json();
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        var now = new Date();
        var pad = function(n) { return n < 10 ? "0" + n : "" + n; };
        var ts = "" + now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate()) + pad(now.getHours()) + pad(now.getMinutes());
        a.download = "prompt-optimizer-plus-config-" + ts + ".json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) { alert("导出失败: " + e); }
    }

    function importConfig() {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = function() {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = async function() {
          try {
            var data = JSON.parse(reader.result);
            var r = await fetch(apiBase + "/import", { method: "POST", headers: apiHeaders(), body: JSON.stringify(data) });
            if (!r.ok) throw new Error("HTTP " + r.status);
            var resp = await r.json();
            var t = await fetchTemplates();
            cachedTemplates = t;
            setTemplates(t);
            var s = await fetchSettings();
            if (s) setSettings({model_id:s.model_id||"", include_context:s.include_context||false, context_rounds:s.context_rounds||5, settings_priority:s.settings_priority!==false});
            var impMsg = "导入成功，共 " + (resp.imported || 0) + " 个模板";
            if (resp.imported_variables) impMsg += "，" + resp.imported_variables + " 个变量";
            alert(impMsg);
            fetchVariables().then(function(v){cachedVariables=v;setVariables(v);});
          } catch (e) { alert("导入失败: " + e); }
        };
        reader.readAsText(file);
      };
      input.click();
    }
    async function saveTemplate(data) { if(data.id&&!data.id.startsWith("new-")){await updateTemplate(data.id,data);}else{delete data.id;await createTemplate(data);} var u=await fetchTemplates(); cachedTemplates=u; setTemplates(u); setEditing(null); }

    var children=[];

    children.push(h("div",{className:"po-head",key:"head"},
      h("div",{className:"po-heading"},h("span",{className:"po-heading-mark"}),h("span",null,"提示词优化")),
      h("div",{className:"po-head-actions"},
        h("button",{className:"po-head-btn",title:"导出配置",onClick:exportConfig},(antdIcons&&antdIcons.UploadOutlined)?h(antdIcons.UploadOutlined,{style:{fontSize:14}}):"↑"),
        h("button",{className:"po-head-btn",title:"导入配置",onClick:importConfig},(antdIcons&&antdIcons.DownloadOutlined)?h(antdIcons.DownloadOutlined,{style:{fontSize:14}}):"↓"),
        h(antd.Popover, {
          open: varManagerOpen, onOpenChange: setVarManagerOpen, trigger: "click", placement: "bottomRight",
          overlayStyle: {width: 400}, overlayClassName: "po-popover-shadow",
          content: h(VariableManager, {React:React, antd:antd, variables:variables, onClose:function(){setVarManagerOpen(false);}, onRefresh:function(){fetchVariables().then(function(v){cachedVariables=v;setVariables(v);});}})
        }, h("button",{className:"po-head-btn",title:"自定义变量"},(antdIcons && antdIcons.BlockOutlined) ? h(antdIcons.BlockOutlined,{style:{fontSize:14}}) : "≡")),
        h("button",{className:"po-head-btn",onClick:function(){setCtxSettingsOpen(true);},key:"ctx-settings",title:"插件设置"},(antdIcons && antdIcons.SettingOutlined) ? h(antdIcons.SettingOutlined,{style:{fontSize:14}}) : "⚙"),
        h("button",{className:"po-head-btn",onClick:function(){setHelpOpen(true);},key:"help",title:"内置变量使用说明"},(antdIcons && antdIcons.QuestionCircleOutlined) ? h(antdIcons.QuestionCircleOutlined,{style:{fontSize:14}}) : "?\uFE0E"),
        h("button",{className:"po-head-btn",onClick:props.onMinimize,key:"min",title:"收起（保留状态）"},"−\uFE0E"),
        h("button",{className:"po-head-btn",onClick:props.onClose,key:"close",title:"关闭（清除状态）"},"✕\uFE0E")
      )
    ));

    children.push(h("div",{className:"po-section",key:"input-preview"},
      h("div",{className:"po-section-title",style:{paddingBottom:"8px"}},"当前输入"),
      h("textarea",{className:"po-input-edit",value:inputText||"",placeholder:"输入要优化的原始提示词...",rows:4,onChange:function(e){setInputTextState(e.target.value);}})
    ));

    var tplItems=templates.map(function(tpl){
      var modelParts = tpl.model_id ? tpl.model_id.split("/", 2) : [];
      var modelProvider = modelParts.length > 1 ? modelParts[0] : "";
      var modelName = modelParts.length > 1 ? modelParts[1] : (modelParts[0] || "");
      var cls = "po-tpl";
      if (dragOverId === tpl.id) cls += " po-drag-over";
      return h("div",{className:cls,key:tpl.id,onClick:function(){setSelected(tpl.id);},
        draggable:true,
        onDragStart:function(e){onTplDragStart(e, tpl.id);},
        onDragOver:function(e){onTplDragOver(e, tpl.id);},
        onDragLeave:onTplDragLeave,
        onDrop:function(e){onTplDrop(e, tpl.id);},
        onDragEnd:onTplDragEnd},
        h("span",{className:"po-tpl-drag",title:"按住拖拽排序"},"⠿"),
        h("div",{className:"po-tpl-info"},
          h("span",{className:"po-tpl-name"},tpl.name),
          h("span",{className:"po-tpl-meta"},
            h("span",null,tpl.category),
            modelProvider?h("span",null,modelProvider):null,
            modelName?h("span",{className:"po-tpl-model"},modelName):null
          )
        ),
        h("div",{className:"po-tpl-actions"},
          h("button",{className:"po-tpl-opt-btn po-opt",title:"优化",onClick:function(e){e.stopPropagation();doOptimize(tpl.id);},disabled:loading},(antdIcons&&antdIcons.ThunderboltOutlined)?h(antdIcons.ThunderboltOutlined,{style:{fontSize:16}}):"→"),
          h("button",{className:"po-tpl-opt-btn po-edit",title:"编辑",onClick:function(e){e.stopPropagation();setEditing(tpl);}},(antdIcons&&antdIcons.EditOutlined)?h(antdIcons.EditOutlined,{style:{fontSize:16}}):"✎"),
          h(antd.Popconfirm,{title:"确定删除该模板？",okText:"删除",cancelText:"取消",placement:"left",onConfirm:function(e){e.stopPropagation();doDelete(tpl.id);},onCancel:function(e){e.stopPropagation();}},
          h("button",{className:"po-tpl-opt-btn po-del",title:"删除",onClick:function(e){e.stopPropagation();}},(antdIcons&&antdIcons.DeleteOutlined)?h(antdIcons.DeleteOutlined,{style:{fontSize:16}}):"×")
        )
        )
      );
    });
    children.push(h("div",{className:"po-section",key:"tpl"},
      h("div",{className:"po-section-head"},h("span",{className:"po-section-title"},"优化模板"),h("div",{className:"po-section-head-actions"},h("button",{className:"po-add-btn",onClick:function(){setEditing({id:"new-"+Date.now(),name:"",system_prompt:"",user_prompt:"{{originalPrompt}}",category:"general",include_context:false,context_rounds:5,model_id:""});}},h("span",{style:{display:"inline-flex",alignItems:"center",gap:4}},(antdIcons&&antdIcons.PlusOutlined?h(antdIcons.PlusOutlined,{style:{fontSize:11}}):"+"),"新建")))),
      templates.length>0?h("div",{className:"po-templates"},tplItems):h("div",{className:"po-empty"},"暂无模板，点击「新建」创建")
    ));

    children.push(h("div",{className:"po-settings",key:"set"},
      h("div",{style:{display:"flex",alignItems:"center",marginBottom:8}},
        h("div",{className:"po-section-title",style:{margin:0}},"优化设置"),
        h("label",{className:"po-checkbox",style:{marginLeft:12,fontSize:11,cursor:"pointer"},title:"开启：本面板的模型/上下文设置优先于模板内设置；关闭：以每个模板内的设置为准"},
          h("input",{type:"checkbox",checked:settings.settings_priority!==false,onChange:function(e){updateSettings(Object.assign({},settings,{settings_priority:e.target.checked}));}}),
          "面板设置优先"
        ),
        settings.settings_priority===false?h("span",{style:{fontSize:10,color:"#8a94a2",marginLeft:6}},"（以模板内设置为准）"):null
      ),
      h("div",{className:"po-setting-row"},h("span",{className:"po-setting-label"},"使用模型"),
        h(CascadeModelSelect, {React:React, antd:antd, models:models, value:settings.model_id, onChange:function(v){updateSettings(Object.assign({},settings,{model_id:v}));}})
      ),
      h("div",{className:"po-setting-row"},
        h("label",{className:"po-checkbox"},h("input",{type:"checkbox",checked:settings.include_context,onChange:function(e){updateSettings(Object.assign({},settings,{include_context:e.target.checked}));}}),"包含对话上下文（最近"),
        h("input",{className:"po-input-sm",type:"number",min:1,max:20,value:settings.context_rounds,onChange:function(e){updateSettings(Object.assign({},settings,{context_rounds:parseInt(e.target.value)||5}));},disabled:!settings.include_context}),
        h("span",null,"轮）")
      )
    ));

    if(loading){children.push(h("div",{className:"po-result",key:"ld"},h("div",{className:"po-loading"},h("span",{className:"po-spinner"}),"正在优化提示词...")));}

    else if(result){
      var rc=[];
      // v1.3.2: 标题旁加请求详情按钮
      rc.push(h("div",{className:"po-result-title",key:"rt"},
        h("span",null,"优化结果"),
        reqDetails?h("button",{className:"po-head-btn",style:{marginLeft:"auto",fontSize:13},onClick:function(){setDetailsOpen(true);},title:"查看本次优化请求详情"},
          (antdIcons&&antdIcons.InfoCircleOutlined)?h(antdIcons.InfoCircleOutlined,{style:{fontSize:14}}):"ⓘ"
        ):null
      ));
      if(result.error) {
        rc.push(h("div",{className:"po-result-card",key:"err",style:{borderColor:"#e53e3e",background:"#fff5f5"}},result.error));
      } else {
        rc.push(h("div",{className:"po-result-card",key:"opt"},h("div",{className:"po-result-label"},"优化后的提示词"),h("div",{className:"po-result-text"},result.optimized_text)));
        var metaParts=[];
        if(result.model_used) metaParts.push("模型: " + result.model_used);
        if(result.template_name) metaParts.push("模板: " + result.template_name);
        if(iterCount > 0) metaParts.push("已迭代 " + iterCount + " 次");
        if(metaParts.length) rc.push(h("div",{className:"po-result-meta",key:"meta"},metaParts.join(" | ")));
      }
      children.push(h("div",{className:"po-result",key:"res"},rc));
    }

    children.push(h("div",{className:"po-actions",key:"act"},
      result && !result.error ? h("button",{className:"po-action",onClick:function(){doOptimize(selected);},disabled:loading||!selected},"重新优化") : null,
      result && result.optimized_text ? h("button",{className:"po-action",onClick:doIterate,disabled:loading},"迭代优化") : null,
      result && result.optimized_text ? h("button",{className:"po-action",onClick:copyResult},"复制") : null,
      result && result.optimized_text ? h("button",{className:"po-action po-primary",onClick:applyToInput},"填入输入框") : null
    ));

    if(editing){children.push(h(TemplateEditor,{React:React,antd:antd,antdIcons:antdIcons,key:"ed",template:editing,models:models,variables:variables,onVarCreated:function(v){var arr=variables.concat([v]);cachedVariables=arr;setVariables(arr);},onSave:saveTemplate,onCancel:function(){setEditing(null);}}));}

    if(helpOpen){
      children.push(h(antd.Modal,{key:"help-modal",open:helpOpen,onCancel:function(){setHelpOpen(false);},footer:null,title:"内置变量使用说明",width:580,zIndex:10001,maskClosable:false},
        h("div",{className:"po-help"},
          h("div",{className:"po-help-h"},"内置变量（写在模板的 system/user prompt 里）"),
          h("table",{className:"po-help-table"},
            h("thead",null,h("tr",null,h("th",null,"变量"),h("th",null,"说明"))),
            h("tbody",null,
              h("tr",null,h("td",null,"{{originalPrompt}}"),h("td",null,"你最初的原始提示词（迭代时保持不变）")),
              h("tr",null,h("td",null,"{{userQuestion}}"),h("td",null,"用户问题或输入")),
              h("tr",null,h("td",null,"{{currentPrompt}}"),h("td",null,"当前使用的提示词（本轮输入）")),
              h("tr",null,h("td",null,"{{iterateInput}}"),h("td",null,"本轮迭代的输入内容")),
              h("tr",null,h("td",null,"{{lastOptimizedPrompt}}"),h("td",null,"上一次优化的结果")),
              h("tr",null,h("td",null,"{{conversationContext}}"),h("td",null,"当前会话上下文（JSON 消息数组，勾选「包含上下文」才有）")),
              h("tr",null,h("td",null,"{{toolsContext}}"),h("td",null,"当前 agent 可用工具列表（JSON）")),
              h("tr",null,h("td",null,"{{projectContext}}"),h("td",null,"当前项目信息（JSON，勾选「包含项目上下文」才有）：项目名/语言/框架/模块/结构等"))
            )
          ),
          h("div",{className:"po-help-h"},"模板语法"),
          h("div",{className:"po-help-code"},
            "{{变量名}}                 → 替换为变量值（已知变量替换，未知 {{...}} 原样保留）\n{{#变量名}}内容{{/变量名}}  → 变量有值才显示（条件块）\n{{^变量名}}内容{{/变量名}}  → 变量为空才显示（反转块）"
          ),
          h("div",{className:"po-help-h"},"简单示例"),
          h("div",{className:"po-help-code"},
            "【user_prompt】\n原始提示词：{{originalPrompt}}\n\n【system_prompt】\n你是提示词优化专家。\n{{#conversationContext}}\n[会话上下文] {{conversationContext}}\n{{/conversationContext}}\n{{^conversationContext}}\n[无上下文，请保守假设]\n{{/conversationContext}}"
          ),
          h("div",{className:"po-help-tip"},"效果：勾选「包含上下文」→ 注入上下文 JSON；未勾选 → 显示「无上下文，请保守假设」。")
        )
      ));
    }

    // v1.3.2: 优化请求详情弹窗 — 显示变量替换后的 System/User Prompt
    if(detailsOpen&&reqDetails){
      var rdContent=[];
      rdContent.push(h("div",{key:"rd-tpl",style:{marginBottom:8,fontSize:12}},
        h("span",{style:{color:"#8a94a2"}},"模板："),h("span",{style:{fontWeight:600}},reqDetails.template_name||"—"),
        h("span",{style:{color:"#8a94a2",marginLeft:12}},"模型："),h("span",null,reqDetails.model_id||"默认（当前会话模型）"),
        h("span",{style:{color:"#8a94a2",marginLeft:12}},"上下文："),h("span",null,reqDetails.include_context?"是（"+reqDetails.context_rounds+"轮）":"不包含")
      ));
      if(reqDetails.iterate){rdContent.push(h("div",{key:"rd-it",style:{marginBottom:8,fontSize:12}},h("span",{style:{color:"#8a94a2"}},"迭代模式：原始提示词 = "),h("span",null,reqDetails.original_prompt||"—")));}
      rdContent.push(h("div",{key:"rd-in",style:{marginBottom:10}},h("div",{className:"po-help-h"},"用户输入"),h("div",{className:"po-help-code"},reqDetails.user_input||"(空)")));
      rdContent.push(h("div",{key:"rd-sp",style:{marginBottom:10}},h("div",{className:"po-help-h"},"System Prompt（变量替换后）"),h("div",{className:"po-help-code"},reqDetails.rendered_system_prompt||"(空)")));
      rdContent.push(h("div",{key:"rd-up",style:{marginBottom:10}},h("div",{className:"po-help-h"},"User Prompt（变量替换后）"),h("div",{className:"po-help-code"},reqDetails.rendered_user_prompt||"(空)")));
      if(reqDetails.custom_variables&&Object.keys(reqDetails.custom_variables).length>0){
        var cvLines=Object.keys(reqDetails.custom_variables).map(function(k){return k+" = "+(reqDetails.custom_variables[k]||"(空)");}).join("\n");
        rdContent.push(h("div",{key:"rd-var"},h("div",{className:"po-help-h"},"自定义变量"),h("div",{className:"po-help-code"},cvLines)));
      }
      // v1.4.0: 项目感知注入
      if(reqDetails.project_info){
        var pj=reqDetails.project_info, pjLines=[]
        if(pj.name) pjLines.push("名称: " + pj.name);
        if(pj.language) pjLines.push("语言: " + pj.language);
        if(pj.frameworks&&pj.frameworks.length) pjLines.push("框架: " + pj.frameworks.join(", "));
        if(pj.build_tool) pjLines.push("构建: " + pj.build_tool);
        if(pj.modules&&pj.modules.length) pjLines.push("模块: " + pj.modules.join(", "));
        if(pj.configs&&pj.configs.sub_projects) pjLines.push("子项目: " + pj.configs.sub_projects.map(function(sp){return sp.dir+" ("+sp.language+")";}).join(", "));
        rdContent.push(h("div",{key:"rd-pj"},h("div",{className:"po-help-h"},"项目感知"),h("div",{className:"po-help-code"},pjLines.length?pjLines.join("\n"):JSON.stringify(pj))));
      }
      children.push(h(antd.Modal,{key:"details-modal",open:detailsOpen,onCancel:function(){setDetailsOpen(false);},footer:null,title:"优化请求详情",width:620,zIndex:10001,maskClosable:false},
        h("div",{className:"po-help",style:{maxHeight:"60vh",overflowY:"auto"}},rdContent)
      ));
    }

    // v1.3.4: 上下文截取设置弹窗
    if(ctxSettingsOpen){
      // 预览截取
      var _sampleMsg=Array.from({length:3000},function(_,i){return i<1000?"头"+(i%10):(i<2000?"中"+(i%10):"尾"+(i%10));}).join("");
      var _prevResult=(function(){
        var c=_sampleMsg,len=c.length;
        var ho=_cf.ctx_trunc_head,mo=_cf.ctx_trunc_middle,to=_cf.ctx_trunc_tail;
        var hb=_cf.ctx_trunc_head_b||0,mb=_cf.ctx_trunc_middle_b||0,tb=_cf.ctx_trunc_tail_b||0;
        var u=_cf.ctx_trunc_unit||"char",mk=_cf.ctx_trunc_marker;
        if(u==="token"){hb=Math.floor(hb*2.5);mb=Math.floor(mb*2.5);tb=Math.floor(tb*2.5);}
        var tot=(ho?hb:0)+(mo?mb:0)+(to?tb:0);
        if(len<=tot)return c;
        var ms2=mk?"...(已截断)...":"...";
        var he=ho?hb:0,ts=to?len-tb:len;
        var mst,med;
        if(mo){if(ho){mst=he;}else if(to){mst=Math.max(0,Math.floor((ts-mb)/2));}else{mst=Math.max(0,Math.floor((len-mb)/2));}med=Math.min(mst+mb,ts);}else{mst=med=he;}
        var ps=[],pe=0;
        if(ho){ps.push(c.substring(0,hb));pe=hb;}
        if(mo&&med>mst){if(mst>pe)ps.push("GAP");ps.push(c.substring(mst,med));pe=med;}
        if(to){if(ts>pe)ps.push("GAP");ps.push(c.substring(ts));pe=len;}
        if(pe<len)ps.push("GAP");
        return ps.map(function(p){return p==="GAP"?ms2:p;}).join("");
      })();
      var _totalBudget=(_cf.ctx_trunc_head?(_cf.ctx_trunc_head_b||0):0)+(_cf.ctx_trunc_middle?(_cf.ctx_trunc_middle_b||0):0)+(_cf.ctx_trunc_tail?(_cf.ctx_trunc_tail_b||0):0);
      var _estTokens=Math.floor(_totalBudget/2.5);
      var _rounds=settings.context_rounds||5;
      children.push(h(antd.Modal,{key:"ctx-settings-modal",open:ctxSettingsOpen,onCancel:function(){setCtxSettingsOpen(false);},footer:null,title:"插件设置",width:580,zIndex:10001,maskClosable:false},
        h("div",{className:"po-help"},
          // v1.4.0: Tab 切换
          h("div",{style:{display:"flex",gap:6,marginBottom:12}},
            h("button",{className:"po-var-tab"+(ctxSettingsTab==="trunc"?" po-var-tab-active":""),onClick:function(){setCtxSettingsTab("trunc");}},"上下文截取"),
            h("button",{className:"po-var-tab"+(ctxSettingsTab==="project"?" po-var-tab-active":""),onClick:function(){setCtxSettingsTab("project");if(!projectInfo&&!projectScanLoading)_loadProjectInfo(false);}},"项目感知")
          ),
          ctxSettingsTab==="trunc"?h("div",{key:"tab-trunc"},[
          // 快速预设
          h("div",{style:{marginBottom:12}},
            h("div",{className:"po-help-h",style:{marginBottom:6}},"快速预设"),
            h("div",{style:{display:"flex",gap:8}},
              (function(){
                // v1.3.5: 匹配当前表单是否等于某个预设
                var _presets=[
                  {name:"精简",head:true,middle:false,tail:false,hb:300,mb:1000,tb:500},
                  {name:"均衡",head:true,middle:false,tail:true,hb:500,mb:1000,tb:500},
                  {name:"完整",head:true,middle:true,tail:true,hb:500,mb:1000,tb:500}
                ];
                function _isPreset(p){return _cf.ctx_trunc_head===p.head&&_cf.ctx_trunc_middle===p.middle&&_cf.ctx_trunc_tail===p.tail&&(_cf.ctx_trunc_head_b||0)===p.hb&&(_cf.ctx_trunc_middle_b||0)===p.mb&&(_cf.ctx_trunc_tail_b||0)===p.tb&&_cf.ctx_trunc_unit==="char"&&_cf.ctx_trunc_marker===true;}
                return _presets.map(function(p){
                  var active=_isPreset(p);
                  return h("button",{className:"po-action",style:{fontSize:11,padding:"4px 10px",borderColor:active?"#2563eb":undefined,color:active?"#2563eb":undefined,fontWeight:active?600:400},onClick:function(){
                    _setCF({ctx_trunc_head:p.head,ctx_trunc_middle:p.middle,ctx_trunc_tail:p.tail,ctx_trunc_head_b:p.hb,ctx_trunc_middle_b:p.mb,ctx_trunc_tail_b:p.tb,ctx_trunc_unit:"char",ctx_trunc_marker:true});
                  }},p.name+"模式");
                });
              })()
            ),
            h("div",{style:{fontSize:10,color:"#8a94a2",marginTop:4}},"精简:仅头300 │ 均衡:头500+尾500 │ 完整:头500+中1000+尾500")
          ),
          // 截取部分复选框
          h("div",{style:{marginBottom:12}},
            h("div",{className:"po-help-h",style:{marginBottom:6}},"截取部分（勾选要保留的段落）"),
            h("div",{style:{display:"flex",flexDirection:"column",gap:8}},
              h("div",{style:{display:"flex",alignItems:"center",gap:10}},
                h("label",{style:{display:"flex",alignItems:"center",gap:6,cursor:"pointer",minWidth:48}},
                  h("input",{type:"checkbox",checked:_cf.ctx_trunc_head,onChange:function(e){_ctxUF("ctx_trunc_head",e.target.checked);}}),
                  h("span",{style:{fontSize:12}},"头部")
                ),
                h("input",{type:"number",className:"po-input-sm",min:50,max:5000,value:_cf.ctx_trunc_head_b,onChange:function(e){_ctxUF("ctx_trunc_head_b",parseInt(e.target.value)||500);},disabled:!_cf.ctx_trunc_head,style:{width:70}}),
                h("span",{style:{fontSize:10,color:"#8a94a2"}},_cf.ctx_trunc_unit==="char"?"字符":"Token")
              ),
              h("div",{style:{display:"flex",alignItems:"center",gap:10}},
                h("label",{style:{display:"flex",alignItems:"center",gap:6,cursor:"pointer",minWidth:48}},
                  h("input",{type:"checkbox",checked:_cf.ctx_trunc_middle,onChange:function(e){_ctxUF("ctx_trunc_middle",e.target.checked);}}),
                  h("span",{style:{fontSize:12}},"中部")
                ),
                h("input",{type:"number",className:"po-input-sm",min:50,max:10000,value:_cf.ctx_trunc_middle_b,onChange:function(e){_ctxUF("ctx_trunc_middle_b",parseInt(e.target.value)||1000);},disabled:!_cf.ctx_trunc_middle,style:{width:70}}),
                h("span",{style:{fontSize:10,color:"#8a94a2"}},_cf.ctx_trunc_unit==="char"?"字符":"Token")
              ),
              h("div",{style:{display:"flex",alignItems:"center",gap:10}},
                h("label",{style:{display:"flex",alignItems:"center",gap:6,cursor:"pointer",minWidth:48}},
                  h("input",{type:"checkbox",checked:_cf.ctx_trunc_tail,onChange:function(e){_ctxUF("ctx_trunc_tail",e.target.checked);}}),
                  h("span",{style:{fontSize:12}},"尾部")
                ),
                h("input",{type:"number",className:"po-input-sm",min:50,max:5000,value:_cf.ctx_trunc_tail_b,onChange:function(e){_ctxUF("ctx_trunc_tail_b",parseInt(e.target.value)||500);},disabled:!_cf.ctx_trunc_tail,style:{width:70}}),
                h("span",{style:{fontSize:10,color:"#8a94a2"}},_cf.ctx_trunc_unit==="char"?"字符":"Token")
              )
            ),
            h("div",{style:{fontSize:10,color:"#8a94a2",marginTop:6}},"总计 "+_totalBudget+" "+(_cf.ctx_trunc_unit==="char"?"字符":"Token")+"（约 "+_estTokens+" Token）│ "+_rounds+" 轮上限 ~"+(_totalBudget*_rounds)+"字")
          ),
          // 计量单位
          h("div",{style:{marginBottom:12}},
            h("div",{className:"po-help-h",style:{marginBottom:6}},"计量单位"),
            h("div",{style:{display:"flex",gap:16}},
              h("label",{style:{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}},
                h("input",{type:"radio",name:"ctx-unit",checked:_cf.ctx_trunc_unit==="char",onChange:function(){_ctxUF("ctx_trunc_unit","char");}}),
                h("span",{style:{fontSize:12}},"字符数")
              ),
              h("label",{style:{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}},
                h("input",{type:"radio",name:"ctx-unit",checked:_cf.ctx_trunc_unit==="token",onChange:function(){_ctxUF("ctx_trunc_unit","token");}}),
                h("span",{style:{fontSize:12}},"Token 估算")
              ),
              h("span",{style:{fontSize:10,color:"#8a94a2"}},"CJK≈1, Latin 4字≈1")
            )
          ),
          // 截断标记
          h("div",{style:{marginBottom:12}},
            h("label",{style:{display:"flex",alignItems:"center",gap:6,cursor:"pointer"}},
              h("input",{type:"checkbox",checked:_cf.ctx_trunc_marker,onChange:function(e){_ctxUF("ctx_trunc_marker",e.target.checked);}}),
              h("span",{style:{fontSize:12}},"截断标记 — 截断处添加 \"...(已截断)\" 提示模型内容不完整")
            )
          ),
          // 预览
          h("div",{className:"po-help-h",style:{marginBottom:6}},"预览效果（模拟 3000 字消息）"),
          h("div",{className:"po-help-code",style:{marginBottom:6,maxHeight:200,overflowY:"auto",scrollbarWidth:"thin"}},_prevResult),
          h("div",{style:{fontSize:10,color:"#8a94a2",marginBottom:12}},"原始 3000 字 → 截取后 "+_prevResult.length+" 字（保留 "+Math.floor(_prevResult.length/30)+"%）"),
          // 按钮
          h("div",{style:{display:"flex",justifyContent:"space-between"}},
            h("button",{className:"po-action",onClick:function(){_setCF({ctx_trunc_head:true,ctx_trunc_middle:false,ctx_trunc_tail:true,ctx_trunc_head_b:500,ctx_trunc_middle_b:1000,ctx_trunc_tail_b:500,ctx_trunc_unit:"char",ctx_trunc_marker:true,include_project:_cf.include_project});}},"恢复默认"),
            h("button",{className:"po-action po-primary",onClick:function(){
              var ns=Object.assign({},settings,_cf);
              saveSettings(ns);
              setCtxSettingsOpen(false);
            }},"保存")
          )
          ]):
          // v1.4.0: 项目感知 Tab
          h("div",{key:"tab-project"},
            h("div",{style:{marginBottom:12}},
              h("label",{style:{display:"flex",alignItems:"center",gap:6,cursor:"pointer"}},
                h("input",{type:"checkbox",checked:_cf.include_project!==false,onChange:function(e){_ctxUF("include_project",e.target.checked);}}),
                h("span",{style:{fontSize:12}},"包含项目上下文（自动注入 {{projectContext}}）")
              ),
              h("div",{style:{fontSize:10,color:"#8a94a2",marginTop:4}},"开启后优化时会自动注入当前项目的语言、框架、目录结构等信息")
            ),
            h("div",{style:{marginBottom:12}},
              h("div",{style:{display:"flex",alignItems:"center",marginBottom:6}},
                h("span",{className:"po-help-h",style:{margin:0,flex:1}},"当前项目"),
                h("button",{className:"po-action",style:{fontSize:11,padding:"3px 8px"},disabled:projectScanLoading,onClick:function(){_loadProjectInfo(true);}},"立即重新扫描")
              ),
              projectScanLoading?h("div",{className:"po-field-hint",style:{padding:"8px"}},"扫描中..."):(projectInfo?h("div",{className:"po-req-detail"},
                h("div",{style:{marginBottom:4,fontSize:12}},h("span",{style:{color:"#8a94a2"}},"项目："),h("span",{style:{fontWeight:600}},projectInfo.name||"—"),projectInfo.language?h("span",{style:{marginLeft:8,color:"#2563eb"}},projectInfo.language):null),
                projectInfo.path?h("div",{style:{marginBottom:4,fontSize:11}},h("span",{style:{color:"#8a94a2"}},"路径："),h("span",null,(projectInfo.path||"").length>70?(projectInfo.path.substring(0,70)+"…"):(projectInfo.path||"—"))):null,
                projectInfo.frameworks&&projectInfo.frameworks.length>0?h("div",{style:{marginBottom:4,fontSize:11}},h("span",{style:{color:"#8a94a2"}},"框架："),h("span",null,projectInfo.frameworks.join(", "))):null,
                projectInfo.configs&&projectInfo.configs.sub_projects?h("div",{style:{marginBottom:4,fontSize:11}},h("span",{style:{color:"#8a94a2"}},"子项目："),h("span",null,projectInfo.configs.sub_projects.map(function(sp){return sp.dir+" ("+sp.language+(sp.build_tool?"/"+sp.build_tool:"")+")";}).join(", "))):null,
                projectInfo.build_tool?h("div",{style:{marginBottom:4,fontSize:11}},h("span",{style:{color:"#8a94a2"}},"构建："),h("span",null,projectInfo.build_tool)):null,
                projectInfo.modules&&projectInfo.modules.length>0?h("div",{style:{marginBottom:4,fontSize:11}},h("span",{style:{color:"#8a94a2"}},"模块："),h("span",null,projectInfo.modules.join(", "))):null,
                projectInfo.top_level?h("div",{style:{fontSize:11}},h("span",{style:{color:"#8a94a2"}},"结构："),h("span",null,projectInfo.top_level.join(" "))):null
              ):h("div",{className:"po-field-hint",style:{padding:"8px"}},"未能获取项目信息"))
            ),
            h("div",{style:{marginBottom:12}},
              h("div",{className:"po-help-h",style:{marginBottom:6}},"模板用法"),
              h("div",{className:"po-help-code"},"{{projectContext}}                        → 整个项目信息 JSON\n{{projectContext.name}}                → 项目名\n{{projectContext.language}}            → 语言\n{{#projectContext}}...{{/projectContext}}  → 有条件时才注入"),
              h("div",{style:{fontSize:10,color:"#8a94a2",marginTop:4}},"未知 {{...}} 原样保留，不影响模板里已有的占位符示例")
            ),
            // 按钮
            h("div",{style:{display:"flex",justifyContent:"space-between"}},
              h("button",{className:"po-action",onClick:function(){_setCF({ctx_trunc_head:true,ctx_trunc_middle:false,ctx_trunc_tail:true,ctx_trunc_head_b:500,ctx_trunc_middle_b:1000,ctx_trunc_tail_b:500,ctx_trunc_unit:"char",ctx_trunc_marker:true,include_project:true});}},"恢复默认"),
              h("button",{className:"po-action po-primary",onClick:function(){
                var ns=Object.assign({},settings,_cf);
                saveSettings(ns);
                setCtxSettingsOpen(false);
              }},"保存")
            )
          )
        )
      ));
    }

    return h("div",{className:"po-panel"},children);
  }

  // --- 变量管理（Popover content）---
  function VariableManager(props) {
    var React=props.React, antd=props.antd, h=React.createElement;
    var variables = props.variables || [];
    var es=React.useState(null), editing=es[0], setEditing=es[1];
    var fs=React.useState({name:"",label:"",value:"",description:""}), form=fs[0], setForm=fs[1];
    function uf(k,v){setForm(Object.assign({},form,{[k]:v}));}
    function startCreate(){setForm({name:"",label:"",value:"",description:""});setEditing({});}
    function startEdit(v){setForm({name:v.name,label:v.label||"",value:v.value||"",description:v.description||""});setEditing({id:v.id});}
    function cancelEdit(){setEditing(null);}
    async function saveVar(){
      if(!form.name.trim()){try{antd.message.warning("变量名不能为空");}catch(e){}return;}
      if(editing.id){
        var r=await updateVariable(editing.id,form);
        if(r.ok){props.onRefresh();cancelEdit();try{antd.message.success("变量已更新");}catch(e){}}
        else{try{antd.message.error(r.error||"保存失败");}catch(e){}}
      }else{
        var r2=await createVariable(form);
        if(r2.ok){props.onRefresh();cancelEdit();try{antd.message.success("变量已创建");}catch(e){}}
        else{try{antd.message.error(r2.error||"创建失败");}catch(e){}}
      }
    }
    async function delVar(id){await deleteVariable(id);props.onRefresh();try{antd.message.success("变量已删除");}catch(e){}}
    if(editing){
      return h("div",{style:{padding:4}},
        h("div",{className:"po-field"},h("label",{className:"po-field-label"},"名称"),h("input",{className:"po-field-input",value:form.label,onChange:function(e){uf("label",e.target.value);},placeholder:"如：用户角色"})),
        h("div",{className:"po-field"},h("label",{className:"po-field-label"},"变量名"),h("input",{className:"po-field-input",value:form.name,onChange:function(e){uf("name",e.target.value);},placeholder:"字母/下划线开头，如 user_role"})),
        h("div",{className:"po-field"},h("label",{className:"po-field-label"},"变量值（支持多行）"),h("textarea",{className:"po-field-textarea",value:form.value,onChange:function(e){uf("value",e.target.value);},placeholder:"变量值",rows:4})),
        h("div",{className:"po-field"},h("label",{className:"po-field-label"},"说明"),h("input",{className:"po-field-input",value:form.description,onChange:function(e){uf("description",e.target.value);},placeholder:"可选"})),
        h("div",{style:{display:"flex",justifyContent:"flex-end",gap:8,marginTop:8}},
          h("button",{className:"po-action",onClick:cancelEdit},"取消"),
          h("button",{className:"po-action po-primary",onClick:saveVar},"保存")
        )
      );
    }
    var items=variables.map(function(v){
      return h("div",{className:"po-var-item",key:v.id},
        h("div",{className:"po-var-info"},
          h("div",{className:"po-var-name"},v.label||v.name),
          h("div",{className:"po-var-sub"},"{{"+v.name+"}} = "+((v.value||"").length>40?(v.value.substring(0,40)+"..."):(v.value||"(空)")))
        ),
        h("div",{className:"po-var-actions"},
          h("button",{className:"po-tpl-btn",onClick:function(){startEdit(v);}},"编辑"),
          h(antd.Popconfirm,{title:"确定删除该变量？",okText:"删除",cancelText:"取消",placement:"left",onConfirm:function(){delVar(v.id);}},
          h("button",{className:"po-tpl-btn po-del-btn"},"删除")
        )
        )
      );
    });
    return h("div",{style:{padding:4,maxHeight:360,overflowY:"auto"}},
      variables.length>0?h("div",{className:"po-var-list"},items):h("div",{className:"po-empty"},"暂无自定义变量"),
      h("button",{className:"po-add-btn",onClick:startCreate,style:{marginTop:10}},"+ 新建变量")
    );
  }

  // --- 模板编辑器（插入变量 Select + 快速定义 Popover）---
  function TemplateEditor(props) {
    var React=props.React, antd=props.antd, h=React.createElement, tpl=props.template, models=props.models;
    var variables=props.variables||[];
    var sysRef=React.useRef(null), userRef=React.useRef(null);
    var fs=React.useState({name:tpl.name||"",system_prompt:tpl.system_prompt||"",user_prompt:tpl.user_prompt||"{{originalPrompt}}",category:tpl.category||"general",include_context:tpl.include_context||false,context_rounds:tpl.context_rounds||5,model_id:tpl.model_id||""});
    var form=fs[0], setForm=fs[1];
    var qds=React.useState(null), quickDef=qds[0], setQuickDef=qds[1];
    var qfs=React.useState({name:"",label:"",value:""}), qForm=qfs[0], setQForm=qfs[1];
    var ivfs=React.useState(null), insVarField=ivfs[0], setInsVarField=ivfs[1];
    var iss=React.useState(""), insSearch=iss[0], setInsSearch=iss[1];
    var ivt=React.useState("all"), insVarTab=ivt[0], setInsVarTab=ivt[1];
    function uf(k,v){var n=Object.assign({},form);n[k]=v;setForm(n);}
    function handleSave(){if(!form.name.trim())return;props.onSave(Object.assign({},tpl,form));}
    function insertVar(ref,field,name){
      var ta=ref.current; if(!ta)return;
      var start=ta.selectionStart||0, end=ta.selectionEnd||0;
      var st=ta.scrollTop;
      var text=form[field]||"", ins="{{"+name+"}}";
      uf(field, text.substring(0,start)+ins+text.substring(end));
      setTimeout(function(){ta.focus();ta.setSelectionRange(start+ins.length,start+ins.length);ta.scrollTop=st;},0);
    }
    async function saveQuickDef(){
      if(!qForm.name.trim()){try{antd.message.warning("变量名不能为空");}catch(e){}return;}
      var r=await createVariable({name:qForm.name,label:qForm.label,value:qForm.value,description:""});
      if(r.ok&&r.variable){
        props.onVarCreated(r.variable);
        insertVar(quickDef.field==="system_prompt"?sysRef:userRef,quickDef.field,r.variable.name);
        setQuickDef(null); setQForm({name:"",label:"",value:""});
        try{antd.message.success("变量已创建并插入");}catch(e){}
      }else{try{antd.message.error(r.error||"创建失败");}catch(e){}}
    }
    function makeVarList(onPick){
      var builtinVars=BUILTIN_VARS.map(function(v){return {name:v.name,label:v.label,builtin:true};});
      var customVars=variables.map(function(v){return {name:v.name,label:v.label||v.name,builtin:false};});
      var s=insSearch.toLowerCase();
      function filterList(arr){
        return s?arr.filter(function(v){return v.name.toLowerCase().indexOf(s)>=0||(v.label||"").toLowerCase().indexOf(s)>=0;}):arr;
      }
      var filteredBuiltin=filterList(builtinVars);
      var filteredCustom=filterList(customVars);
      return h("div",{style:{width:220,padding:4}},
        h("div",{style:{display:"flex",gap:4,marginBottom:6}},
          h("input",{className:"po-field-input",placeholder:"搜索变量...",value:insSearch,onChange:function(e){setInsSearch(e.target.value);},style:{flex:1}})
        ),
        h("div",{style:{display:"flex",gap:4,marginBottom:6,fontSize:11}},
          h("button",{className:"po-var-tab"+(insVarTab==="all"?" po-var-tab-active":""),onClick:function(){setInsVarTab("all")}},"全部"),
          h("button",{className:"po-var-tab"+(insVarTab==="builtin"?" po-var-tab-active":""),onClick:function(){setInsVarTab("builtin")}},"内置"),
          h("button",{className:"po-var-tab"+(insVarTab==="custom"?" po-var-tab-active":""),onClick:function(){setInsVarTab("custom")}},"自定义")
        ),
        h("div",{style:{height:200,overflowY:"auto",scrollbarWidth:"thin"}},
          (insVarTab==="all"||insVarTab==="builtin")?h("div",null,
            h("div",{style:{fontSize:10,color:"#8a94a2",padding:"2px 8px",marginBottom:2}},"内置变量"),
            filteredBuiltin.length>0?filteredBuiltin.map(function(v){
              return h("div",{key:v.name,onClick:function(){onPick(v.name);},className:"po-var-item-opt"},
                h("div",{style:{fontSize:12}},v.label),
                h("div",{style:{fontSize:10,color:"#8a94a2"}},"{{"+v.name+"}}")
              );
            }):(insVarTab==="builtin"?h("div",{style:{padding:"8px",color:"#8a94a2",fontSize:11}},"无匹配内置变量"):null)
          ):null,
          (insVarTab==="all"||insVarTab==="custom")?h("div",null,
            h("div",{style:{fontSize:10,color:"#8a94a2",padding:"2px 8px",marginTop:4,marginBottom:2}},"自定义变量（"+customVars.length+"）"),
            filteredCustom.length>0?filteredCustom.map(function(v){
              return h("div",{key:v.name,onClick:function(){onPick(v.name);},className:"po-var-item-opt"},
                h("div",{style:{fontSize:12}},v.label),
                h("div",{style:{fontSize:10,color:"#8a94a2"}},"{{"+v.name+"}}")
              );
            }):(insVarTab==="custom"?h("div",{style:{padding:"8px",color:"#8a94a2",fontSize:11}},"暂无自定义变量，可用「快速定义」创建"):null)
          ):null
        )
      );
    }
    function varToolbar(field,ref){
      return h("div",{className:"po-var-toolbar"},
        h(antd.Popover,{
          open:insVarField===field,
          onOpenChange:function(o){if(o){setInsVarField(field);setInsSearch("");setInsVarTab("all");}else setInsVarField(null);},
          trigger:"click",placement:"topLeft",overlayClassName:"po-popover-shadow",overlayStyle:{width:248},
          content:makeVarList(function(name){insertVar(ref,field,name);setInsVarField(null);})
        },h("button",{className:"po-add-btn"},"插入变量")),
        h(antd.Popover,{
          open:!!quickDef&&quickDef.field===field,
          onOpenChange:function(o){if(!o)setQuickDef(null);},
          trigger:"click",placement:"bottomLeft",overlayStyle:{width:320},overlayClassName:"po-popover-shadow",
          content:quickDef&&quickDef.field===field?h("div",{style:{padding:4}},
            h("div",{className:"po-field"},h("label",{className:"po-field-label"},"名称"),h("input",{className:"po-field-input",value:qForm.label,onChange:function(e){setQForm(Object.assign({},qForm,{label:e.target.value}));},placeholder:"如：用户角色"})),
            h("div",{className:"po-field"},h("label",{className:"po-field-label"},"变量名"),h("input",{className:"po-field-input",value:qForm.name,onChange:function(e){setQForm(Object.assign({},qForm,{name:e.target.value}));},placeholder:"如 user_role"})),
            h("div",{className:"po-field"},h("label",{className:"po-field-label"},"变量值"),h("textarea",{className:"po-field-textarea",value:qForm.value,onChange:function(e){setQForm(Object.assign({},qForm,{value:e.target.value}));},placeholder:"变量值",rows:3})),
            h("div",{style:{display:"flex",justifyContent:"flex-end",gap:8,marginTop:8}},
              h("button",{className:"po-action",onClick:function(){setQuickDef(null);}},"取消"),
              h("button",{className:"po-action po-primary",onClick:saveQuickDef},"创建并插入")
            )
          ):null
        },h("button",{className:"po-add-btn",onClick:function(){setQForm({name:"",label:"",value:""});setQuickDef({field:field});}},"快速定义"))
      );
    }

    return h("div",{className:"po-modal-overlay"},
      h("div",{className:"po-modal",onClick:function(e){e.stopPropagation();}},
        h("div",{className:"po-modal-head"},h("span",{className:"po-modal-title"},tpl.id.startsWith("new-")?"新建模板":"编辑模板"),h("button",{className:"po-close",onClick:props.onCancel},"✕")),
        h("div",{className:"po-modal-body"},
          h("div",{className:"po-field"},h("label",{className:"po-field-label"},"模板名称"),h("input",{className:"po-field-input",value:form.name,onChange:function(e){uf("name",e.target.value);},placeholder:"如：通用提示词优化"})),
          h("div",{className:"po-field"},h("label",{className:"po-field-label"},"分类"),h(antd.Select,{className:"po-model-select",value:form.category||"general",onChange:function(v){uf("category",v);},style:{width:"100%"}},
            h(antd.Select.Option,{value:"general",key:"general"},"通用"),
            h(antd.Select.Option,{value:"coding",key:"coding"},"编程"),
            h(antd.Select.Option,{value:"writing",key:"writing"},"写作"),
            h(antd.Select.Option,{value:"analysis",key:"analysis"},"分析"),
            h(antd.Select.Option,{value:"custom",key:"custom"},"自定义")
          )),
          h("div",{className:"po-field"},h("div",{className:"po-field-row"},h("label",{className:"po-field-label"},"系统提示词"),varToolbar("system_prompt",sysRef)),h("textarea",{ref:sysRef,className:"po-field-textarea",value:form.system_prompt,onChange:function(e){uf("system_prompt",e.target.value);},placeholder:"定义 AI 的角色、能力和优化规则...",rows:7})),
          h("div",{className:"po-field"},h("div",{className:"po-field-row"},h("label",{className:"po-field-label"},"用户提示词"),varToolbar("user_prompt",userRef)),h("textarea",{ref:userRef,className:"po-field-textarea",value:form.user_prompt,onChange:function(e){uf("user_prompt",e.target.value);},placeholder:"用户的请求模板，可用 {{originalPrompt}} 等变量",rows:5}),h("div",{className:"po-field-hint"},"{{originalPrompt}} 会被替换为用户输入的原始提示词")),
          h("div",{className:"po-field"},h("label",{className:"po-field-label"},"使用模型"),
            h(CascadeModelSelect, {React:React, antd:antd, models:models, value:form.model_id, onChange:function(v){uf("model_id",v);}})
          ),
          h("div",{className:"po-field"},h("label",{className:"po-checkbox"},h("input",{type:"checkbox",checked:form.include_context,onChange:function(e){uf("include_context",e.target.checked);}}),"默认包含上下文"),
            form.include_context?h("span",{style:{marginLeft:8,fontSize:11,color:"#8a94a2"}},"最近 ",h("input",{className:"po-input-sm",type:"number",min:1,max:20,value:form.context_rounds,onChange:function(e){uf("context_rounds",parseInt(e.target.value)||5);}})," 轮"):null
          )
        ),
        h("div",{className:"po-modal-foot"},h("button",{className:"po-action",onClick:props.onCancel},"取消"),h("button",{className:"po-action po-primary",onClick:handleSave,disabled:!form.name.trim()},"保存"))
      )
    );
  }

  // v1.3.0: 补全 refresh() 函数 — v2.4 注释称"refresh() 加防重入锁"但函数体缺失，
  // 导致 init() 在 await refresh() 处中断、setInterval 从未注册。
  // 现补全：轻量级数据同步，保持全局缓存新鲜，供面板下次打开时使用。
  async function refresh() {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      var t = await fetchTemplates();
      if (t) cachedTemplates = t;
      var m = await fetchModels();
      if (m) cachedModels = m;
      var v = await fetchVariables();
      if (v) cachedVariables = v;
      if (refreshSenderPrefix) refreshSenderPrefix();
    } catch (e) { /* ignore — best effort */ }
    finally { refreshBusy = false; }
  }

  async function init() {
    injectStyles(); registerPayloadTransform(); registerSenderPrefix(); await refresh();
    pollTimer = setInterval(function(){ if(!payloadTransformRegistered)registerPayloadTransform(); if(!senderPrefixRegistered)registerSenderPrefix(); refresh(); },3000);
  }

  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",init);}else{init();}
  window.__promptOptimizerCleanup=function(){
    if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
    if(payloadTransformDisposable&&payloadTransformDisposable.dispose)payloadTransformDisposable.dispose();
    if(senderPrefixDisposable&&senderPrefixDisposable.dispose)senderPrefixDisposable.dispose();
    if(styleEl)styleEl.remove();
  };
})();
