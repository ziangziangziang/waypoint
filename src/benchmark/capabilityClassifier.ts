import { BenchmarkCapabilityStatus } from "./types";

const UNSUPPORTED_SIGNAL_PATTERNS = [
  /unsupported/i,
  /not\s+supported/i,
  /not\s+implemented/i,
  /unknown\s+parameter/i,
  /invalid\s+parameter/i,
  /unrecognized\s+parameter/i,
  /does\s+not\s+support/i,
  /modality\s+not\s+supported/i,
  /endpoint\s+not\s+found/i,
  /route\s+not\s+found/i,
];

const MISCONFIGURED_SIGNAL_PATTERNS = [
  /api\s*key/i,
  /missing\s+api\s*key/i,
  /authorization/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid\s+auth/i,
  /invalid\s+api\s*key/i,
  /model\s+not\s+found/i,
  /unknown\s+model/i,
  /no\s+such\s+model/i,
  /credential/i,
  /token/i,
];

const TRANSIENT_SIGNAL_PATTERNS = [
  /timeout/i,
  /timed\s*out/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /network/i,
  /temporar/i,
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
];

export interface CapabilityClassificationInput {
  success: boolean;
  statusCode?: number;
  error?: string;
}

export function classifyCapabilityStatus(input: CapabilityClassificationInput): BenchmarkCapabilityStatus {
  if (input.success) {
    return "supported";
  }

  const statusCode = Number.isFinite(input.statusCode) ? input.statusCode : undefined;
  const error = (input.error ?? "").toLowerCase();

  if (statusCode === 401 || statusCode === 403) {
    return "misconfigured";
  }

  if (statusCode === 404) {
    if (MISCONFIGURED_SIGNAL_PATTERNS.some((pattern) => pattern.test(error))) {
      return "misconfigured";
    }
    return "unsupported";
  }

  if (statusCode === 429) {
    return "unknown";
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return "unknown";
  }

  if (statusCode === 400) {
    if (MISCONFIGURED_SIGNAL_PATTERNS.some((pattern) => pattern.test(error))) {
      return "misconfigured";
    }
    if (UNSUPPORTED_SIGNAL_PATTERNS.some((pattern) => pattern.test(error))) {
      return "unsupported";
    }
    return "unknown";
  }

  if (MISCONFIGURED_SIGNAL_PATTERNS.some((pattern) => pattern.test(error))) {
    return "misconfigured";
  }

  if (UNSUPPORTED_SIGNAL_PATTERNS.some((pattern) => pattern.test(error))) {
    return "unsupported";
  }

  if (TRANSIENT_SIGNAL_PATTERNS.some((pattern) => pattern.test(error))) {
    return "unknown";
  }

  return "unknown";
}
