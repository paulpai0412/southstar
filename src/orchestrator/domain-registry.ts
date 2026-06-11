import type { RuntimeConfig } from "../config/schema.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";
import type { DomainDriver } from "./domain-driver.ts";

export type DomainDriverRegistryErrorCode =
  | "DOMAIN_DRIVER_UNKNOWN"
  | "DOMAIN_DRIVER_NOT_IMPLEMENTED"
  | "DOMAIN_DRIVER_CONFIG_INVALID";

export class DomainDriverRegistryError extends Error {
  readonly code: DomainDriverRegistryErrorCode;

  constructor(code: DomainDriverRegistryErrorCode, message: string) {
    super(message);
    this.name = "DomainDriverRegistryError";
    this.code = code;
  }
}

export interface DomainDriverFactoryInput {
  workflow: WorkflowDefinition;
  config: RuntimeConfig | Record<string, unknown>;
  dependencies: Record<string, unknown>;
}

export type DomainDriverFactory = (input: DomainDriverFactoryInput) => DomainDriver;

export interface DomainDriverRegistryMetrics {
  domain_registry_registered_domains: number;
  domain_registry_software_dev_resolved: number;
  domain_registry_content_creation_deferred: number;
  domain_registry_office_automation_deferred: number;
  domain_registry_unknown_domain_errors: number;
}

export class DomainDriverRegistry {
  private readonly factories = new Map<string, DomainDriverFactory>();
  private readonly recognizedDeferred = new Set(["content_creation", "office_automation"]);
  private readonly counters: DomainDriverRegistryMetrics = {
    domain_registry_registered_domains: 0,
    domain_registry_software_dev_resolved: 0,
    domain_registry_content_creation_deferred: 0,
    domain_registry_office_automation_deferred: 0,
    domain_registry_unknown_domain_errors: 0,
  };

  register(domain: string, factory: DomainDriverFactory): this {
    this.factories.set(domain, factory);
    this.counters.domain_registry_registered_domains = this.factories.size + this.recognizedDeferred.size;
    return this;
  }

  resolve(input: DomainDriverFactoryInput): DomainDriver {
    const domain = input.workflow.domain ?? compatibilityDomain(input.workflow);
    if (!domain) {
      this.counters.domain_registry_unknown_domain_errors += 1;
      throw new DomainDriverRegistryError("DOMAIN_DRIVER_UNKNOWN", `Workflow ${input.workflow.id} does not declare a supported domain`);
    }

    if (this.recognizedDeferred.has(domain)) {
      if (domain === "content_creation") this.counters.domain_registry_content_creation_deferred += 1;
      if (domain === "office_automation") this.counters.domain_registry_office_automation_deferred += 1;
      throw new DomainDriverRegistryError("DOMAIN_DRIVER_NOT_IMPLEMENTED", `Domain driver ${domain} is recognized but not implemented`);
    }

    const factory = this.factories.get(domain);
    if (!factory) {
      this.counters.domain_registry_unknown_domain_errors += 1;
      throw new DomainDriverRegistryError("DOMAIN_DRIVER_UNKNOWN", `Unknown domain driver ${domain}`);
    }

    try {
      const driver = factory(input);
      if (domain === "software_development") this.counters.domain_registry_software_dev_resolved += 1;
      return driver;
    } catch (error) {
      if (error instanceof DomainDriverRegistryError) throw error;
      throw new DomainDriverRegistryError(
        "DOMAIN_DRIVER_CONFIG_INVALID",
        error instanceof Error ? error.message : `Invalid configuration for domain driver ${domain}`,
      );
    }
  }

  metrics(): DomainDriverRegistryMetrics {
    return { ...this.counters };
  }
}

export function createDefaultDomainDriverRegistry(input: {
  softwareDevelopmentFactory: DomainDriverFactory;
}): DomainDriverRegistry {
  return new DomainDriverRegistry()
    .register("software_development", input.softwareDevelopmentFactory);
}

function compatibilityDomain(workflow: WorkflowDefinition): string | undefined {
  return workflow.id === "issue_to_pr_release" ? "software_development" : undefined;
}
