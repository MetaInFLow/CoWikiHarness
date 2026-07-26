export const CONNECTOR_TYPES = [
  "local-folder",
  "github",
  "feishu",
  "codex-history",
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const CONNECTOR_STATUSES = [
  "connected",
  "auth-required",
  "missing",
  "blocked",
] as const;

export type ConnectorConnectionStatus = (typeof CONNECTOR_STATUSES)[number];
export type ConnectorSupportStatus = "supported" | "placeholder";

export interface ConnectorDescriptor<TConnectorType extends string = string> {
  readonly schema: "openlifewiki.connector-descriptor/v1";
  readonly connectorType: TConnectorType;
  readonly displayName: string;
  readonly classification: readonly string[];
  readonly supportStatus: ConnectorSupportStatus;
  readonly provider: {
    readonly project: string;
    readonly publicSurface: string;
    readonly executable: string | null;
    readonly versionCommand: readonly string[];
  };
  readonly capabilities: {
    readonly hierarchy: boolean;
    readonly pagination: "none" | "page" | "cursor";
    readonly modifiedVersion: "content-hash" | "filesystem-stat" | "provider-version";
    readonly representativeMetadata: boolean;
    readonly leafBodies: boolean;
    readonly nodeKinds: readonly string[];
  };
  readonly scopeSchema: string;
}

export interface ConnectorStatus {
  readonly schema: "openlifewiki.connector-status/v1";
  readonly sourceId: string;
  readonly connectorType: ConnectorType;
  readonly providerName: string;
  readonly providerProject?: string;
  readonly providerVersion?: string;
  readonly identity?: Readonly<Record<string, string>>;
  readonly providerContractHash?: string;
  readonly authorizedScope?: Readonly<Record<string, unknown>>;
  readonly status: ConnectorConnectionStatus;
  readonly lastProbe: string;
  readonly lastScan?: string;
  readonly changedItems: number;
  readonly blocking: {
    readonly code: string;
    readonly remediation: string;
  } | null;
}

export interface AuthorizedSourceV1 {
  readonly schema: "openlifewiki.authorized-source/v1";
  readonly sourceId: string;
  readonly connectorType: ConnectorType;
  readonly rootNodeId: string;
  readonly identityFingerprint: string;
  readonly approval: {
    readonly schema: "openlifewiki.source-owner-approval/v1";
    readonly action: "authorize" | "narrow" | "reauthorize";
    readonly approvedBy: "human:owner";
    readonly approvedAt: string;
    readonly ownerIdentityFingerprint: string;
    readonly previewHash: string;
    readonly configHash: string;
    readonly configRevision: number;
    readonly previousAuthorizationHash: string | null;
    readonly approvalHash: string;
  };
  readonly providerObservation?: {
    readonly providerName: string;
    readonly providerVersion: string;
    readonly contractHash: string | null;
  };
  readonly scope: Readonly<Record<string, unknown>>;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly sensitivity: {
    readonly default: "normal" | "sensitive";
    readonly rules: readonly {
      readonly match: string;
      readonly level: "normal" | "sensitive";
    }[];
  };
  readonly budget: {
    readonly maxNodes: number;
    readonly maxBodyBytes: number;
    readonly maxAgentCalls: number;
  };
  readonly approvedBy: "human:owner";
  readonly approvedAt: string;
  readonly authorizationHash: string;
}

export interface SkeletonNode {
  readonly schema: "openlifewiki.skeleton-node/v1";
  readonly sourceId: string;
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly locator: string;
  readonly childCount: {
    readonly value: number | null;
    readonly kind: "known" | "estimated" | "unknown";
  };
  readonly modifiedRange: {
    readonly from: string;
    readonly to: string;
  } | null;
  readonly permission: "readable" | "approval-required" | "denied" | "unknown";
  readonly scanability: "metadata-only" | "metadata-and-body";
  readonly page: {
    readonly cursor: string | null;
    readonly hasMore: boolean;
  };
  readonly sizeEstimate: {
    readonly bytes: number | null;
    readonly kind: "known" | "estimated" | "unknown";
  };
  readonly nodeVersion: string;
}

export interface SkeletonPage {
  readonly schema: "openlifewiki.skeleton-page/v1";
  readonly sourceId: string;
  readonly parentNodeId: string;
  readonly requestScopeHash: string;
  readonly nodes: readonly SkeletonNode[];
  readonly nextCursor: string | null;
  readonly pageComplete: boolean;
  readonly observedAt: string;
  readonly skeletonVersion: string;
}

export interface MetadataSample {
  readonly schema: "openlifewiki.metadata-sample/v1";
  readonly nodeId: string;
  readonly inputSetHash: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly body?: never;
}
