import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { emailOwnerKey } from "./auth";
import { readJsonWithBackup, writeJsonAtomic } from "./json-storage";

export const DEFAULT_AI_PROVIDER = "zhipu";
export const DEFAULT_AI_ENDPOINT =
  "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export const DEFAULT_AI_MODEL = "glm-4.7-flash";
export const DEFAULT_VISION_AI_MODEL = "glm-4.6v-flash";

const ENV_FILE = path.join(process.cwd(), ".env.local");
const DATA_ROOT = path.join(process.cwd(), "data");
let envWriteQueue = Promise.resolve();
let legacyMigrationQueue = Promise.resolve();

export type AiConfiguration = {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
};

export type AiConfigurationKind = "text" | "vision";

function userConfigFile(ownerEmail: string, kind: AiConfigurationKind) {
  return path.join(DATA_ROOT, `ai-config-${emailOwnerKey(ownerEmail)}-${kind}.json`);
}

function parseEnvValue(contents: string, name: string) {
  const line = contents
    .split(/\r?\n/u)
    .find((item) => item.trimStart().startsWith(`${name}=`));
  if (!line) return "";
  const value = line.slice(line.indexOf("=") + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function setEnvValue(contents: string, name: string, value: string) {
  const line = `${name}=${value}`;
  const expression = new RegExp(`^${name}=.*$`, "mu");
  if (expression.test(contents)) return contents.replace(expression, line);
  return `${contents.trimEnd()}${contents.trim() ? "\n" : ""}${line}\n`;
}

function envField(value: string, field: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/u.test(normalized)) {
    throw new Error(`${field} 格式无效`);
  }
  return normalized;
}

async function readLocalEnv() {
  try {
    return await readFile(ENV_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function stripLegacyApiKeys(contents: string) {
  return contents
    .replace(/^AI_API_KEY=.*(?:\r?\n|$)/gmu, "")
    .replace(/^ZAI_API_KEY=.*(?:\r?\n|$)/gmu, "")
    .replace(/^VISION_AI_API_KEY=.*(?:\r?\n|$)/gmu, "")
    .replace(/\n{3,}/gu, "\n\n");
}

async function fileExists(file: string) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 一次性把旧的本机 .env.local 配置认领给首个已登录用户。
 * ponytail: 只支持单机旧配置的一次性迁移；后续用户必须自行配置，避免共享 Key。
 */
async function migrateLegacyConfiguration(
  ownerEmail: string,
  textFallback: AiConfiguration,
  visionFallback: AiConfiguration,
) {
  const operation = legacyMigrationQueue.then(async () => {
    const textFile = userConfigFile(ownerEmail, "text");
    const visionFile = userConfigFile(ownerEmail, "vision");
    const [textStored, visionStored] = await Promise.all([
      fileExists(textFile),
      fileExists(visionFile),
    ]);
    const textKey = textFallback.apiKey.trim();
    const visionKey = visionFallback.apiKey.trim() || textKey;
    if ((textStored && visionStored) || (!textKey && !visionKey)) return;

    if (!textStored && textKey) {
      await writeJsonAtomic(textFile, {
        provider: textFallback.provider,
        endpoint: textFallback.endpoint,
        model: textFallback.model,
        apiKey: textKey,
        updatedAt: new Date().toISOString(),
      });
    }
    if (!visionStored && visionKey) {
      await writeJsonAtomic(visionFile, {
        provider: visionFallback.provider,
        endpoint: visionFallback.endpoint,
        model: visionFallback.model,
        apiKey: visionKey,
        updatedAt: new Date().toISOString(),
      });
    }

    const contents = await readLocalEnv();
    const next = stripLegacyApiKeys(contents);
    if (next !== contents) {
      const temporary = `${ENV_FILE}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, ENV_FILE);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    // Next 已把 .env.local 注入 process.env；清掉当前进程副本，防止第二个邮箱再次认领。
    delete process.env.AI_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.VISION_AI_API_KEY;
  });
  legacyMigrationQueue = operation.then(() => undefined, () => undefined);
  await operation;
}

export function normalizeAiEndpoint(value: string) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("服务地址必须以 http:// 或 https:// 开头");
  }
  if (url.username || url.password) {
    throw new Error("服务地址中不要填写账号或密码");
  }
  return url.toString().replace(/\/$/u, "");
}

export async function readAiConfiguration(
  kind: AiConfigurationKind = "text",
  ownerEmail?: string,
): Promise<AiConfiguration> {
  const contents = await readLocalEnv();
  const textConfiguration = {
    provider:
      parseEnvValue(contents, "AI_PROVIDER").trim() ||
      process.env.AI_PROVIDER?.trim() ||
      DEFAULT_AI_PROVIDER,
    endpoint:
      parseEnvValue(contents, "AI_ENDPOINT").trim() ||
      process.env.AI_ENDPOINT?.trim() ||
      DEFAULT_AI_ENDPOINT,
    apiKey:
      parseEnvValue(contents, "AI_API_KEY").trim() ||
      process.env.AI_API_KEY?.trim() ||
      // Backward compatibility for existing local Zhipu setups.
      parseEnvValue(contents, "ZAI_API_KEY").trim() ||
      process.env.ZAI_API_KEY?.trim() ||
      "",
    model:
      parseEnvValue(contents, "AI_MODEL").trim() ||
      process.env.AI_MODEL?.trim() ||
      parseEnvValue(contents, "ZAI_MODEL").trim() ||
      process.env.ZAI_MODEL?.trim() ||
      DEFAULT_AI_MODEL,
  };
  const visionConfiguration = {
    provider:
      parseEnvValue(contents, "VISION_AI_PROVIDER").trim() ||
      process.env.VISION_AI_PROVIDER?.trim() ||
      textConfiguration.provider,
    endpoint:
      parseEnvValue(contents, "VISION_AI_ENDPOINT").trim() ||
      process.env.VISION_AI_ENDPOINT?.trim() ||
      textConfiguration.endpoint,
    apiKey:
      parseEnvValue(contents, "VISION_AI_API_KEY").trim() ||
      process.env.VISION_AI_API_KEY?.trim() ||
      textConfiguration.apiKey,
    model:
      parseEnvValue(contents, "VISION_AI_MODEL").trim() ||
      process.env.VISION_AI_MODEL?.trim() ||
      DEFAULT_VISION_AI_MODEL,
  };
  const fallback = kind === "text" ? textConfiguration : visionConfiguration;
  if (ownerEmail) {
    await migrateLegacyConfiguration(ownerEmail, textConfiguration, visionConfiguration);
  }
  if (!ownerEmail) return fallback;
  const userFallback = { ...fallback, apiKey: "" };
  try {
    const stored = await readJsonWithBackup(
      userConfigFile(ownerEmail, kind),
      `${userConfigFile(ownerEmail, kind)}.backup`,
      (value) => {
        if (!value || typeof value !== "object") throw new Error("用户模型配置无效");
        const record = value as Record<string, unknown>;
        return {
          provider: typeof record.provider === "string" ? record.provider : fallback.provider,
          endpoint: typeof record.endpoint === "string" ? record.endpoint : fallback.endpoint,
          model: typeof record.model === "string" ? record.model : fallback.model,
          apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
        } satisfies AiConfiguration;
      },
      userFallback,
    );
    return stored;
  } catch {
    return userFallback;
  }
}

export async function validateAiConnection(config: AiConfiguration) {
  const response = await fetch(normalizeAiEndpoint(config.endpoint), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 2,
      messages: [{ role: "user", content: "只回复：好" }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { message?: string } | string;
  };
  return {
    ok: response.ok,
    status: response.status,
    upstreamMessage:
      typeof data.error === "string" ? data.error : data.error?.message,
  };
}

export async function saveAiConfiguration(
  config: AiConfiguration,
  kind: AiConfigurationKind = "text",
  ownerEmail?: string,
) {
  const prefix = kind === "vision" ? "VISION_AI_" : "AI_";
  const entries: Array<[string, string]> = [
    [`${prefix}PROVIDER`, envField(config.provider, "服务商", 80)],
    [`${prefix}ENDPOINT`, normalizeAiEndpoint(config.endpoint)],
    [`${prefix}MODEL`, envField(config.model, "模型名称", 160)],
    [`${prefix}API_KEY`, envField(config.apiKey, "API Key", 512)],
  ];
  if (ownerEmail) {
    await writeJsonAtomic(userConfigFile(ownerEmail, kind), {
      provider: entries[0][1],
      endpoint: entries[1][1],
      model: entries[2][1],
      apiKey: entries[3][1],
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const operation = envWriteQueue.then(async () => {
    const contents = await readLocalEnv();
    const next = entries.reduce(
      (current, [name, value]) => setEnvValue(current, name, value),
      contents,
    );
    const temporary = `${ENV_FILE}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, ENV_FILE);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  envWriteQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
}
