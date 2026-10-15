export type CharacterIdentityReference = {
  roleName: string;
  characterName: string;
  imageDataUrl: string;
};

export type CharacterIdentityMatch = {
  roleName: string;
  characterName: string;
  matchedPerson: string;
  status: "MATCH" | "UNCERTAIN" | "NO_MATCH";
  confidence: number;
  evidence: string[];
  sceneCue: string;
  promptClause: string;
};

export type CharacterIdentityResult = {
  matches: CharacterIdentityMatch[];
  model?: string;
  createdAt?: string;
};

export type CharacterIdentityCheckStatus =
  | "not-needed"
  | "matched"
  | "uncertain"
  | "unavailable";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function strings(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, maxLength))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
}

export function normalizeCharacterIdentityResult(
  value: unknown,
  references: Array<Pick<CharacterIdentityReference, "roleName" | "characterName">>,
): CharacterIdentityResult {
  const source = record(value) ? value : {};
  const rawMatches = Array.isArray(source.matches) ? source.matches : [];
  const referenceByRole = new Map(references.map((item) => [item.roleName, item]));
  const matches = rawMatches
    .filter(record)
    .map((item) => {
      const requestedRoleName = text(item.roleName, 80);
      const requestedCharacterName = text(item.characterName, 80);
      const reference = referenceByRole.get(requestedRoleName) ?? references.find(
        (candidate) => candidate.characterName === requestedCharacterName,
      );
      if (!reference) return undefined;
      const roleName = reference.roleName;
      const status = ["MATCH", "UNCERTAIN", "NO_MATCH"].includes(text(item.status, 20))
        ? (text(item.status, 20) as CharacterIdentityMatch["status"])
        : "UNCERTAIN";
      const confidence = Math.min(1, Math.max(0, Number(item.confidence) || 0));
      return {
        roleName,
        characterName: reference.characterName,
        matchedPerson: text(item.matchedPerson, 80) || "uncertain",
        status,
        confidence,
        evidence: strings(item.evidence, 6, 160),
        sceneCue: text(item.sceneCue, 400),
        promptClause: text(item.promptClause, 500),
      } satisfies CharacterIdentityMatch;
    })
    .filter((item): item is CharacterIdentityMatch => Boolean(item));
  return {
    matches,
    model: text(source.model, 120) || undefined,
    createdAt: text(source.createdAt, 80) || undefined,
  };
}

export function buildCharacterIdentityNote(matches: CharacterIdentityMatch[]) {
  const clauses = matches
    .filter((item) => item.status === "MATCH" && item.confidence >= 0.7)
    .map((item) => {
      const cue = item.sceneCue || item.promptClause;
      return cue
        ? `${item.characterName}（对应官方${item.roleName}形象）是${cue}`
        : `${item.characterName}（对应官方${item.roleName}形象）对应${item.matchedPerson}`;
    });
  const uncertain = matches
    .filter((item) => item.status !== "MATCH" || item.confidence < 0.7)
    .map((item) => `${item.characterName}暂未能稳定匹配到场景人物`);
  const all = [...clauses, ...uncertain];
  return all.length
    ? `视觉身份匹配（以官方角色参考图比对场景所得）：${all.join("；")}。${uncertain.length ? "不确定的人物不得强行归属。" : ""}`
    : undefined;
}

export function classifyCharacterIdentity(
  matches: CharacterIdentityMatch[],
  references: Array<Pick<CharacterIdentityReference, "roleName">>,
): Exclude<CharacterIdentityCheckStatus, "unavailable"> {
  if (!references.length) return "not-needed";
  const matchedRoles = new Set(
    matches
      .filter((item) => item.status === "MATCH" && item.confidence >= 0.7)
      .map((item) => item.roleName),
  );
  return references.every((reference) => matchedRoles.has(reference.roleName)
  )
    ? "matched"
    : "uncertain";
}
