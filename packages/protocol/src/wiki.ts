export interface WikiProposal {
  readonly schema: "openlifewiki.wiki-proposal/v1";
  readonly proposalId: string;
  readonly baseWikiHash: string;
  readonly evidenceManifestHash: string;
  readonly compiler: {
    readonly project: "atomicstrata/llm-wiki-compiler";
    readonly version: "1.1.0";
    readonly receiptHash: string;
  };
  readonly taxonomy: {
    readonly folders: readonly unknown[];
    readonly tags: readonly unknown[];
    readonly aliases: readonly unknown[];
  };
  readonly directoryDiff: readonly unknown[];
  readonly fileDiff: readonly unknown[];
  readonly tagDiff: readonly unknown[];
  readonly linkChanges: readonly unknown[];
  readonly quality: {
    readonly citation: Readonly<Record<string, unknown>>;
    readonly freshness: Readonly<Record<string, unknown>>;
    readonly links: Readonly<Record<string, unknown>>;
    readonly lint: Readonly<Record<string, unknown>>;
    readonly eval: Readonly<Record<string, unknown>>;
    readonly knownGaps: readonly unknown[];
  };
  readonly proposalHash: string;
}

export interface WikiApproval {
  readonly schema: "openlifewiki.wiki-approval/v1";
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly baseWikiHash: string;
  readonly actor: {
    readonly id: string;
    readonly role: "owner" | "admin";
  };
  readonly approvedAt: string;
  readonly receiptHash: string;
}
