import { CONNECTOR_DESCRIPTORS } from "@openlifewiki/core";
import type { AuthorizedSourceV1, ConnectorStatus } from "@openlifewiki/protocol";

import type { CommandRunner } from "./command-runner.js";
import { CONNECTOR_PROVIDERS, type ProbeSource } from "./connectors/index.js";

export async function probeSourceCandidate(options: {
  readonly source: ProbeSource;
  readonly runner: CommandRunner;
  readonly now?: () => Date;
  readonly scratchRoot?: string;
}): Promise<ConnectorStatus> {
  const provider = CONNECTOR_PROVIDERS.find(({ connectorType }) => connectorType === options.source.connectorType);
  if (provider === undefined) throw new Error(`Unsupported Connector ${options.source.connectorType}`);
  return await provider.probe({
    source: options.source,
    runner: options.runner,
    now: options.now ?? (() => new Date()),
    scratchRoot: options.scratchRoot ?? ".openlifewiki-connector-probes",
  });
}

export async function listConnectorStatuses(options: {
  readonly sources: readonly AuthorizedSourceV1[];
  readonly runner: CommandRunner;
  readonly now?: () => Date;
  readonly scratchRoot?: string;
}): Promise<readonly ConnectorStatus[]> {
  const now = options.now ?? (() => new Date());
  return await Promise.all(CONNECTOR_DESCRIPTORS.map(async (descriptor) => {
    const source = options.sources.find(({ connectorType }) => connectorType === descriptor.connectorType);
    if (source !== undefined) {
      let status: ConnectorStatus;
      try {
        status = await probeSourceCandidate({
          source,
          runner: options.runner,
          now,
          ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }),
        });
      } catch {
        return blockedStatus(descriptor, source, now(), "CONNECTOR_PROBE_FAILED", "Retry the Connector probe or inspect its local authentication");
      }
      if (status.status === "connected" && status.identity?.fingerprint !== source.identityFingerprint) {
        return {
          ...status,
          status: "blocked",
          blocking: {
            code: "SOURCE_IDENTITY_CHANGED",
            remediation: "Preview and approve the Source again for the current provider identity",
          },
        };
      }
      const observation = source.providerObservation;
      if (status.status === "connected" && observation !== undefined
        && (status.providerName !== observation.providerName
          || status.providerVersion !== observation.providerVersion
          || (status.providerContractHash ?? null) !== observation.contractHash)) {
        return {
          ...status,
          status: "blocked",
          blocking: {
            code: "PROVIDER_OBSERVATION_CHANGED",
            remediation: "Preview and approve the Source again for the current provider version or contract",
          },
        };
      }
      return status;
    }
    return {
      schema: "openlifewiki.connector-status/v1",
      sourceId: `unconfigured:${descriptor.connectorType}`,
      connectorType: descriptor.connectorType,
      providerName: descriptor.provider.publicSurface,
      providerProject: descriptor.provider.project,
      providerVersion: "unverified",
      identity: { account: "unverified" },
      status: "auth-required",
      lastProbe: now().toISOString(),
      changedItems: 0,
      blocking: {
        code: "SOURCE_AUTHORIZATION_REQUIRED",
        remediation: "Preview and approve an exact Source scope",
      },
    } satisfies ConnectorStatus;
  }));
}

function blockedStatus(
  descriptor: (typeof CONNECTOR_DESCRIPTORS)[number],
  source: AuthorizedSourceV1,
  observedAt: Date,
  code: string,
  remediation: string,
): ConnectorStatus {
  return {
    schema: "openlifewiki.connector-status/v1",
    sourceId: source.sourceId,
    connectorType: descriptor.connectorType,
    providerName: descriptor.provider.publicSurface,
    providerProject: descriptor.provider.project,
    identity: { account: "unverified" },
    authorizedScope: source.scope,
    status: "blocked",
    lastProbe: observedAt.toISOString(),
    changedItems: 0,
    blocking: { code, remediation },
  };
}
