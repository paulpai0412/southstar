export type CatalogCanonicalDomain = {
  key: string;
  title: string;
  sourcePathPrefixes: string[];
};

export const CATALOG_CANONICAL_DOMAINS = [
  { key: "academic", title: "學術部", sourcePathPrefixes: ["academic/"] },
  { key: "design", title: "設計部", sourcePathPrefixes: ["design/"] },
  { key: "engineering", title: "工程部", sourcePathPrefixes: ["engineering/"] },
  { key: "finance", title: "金融部", sourcePathPrefixes: ["finance/"] },
  { key: "game-development", title: "遊戲開發部", sourcePathPrefixes: ["game-development/"] },
  { key: "hr", title: "人力資源部", sourcePathPrefixes: ["hr/"] },
  { key: "legal", title: "法務部", sourcePathPrefixes: ["legal/"] },
  { key: "marketing", title: "營銷部", sourcePathPrefixes: ["marketing/"] },
  { key: "paid-media", title: "付費媒體部", sourcePathPrefixes: ["paid-media/"] },
  { key: "product", title: "產品部", sourcePathPrefixes: ["product/"] },
  { key: "project-management", title: "項目管理部", sourcePathPrefixes: ["project-management/"] },
  { key: "sales", title: "銷售部", sourcePathPrefixes: ["sales/"] },
  { key: "spatial-computing", title: "空間計算部", sourcePathPrefixes: ["spatial-computing/"] },
  { key: "specialized", title: "專項部", sourcePathPrefixes: ["specialized/"] },
  { key: "supply-chain", title: "供應鏈部", sourcePathPrefixes: ["supply-chain/"] },
  { key: "support", title: "支持部", sourcePathPrefixes: ["support/"] },
  { key: "testing", title: "測試部", sourcePathPrefixes: ["testing/"] },
  { key: "gis", title: "GIS 部", sourcePathPrefixes: ["gis/"] },
  { key: "security", title: "安全部", sourcePathPrefixes: ["security/"] },
] as const satisfies readonly CatalogCanonicalDomain[];

export const CATALOG_CANONICAL_DOMAIN_KEYS = CATALOG_CANONICAL_DOMAINS.map((domain) => domain.key);

export function isCatalogCanonicalDomain(value: string | undefined): value is typeof CATALOG_CANONICAL_DOMAIN_KEYS[number] {
  return Boolean(value && CATALOG_CANONICAL_DOMAIN_KEYS.some((key) => key === value));
}

export function catalogDomainFromSourcePath(sourcePath: string | undefined): CatalogCanonicalDomain | undefined {
  if (!sourcePath) return undefined;
  const normalized = sourcePath.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
  return CATALOG_CANONICAL_DOMAINS.find((domain) => (
    domain.sourcePathPrefixes.some((prefix) => normalized.startsWith(prefix))
  ));
}

export function catalogDomainTitle(key: string): string | undefined {
  return CATALOG_CANONICAL_DOMAINS.find((domain) => domain.key === key)?.title;
}
