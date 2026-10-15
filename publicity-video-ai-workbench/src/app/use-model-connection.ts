"use client";
import { useEffect, useState } from "react";

export const AI_PROVIDER_PRESETS = [
  {
    value: "zhipu",
    label: "智谱",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.7-flash",
    consoleUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    value: "custom",
    label: "其他兼容服务",
    endpoint: "",
    model: "",
    consoleUrl: "",
  },
] as const;

export type AiClientConfiguration = {
  configured: boolean;
  provider: string;
  endpoint: string;
  model: string;
};


export function useModelConnection(kind: "text" | "vision", enabled = true) {
  const label = kind === "vision" ? "视觉模型" : "模型";
  const defaults: AiClientConfiguration = { configured: false, provider: "zhipu", endpoint: AI_PROVIDER_PRESETS[0].endpoint,
    model: kind === "vision" ? "glm-4.6v-flash" : AI_PROVIDER_PRESETS[0].model };
  const [configuration, setConfiguration] = useState<AiClientConfiguration>(defaults);
  const [draft, setDraft] = useState({ ...defaults, apiKey: "" });
  const [state, setState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch("/api/ai/settings?kind=" + kind, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("模型设置读取失败");
        return response.json() as Promise<AiClientConfiguration>;
      })
      .then((config) => {
        if (controller.signal.aborted) return;
        setConfiguration(config);
        setDraft({ ...config, apiKey: "" });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [kind, enabled]);
  const reset = (open: boolean) => {
    setDraft({ ...configuration, apiKey: "" });
    setState("idle");
    setMessage("");
    setEditing(open);
  };
  const changeProvider = (provider: string) => {
    const preset = AI_PROVIDER_PRESETS.find((item) => item.value === provider);
    setDraft((current) => ({ ...current, provider, endpoint: preset?.endpoint || current.endpoint,
      model: kind === "vision" && provider === "zhipu" ? "glm-4.6v-flash" : preset?.model || current.model }));
    setState("idle");
    setMessage("");
  };
  const save = async () => {
    if (!draft.endpoint.trim() || !draft.model.trim()) {
      setState("error");
      setMessage("请填写服务地址和" + label + "名称。");
      return false;
    }
    setState("saving");
    setMessage("正在验证" + label + "连接…");
    try {
      const response = await fetch("/api/ai/settings", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, provider: draft.provider, endpoint: draft.endpoint.trim(),
          model: draft.model.trim(), apiKey: draft.apiKey.trim() }) });
      const data = await response.json() as AiClientConfiguration & { error?: string; message?: string };
      if (!response.ok || !data.configured) throw new Error(data.error || label + "连接失败");
      const config = { configured: true, provider: data.provider || draft.provider,
        endpoint: data.endpoint || draft.endpoint, model: data.model || draft.model };
      setConfiguration(config);
      setDraft({ ...config, apiKey: "" });
      setState("success");
      setMessage(data.message || label + "连接已保存");
      setEditing(false);
      return true;
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : label + "连接失败");
      return false;
    }
  };
  return { configuration, draft, setDraft, state, setState, message, setMessage, editing, changeProvider,
    edit: () => reset(true), cancel: () => reset(false), save };
}
