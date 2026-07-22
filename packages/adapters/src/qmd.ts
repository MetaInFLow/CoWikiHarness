import { realpath } from "node:fs/promises";

import type { RuntimeLayout } from "@openlifewiki/protocol";

export const DEFAULT_SOURCE_ID = "default-local";
export const DEFAULT_QMD_COLLECTION = "openlifewiki-sources";
export const DEFAULT_QMD_MASK = "**/*.md";

export function qmdEnvironment(
  layout: RuntimeLayout,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...base };
  delete environment.INDEX_PATH;
  environment.NO_COLOR = "1";
  environment.QMD_CONFIG_DIR = layout.qmdConfigDir;
  environment.XDG_CACHE_HOME = layout.qmdCacheDir;
  return environment;
}

export function parseQmdCollectionNames(output: string): string[] {
  return [...output.matchAll(/qmd:\/\/([^\s/]+)\//gu)].map((match) => match[1]!);
}

export function parseQmdCollectionDetails(output: string): {
  readonly path?: string;
  readonly mask?: string;
} {
  const path = output.match(/^\s*Path:\s+(.+)$/mu)?.[1]?.trim();
  const mask = output.match(/^\s*Pattern:\s+(.+)$/mu)?.[1]?.trim();
  return {
    ...(path === undefined ? {} : { path }),
    ...(mask === undefined ? {} : { mask }),
  };
}

export async function pathsReferToSameLocation(left: string, right: string): Promise<boolean> {
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([realpath(left), realpath(right)]);
    return canonicalLeft === canonicalRight;
  } catch {
    return false;
  }
}
