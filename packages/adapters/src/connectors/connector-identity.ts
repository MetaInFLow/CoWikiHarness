import type { ConnectorType } from "@openlifewiki/protocol";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const EXPLICIT_SECRET = /(?:^|[^a-z0-9])(?:bearer|token|secret|password|credential|api[_-]?key)(?:[^a-z0-9]|$)/iu;
const SECRET_PREFIX = /(?:^|[^a-z0-9])(?:sk-(?:proj-)?|agt[_-]|gh[pousr]_|github_pat_|xox[baprs]-|akia)[a-z0-9_-]{8,}/iu;
const JWT = /(?:^|\s)eyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:\s|$)/iu;
const HIGH_ENTROPY = /(?=[a-z0-9_+\/-]{36,})(?=[a-z0-9_+\/-]*[a-z])(?=[a-z0-9_+\/-]*\d)[a-z0-9_+\/-]{36,}/iu;

export const CODEX_PUBLIC_ACCOUNT = "chatgpt-account";

const CODEX_PLAN_LABELS = new Set([
  "business",
  "edu",
  "enterprise",
  "free",
  "plus",
  "pro",
  "team",
]);
const CODEX_PUBLIC_PLAN_LABELS = new Set([...CODEX_PLAN_LABELS, "other"]);

export function safeCodexPlanLabel(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return CODEX_PLAN_LABELS.has(normalized) ? normalized : "other";
}

export function assertSafeConnectorIdentityValues(
  connectorType: ConnectorType,
  identity: Readonly<Record<string, string>>,
): void {
  if (connectorType === "codex-history"
    && (identity.account !== CODEX_PUBLIC_ACCOUNT
      || identity.profile !== "ChatGPT login" && identity.profile !== "Codex login"
      || identity.plan !== undefined && !CODEX_PUBLIC_PLAN_LABELS.has(identity.plan))) {
    throw new Error("Codex History identity is outside the canonical public projection");
  }
  for (const [key, value] of Object.entries(identity)) {
    if (key === "fingerprint") {
      if (!SHA256.test(value)) throw new Error(`${connectorType} identity fingerprint is invalid`);
      continue;
    }
    if (!isSafePublicValue(value)) {
      throw new Error(`${connectorType} identity ${key} contains a secret-shaped value`);
    }
  }
}

function isSafePublicValue(value: string): boolean {
  return value.length > 0
    && value.length <= 2_048
    && !CONTROL_CHARACTER.test(value)
    && !EXPLICIT_SECRET.test(value)
    && !SECRET_PREFIX.test(value)
    && !JWT.test(value)
    && !HIGH_ENTROPY.test(value);
}
