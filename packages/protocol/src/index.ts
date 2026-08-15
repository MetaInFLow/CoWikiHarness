export type LifecycleStageId =
  | "discover"
  | "install"
  | "initialize"
  | "activate"
  | "use"
  | "maintain"
  | "uninstall";

export type StableRuntimeState = "INSTALLED" | "INITIALIZED" | "ACTIVE" | "DEGRADED";

export interface LifecycleStageDefinition {
  readonly id: LifecycleStageId;
  readonly label: string;
  readonly owner: "install-skill" | "product-cli" | "product-runtime";
  readonly requiredOutputs: readonly string[];
  readonly completionChecks: readonly string[];
  readonly stableStateAfter?: StableRuntimeState;
}

export interface ComponentRelease {
  readonly id: string;
  readonly displayName: string;
  readonly firstRequiredStage: LifecycleStageId | "wiki-management" | "optional-source" | "optional-agent";
  readonly installOwner: "openlifewiki" | "user" | "build";
  readonly delivery: "npm-release" | "native-cli" | "library";
  readonly packageName?: string;
  readonly version?: string;
  readonly integrity?: string;
  readonly schemaManifestHash?: string;
  readonly executable?: string;
  readonly sourceUrl: string;
  readonly publicInterfaces: readonly ("cli" | "mcp" | "sdk")[];
}

export interface RuntimeLayout {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly configFile: string;
  readonly stateFile: string;
  readonly componentsDir: string;
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly logsDir: string;
  readonly sourcesDir: string;
  readonly wikiDir: string;
  readonly qmdConfigDir: string;
  readonly qmdCacheDir: string;
  readonly qmdInstallDir: string;
  readonly qmdExecutable: string;
}

export interface InitializationAction {
  readonly id: string;
  readonly description: string;
  readonly target?: string;
  readonly network: boolean;
  readonly writes: boolean;
}

export interface InitializationPlan {
  readonly schema: "openlifewiki.init-plan/v1";
  readonly fromState: "INSTALLED";
  readonly targetState: "INITIALIZED";
  readonly approvalRequired: true;
  readonly components: readonly ComponentRelease[];
  readonly actions: readonly InitializationAction[];
  readonly excluded: readonly string[];
}

export interface ComponentReceipt {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
  readonly executable: string;
  readonly installedAt: string;
}

export interface DurableStateV1 {
  readonly schema: "openlifewiki.state/v1";
  readonly stableState: "INITIALIZED" | "ACTIVE";
  readonly completedAt: string;
  readonly components: readonly ComponentReceipt[];
}

export interface ComponentHealth {
  readonly id: string;
  readonly status: "ready" | "missing" | "version-mismatch" | "probe-failed";
  readonly expectedVersion: string;
  readonly actualVersion?: string;
  readonly executable: string;
}

export interface DoctorReport {
  readonly schema: "openlifewiki.doctor/v1";
  readonly status: "ready" | "setup-required" | "degraded";
  readonly stableState: StableRuntimeState;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly sourcePath: string;
  readonly components: readonly ComponentHealth[];
  readonly nextAction: "initialize" | "activate" | "repair" | "use";
}

export interface StatusReport {
  readonly schema: "openlifewiki.status/v1";
  readonly stableState: StableRuntimeState;
  readonly ready: boolean;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly sourcePath: string;
  readonly nextAction: "initialize" | "activate" | "repair" | "use";
}

export interface InitializationResult {
  readonly schema: "openlifewiki.init-result/v1";
  readonly status: "initialized" | "already-initialized";
  readonly stableState: "INITIALIZED" | "ACTIVE";
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly components: readonly ComponentReceipt[];
}

export interface ActivationAction {
  readonly id: string;
  readonly description: string;
  readonly target: string;
  readonly readsSource: boolean;
  readonly writes: boolean;
}

export interface ActivationPlan {
  readonly schema: "openlifewiki.activation-plan/v1";
  readonly fromState: "INITIALIZED";
  readonly targetState: "ACTIVE";
  readonly approvalRequired: true;
  readonly source: {
    readonly id: "default-local";
    readonly path: string;
    readonly mask: "**/*.md";
  };
  readonly actions: readonly ActivationAction[];
}

export interface McpLaunchConfig {
  readonly transport: "stdio";
  readonly command: "openlifewiki";
  readonly args: readonly ["mcp", "--stdio"];
}

export interface ActivationResult {
  readonly schema: "openlifewiki.activation-result/v1";
  readonly status: "activated" | "already-active" | "source-empty";
  readonly stableState: "INITIALIZED" | "ACTIVE";
  readonly sourcePath: string;
  readonly indexedFiles: number;
  readonly mcp: McpLaunchConfig;
  readonly nextAction: "add-markdown" | "connect-agent";
}

export * from "./access.js";
export * from "./agent-io.js";
export * from "./agent.js";
export * from "./connector.js";
export * from "./config.js";
export * from "./hashing.js";
export * from "./identity.js";
export * from "./knowledge.js";
export * from "./operation.js";
export * from "./policy.js";
export * from "./scan.js";
export * from "./schema-validator.js";
export * from "./wiki.js";
