import { DomainError } from "./errors.js";

export interface OrchestratorSettings {
  name: string;
  customInstructions: string;
}

export const DEFAULT_ORCHESTRATOR_SETTINGS: Readonly<OrchestratorSettings> = Object.freeze({
  name: "Orchestrator", customInstructions: "",
});
export const MAX_ORCHESTRATOR_NAME_LENGTH = 60;
export const MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH = 8_000;

export function orchestratorSettingsError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Provide a name and custom instructions";
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some((key) => key !== "name" && key !== "customInstructions")) return "Only name and custom instructions can be changed here";
  if (typeof settings.name !== "string" || !settings.name.trim()) return "Enter a name";
  if (settings.name.length > MAX_ORCHESTRATOR_NAME_LENGTH) return `Name must be ${MAX_ORCHESTRATOR_NAME_LENGTH} characters or fewer`;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(settings.name)) return "Name must be a single line without control characters";
  if (typeof settings.customInstructions !== "string") return "Custom instructions must be text";
  if (settings.customInstructions.length > MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH) return `Custom instructions must be ${MAX_ORCHESTRATOR_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters or fewer`;
  return null;
}

export function parseOrchestratorSettings(value: unknown): OrchestratorSettings {
  const error = orchestratorSettingsError(value);
  if (error) throw new DomainError(error, "invalid_orchestrator_settings");
  const settings = value as OrchestratorSettings;
  return { name: settings.name.trim(), customInstructions: settings.customInstructions };
}
