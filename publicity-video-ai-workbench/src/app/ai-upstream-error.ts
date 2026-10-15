export type AiUpstreamPayload = {
  error?: { message?: string } | string;
};

type AiUpstreamErrorPolicy = {
  authCode: string;
  upstreamCode: string;
  fallbackMessage: (status: number) => string;
  authStatuses?: readonly number[];
  rateLimitCode?: string;
  rateLimitStatuses?: readonly number[];
  fallbackStatus?: number;
};

export function mapAiUpstreamError(
  status: number,
  data: AiUpstreamPayload,
  policy: AiUpstreamErrorPolicy,
) {
  const authStatuses = policy.authStatuses ?? [401];
  const rateLimitStatuses = policy.rateLimitStatuses ?? [429];
  const authFailed = authStatuses.includes(status);
  const rateLimited = !authFailed && rateLimitStatuses.includes(status);
  const message = typeof data.error === "string" ? data.error : data.error?.message;

  return {
    code: authFailed
      ? policy.authCode
      : rateLimited && policy.rateLimitCode
        ? policy.rateLimitCode
        : policy.upstreamCode,
    error: message || policy.fallbackMessage(status),
    status: authFailed ? status : (policy.fallbackStatus ?? 502),
  };
}
