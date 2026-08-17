import type { Stats } from "node:fs";
import { link, lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { AdapterError, type BootstrapResult } from "@openlifewiki/adapters";

const RECOVERY_REQUIRED = "Bootstrap credential recovery required: final or pending file already exists";

export async function persistBootstrapCredentialFile(
  credentialFile: string,
  result: BootstrapResult,
): Promise<string> {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new AdapterError(
      "CONFIG_INVALID",
      "Bootstrap credential persistence requires a local POSIX filesystem",
    );
  }

  const currentUid = process.getuid();
  const normalizedTarget = resolve(credentialFile);
  const normalizedParent = dirname(normalizedTarget);
  const realParent = await resolveTrustedParent(normalizedParent, currentUid);
  const finalPath = join(realParent, basename(normalizedTarget));
  const pendingPath = `${finalPath}.pending`;

  await assertEntryAbsent(finalPath);
  await assertEntryAbsent(pendingPath);

  let handle: FileHandle | undefined;
  let ownsPending = false;
  try {
    handle = await open(pendingPath, "wx", 0o600);
    ownsPending = true;
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(result)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    assertSecureCredentialFile(await lstat(pendingPath), currentUid, 1);
    await link(pendingPath, finalPath);
    const [linkedPending, linkedFinal] = await Promise.all([
      lstat(pendingPath),
      lstat(finalPath),
    ]);
    assertSecureCredentialFile(linkedPending, currentUid, 2);
    assertSecureCredentialFile(linkedFinal, currentUid, 2);
    if (linkedPending.dev !== linkedFinal.dev || linkedPending.ino !== linkedFinal.ino) {
      throw new Error("Bootstrap credential hard-link identity verification failed");
    }

    await unlink(pendingPath);
    ownsPending = false;
    assertSecureCredentialFile(await lstat(finalPath), currentUid, 1);
    await syncDirectory(realParent);
    return finalPath;
  } catch (error) {
    await closeQuietly(handle);
    const cleanupError = ownsPending
      ? await cleanupPending(pendingPath, realParent)
      : undefined;
    const cause = cleanupError === undefined
      ? error
      : new AggregateError([error, cleanupError], "Bootstrap credential pending cleanup failed");
    if (hasErrorCode(error, "EEXIST")) {
      throw new AdapterError("CONFIG_INVALID", RECOVERY_REQUIRED, { cause });
    }
    throw new AdapterError(
      "CONFIG_INVALID",
      "Bootstrap credential file could not be persisted; inspect final and pending files before recovery",
      { cause },
    );
  }
}

async function resolveTrustedParent(parent: string, currentUid: number): Promise<string> {
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    throw new AdapterError(
      "CONFIG_INVALID",
      "Bootstrap credential parent directory is unavailable",
      { cause: error },
    );
  }
  if (realParent !== parent) {
    throw new AdapterError(
      "CONFIG_INVALID",
      "Bootstrap credential parent path must resolve without symlinks",
    );
  }

  let parentStat: Stats;
  try {
    parentStat = await lstat(realParent);
  } catch (error) {
    throw new AdapterError(
      "CONFIG_INVALID",
      "Bootstrap credential parent directory is unavailable",
      { cause: error },
    );
  }
  if (!parentStat.isDirectory()) {
    throw new AdapterError("CONFIG_INVALID", "Bootstrap credential parent directory is unavailable");
  }
  if (parentStat.uid !== currentUid) {
    throw new AdapterError(
      "CONFIG_INVALID",
      "Bootstrap credential parent directory must be owned by the current user",
    );
  }
  if ((parentStat.mode & 0o077) !== 0) {
    throw new AdapterError(
      "CONFIG_INVALID",
      "Bootstrap credential parent directory must be private",
    );
  }
  return realParent;
}

async function assertEntryAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw new AdapterError("CONFIG_INVALID", "Bootstrap credential path could not be inspected", { cause: error });
  }
  throw new AdapterError("CONFIG_INVALID", RECOVERY_REQUIRED);
}

function assertSecureCredentialFile(fileStat: Stats, currentUid: number, expectedLinks: number): void {
  if (
    !fileStat.isFile()
    || fileStat.isSymbolicLink()
    || fileStat.uid !== currentUid
    || (fileStat.mode & 0o777) !== 0o600
    || fileStat.nlink !== expectedLinks
  ) {
    throw new Error("Bootstrap credential file identity or permissions verification failed");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupPending(pendingPath: string, parent: string): Promise<unknown | undefined> {
  try {
    await unlink(pendingPath);
    await syncDirectory(parent);
    return undefined;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    return error;
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The persistence error remains the primary failure.
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
