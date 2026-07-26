(() => {
  "use strict";

  const tokenFromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (tokenFromHash) {
    sessionStorage.setItem("openlifewiki-session", tokenFromHash);
    history.replaceState(null, "", location.pathname);
  }
  const token = sessionStorage.getItem("openlifewiki-session") || "";
  let status = null;
  let sourcesSnapshot = null;
  let pendingOperation = null;
  let toastTimer = null;

  const DEFAULT_BUDGET = { maxNodes: 10000, maxBodyBytes: 2147483648, maxAgentCalls: 500 };

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
    if (!response.ok) {
      const error = new Error(value.message || value.code || "本地管理请求失败");
      error.code = value.code;
      error.details = value.details;
      throw error;
    }
    return value;
  }

  async function loadStatus(quiet = false) {
    if (!quiet) setLoading(true, "刷新本地状态");
    try {
      [status, sourcesSnapshot] = await Promise.all([
        api("/api/status"),
        api("/api/sources"),
      ]);
      renderStatus(status);
      renderSources(sourcesSnapshot);
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

  function renderSources(snapshot) {
    const rows = Array.isArray(snapshot?.sources) ? snapshot.sources : [];
    const connected = rows.filter((row) => row.status === "connected").length;
    byId("sources-migration-banner").hidden = snapshot?.migrationRequired !== true;
    setText("sources-connected-count", `${connected} / 4`);
    setText("sources-revision", `Revision ${snapshot?.revision ?? "-"}`);
    setText("sources-summary-copy", connected === 4
      ? "四类来源均已通过当前授权边界检查。"
      : `${4 - connected} 类来源需要授权、登录或本地组件处理。`);
    byId("sources-table").innerHTML = rows.map((row) => {
      const identity = formatIdentity(row.identity);
      const scope = formatScope(row.authorizedScope);
      const setupRequired = snapshot?.revision === null && snapshot?.migrationRequired !== true;
      const blocking = setupRequired
        ? '<span class="connector-blocking">完成初始化后可以授权</span>'
        : row.blocking
          ? `<span class="connector-blocking">${escapeHtml(blockingMessage(row.blocking))}</span>`
        : "";
      const authorized = isAuthorizedSource(row);
      const disabled = snapshot?.migrationRequired === true || setupRequired ? " disabled" : "";
      const scopeAction = authorized ? "调整范围" : "授权";
      const actions = `<div class="connector-actions">
        <button class="secondary-button connector-action" type="button" data-source-action="authorize" data-connector="${escapeHtml(row.connectorType)}"${disabled}>${scopeAction}</button>
        ${authorized ? `<button class="text-button danger-text" type="button" data-source-action="revoke" data-connector="${escapeHtml(row.connectorType)}"${disabled}>撤销</button>` : ""}
      </div>`;
      return `<article class="connector-row" data-connector="${escapeHtml(row.connectorType)}">
        <div class="connector-name">
          <span class="connector-symbol"><img src="/icons/${connectorIcon(row.connectorType)}.svg" alt=""></span>
          <div><strong>${escapeHtml(connectorLabel(row.connectorType))}</strong><small>${escapeHtml(row.providerName)} ${escapeHtml(row.providerVersion || "-")}</small></div>
        </div>
        <div class="connector-detail"><span>身份</span><strong>${escapeHtml(identity)}</strong></div>
        <div class="connector-detail"><span>授权范围</span><strong>${escapeHtml(scope)}</strong></div>
        <div class="connector-detail"><span>最近检查</span><strong>${escapeHtml(row.lastProbe || "-")}</strong><small>扫描 ${escapeHtml(row.lastScan || "尚未开始")} · 变化 ${Number(row.changedItems) || 0}</small></div>
        <div class="connector-state"><span class="connector-status status-${escapeHtml(row.status)}">${escapeHtml(statusLabel(row.status))}</span>${blocking}${actions}</div>
      </article>`;
    }).join("");
  }

  function isAuthorizedSource(row) {
    return row?.authorizedScope && typeof row.authorizedScope === "object"
      && typeof row.sourceId === "string" && !row.sourceId.startsWith("unconfigured:");
  }

  function sourceRow(connectorType) {
    return sourcesSnapshot?.sources?.find((row) => row.connectorType === connectorType);
  }

  function sourceAuthorization(row) {
    const authorizations = Array.isArray(sourcesSnapshot?.authorizations) ? sourcesSnapshot.authorizations : [];
    return authorizations.find((source) => source.sourceId === row?.sourceId || source.connectorType === row?.connectorType);
  }

  function connectorLabel(type) {
    return ({
      "local-folder": "本地文件夹",
      github: "GitHub",
      feishu: "飞书",
      "codex-history": "Codex 历史",
    })[type] || type;
  }

  function connectorIcon(type) {
    return ({
      "local-folder": "folder-open",
      github: "square-terminal",
      feishu: "book-open",
      "codex-history": "file-text",
    })[type] || "plug-zap";
  }

  function statusLabel(value) {
    return ({
      connected: "已连接",
      "auth-required": "需要授权",
      missing: "组件缺失",
      blocked: "连接受阻",
    })[value] || value;
  }

  function blockingMessage(blocking) {
    const messages = {
      SOURCE_AUTHORIZATION_REQUIRED: "等待你确认读取范围",
      LOCAL_NOT_DIRECTORY: "所选位置并非文件夹",
      LOCAL_SYMLINK_BLOCKED: "所选路径超出允许的符号链接范围",
      LOCAL_PERMISSION_DENIED: "当前用户无法读取所选文件夹",
      LOCAL_UNAVAILABLE: "所选文件夹当前不可用",
      GITHUB_CLI_MISSING: "需要先安装 GitHub CLI",
      GITHUB_AUTH_REQUIRED: "需要登录所选 GitHub 主机",
      GITHUB_REPOSITORY_BLOCKED: "当前身份无法读取所选仓库",
      GITHUB_SCOPE_MISMATCH: "仓库与授权范围不一致",
      FEISHU_CLI_MISSING: "需要先安装飞书 CLI",
      FEISHU_AUTH_REQUIRED: "所选飞书 CLI 身份需要登录",
      FEISHU_TENANT_MISMATCH: "当前身份与所选飞书租户不一致",
      FEISHU_SCOPE_MISSING: "当前飞书身份缺少所选内容的读取权限",
      CODEX_CLI_MISSING: "需要先安装 Codex CLI",
      CODEX_AUTH_REQUIRED: "需要先登录 Codex",
      CODEX_SCHEMA_MISMATCH: "当前 Codex 版本不支持所需的历史读取能力",
      SOURCE_IDENTITY_CHANGED: "连接身份已变化，需要重新确认授权",
    };
    return messages[blocking.code] || blocking.remediation || "连接检查未通过";
  }

  function formatIdentity(identity) {
    if (!identity || typeof identity !== "object") return "未识别";
    return Object.entries(identity)
      .filter(([key, value]) => key !== "fingerprint" && typeof value === "string" && value.length > 0)
      .map(([, value]) => value)
      .join(" · ") || "未识别";
  }

  function formatScope(scope) {
    if (!scope || typeof scope !== "object") return "尚未授权";
    if (scope.schema === "openlifewiki.scope/local-folder/v1") return scope.root || "尚未选择目录";
    if (scope.schema === "openlifewiki.scope/github/v1") {
      return `${scope.hostname}/${scope.repository}${scope.path ? `/${scope.path}` : ""} · ${scope.ref}`;
    }
    if (scope.schema === "openlifewiki.scope/feishu/v1") {
      return `${scope.profile} · 文档 ${scope.documentIds?.length || 0} · 知识库 ${scope.wikiNodeIds?.length || 0} · 多维表 ${scope.baseIds?.length || 0}`;
    }
    if (scope.schema === "openlifewiki.scope/codex-history/v1") {
      return `项目 ${scope.projectRoots?.length || 0} · 对话 ${scope.threadIds?.length || 0}`;
    }
    return "已授权范围";
  }

  function openSourceDialog(connectorType) {
    const row = sourceRow(connectorType);
    if (!row || sourcesSnapshot?.migrationRequired) return;
    const authorization = sourceAuthorization(row);
    const scope = authorization?.scope || row.authorizedScope || {};
    const sourceId = isAuthorizedSource(row) ? row.sourceId : `source-${connectorType}`;
    const rootNodeId = authorization?.rootNodeId || `root-${connectorType}`;

    setText("source-dialog-title", `${isAuthorizedSource(row) ? "调整" : "授权"}${connectorLabel(connectorType)}`);
    setText("connector-scope-legend", `${connectorLabel(connectorType)}连接范围`);
    byId("source-connector-type").value = connectorType;
    byId("source-root-node-id").value = rootNodeId;
    byId("source-id").value = sourceId;
    byId("source-include").value = listText(authorization?.include ?? row.include ?? defaultInclude(connectorType));
    byId("source-exclude").value = listText(authorization?.exclude ?? row.exclude ?? defaultExclude(connectorType));
    byId("source-sensitivity-default").value = authorization?.sensitivity?.default ?? row.sensitivity?.default ?? "normal";
    byId("source-sensitivity-rules").value = sensitivityText(authorization?.sensitivity?.rules ?? row.sensitivity?.rules ?? []);
    const budget = authorization?.budget || row.budget || DEFAULT_BUDGET;
    byId("source-budget-nodes").value = String(budget.maxNodes ?? DEFAULT_BUDGET.maxNodes);
    byId("source-budget-bytes").value = String(budget.maxBodyBytes ?? DEFAULT_BUDGET.maxBodyBytes);
    byId("source-budget-agent").value = String(budget.maxAgentCalls ?? DEFAULT_BUDGET.maxAgentCalls);
    byId("connector-scope-fields").innerHTML = scopeFields(connectorType, scope);
    clearSourceDiagnostic();
    byId("source-dialog").showModal();
    byId("connector-scope-fields").querySelector("input, textarea, select")?.focus();
  }

  function scopeFields(connectorType, scope) {
    if (connectorType === "local-folder") {
      return `${field("授权目录", "scope-local-root", scope.root || status?.paths?.source || "", true, "text", "field-wide")}
        <label class="field field-wide"><span>符号链接</span><select id="scope-local-symlink">
          <option value="deny"${scope.symlinkPolicy === "deny" ? " selected" : ""}>不跟随</option>
          <option value="within-root"${scope.symlinkPolicy !== "deny" ? " selected" : ""}>仅限授权目录内</option>
        </select></label>`;
    }
    if (connectorType === "github") {
      return `${field("GitHub 主机", "scope-github-host", scope.hostname || "github.com")}
        ${field("仓库", "scope-github-repository", scope.repository || "", true, "text", "field-wide", "owner/repository")}
        ${field("仓库内目录", "scope-github-path", scope.path || "", false, "text", "field-wide")}
        ${field("分支或版本", "scope-github-ref", scope.ref || "")}`;
    }
    if (connectorType === "feishu") {
      return `${field("飞书 CLI 身份", "scope-feishu-profile", scope.profile || "")}
        ${field("租户标识", "scope-feishu-tenant", scope.expectedTenantId || "")}
        ${textAreaField("文档标识", "scope-feishu-documents", scope.documentIds || [])}
        ${textAreaField("知识库节点标识", "scope-feishu-wiki", scope.wikiNodeIds || [])}
        ${textAreaField("多维表格标识", "scope-feishu-base", scope.baseIds || [], "field-wide")}`;
    }
    return `${textAreaField("项目目录", "scope-codex-roots", scope.projectRoots || [], "field-wide")}
      ${textAreaField("对话标识", "scope-codex-threads", scope.threadIds || [], "field-wide")}`;
  }

  function field(label, id, value, required = true, type = "text", className = "", placeholder = "") {
    return `<label class="field ${className}"><span>${escapeHtml(label)}</span><input id="${id}" type="${type}" value="${escapeHtml(value)}"${required ? " required" : ""}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""} autocomplete="off"></label>`;
  }

  function textAreaField(label, id, values, className = "") {
    return `<label class="field ${className}"><span>${escapeHtml(label)}</span><textarea id="${id}" rows="3">${escapeHtml(listText(values))}</textarea></label>`;
  }

  function defaultInclude(connectorType) {
    return connectorType === "local-folder" || connectorType === "github" ? ["**/*.md"] : [];
  }

  function defaultExclude(connectorType) {
    return connectorType === "local-folder" || connectorType === "github" ? [".git/**"] : [];
  }

  function listText(values) {
    return Array.isArray(values) ? values.join("\n") : "";
  }

  function parseList(value) {
    return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))];
  }

  function sensitivityText(rules) {
    return Array.isArray(rules) ? rules.map((rule) => `${rule.match} = ${rule.level}`).join("\n") : "";
  }

  function parseSensitivityRules(value) {
    return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = line.match(/^(.*?)\s*=\s*(normal|sensitive)$/u);
      if (!match || !match[1].trim()) throw new Error(`敏感规则格式无效：${line}`);
      return { match: match[1].trim(), level: match[2] };
    });
  }

  function sourceRequestFromForm() {
    const connectorType = byId("source-connector-type").value;
    const request = {
      schema: "openlifewiki.source-authorization-request/v1",
      sourceId: byId("source-id").value.trim(),
      connectorType,
      rootNodeId: byId("source-root-node-id").value,
      scope: sourceScopeFromForm(connectorType),
      include: parseList(byId("source-include").value),
      exclude: parseList(byId("source-exclude").value),
      sensitivity: {
        default: byId("source-sensitivity-default").value,
        rules: parseSensitivityRules(byId("source-sensitivity-rules").value),
      },
      budget: {
        maxNodes: Number(byId("source-budget-nodes").value),
        maxBodyBytes: Number(byId("source-budget-bytes").value),
        maxAgentCalls: Number(byId("source-budget-agent").value),
      },
    };
    if (!request.sourceId) throw new Error("请填写来源名称");
    if (Object.values(request.budget).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("扫描上限必须是正整数");
    }
    return request;
  }

  function sourceScopeFromForm(connectorType) {
    if (connectorType === "local-folder") {
      return {
        schema: "openlifewiki.scope/local-folder/v1",
        root: requiredValue("scope-local-root", "请选择授权目录"),
        symlinkPolicy: byId("scope-local-symlink").value,
      };
    }
    if (connectorType === "github") {
      return {
        schema: "openlifewiki.scope/github/v1",
        hostname: requiredValue("scope-github-host", "请填写 GitHub 主机"),
        repository: requiredValue("scope-github-repository", "请填写仓库"),
        path: byId("scope-github-path").value.trim() || null,
        ref: requiredValue("scope-github-ref", "请填写分支或版本"),
      };
    }
    if (connectorType === "feishu") {
      const scope = {
        schema: "openlifewiki.scope/feishu/v1",
        profile: requiredValue("scope-feishu-profile", "请选择飞书 CLI 身份"),
        expectedTenantId: requiredValue("scope-feishu-tenant", "请填写租户标识"),
        documentIds: parseList(byId("scope-feishu-documents").value),
        wikiNodeIds: parseList(byId("scope-feishu-wiki").value),
        baseIds: parseList(byId("scope-feishu-base").value),
      };
      if (scope.documentIds.length + scope.wikiNodeIds.length + scope.baseIds.length === 0) {
        throw new Error("请至少选择一项飞书文档、知识库节点或多维表格");
      }
      return scope;
    }
    const scope = {
      schema: "openlifewiki.scope/codex-history/v1",
      projectRoots: parseList(byId("scope-codex-roots").value),
      threadIds: parseList(byId("scope-codex-threads").value),
    };
    if (scope.projectRoots.length + scope.threadIds.length === 0) throw new Error("请至少选择一个项目目录或对话");
    return scope;
  }

  function requiredValue(id, message) {
    const value = byId(id).value.trim();
    if (!value) throw new Error(message);
    return value;
  }

  async function previewSourceAuthorization(request) {
    setLoading(true, `检查${connectorLabel(request.connectorType)}连接`);
    try {
      const preview = await api("/api/sources/authorization/preview", {
        method: "POST",
        body: JSON.stringify({ request }),
      });
      byId("source-dialog").close();
      showPlanDialog({
        eyebrow: "精确授权预览",
        title: `${sourceActionLabel(preview.action)}${connectorLabel(request.connectorType)}`,
        description: "请核对连接身份、授权范围与配置变更。",
        actions: authorizationPreviewActions(preview),
        digest: preview.previewHash,
        endpoint: "/api/sources/authorization/execute",
        payload: { request: preview.normalizedRequest, confirmed: true, digest: preview.previewHash },
        loading: `正在${sourceActionLabel(preview.action)}${connectorLabel(request.connectorType)}`,
        successMessage: `${connectorLabel(request.connectorType)}授权已更新`,
        confirmLabel: "Owner 确认",
        errorFormatter: sourceErrorMessage,
        approvalCopy: "确认后只会保存以上精确范围，并以当前连接身份为边界。",
      });
    } catch (error) {
      renderSourceDiagnostic(error, request);
      showToast(sourceErrorMessage(error), true);
    } finally {
      setLoading(false);
    }
  }

  function sourceErrorMessage(error) {
    if (error?.code === "SOURCE_PROBE_BLOCKED") return `连接检查未通过：${error.message}`;
    if (error?.code === "PLAN_CHANGED" || error?.code === "CONFIG_CONFLICT") return "配置已变化，请刷新后重新预览";
    if (error?.code === "CONFIG_MIGRATION_REQUIRED") return "请先完成页面顶部的配置升级";
    return error?.message || "资料源操作失败";
  }

  function clearSourceDiagnostic() {
    byId("source-diagnostic").hidden = true;
    byId("source-diagnostic-details").innerHTML = "";
  }

  function renderSourceDiagnostic(error, request) {
    const connectorStatus = error?.details?.connectorStatus;
    if (!connectorStatus || typeof connectorStatus !== "object") return;
    const identity = connectorStatus.identity && typeof connectorStatus.identity === "object" ? connectorStatus.identity : {};
    const blocking = connectorStatus.blocking && typeof connectorStatus.blocking === "object" ? connectorStatus.blocking : {};
    const scope = connectorStatus.authorizedScope && typeof connectorStatus.authorizedScope === "object"
      ? connectorStatus.authorizedScope : request.scope;
    const rows = [
      ["资料源", connectorLabel(connectorStatus.connectorType || request.connectorType)],
      ["状态", statusLabel(connectorStatus.status || "blocked")],
      ["连接身份", identity.profile || "未提供"],
      ["账号", identity.account || "未验证"],
      ["租户", identity.tenant || "未验证"],
      ["有效权限", identity.effectiveScope || "未验证"],
      ["请求范围", normalizedScopeText(scope)],
      ["阻断码", blocking.code || error.code || "SOURCE_PROBE_BLOCKED"],
      ["处理建议", blocking.remediation || error.message || "请检查当前连接设置"],
    ];
    setText("source-diagnostic-title", `${connectorLabel(connectorStatus.connectorType || request.connectorType)}连接检查未通过`);
    byId("source-diagnostic-details").innerHTML = rows.map(([label, value]) => `
      <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    byId("source-diagnostic").hidden = false;
    byId("source-diagnostic").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function sourceActionLabel(action) {
    return ({ authorize: "授权", narrow: "缩小范围", reauthorize: "重新授权" })[action] || "更新";
  }

  function authorizationPreviewActions(preview) {
    const request = preview.normalizedRequest;
    return [
      { description: "来源与根节点", target: `${request.sourceId}\n${request.rootNodeId}` },
      { description: "配置修订", target: `Revision ${preview.configRevision}\n${preview.configHash}` },
      { description: "连接与版本", target: `${preview.provider.name} ${preview.provider.version}` },
      { description: "连接身份", target: formatIdentity(preview.provider.identity) },
      { description: "身份指纹", target: preview.provider.identityFingerprint },
      { description: "标准化授权范围", target: normalizedScopeText(request.scope) },
      { description: "内容与敏感边界", target: contentBoundaryText(request) },
      { description: "扫描上限", target: `节点 ${request.budget.maxNodes}\n内容字节 ${request.budget.maxBodyBytes}\nAgent 调用 ${request.budget.maxAgentCalls}` },
      { description: "Hash 对照", target: `当前授权：${preview.previousAuthorizationHash || "无"}\n本次预览：${preview.previewHash}` },
    ];
  }

  function normalizedScopeText(scope) {
    if (scope.schema === "openlifewiki.scope/local-folder/v1") {
      return `目录 ${scope.root}\n符号链接 ${scope.symlinkPolicy}`;
    }
    if (scope.schema === "openlifewiki.scope/github/v1") {
      return `主机 ${scope.hostname}\n仓库 ${scope.repository}\n目录 ${scope.path || "全部"}\n分支或版本 ${scope.ref}`;
    }
    if (scope.schema === "openlifewiki.scope/feishu/v1") {
      return `CLI 身份 ${scope.profile}\n租户 ${scope.expectedTenantId}\n文档 ${listOrNone(scope.documentIds)}\n知识库节点 ${listOrNone(scope.wikiNodeIds)}\n多维表格 ${listOrNone(scope.baseIds)}`;
    }
    return `项目目录 ${listOrNone(scope.projectRoots)}\n对话 ${listOrNone(scope.threadIds)}`;
  }

  function contentBoundaryText(request) {
    const rules = request.sensitivity.rules.map((rule) => `${rule.match} = ${rule.level}`);
    return `包含 ${listOrNone(request.include)}\n排除 ${listOrNone(request.exclude)}\n默认敏感级别 ${request.sensitivity.default}\n敏感规则 ${listOrNone(rules)}`;
  }

  function listOrNone(values) {
    return Array.isArray(values) && values.length > 0 ? values.map((value) => `[${value}]`).join(" ") : "无";
  }

  async function previewSourceRevocation(connectorType) {
    const row = sourceRow(connectorType);
    if (!row || !isAuthorizedSource(row)) return;
    setLoading(true, `读取${connectorLabel(connectorType)}撤销计划`);
    try {
      const preview = await api("/api/sources/revoke/preview", {
        method: "POST",
        body: JSON.stringify({ sourceId: row.sourceId }),
      });
      showPlanDialog({
        eyebrow: "精确撤销预览",
        title: `撤销${connectorLabel(connectorType)}授权`,
        description: "撤销后，这个资料源将无法继续读取或扫描。",
        actions: [
          { description: "资料源", target: `${preview.sourceId} · ${preview.connectorType}` },
          { description: "配置修订", target: `Revision ${preview.configRevision}\n${preview.configHash}` },
          { description: "撤销授权 Hash", target: preview.authorizationHash },
          { description: "撤销预览 Hash", target: preview.previewHash },
        ],
        endpoint: "/api/sources/revoke/execute",
        payload: { sourceId: preview.sourceId, confirmed: true, digest: preview.previewHash },
        loading: `正在撤销${connectorLabel(connectorType)}授权`,
        successMessage: `${connectorLabel(connectorType)}授权已撤销`,
        confirmLabel: "Owner 确认",
        errorFormatter: sourceErrorMessage,
        approvalCopy: "确认后只撤销以上资料源授权，原始资料不会被删除。",
      });
    } catch (error) {
      showToast(sourceErrorMessage(error), true);
    } finally {
      setLoading(false);
    }
  }

  async function previewConfigMigration() {
    setLoading(true, "读取配置升级计划");
    try {
      const preview = await api("/api/config/migration/preview", { method: "POST", body: "{}" });
      showPlanDialog({
        eyebrow: "配置升级预览",
        title: "启用资料源独立授权",
        description: "升级后可以分别授权和管理四类资料源。",
        actions: [
          { description: "配置版本", target: `${preview.fromSchema} → ${preview.toSchema}` },
          { description: "保留当前设置", target: `资料 ${preview.preservedP0Sources} 项 · Agent ${preview.preservedAgentBindings} 项` },
          { description: "新增授权", target: `${preview.v1AuthorizationsAdded} 项，升级不会自动授权任何新来源` },
          { description: "配置 Hash 变化", target: `${preview.sourceConfigHash}\n→ ${preview.targetConfigHash}` },
          { description: "升级预览 Hash", target: preview.previewHash },
        ],
        endpoint: "/api/config/migration/execute",
        payload: { confirmed: true, digest: preview.previewHash },
        loading: "正在升级配置",
        successMessage: "资料源管理已启用",
        confirmLabel: "Owner 确认",
        errorFormatter: sourceErrorMessage,
        approvalCopy: "确认后保留当前设置，并启用独立资料源授权。",
      });
    } catch (error) {
      showToast(sourceErrorMessage(error), true);
    } finally {
      setLoading(false);
    }
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
    setText("dialog-eyebrow", operation.eyebrow || "操作预览");
    setText("dialog-title", operation.title);
    setText("dialog-description", operation.description);
    setText("approval-copy", operation.approvalCopy || "确认后才会执行以上变更。");
    byId("dialog-confirm").querySelector("span").textContent = operation.confirmLabel || "确认执行";
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
        body: JSON.stringify(operation.payload || { confirmed: true, digest: operation.digest }),
      });
      showToast(operation.successMessage || (result.result?.status === "source-empty" ? "资料目录为空，请先添加 Markdown。" : "操作已完成"));
      await loadStatus(true);
    } catch (error) {
      showToast(operation.errorFormatter ? operation.errorFormatter(error) : error.message, true);
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
  byId("sources-probe-button").addEventListener("click", () => loadStatus());
  byId("migrate-config-button").addEventListener("click", previewConfigMigration);
  byId("sources-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-source-action]");
    if (!button || button.disabled) return;
    if (button.dataset.sourceAction === "revoke") previewSourceRevocation(button.dataset.connector);
    else openSourceDialog(button.dataset.connector);
  });
  byId("source-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    try {
      previewSourceAuthorization(sourceRequestFromForm());
    } catch (error) {
      showToast(error.message, true);
    }
  });
  byId("source-dialog-close").addEventListener("click", () => byId("source-dialog").close());
  byId("source-dialog-cancel").addEventListener("click", () => byId("source-dialog").close());
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
