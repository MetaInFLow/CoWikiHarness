import type {
  ActivationPlan,
  InitializationPlan,
  LifecycleStageDefinition,
  RuntimeLayout,
} from "@openlifewiki/protocol";

import { QMD_RELEASE } from "./components.js";

export const LIFECYCLE_STAGES = [
  {
    id: "discover",
    label: "Discover",
    owner: "install-skill",
    requiredOutputs: ["purpose", "limitations", "permission disclosure", "release source"],
    completionChecks: ["no machine writes"],
  },
  {
    id: "install",
    label: "Install",
    owner: "install-skill",
    requiredOutputs: ["openlifewiki executable", "Install Skill", "release manifest", "license"],
    completionChecks: ["version command passes", "status returns INSTALLED"],
    stableStateAfter: "INSTALLED",
  },
  {
    id: "initialize",
    label: "Initialize",
    owner: "product-cli",
    requiredOutputs: ["owner-only state root", "visible default workspace", "default config", "QMD 2.5.3", "state receipt"],
    completionChecks: ["QMD version contract passes", "state is INITIALIZED"],
    stableStateAfter: "INITIALIZED",
  },
  {
    id: "activate",
    label: "Activate",
    owner: "product-cli",
    requiredOutputs: ["authorized default Source", "QMD collection", "local stdio MCP entry"],
    completionChecks: ["real retrieval smoke passes", "MCP launch contract is ready"],
    stableStateAfter: "ACTIVE",
  },
  {
    id: "use",
    label: "Use",
    owner: "product-runtime",
    requiredOutputs: ["validated answer", "resolvable citations"],
    completionChecks: ["answer envelope passes", "citations resolve to current content"],
  },
  {
    id: "maintain",
    label: "Maintain",
    owner: "product-cli",
    requiredOutputs: ["health report", "update preview", "recovery path"],
    completionChecks: ["supported journeys still pass"],
  },
  {
    id: "uninstall",
    label: "Uninstall",
    owner: "install-skill",
    requiredOutputs: ["removal preview", "retained asset list", "removal receipt"],
    completionChecks: ["registrations and runtime are absent", "Wiki is retained by default"],
  },
] as const satisfies readonly LifecycleStageDefinition[];

export function createInitializationPlan(layout: RuntimeLayout): InitializationPlan {
  return {
    schema: "openlifewiki.init-plan/v1",
    fromState: "INSTALLED",
    targetState: "INITIALIZED",
    approvalRequired: true,
    components: [QMD_RELEASE],
    actions: [
      {
        id: "create-runtime-layout",
        description: "Create owner-only runtime directories",
        target: layout.root,
        network: false,
        writes: true,
      },
      {
        id: "create-default-workspace",
        description: "Create the visible Source and Wiki folders",
        target: layout.workspaceRoot,
        network: false,
        writes: true,
      },
      {
        id: "write-default-config",
        description: "Write the initial configuration when absent",
        target: layout.configFile,
        network: false,
        writes: true,
      },
      {
        id: "install-qmd",
        description: "Install @tobilu/qmd@2.5.3 from the npm registry",
        target: layout.qmdInstallDir,
        network: true,
        writes: true,
      },
      {
        id: "verify-qmd",
        description: "Run the installed QMD version probe",
        target: layout.qmdExecutable,
        network: false,
        writes: false,
      },
      {
        id: "commit-state",
        description: "Atomically publish the INITIALIZED state receipt",
        target: layout.stateFile,
        network: false,
        writes: true,
      },
    ],
    excluded: [
      "Source scanning",
      "Source authorization",
      "Agent authentication changes",
      "MCP registration",
      "optional QMD semantic and reranking model downloads",
      "llm-wiki-compiler installation",
      "optional Source and Agent components",
    ],
  };
}

export function createActivationPlan(layout: RuntimeLayout): ActivationPlan {
  return {
    schema: "openlifewiki.activation-plan/v1",
    fromState: "INITIALIZED",
    targetState: "ACTIVE",
    approvalRequired: true,
    source: {
      id: "default-local",
      path: layout.sourcesDir,
      mask: "**/*.md",
    },
    actions: [
      {
        id: "authorize-default-source",
        description: "Authorize Markdown files in the default Source folder",
        target: layout.sourcesDir,
        readsSource: true,
        writes: false,
      },
      {
        id: "configure-qmd-collection",
        description: "Register the default Source through the QMD public CLI",
        target: layout.qmdConfigDir,
        readsSource: true,
        writes: true,
      },
      {
        id: "build-qmd-index",
        description: "Build the isolated QMD index and run a retrieval smoke",
        target: layout.qmdCacheDir,
        readsSource: true,
        writes: true,
      },
      {
        id: "publish-active-state",
        description: "Publish ACTIVE after the retrieval smoke succeeds",
        target: layout.stateFile,
        readsSource: false,
        writes: true,
      },
    ],
  };
}
