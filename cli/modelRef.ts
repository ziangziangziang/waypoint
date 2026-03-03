export interface ParsedModelRef {
  providerId?: string;
  modelId: string;
  canonical?: string;
}

export function parseModelRef(input: string): ParsedModelRef {
  const trimmed = input.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { modelId: trimmed };
  }

  const providerId = trimmed.slice(0, slashIndex).trim();
  const modelId = trimmed.slice(slashIndex + 1).trim();
  if (!providerId || !modelId) {
    return { modelId: trimmed };
  }
  return {
    providerId,
    modelId,
    canonical: `${providerId}/${modelId}`,
  };
}
