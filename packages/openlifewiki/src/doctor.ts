import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { componentCatalog, type ComponentDescriptor } from "./catalog.js";

export interface ComponentProbe {
  readonly id: string;
  readonly state: "installed-unverified" | "missing" | "reference-only";
  readonly expectedVersion?: string;
}

export async function probeComponents(
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly ComponentProbe[]> {
  return Promise.all(componentCatalog.map((component) => probeComponent(component, env)));
}

async function probeComponent(
  component: ComponentDescriptor,
  env: NodeJS.ProcessEnv,
): Promise<ComponentProbe> {
  if (component.packageName !== undefined) {
    const installed = packageIsInstalled(component.packageName);
    return {
      id: component.id,
      state: installed ? "installed-unverified" : "missing",
      ...(component.pinnedVersion === undefined ? {} : { expectedVersion: component.pinnedVersion }),
    };
  }
  if (component.executable !== undefined) {
    return {
      id: component.id,
      state: await executableExists(component.executable, env.PATH)
        ? "installed-unverified"
        : "missing",
    };
  }
  return { id: component.id, state: "reference-only" };
}

function packageIsInstalled(packageName: string): boolean {
  try {
    return import.meta.resolve(packageName).startsWith("file:");
  } catch {
    return false;
  }
}

async function executableExists(executable: string, pathValue: string | undefined): Promise<boolean> {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    try {
      const candidate = join(directory, executable);
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue through PATH without executing any candidate.
    }
  }
  return false;
}
