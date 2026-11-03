import { assertDomain } from "../domain/errors.js";
import { defaultChatModel, type ChatModelOption, type ChatModelSettings, type ChatModelSelection } from "../domain/chat-model.js";
import type { AppDatabase } from "./database.js";
import type { SessionOwnerType } from "../domain/types.js";

type Rpc = { initialize(): Promise<unknown>; request(method: string, params: Record<string, unknown>): Promise<any> };

/** Preferences belong to the chat, so cleaning or restoring its runtime keeps them. */
export class ChatModels {
  private cached: { at: number; models: ChatModelOption[] } | null = null;
  private loading: Promise<ChatModelOption[]> | null = null;
  constructor(private readonly database: AppDatabase, private readonly rpc: Rpc) {}

  settings(type: SessionOwnerType, id: string): ChatModelSettings {
    const stored = this.database.setting(`chat_model:${type}:${id}`) ?? this.database.setting("chat_model_default");
    if (stored) {
      try {
        const value = JSON.parse(stored);
        if (typeof value.model === "string" && typeof value.effort === "string") return value;
      } catch { /* Keep the existing defaults for older or invalid preferences. */ }
    }
    return defaultChatModel(type);
  }

  async list(): Promise<ChatModelOption[]> {
    if (this.cached && Date.now() - this.cached.at < 300_000) return this.cached.models;
    if (this.loading) return this.loading;
    this.loading = this.fetch();
    try { return await this.loading; } finally { this.loading = null; }
  }

  private async fetch(): Promise<ChatModelOption[]> {
    await this.rpc.initialize();
    const models: ChatModelOption[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.rpc.request("model/list", { cursor, limit: 100, includeHidden: false });
      assertDomain(Array.isArray(page.data), "Could not load models. Please retry.", "models_unavailable", 503);
      for (const item of page.data) {
        if (item.hidden || typeof item.model !== "string" || !Array.isArray(item.supportedReasoningEfforts)) continue;
        const efforts = item.supportedReasoningEfforts.filter((option: any) => typeof option.reasoningEffort === "string")
          .map((option: any) => ({ reasoningEffort: option.reasoningEffort, description: typeof option.description === "string" ? option.description : "" }));
        if (!efforts.length || models.some(model => model.model === item.model)) continue;
        models.push({ model: item.model, displayName: item.displayName || item.model,
          defaultReasoningEffort: efforts.some((option: any) => option.reasoningEffort === item.defaultReasoningEffort)
            ? item.defaultReasoningEffort : efforts[0].reasoningEffort,
          supportedReasoningEfforts: efforts });
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      assertDomain(!cursor || !seen.has(cursor), "Could not load models. Please retry.", "models_unavailable", 503);
      if (cursor) seen.add(cursor);
    } while (cursor);
    assertDomain(models.length > 0, "No models are available. Please retry.", "models_unavailable", 503);
    this.cached = { at: Date.now(), models };
    return models;
  }

  async save(type: SessionOwnerType, id: string, input: unknown): Promise<ChatModelSettings> {
    const value = input as Partial<ChatModelSelection> | null;
    assertDomain(value && typeof value.model === "string" && typeof value.effort === "string",
      "Choose a model and reasoning effort.", "invalid_chat_model");
    assertDomain(value.useAsDefault === undefined || typeof value.useAsDefault === "boolean",
      "Default preference must be enabled or disabled.", "invalid_chat_model");
    const model = (await this.list()).find(model => model.model === value.model);
    assertDomain(model, "This model is unavailable. Choose another model.", "invalid_chat_model");
    assertDomain(model.supportedReasoningEfforts.some(option => option.reasoningEffort === value.effort),
      "Choose a supported reasoning effort for this model.", "invalid_chat_effort");
    const settings = { model: model.model, effort: value.effort };
    this.database.db.transaction(() => {
      if (value.useAsDefault) {
        // Pin existing chats before changing the fallback, including chats that
        // have never used the picker. The running turn keeps its own snapshot.
        const sessions = this.database.db.prepare("SELECT owner_type, owner_id FROM agent_sessions").all() as Array<{ owner_type: SessionOwnerType; owner_id: string }>;
        for (const session of sessions) {
          const key = `chat_model:${session.owner_type}:${session.owner_id}`;
          if (!this.database.setting(key)) this.database.setSetting(key, JSON.stringify(this.settings(session.owner_type, session.owner_id)));
        }
        this.database.setSetting("chat_model_default", JSON.stringify(settings));
      }
      this.database.setSetting(`chat_model:${type}:${id}`, JSON.stringify(settings));
    })();
    return settings;
  }
}
