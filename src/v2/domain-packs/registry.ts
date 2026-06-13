import type { DomainPack, IntentDefinition } from "./types.ts";

export type DomainRouteInput = {
  goalPrompt: string;
  domainHint?: string;
};

export type DomainRouteResult = {
  domainPack: DomainPack;
  intent: IntentDefinition;
};

export type DomainPackRegistry = {
  list(): DomainPack[];
  get(id: string): DomainPack | undefined;
  route(input: DomainRouteInput): DomainRouteResult;
};

type PromptRouteMatch = {
  domainPack: DomainPack;
  intent?: IntentDefinition;
};

export function createDomainPackRegistry(domainPacks: DomainPack[]): DomainPackRegistry {
  const byId = new Map(domainPacks.map((pack) => [pack.id, pack]));

  return {
	    list: () => [...domainPacks],
	    get: (id) => byId.get(id),
	    route(input) {
	      const hinted = input.domainHint ? byId.get(input.domainHint) : undefined;
	      if (input.domainHint && !hinted) {
	        throw new Error(`unknown domain hint: ${input.domainHint}`);
	      }
	      const promptMatch = hinted ? undefined : routeByPrompt(domainPacks, input.goalPrompt);
	      const domainPack = hinted ?? promptMatch?.domainPack;
	      if (!domainPack) {
	        throw new Error(`no domain pack matched prompt: ${input.goalPrompt.slice(0, 120)}`);
	      }
	      const intent = promptMatch?.intent ?? routeIntent(domainPack, input.goalPrompt);
	      return { domainPack, intent };
	    },
	  };
}

function routeByPrompt(domainPacks: DomainPack[], goalPrompt: string): PromptRouteMatch | undefined {
  const normalized = goalPrompt.toLowerCase();
  for (const domainPack of domainPacks) {
    for (const intent of domainPack.intents) {
      if (intent.examples.some((example) => normalized.includes(example.toLowerCase()))) {
        return { domainPack, intent };
      }
    }
  }
  const fallbackDomainPack = domainPacks.find(
    (pack) => pack.id === "software" && /\b(cli|readme|bug|calc)\b|程式|測試|實作|修正|新增/i.test(normalized),
  );
  return fallbackDomainPack ? { domainPack: fallbackDomainPack } : undefined;
}

function routeIntent(domainPack: DomainPack, goalPrompt: string): IntentDefinition {
  const normalized = goalPrompt.toLowerCase();
  if (domainPack.id === "software" && /(fix|bug|修正|失敗|failure)/i.test(normalized)) {
    return requiredIntent(domainPack, "fix_bug");
  }
  if (domainPack.id === "software") {
    return requiredIntent(domainPack, "implement_feature");
  }
  return domainPack.intents[0] ?? fail(`domain pack has no intents: ${domainPack.id}`);
}

function requiredIntent(domainPack: DomainPack, id: string): IntentDefinition {
  return domainPack.intents.find((intent) => intent.id === id) ?? fail(`missing intent ${id} in ${domainPack.id}`);
}

function fail(message: string): never {
  throw new Error(message);
}
