(() => {
  "use strict";

  const tokenFromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (tokenFromHash) {
    sessionStorage.setItem("openlifewiki-session", tokenFromHash);
    history.replaceState(null, "", location.pathname);
  }
  const token = sessionStorage.getItem("openlifewiki-session") || "";
  let status = null;
  let pendingOperation = null;
  let toastTimer = null;

  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => { byId(id).textContent = value ?? "-"; };
  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const actionLabels = {
    "create-runtime-layout": "创建本地运行目录",
    "create-default-workspace": "创建资料源与正式知识目录",
    "write-default-config": "写入初始产品配置",
    "install-qmd": "安装固定版本 QMD Release",
    "verify-qmd": "验证 QMD 版本合同",
    "commit-state": "发布 INITIALIZED 状态",
    "authorize-default-source": "授权默认 Markdown 资料目录",
    "configure-qmd-collection": "登记隔离的 QMD collection",
    "build-qmd-index": "建立索引并执行真实检索检查",
    "publish-active-state": "检索通过后发布 ACTIVE 状态",
  };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-openLifeWiki-Session": token,
        ...(options.headers || {}),
      },
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || value.code || "本地管理请求失败");
    return value;
  }

  async function loadStatus(quiet = false) {
    if (!quiet) setLoading(true, "刷新本地状态");
    try {
      status = await api("/api/status");
      renderStatus(status);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  function renderStatus(value) {
    const state = value.stableState;
    const healthy = value.health === "ready";
    setText("header-state", state);
    setText("header-health", healthy ? "Healthy" : value.health);
    setText("product-version", `v${value.productVersion}`);
    setText("path-source", value.paths.source);
    setText("path-wiki", value.paths.wiki);
    setText("path-runtime", value.paths.runtime);
    setText("source-path-full", value.paths.source);
    setText("source-mask", value.source.mask);

    const stateInfo = {
      INSTALLED: ["等待初始化", "创建本地目录并安装 QMD。", "初始化", "warning", "预览初始化"],
      INITIALIZED: ["运行环境已准备", "将 Markdown 放入资料目录，然后授权激活。", "激活资料源", "warning", "预览激活"],
      ACTIVE: ["知识服务已激活", "QMD 检索和本地 MCP 已通过合同检查。", "连接 Codex", "", value.mcp.registered ? "查看连接" : "注册 Codex"],
      DEGRADED: ["本地合同异常", "打开健康状态查看需要修复的组件。", "检查健康", "danger", "查看健康"],
    }[state] || [state, "读取本地状态。", value.nextAction, "", "刷新"];
    setText("state-title", stateInfo[0]);
    setText("state-description", stateInfo[1]);
    setText("next-action-label", stateInfo[2]);
    byId("state-banner").className = `state-banner ${stateInfo[3]}`.trim();
    const primary = byId("primary-action");
    primary.querySelector("span").textContent = stateInfo[4];
    primary.setAttribute("aria-label", stateInfo[4]);
    primary.title = stateInfo[4];
    primary.dataset.action = state === "INSTALLED" ? "init" : state === "INITIALIZED" ? "activate" : state === "ACTIVE" ? "agent" : "health";

    const qmd = value.components.find((component) => component.id === "qmd");
    setText("qmd-status", qmd?.status === "ready" ? "READY" : (qmd?.status || "MISSING").toUpperCase());
    setText("qmd-version", qmd?.actualVersion ? `QMD ${qmd.actualVersion}` : `QMD ${qmd?.expectedVersion || ""}`);
    setText("qmd-description", qmd?.status === "ready" ? "官方 Release 合同通过" : "组件需要处理");
    byId("qmd-status").classList.toggle("error", qmd?.status !== "ready");

    setStep("step-runtime", state !== "INSTALLED" && state !== "DEGRADED", state === "INSTALLED");
    setStep("step-source", state === "ACTIVE", state === "INITIALIZED");
    setStep("step-agent", value.mcp.registered, state === "ACTIVE" && !value.mcp.registered);

    const authorized = value.source.authorized;
    setText("source-authorization-title", authorized ? "默认资料源已授权" : "默认资料源等待授权");
    setText("source-authorization-copy", authorized
      ? "QMD collection 与当前资料路径一致。"
      : "激活确认前，openLifeWiki 不读取资料正文。");
    setText("source-authorization-badge", authorized ? "AUTHORIZED" : "PENDING");
    byId("source-authorization-badge").classList.toggle("ready", authorized);
    byId("activate-button").disabled = state !== "INITIALIZED";
    byId("activate-button").querySelector("span").textContent = state === "ACTIVE" ? "已激活" : "预览激活";
    setText("activation-copy", state === "ACTIVE" ? "当前资料源已经通过真实检索检查。" : "资料准备好后，先查看精确变更计划。");

    setText("connection-title", value.mcp.registered ? "Codex 已注册" : value.mcp.ready ? "可以注册 Codex" : "等待资料源激活");
    setText("connection-copy", value.mcp.registered
      ? "Codex 可以按需启动本地 stdio MCP。"
      : value.mcp.ready ? "确认后写入当前用户的 Codex MCP 配置。" : "完成资料源激活后开放注册。");
    setText("connection-badge", value.mcp.registered ? "CONNECTED" : value.mcp.ready ? "READY" : "BLOCKED");
    setText("codex-command", value.mcp.command);
    byId("register-button").disabled = !value.mcp.ready || value.mcp.registered;
    byId("register-button").querySelector("span").textContent = value.mcp.registered ? "已注册" : "预览注册";
    renderTools(value.mcp.tools, value.mcp.ready);

    setText("health-summary-title", healthy ? "所有当前合同通过" : "需要处理本地合同");
    setText("health-summary-copy", healthy ? `${state} 状态可继续执行下一步。` : "查看下方组件状态。" );
    renderHealth(value.components);
  }

  function setStep(id, complete, current) {
    const item = byId(id);
    item.classList.toggle("complete", complete);
    item.classList.toggle("current", current);
  }

  function renderTools(tools, ready) {
    byId("tool-grid").innerHTML = tools.map((tool) => `
      <div class="tool-item">
        <img src="/icons/${ready ? "check-circle-2" : "square-terminal"}.svg" alt="">
        <strong>${escapeHtml(tool)}</strong>
      </div>`).join("");
  }

  function renderHealth(components) {
    byId("health-table").innerHTML = components.map((component) => `
      <div class="health-table-row">
        <strong>${escapeHtml(component.id.toUpperCase())}</strong>
        <span class="${component.status === "ready" ? "status-ok" : ""}">${escapeHtml(component.status)}</span>
        <span>Expected ${escapeHtml(component.expectedVersion)}</span>
        <span>Actual ${escapeHtml(component.actualVersion || "-")}</span>
      </div>`).join("");
  }

  function switchView(name) {
    document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function previewOperation(kind) {
    setLoading(true, kind === "init" ? "读取初始化计划" : "读取激活计划");
    try {
      const preview = await api(`/api/operations/${kind}/preview`, { method: "POST", body: "{}" });
      const title = kind === "init" ? "初始化 openLifeWiki" : "激活默认资料源";
      const description = kind === "init"
        ? "创建本地运行目录并安装固定版本 QMD。"
        : "授权默认 Markdown 目录、建立索引并执行检索检查。";
      showPlanDialog({
        title,
        description,
        actions: preview.plan.actions,
        digest: preview.digest,
        endpoint: `/api/operations/${kind}/execute`,
        loading: kind === "init" ? "正在初始化" : "正在激活资料源",
      });
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setLoading(false);
    }
  }

  async function previewRegistration() {
    setLoading(true, "读取 Codex 注册计划");
    try {
      const plan = await api("/api/mcp/codex-config");
      showPlanDialog({
        title: "注册 Codex MCP",
        description: "通过 Codex 公共 CLI 写入当前用户的 MCP 配置。",
        actions: [{ description: "Register openlifewiki stdio MCP", target: plan.command }],
        digest: plan.digest,
        endpoint: "/api/mcp/register",
        loading: "正在注册 Codex",
      });
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setLoading(false);
    }
  }

  function showPlanDialog(operation) {
    pendingOperation = operation;
    setText("dialog-title", operation.title);
    setText("dialog-description", operation.description);
    byId("plan-actions").innerHTML = operation.actions.map((action, index) => `
      <div class="plan-action">
        <span class="plan-action-index">${index + 1}</span>
        <div><strong>${escapeHtml(actionLabels[action.id] || action.description || action.id)}</strong><small>${escapeHtml(action.target || "本地产品状态")}</small></div>
      </div>`).join("");
    byId("operation-dialog").showModal();
  }

  async function executePendingOperation() {
    if (!pendingOperation) return;
    const operation = pendingOperation;
    byId("operation-dialog").close();
    setLoading(true, operation.loading);
    try {
      const result = await api(operation.endpoint, {
        method: "POST",
        body: JSON.stringify({ confirmed: true, digest: operation.digest }),
      });
      showToast(result.result?.status === "source-empty" ? "资料目录为空，请先添加 Markdown。" : "操作已完成");
      await loadStatus(true);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      pendingOperation = null;
      setLoading(false);
    }
  }

  async function openWorkspace() {
    setLoading(true, "打开本地目录");
    try {
      await api("/api/actions/open-workspace", { method: "POST", body: "{}" });
      showToast("已打开 openLifeWiki 目录");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setLoading(false);
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(status?.mcp.command || "");
      showToast("Codex MCP 命令已复制");
    } catch {
      showToast("无法访问剪贴板", true);
    }
  }

  async function stopServer() {
    if (!confirm("停止本地 Management Companion？")) return;
    try {
      await api("/api/server/stop", { method: "POST", body: "{}" });
      document.body.innerHTML = '<main class="stopped-screen"><h1>openLifeWiki</h1><p>本地管理服务已停止。</p></main>';
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function setLoading(visible, label = "正在处理") {
    byId("loading-layer").classList.toggle("visible", visible);
    byId("loading-layer").setAttribute("aria-hidden", String(!visible));
    setText("loading-label", label);
  }

  function showToast(message, error = false) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.classList.toggle("error", error);
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
  byId("refresh-button").addEventListener("click", () => loadStatus());
  byId("health-refresh-button").addEventListener("click", () => loadStatus());
  byId("open-workspace-button").addEventListener("click", openWorkspace);
  byId("source-open-button").addEventListener("click", openWorkspace);
  byId("activate-button").addEventListener("click", () => previewOperation("activate"));
  byId("register-button").addEventListener("click", previewRegistration);
  byId("copy-command-button").addEventListener("click", copyCommand);
  byId("stop-button").addEventListener("click", stopServer);
  byId("dialog-confirm").addEventListener("click", executePendingOperation);
  byId("primary-action").addEventListener("click", () => {
    const action = byId("primary-action").dataset.action;
    if (action === "init" || action === "activate") previewOperation(action);
    else switchView(action === "agent" ? "agent" : "health");
  });
  byId("operation-dialog").addEventListener("close", () => {
    if (byId("operation-dialog").returnValue === "cancel") pendingOperation = null;
  });

  if (!token) showToast("缺少本地会话令牌，请重新启动 Management Companion。", true);
  loadStatus();
})();
