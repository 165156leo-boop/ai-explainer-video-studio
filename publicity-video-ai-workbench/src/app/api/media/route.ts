import { NextResponse } from "next/server";
import { requireAuthenticatedEmail } from "../../auth";
import {
  ProviderRequestError,
  adoptCandidate,
  checkProviderAccount,
  createMediaJob,
  createProviderAccount,
  getCandidateFile,
  getProviderOverview,
  initializeProviderAccount,
  listMediaJobs,
  maintainMediaJobs,
  listProviderAccounts,
  rejectCandidate,
  saveCandidateReview,
  saveProviderConfiguration,
  startProviderRuntime,
} from "../../media-provider";
import { normalizeVisionReview } from "../../media-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function stringValue(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少${field}`);
  return value.trim();
}

function errorResponse(error: unknown) {
  const status = error instanceof ProviderRequestError
    ? error.status
    : error instanceof Error && "status" in error && typeof error.status === "number"
      ? error.status
      : 400;
  return NextResponse.json(
    {
      code: error instanceof ProviderRequestError ? error.code : "MEDIA_REQUEST_FAILED",
      error: error instanceof Error ? error.message : "媒体请求失败",
    },
    { status },
  );
}

export async function GET(request: Request) {
  try {
    const email = await requireAuthenticatedEmail(request);
    const search = new URL(request.url).searchParams;
    const resource = search.get("resource") || "settings";
    if (resource === "settings") return NextResponse.json(await getProviderOverview());
    if (resource === "accounts") return NextResponse.json({ accounts: await listProviderAccounts(email) });
    if (resource === "jobs") {
      return NextResponse.json({ jobs: await listMediaJobs(email, search.get("projectId") || "") });
    }
    if (resource === "file") {
      const file = await getCandidateFile(
        email,
        stringValue(search.get("jobId"), "任务 ID"),
        stringValue(search.get("candidateId"), "候选 ID"),
      );
      return new Response(file.stream, {
        headers: {
          "Content-Type": file.mimeType,
          "Content-Length": String(file.size),
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    throw new Error("未知的媒体资源");
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const email = await requireAuthenticatedEmail(request);
    const body = (await request.json()) as Record<string, unknown>;
    const operation = stringValue(body.operation, "媒体操作");
    if (operation === "save-settings") {
      return NextResponse.json(
        await saveProviderConfiguration(stringValue(body.baseUrl, "Provider 地址")),
      );
    }
    if (operation === "start-provider") {
      return NextResponse.json(await startProviderRuntime());
    }
    if (operation === "create-account") {
      return NextResponse.json(
        await createProviderAccount(
          email,
          stringValue(body.displayName, "账号名称"),
          typeof body.accountId === "string" ? body.accountId : undefined,
        ),
      );
    }
    if (operation === "check-account") {
      return NextResponse.json(
        await checkProviderAccount(email, stringValue(body.accountId, "账号 ID")),
      );
    }
    if (operation === "login-account") {
      return NextResponse.json(
        await initializeProviderAccount(email, stringValue(body.accountId, "账号 ID")),
      );
    }
    if (operation === "maintain-jobs") {
      return NextResponse.json({ maintained: await maintainMediaJobs(email) });
    }
    if (operation === "create-job") {
      const mediaType = stringValue(body.mediaType, "媒体类型");
      if (!['image', 'video'].includes(mediaType)) throw new Error("媒体类型无效");
      const referenceImages = Array.isArray(body.referenceImages)
        ? body.referenceImages
            .filter((item): item is { dataUrl: string; fileName?: string } =>
              typeof item === "object" && item !== null && typeof (item as { dataUrl?: unknown }).dataUrl === "string",
            )
            .slice(0, 10)
        : [];
      return NextResponse.json(
        await createMediaJob({
          ownerEmail: email,
          projectId: stringValue(body.projectId, "项目 ID"),
          projectTitle: stringValue(body.projectTitle, "项目名称"),
          targetId: stringValue(body.targetId, "镜头 ID"),
          // 展示编号是可选的：老客户端不传也能建任务，导出文件名回退用 `targetId`。
          targetLabel: typeof body.targetLabel === "string" ? body.targetLabel : undefined,
          mediaType: mediaType as "image" | "video",
          accountId: stringValue(body.accountId, "豆包账号"),
          prompt: stringValue(body.prompt, "提示词"),
          referenceImages,
          retryOfJobId: typeof body.retryOfJobId === "string" ? body.retryOfJobId : undefined,
          videoModel: typeof body.videoModel === "string" ? body.videoModel : undefined,
          videoDurationSeconds:
            typeof body.videoDurationSeconds === "number" && Number.isFinite(body.videoDurationSeconds)
              ? body.videoDurationSeconds
              : undefined,
        }),
        { status: 202 },
      );
    }
    if (operation === "save-review") {
      return NextResponse.json(
        await saveCandidateReview(
          email,
          stringValue(body.jobId, "任务 ID"),
          stringValue(body.candidateId, "候选 ID"),
          normalizeVisionReview(body.review),
        ),
      );
    }
    if (operation === "reject-candidate") {
      return NextResponse.json(
        await rejectCandidate(
          email,
          stringValue(body.jobId, "任务 ID"),
          stringValue(body.candidateId, "候选 ID"),
          typeof body.reason === "string" ? body.reason : undefined,
        ),
      );
    }
    if (operation === "adopt-candidate") {
      return NextResponse.json(
        await adoptCandidate(
          email,
          stringValue(body.jobId, "任务 ID"),
          stringValue(body.candidateId, "候选 ID"),
        ),
      );
    }
    throw new Error("未知的媒体操作");
  } catch (error) {
    return errorResponse(error);
  }
}
