/** Fixed generation constraints are a subset of the v4 contract, not a replacement for validation. */
const text = (maxLength = 2000, minLength = 1) => ({ type: 'string', minLength, maxLength });
const enumeration = (...values: string[]) => ({ type: 'string', enum: values });
const integer = (minimum = 1) => ({ type: 'integer', minimum });
const array = (items: object, maxItems: number) => ({ type: 'array', items, maxItems });
const object = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const source = object({
  role: enumeration('missing-guard', 'caller-assumption', 'contract', 'schema', 'test-gap', 'impact-path'),
  revision: text(64), path: text(4096), startLine: integer(), endLine: integer(), evidence: text(8192, 0),
});
const graph = object({
  provider: text(128), providerVersion: text(128), snapshotRevision: text(64), capability: text(128),
  query: text(2000), relationship: text(2000), resolution: enumeration('exact', 'approximate', 'unresolved'),
  graphFactDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
});
const finding = {
  title: text(240), dimensions: array(enumeration('correctness', 'security', 'regression', 'testing', 'operational', 'maintainability', 'compatibility', 'data-integrity', 'architecture'), 9),
  category: enumeration('correctness', 'security', 'regression', 'testing', 'operational', 'maintainability'),
  classification: enumeration('defect', 'risk', 'test-gap', 'design-debt', 'question'),
  severity: enumeration('critical', 'high', 'medium', 'low'), confidence: { type: 'number', minimum: 0, maximum: 1 },
  side: enumeration('LEFT', 'RIGHT'), startLine: integer(), endLine: integer(), evidence: text(8192, 0),
  supportingEvidence: array(source, 12), graphReferences: array(graph, 8),
  impactPath: object({
    status: enumeration('complete', 'partial', 'unresolved'),
    steps: array(object({ from: text(), to: text(), relationship: text(), evidence: enumeration('source', 'graph'), referenceIndex: integer(0) }), 16),
    limitation: text(500),
  }),
  behavioralContract: text(), failureScenario: text(), reachability: text(), rootCause: text(), impact: text(), blastRadius: text(),
  reversibility: enumeration('reversible', 'partially-reversible', 'irreversible', 'unknown'),
  assumptions: array(text(), 8), counterEvidence: array(text(), 8), uncertainty: text(), fix: text(), regressionTest: text(),
  verification: object({ status: { const: 'unverified', type: 'string' }, reason: text(500) }),
};

export const FILE_REVIEW_GENERATION_SCHEMA: Readonly<Record<string, unknown>> = object({
  version: { type: 'integer', const: 4 },
  fileId: { type: 'string', pattern: '^[0-9]{6}$' }, outcome: enumeration('clean', 'findings', 'omitted'),
  reason: text(500),
  contextRequests: array(object({ candidateIndex: integer(0), direction: enumeration('incoming', 'outgoing') }), 2),
  findings: array({ anyOf: [
    object({ ...finding, remediationStatus: enumeration('guidance') }),
    object({ ...finding, remediationStatus: enumeration('proposed'), suggestedChange: text(8192) }),
  ] }, 10),
});
