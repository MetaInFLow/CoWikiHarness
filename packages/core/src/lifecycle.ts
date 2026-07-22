import type {
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
    requiredOutputs: ["owner-only state root", "default config", "QMD 2.5.3", "state receipt"],
    completionChecks: ["QMD version contract passes", "state is INITIALIZED"],
    stableStateAfter: "INITIALIZED",
  },
  {
    id: "activate",
    label: "Activate",
    owner: "product-cli",
    requiredOutputs: ["authorized Source", "Agent binding", "Visitor MCP registration"],
    completionChecks: ["real cited-query smoke passes"],
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
      "llm-wiki-compiler installation",
      "optional Source and Agent components",
    ],
  };
}
