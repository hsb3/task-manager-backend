// Where tm keeps its key: the system credential store (Bun.secrets) when one answers, else the config file.

import { ConfigError } from "./api.ts";

export type Store = "os" | "file";

type Secrets = {
  get(o: { service: string; name: string }): Promise<string | null>;
  set(o: { service: string; name: string; value: string }): Promise<void>;
  delete(o: { service: string; name: string }): Promise<boolean>;
};

/** Replaced by tests/test_tm_store.ts; undefined under Node. */
export const backend = { secrets: (): Secrets | undefined => (globalThis as any).Bun?.secrets };

export function store_mode(): Store {
  const v = process.env.TM_CREDENTIAL_STORE;
  if (v === undefined || v === "" || v === "os") return "os";
  if (v === "file") return "file";
  throw new ConfigError("TM_CREDENTIAL_STORE must be os or file");
}

/** undefined when there is no store; a platform error means none, any other is refused. */
async function call<T>(f: (s: Secrets) => Promise<T>): Promise<T | undefined> {
  const s = backend.secrets();
  if (!s) return undefined;
  try {
    return await f(s);
  } catch (e: any) {
    if (e?.code === "ERR_SECRETS_PLATFORM_ERROR") return undefined;
    throw new ConfigError(`the credential store refused: ${e?.message ?? e}`);
  }
}

const entry = (url: string) => ({ service: "tm", name: url.replace(/\/+$/, "") });

export async function os_get(url: string): Promise<string | null | undefined> {
  return call((s) => s.get(entry(url)));
}

export async function os_set(url: string, key: string): Promise<boolean> {
  return (await call((s) => s.set({ ...entry(url), value: key }).then(() => true))) ?? false;
}

export async function os_delete(url: string): Promise<void> {
  await call((s) => s.delete(entry(url)));
}
