import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

// The caller serializes updates. Recovery is read-only so readers cannot
// overwrite a newer save; the next save replaces the damaged primary file.
export async function readJsonWithBackup<T>(
  file: string,
  backup: string,
  decode: (value: unknown) => T,
  empty: T,
): Promise<T> {
  let failure: unknown;
  for (const candidate of [file, backup]) {
    let contents: string;
    try {
      contents = await readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      return decode(JSON.parse(contents.replace(/^\uFEFF/u, "")));
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return empty;
}
