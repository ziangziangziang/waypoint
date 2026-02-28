import {
  EndpointType,
  ModelCapabilities,
  ModelMapping,
  ModelModality,
} from "../types";

export interface CapabilitiesRequirements {
  requiredInput?: ModelModality[];
  requiredOutput?: ModelModality[];
}

export function resolveCapabilities(
  mapping: ModelMapping,
  endpointType: EndpointType,
  upstreamCaps?: ModelCapabilities
): ModelCapabilities {
  if (mapping.capabilities) {
    return normalizeCapabilities(mapping.capabilities, "configured");
  }
  if (upstreamCaps) {
    return normalizeCapabilities(upstreamCaps, "inferred");
  }

  const inferred = inferCapabilities(mapping.publicName, endpointType);
  warnInference(mapping.publicName, endpointType, inferred);
  return normalizeCapabilities(inferred, "inferred");
}

export function inferCapabilities(
  modelName: string,
  endpointType: EndpointType
): ModelCapabilities {
  const name = modelName.toLowerCase();

  if (endpointType === "embedding") {
    return { input: ["text"], output: ["embedding"] };
  }

  if (endpointType === "diffusion") {
    return { input: ["text"], output: ["image"] };
  }

  if (endpointType === "audio") {
    if (isTtsModelName(name)) {
      return { input: ["text"], output: ["audio"] };
    }
    // Default audio fallback favors transcription-like behavior.
    return { input: ["audio"], output: ["text"] };
  }

  if (isVisionModelName(name)) {
    return { input: ["text", "image"], output: ["text"], supportsTools: true, supportsStreaming: true };
  }

  return { input: ["text"], output: ["text"], supportsTools: true, supportsStreaming: true };
}

export function supportsRequirements(
  capabilities: ModelCapabilities,
  requirements?: CapabilitiesRequirements
): boolean {
  if (!requirements) {
    return true;
  }

  if (requirements.requiredInput && requirements.requiredInput.length > 0) {
    for (const modality of requirements.requiredInput) {
      if (!capabilities.input.includes(modality)) {
        return false;
      }
    }
  }

  if (requirements.requiredOutput && requirements.requiredOutput.length > 0) {
    for (const modality of requirements.requiredOutput) {
      if (!capabilities.output.includes(modality)) {
        return false;
      }
    }
  }

  return true;
}

function normalizeCapabilities(
  capabilities: ModelCapabilities,
  source: "configured" | "inferred"
): ModelCapabilities {
  return {
    input: normalizeModalities(capabilities.input),
    output: normalizeModalities(capabilities.output),
    supportsTools: capabilities.supportsTools,
    supportsStreaming: capabilities.supportsStreaming,
    source,
  };
}

function normalizeModalities(modalities: ModelModality[]): ModelModality[] {
  const allowed: ModelModality[] = ["text", "image", "audio", "embedding"];
  const unique = new Set<ModelModality>();

  for (const modality of modalities) {
    if (allowed.includes(modality)) {
      unique.add(modality);
    }
  }

  return allowed.filter((modality) => unique.has(modality));
}

function isTtsModelName(name: string): boolean {
  return (
    name.includes("tts") ||
    name.includes("speech") ||
    name.includes("voice") ||
    name.includes("audio-gen")
  );
}

function isVisionModelName(name: string): boolean {
  return (
    name.includes("vision") ||
    name.includes("vl") ||
    name.includes("omni") ||
    name.includes("multimodal")
  );
}

const capabilityInferenceWarnings = new Set<string>();

function warnInference(
  modelName: string,
  endpointType: EndpointType,
  capabilities: ModelCapabilities
): void {
  const key = `${endpointType}:${modelName}`;
  if (capabilityInferenceWarnings.has(key)) {
    return;
  }
  capabilityInferenceWarnings.add(key);
  console.warn(
    `[waypoint] Inferred capabilities for model '${modelName}' on ${endpointType}: ` +
      `${capabilities.input.join("+")}->${capabilities.output.join("+")}`
  );
}
