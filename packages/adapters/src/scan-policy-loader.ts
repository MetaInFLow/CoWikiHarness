import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createPolicyBinding,
  scanNarrowingPolicySchema,
  sha256Canonical,
  type PolicyBindingV1,
  type ScanNarrowingPolicyV1,
} from "@openlifewiki/protocol";

import { AdapterError } from "./errors.js";

const MAX_WIKI_BYTES = 256 * 1024;
const POLICY_MARKER = "```openlifewiki-scan-policy";
const POLICY_BLOCK = /```openlifewiki-scan-policy[ \t]*\r?\n([\s\S]*?)\r?\n```/gu;

export interface LoadedWikiScanPolicy {
  readonly binding: PolicyBindingV1;
  readonly policy: ScanNarrowingPolicyV1 | null;
}

export async function loadWikiScanPolicy(options: {
  readonly wikiDir: string;
}): Promise<LoadedWikiScanPolicy> {
  const path = join(options.wikiDir, "WIKI.md");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isMissing(error)) {
      return { binding: createPolicyBinding({ kind: "wiki", state: "absent" }), policy: null };
    }
    throw error;
  }
  if (bytes.byteLength > MAX_WIKI_BYTES) {
    throw invalid("WIKI.md scan policy input exceeds the bounded file size");
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid("WIKI.md scan policy input must be valid UTF-8", error);
  }
  const matches = [...body.matchAll(POLICY_BLOCK)];
  if (matches.length > 1) throw invalid("WIKI.md must contain exactly one scan policy block");
  if (body.includes(POLICY_MARKER) && matches.length !== 1) {
    throw invalid("WIKI.md scan policy block is malformed");
  }
  let policy: ScanNarrowingPolicyV1 | null = null;
  if (matches.length === 1) {
    const encoded = matches[0]?.[1];
    try {
      policy = scanNarrowingPolicySchema.parse(JSON.parse(encoded ?? ""));
    } catch (error) {
      throw invalid("WIKI.md scan policy block is invalid", error);
    }
  }
  return {
    policy,
    binding: createPolicyBinding({
      kind: "wiki",
      state: "present",
      contentHash: sha256Bytes(bytes),
      normalizedPolicyHash: sha256Canonical(policy),
    }),
  };
}

export function bindHostScanPolicy(policy: ScanNarrowingPolicyV1 | null): {
  readonly binding: PolicyBindingV1;
  readonly policy: ScanNarrowingPolicyV1 | null;
} {
  if (policy === null) {
    return { binding: createPolicyBinding({ kind: "host", state: "absent" }), policy: null };
  }
  const normalized = scanNarrowingPolicySchema.parse(policy);
  const policyHash = sha256Canonical(normalized);
  return {
    policy: normalized,
    binding: createPolicyBinding({
      kind: "host",
      state: "present",
      contentHash: policyHash,
      normalizedPolicyHash: policyHash,
    }),
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function invalid(message: string, cause?: unknown): AdapterError {
  return new AdapterError("SCAN_INVALID", message, cause === undefined ? undefined : { cause });
}
