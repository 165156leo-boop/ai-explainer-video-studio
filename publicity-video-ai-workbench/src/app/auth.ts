import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonWithBackup, writeJsonAtomic } from "./json-storage";

const DATA_ROOT = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_ROOT, "users.json");
const USERS_BACKUP_FILE = path.join(DATA_ROOT, "users.backup.json");
const SECRET_FILE = path.join(DATA_ROOT, ".auth-secret");
export const AUTH_COOKIE = "ai-workbench-session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

type StoredUser = { email: string; passwordHash: string; createdAt: string };

export class AuthenticationError extends Error {
  readonly status = 401;
  readonly code = "AUTH_REQUIRED";
}

let userQueue = Promise.resolve();
let secretPromise: Promise<string> | undefined;

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") throw new Error("请输入邮箱");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error("请输入有效邮箱");
  }
  return email;
}

function password(value: unknown) {
  if (typeof value !== "string" || value.length < 8 || value.length > 200) {
    throw new Error("密码长度应为 8～200 位");
  }
  return value;
}

function hashPassword(value: string, salt = randomBytes(16).toString("base64url")) {
  return `scrypt$${salt}$${scryptSync(value, salt, 32).toString("base64url")}`;
}

function passwordMatches(value: string, encoded: string) {
  const [, salt, expected] = encoded.split("$");
  if (!salt || !expected) return false;
  const actual = Buffer.from(hashPassword(value, salt).split("$")[2], "base64url");
  const target = Buffer.from(expected, "base64url");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function readUsers() {
  return readJsonWithBackup(USERS_FILE, USERS_BACKUP_FILE, (value) => {
    if (!Array.isArray(value)) throw new Error("用户数据结构无效");
    return value.filter((item): item is StoredUser => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return typeof record.email === "string" && typeof record.passwordHash === "string";
    });
  }, []);
}

async function writeUsers(users: StoredUser[]) {
  const previous = await readUsers();
  await writeJsonAtomic(USERS_BACKUP_FILE, previous);
  await writeJsonAtomic(USERS_FILE, users);
}

async function authSecret() {
  if (process.env.AUTH_SECRET?.trim()) return process.env.AUTH_SECRET.trim();
  if (!secretPromise) {
    secretPromise = (async () => {
      await mkdir(DATA_ROOT, { recursive: true });
      try {
        return (await readFile(SECRET_FILE, "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const generated = randomBytes(32).toString("base64url");
        try {
          await writeFile(SECRET_FILE, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
          return generated;
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
          return (await readFile(SECRET_FILE, "utf8")).trim();
        }
      }
    })();
  }
  return secretPromise;
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

async function createSessionToken(email: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${email}|${expiresAt}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload, await authSecret())}`;
}

export async function getAuthenticatedEmail(request: Request) {
  if (!isSameOrigin(request)) return null;
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${AUTH_COOKIE}=`))?.slice(AUTH_COOKIE.length + 1);
  if (!cookie) return null;
  const [encodedPayload, signature] = cookie.split(".");
  if (!encodedPayload || !signature) return null;
  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [email, expiresText] = payload.split("|");
  const expiresAt = Number(expiresText);
  if (!email || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const expected = sign(payload, await authSecret());
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return email;
}

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function requireAuthenticatedEmail(request: Request) {
  const email = await getAuthenticatedEmail(request);
  if (!email) throw new AuthenticationError("请先登录");
  return email;
}

export async function authenticate(mode: "login" | "register", rawEmail: unknown, rawPassword: unknown) {
  const email = normalizeEmail(rawEmail);
  const secret = password(rawPassword);
  const operation = userQueue.then(async () => {
    const users = await readUsers();
    const existing = users.find((user) => user.email === email);
    if (mode === "register") {
      if (existing) throw new Error("该邮箱已注册，请直接登录");
      users.push({ email, passwordHash: hashPassword(secret), createdAt: new Date().toISOString() });
      await writeUsers(users);
    } else if (!existing || !passwordMatches(secret, existing.passwordHash)) {
      throw new Error("邮箱或密码错误");
    }
    return { email, token: await createSessionToken(email) };
  });
  userQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: false,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

export function emailOwnerKey(email: string) {
  return createHash("sha256").update(email).digest("hex").slice(0, 24);
}
