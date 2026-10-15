import { readJsonWithBackup, writeJsonAtomic } from "../../json-storage";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAuthenticatedEmail } from "../../auth";
import {
  mergeProjectSnapshots,
  normalizeProjectSnapshot,
  WORKSPACE_SCHEMA_VERSION,
  type ProjectSnapshot,
  type WorkspaceSnapshot,
} from "../../project-store";
import {
  BUILT_IN_REFERENCE_ASSETS,
  normalizeReferenceAsset,
  normalizeReuseRule,
  type ReuseRule,
  type RuleEditableState,
} from "../../workspace-memory";

export const runtime = "nodejs";

const DATA_FILE = path.join(process.cwd(), "data", "workbench-data.json");
const BACKUP_FILE = path.join(
  process.cwd(),
  "data",
  "workbench-data.backup.json",
);
let writeQueue = Promise.resolve();
let ownershipQueue = Promise.resolve();

function editableState(rule: ReuseRule): RuleEditableState {
  return {
    title: rule.title,
    instruction: rule.instruction,
    stage: rule.stage,
    issueType: rule.issueType,
    scope: rule.scope,
    status: rule.status,
    keywords: rule.keywords,
    projectId: rule.projectId,
    updatedAt: rule.updatedAt,
  };
}

function editableFingerprint(rule: ReuseRule) {
  const { updatedAt: _updatedAt, ...fields } = editableState(rule);
  void _updatedAt;
  return JSON.stringify(fields);
}

function mergeByUpdatedAt<T extends { id: string; updatedAt: string }>(
  current: T[],
  incoming: T[],
) {
  const merged = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => {
    const existing = merged.get(item.id);
    if (!existing || item.updatedAt > existing.updatedAt) merged.set(item.id, item);
  });
  return [...merged.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

async function readWorkspace(): Promise<WorkspaceSnapshot> {
  return readJsonWithBackup(DATA_FILE, BACKUP_FILE, (value) => {
    if (!value || typeof value !== "object" || !Array.isArray((value as { projects?: unknown }).projects)) throw new Error("项目数据结构无效");
    const parsed = value as {
      activeProjectId?: unknown;
      projects?: unknown;
      rules?: unknown;
      assets?: unknown;
    };
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.map(normalizeProjectSnapshot)
      : [];
    const activeProjectId =
      typeof parsed.activeProjectId === "string" &&
      projects.some((project) => project.id === parsed.activeProjectId)
        ? parsed.activeProjectId
        : projects[0]?.id ?? "";
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.map(normalizeReuseRule)
      : [];
    const storedAssets = Array.isArray(parsed.assets)
      ? parsed.assets.map(normalizeReferenceAsset)
      : [];
    const assets = mergeByUpdatedAt(BUILT_IN_REFERENCE_ASSETS, storedAssets);
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activeProjectId,
      projects,
      rules,
      assets,
    };
  }, { schemaVersion: WORKSPACE_SCHEMA_VERSION, activeProjectId: "", projects: [], rules: [], assets: BUILT_IN_REFERENCE_ASSETS });
}

function scopeWorkspace(workspace: WorkspaceSnapshot, email: string): WorkspaceSnapshot {
  const projects = workspace.projects.filter((project) => project.ownerEmail === email);
  const rules = workspace.rules.filter((rule) => rule.ownerEmail === email);
  const storedAssets = workspace.assets.filter((asset) => !asset.builtIn && asset.ownerEmail === email);
  return {
    ...workspace,
    activeProjectId: projects.some((project) => project.id === workspace.activeProjectId)
      ? workspace.activeProjectId
      : projects[0]?.id ?? "",
    projects,
    rules,
    assets: mergeByUpdatedAt(BUILT_IN_REFERENCE_ASSETS, storedAssets),
  };
}

async function claimLegacyWorkspace(email: string) {
  const operation = ownershipQueue.then(async () => {
    const workspace = await readWorkspace();
    if (workspace.projects.some((project) => project.ownerEmail)) return;
    const hasLegacyData = Boolean(
      workspace.projects.length ||
      workspace.rules.length ||
      workspace.assets.some((asset) => !asset.builtIn),
    );
    if (!hasLegacyData) return;
    const claimed: WorkspaceSnapshot = {
      ...workspace,
      projects: workspace.projects.map((project) => ({ ...project, ownerEmail: email })),
      rules: workspace.rules.map((rule) => ({ ...rule, ownerEmail: email })),
      assets: workspace.assets.map((asset) => asset.builtIn ? asset : { ...asset, ownerEmail: email }),
    };
    await writeJsonAtomic(BACKUP_FILE, workspace);
    await writeJsonAtomic(DATA_FILE, claimed);
  });
  ownershipQueue = operation.then(() => undefined, () => undefined);
  await operation;
}

function updateOwnedWorkspace(
  email: string,
  update: (current: WorkspaceSnapshot) => WorkspaceSnapshot,
) {
  const result = writeQueue.then(async () => {
    await claimLegacyWorkspace(email);
    const current = await readWorkspace();
    const scoped = scopeWorkspace(current, email);
    const nextScoped = update(scoped);
    const next: WorkspaceSnapshot = {
      ...current,
      activeProjectId: nextScoped.activeProjectId,
      projects: [
        ...current.projects.filter((project) => project.ownerEmail !== email),
        ...nextScoped.projects.map((project) => ({ ...project, ownerEmail: email })),
      ],
      rules: [
        ...current.rules.filter((rule) => rule.ownerEmail !== email),
        ...nextScoped.rules.map((rule) => ({ ...rule, ownerEmail: email })),
      ],
      assets: [
        ...current.assets.filter((asset) => asset.builtIn || asset.ownerEmail !== email),
        ...nextScoped.assets.filter((asset) => !asset.builtIn).map((asset) => ({ ...asset, ownerEmail: email })),
      ],
    };
    await writeJsonAtomic(BACKUP_FILE, current);
    await writeJsonAtomic(DATA_FILE, next);
    return nextScoped;
  });
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function errorResponse(error: unknown) {
  const status = error instanceof Error && "status" in error && typeof error.status === "number"
    ? error.status
    : 400;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "项目数据文件操作失败" },
    { status },
  );
}

export async function GET(request: Request) {
  try {
    const email = await requireAuthenticatedEmail(request);
    await claimLegacyWorkspace(email);
    await writeQueue;
    return NextResponse.json(scopeWorkspace(await readWorkspace(), email));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const email = await requireAuthenticatedEmail(request);
    const body = (await request.json()) as {
      project?: unknown;
      activeProjectId?: unknown;
    };
    const project = normalizeProjectSnapshot(body.project);
    return NextResponse.json(
      await updateOwnedWorkspace(email, (current) => ({
        ...current,
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activeProjectId: project.id,
        projects: mergeProjectSnapshots(current.projects, [project]),
      })),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const email = await requireAuthenticatedEmail(request);
    const body = (await request.json()) as {
      projects?: unknown;
      activeProjectId?: unknown;
      rules?: unknown;
      assets?: unknown;
    };
    const incoming: ProjectSnapshot[] = Array.isArray(body.projects)
      ? body.projects.map(normalizeProjectSnapshot)
      : [];
    const requestedId =
      typeof body.activeProjectId === "string" ? body.activeProjectId : "";
    const incomingRules = Array.isArray(body.rules)
      ? body.rules.map(normalizeReuseRule)
      : [];
    const incomingAssets = Array.isArray(body.assets)
      ? body.assets.map(normalizeReferenceAsset)
      : [];
    return NextResponse.json(
      await updateOwnedWorkspace(email, (current) => {
        const projects = mergeProjectSnapshots(current.projects, incoming);
        const activeProjectId = projects.some(
          (project) => project.id === requestedId,
        )
          ? requestedId
          : current.activeProjectId || projects[0]?.id || "";
        return {
          ...current,
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          activeProjectId,
          projects,
          rules: mergeByUpdatedAt(current.rules, incomingRules),
          assets: mergeByUpdatedAt(current.assets, incomingAssets),
        };
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const email = await requireAuthenticatedEmail(request);
    const body = (await request.json()) as {
      operation?: unknown;
      activeProjectId?: unknown;
      rule?: unknown;
      asset?: unknown;
      ruleId?: unknown;
      decision?: unknown;
    };
    if (body.operation === "upsert-rule") {
      const rule = normalizeReuseRule(body.rule);
      return NextResponse.json(
        await updateOwnedWorkspace(email, (current) => {
          const existing = current.rules.find((item) => item.id === rule.id);
          const nextRule =
            existing && editableFingerprint(existing) !== editableFingerprint(rule)
              ? { ...rule, previous: editableState(existing) }
              : { ...rule, previous: existing?.previous ?? rule.previous };
          return {
            ...current,
            rules: [nextRule, ...current.rules.filter((item) => item.id !== rule.id)],
          };
        }),
      );
    }
    if (body.operation === "upsert-asset") {
      const asset = normalizeReferenceAsset(body.asset);
      return NextResponse.json(
        await updateOwnedWorkspace(email, (current) => ({
          ...current,
          assets: [asset, ...current.assets.filter((item) => item.id !== asset.id)],
        })),
      );
    }
    if (body.operation === "record-rule-decision") {
      if (
        typeof body.ruleId !== "string" ||
        !["adopted", "rejected"].includes(String(body.decision))
      ) {
        throw new Error("规则采用记录无效");
      }
      const field = body.decision === "adopted" ? "adoptedCount" : "rejectedCount";
      return NextResponse.json(
        await updateOwnedWorkspace(email, (current) => ({
          ...current,
          rules: current.rules.map((rule) =>
            rule.id === body.ruleId
              ? { ...rule, [field]: rule[field] + 1, updatedAt: new Date().toISOString() }
              : rule,
          ),
        })),
      );
    }
    if (body.operation === "undo-rule") {
      if (typeof body.ruleId !== "string") throw new Error("规则 ID 无效");
      return NextResponse.json(
        await updateOwnedWorkspace(email, (current) => ({
          ...current,
          rules: current.rules.map((rule) => {
            if (rule.id !== body.ruleId) return rule;
            if (!rule.previous) throw new Error("这条规则没有可撤销的上一个版本");
            return {
              ...rule,
              ...rule.previous,
              previous: editableState(rule),
              updatedAt: new Date().toISOString(),
            };
          }),
        })),
      );
    }
    const activeProjectId = body.activeProjectId;
    if (typeof activeProjectId !== "string") {
      throw new Error("要切换的项目不存在");
    }
    return NextResponse.json(
      await updateOwnedWorkspace(email, (current) => {
        if (
          !current.projects.some(
            (project) => project.id === activeProjectId,
          )
        ) {
          throw new Error("要切换的项目不存在");
        }
        return { ...current, activeProjectId };
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
