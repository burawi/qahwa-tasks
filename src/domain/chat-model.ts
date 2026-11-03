export interface ChatModelSettings { model: string; effort: string }
export interface ChatModelSelection extends ChatModelSettings { useAsDefault?: boolean }

export interface ChatModelOption {
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
}

export function defaultChatModel(ownerType: "task" | "orchestrator"): ChatModelSettings {
  return { model: ownerType === "orchestrator" ? "gpt-6-astra" : "gpt-6.1-sol", effort: "high" };
}
