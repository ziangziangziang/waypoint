export interface LegacyRewriteResult {
  argv: string[];
  legacyUsed: boolean;
  ruleId?: string;
  oldCmd?: string;
  newCmd?: string;
}

function hasPositional(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("-");
}

function joinModelRef(providerId: string, modelRef: string): string {
  if (modelRef.includes("/")) {
    return modelRef;
  }
  return `${providerId}/${modelRef}`;
}

export function rewriteLegacyArgv(argv: string[]): LegacyRewriteResult {
  const args = [...argv];
  const [a0, a1, a2, a3, a4] = args;

  if (a0 === "provider" && a1 === "model" && (a2 === "ls" || a2 === "list") && hasPositional(a3)) {
    return {
      argv: ["models", a3, ...args.slice(4)],
      legacyUsed: true,
      ruleId: "provider-model-list",
      oldCmd: args.join(" "),
      newCmd: `models ${a3}`,
    };
  }

  if (a0 === "provider" && a1 === "models" && hasPositional(a2)) {
    return {
      argv: ["models", a2, ...args.slice(3)],
      legacyUsed: true,
      ruleId: "provider-models-list",
      oldCmd: args.join(" "),
      newCmd: `models ${a2}`,
    };
  }

  if (a0 === "provider" && (a1 === "ls" || a1 === "list")) {
    return {
      argv: ["providers", "list", ...args.slice(2)],
      legacyUsed: true,
      ruleId: "provider-list",
      oldCmd: args.join(" "),
      newCmd: "providers list",
    };
  }

  if (a0 === "provider" && a1 === "show" && hasPositional(a2)) {
    return {
      argv: ["providers", "show", a2, ...args.slice(3)],
      legacyUsed: true,
      ruleId: "provider-show",
      oldCmd: args.join(" "),
      newCmd: `providers show ${a2}`,
    };
  }

  if (a0 === "provider" && (a1 === "enable" || a1 === "disable") && hasPositional(a2)) {
    return {
      argv: ["providers", a1, a2, ...args.slice(3)],
      legacyUsed: true,
      ruleId: `provider-${a1}`,
      oldCmd: args.join(" "),
      newCmd: `providers ${a1} ${a2}`,
    };
  }

  if (a0 === "provider" && a1 === "model" && a2 === "show" && hasPositional(a3) && hasPositional(a4)) {
    const modelRef = joinModelRef(a3, a4);
    return {
      argv: ["models", "show", modelRef, ...args.slice(5)],
      legacyUsed: true,
      ruleId: "provider-model-show",
      oldCmd: args.join(" "),
      newCmd: `models show ${modelRef}`,
    };
  }

  if (a0 === "provider" && a1 === "model" && (a2 === "enable" || a2 === "disable") && hasPositional(a3) && hasPositional(a4)) {
    const modelRef = joinModelRef(a3, a4);
    return {
      argv: ["models", a2, modelRef, ...args.slice(5)],
      legacyUsed: true,
      ruleId: `provider-model-${a2}`,
      oldCmd: args.join(" "),
      newCmd: `models ${a2} ${modelRef}`,
    };
  }

  if (a0 === "provider" && a1 === "model" && a2 === "set-key" && hasPositional(a3) && hasPositional(a4)) {
    const modelRef = joinModelRef(a3, a4);
    return {
      argv: ["models", "set-key", modelRef, ...args.slice(5)],
      legacyUsed: true,
      ruleId: "provider-model-set-key",
      oldCmd: args.join(" "),
      newCmd: `models set-key ${modelRef}`,
    };
  }

  return { argv, legacyUsed: false };
}
