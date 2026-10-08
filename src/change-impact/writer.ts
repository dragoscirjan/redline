import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeImpactMap, ReviewContextPlan } from './types.js';

let temporarySequence = 0;

async function writeAtomic(path: string, content: string): Promise<void> {
  temporarySequence += 1;
  const temporaryPath = `${path}.${process.pid}.${temporarySequence}.tmp`;
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderChangeImpactMarkdown(map: ChangeImpactMap): string {
  const lines = [
    '# Change impact map',
    '',
    `- **Contract version:** ${map.version}`,
    `- **Mode:** ${map.mode}`,
    `- **Revisions:** ${map.baseRevision.slice(0, 12)}..${map.headRevision.slice(0, 12)}`,
    `- **Coverage:** ${map.coverage}`,
    `- **Changed targets:** ${map.changedTargets.length}`,
    `- **Neighborhoods:** ${map.neighborhoods.length}`,
    `- **Cones:** ${map.cones.length}`,
    `- **Witnesses:** ${map.witnesses.length}`,
    '',
    'Graph relationships are derived evidence. Diff text and captured source remain authoritative.',
    '',
    '## Graph delta',
    '',
    `- Added nodes: ${map.graphDelta.nodes.filter((item) => item.kind === 'added').length}`,
    `- Removed nodes: ${map.graphDelta.nodes.filter((item) => item.kind === 'removed').length}`,
    `- Changed or renamed nodes: ${map.graphDelta.nodes.filter((item) => item.kind === 'changed' || item.kind === 'renamed').length}`,
    `- Added edges: ${map.graphDelta.edges.filter((item) => item.kind === 'added').length}`,
    `- Removed edges: ${map.graphDelta.edges.filter((item) => item.kind === 'removed').length}`,
    '',
    '## Neighborhoods',
    '',
    '| Neighborhood | Targets | Paths | Coverage |',
    '| --- | --- | --- | --- |',
  ];
  for (const neighborhood of map.neighborhoods) {
    lines.push(
      `| ${neighborhood.id} | ${neighborhood.targetIds.map(escapeTable).join(', ')} | ${neighborhood.paths.map(escapeTable).join(', ')} | ${neighborhood.partial ? 'partial' : 'complete'} |`,
    );
  }
  lines.push('', '## Risk and routing inputs', '');
  lines.push(`- **Blast radius:** ${map.risk.blastRadius}`);
  lines.push(`- **Reversibility:** ${map.risk.reversibility}`);
  lines.push(`- **Specialists:** ${map.risk.specialistDimensions.join(', ') || 'none'}`);
  for (const reason of map.risk.reasons) lines.push(`- ${reason}`);
  lines.push('', 'These are planning signals, not findings, and cannot independently block a change.', '');
  lines.push('## Uncertainty', '');
  if (map.uncertainty.length === 0) {
    lines.push('No impact-analysis uncertainty was recorded.');
  } else {
    for (const item of map.uncertainty) lines.push(`- **${item.code}** (${item.coverage}): ${item.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderContextPlanMarkdown(plan: ReviewContextPlan): string {
  const lines = [
    '# Review context plan',
    '',
    `- **Contract version:** ${plan.version}`,
    `- **Accounting:** ${plan.accounting}`,
    '',
  ];
  for (const question of plan.questions) {
    lines.push(`## ${question.questionId}`, '');
    lines.push(`- **Specialist:** ${question.specialist}`);
    lines.push(`- **Coverage:** ${question.coverage}`);
    lines.push(`- **Packed size:** ${question.bytes} bytes / ~${question.tokenEstimate} tokens`);
    lines.push(`- **Omitted candidates:** ${question.omittedCandidateIds.join(', ') || 'none'}`, '');
    lines.push('| Order | Category | Source | Selection reason | Provenance |', '| ---: | --- | --- | --- | --- |');
    question.items.forEach((item, index) => {
      const span = item.span === undefined ? '' : `:${item.span.startLine}-${item.span.endLine}`;
      const provenance = item.provenance === undefined
        ? 'captured source'
        : `${item.provenance.provider}/${item.provenance.queryId} (${item.provenance.status})`;
      lines.push(
        `| ${index + 1} | ${item.category} | ${escapeTable(`${item.path}${span} @ ${item.revision}`)} | ${escapeTable(item.selectionReason)} | ${escapeTable(provenance)} |`,
      );
    });
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export interface ChangeImpactWriter {
  writeImpactMap(map: ChangeImpactMap): Promise<void>;
  writeContextPlan(plan: ReviewContextPlan): Promise<void>;
}

/** Writes separate, versioned machine- and human-readable planning artifacts. */
export function createChangeImpactWriter(outputDirectory: string): ChangeImpactWriter {
  const impactDirectory = join(outputDirectory, 'impact');
  let prepared = false;
  const prepare = async (): Promise<void> => {
    if (!prepared) {
      await mkdir(impactDirectory, { recursive: true });
      prepared = true;
    }
  };
  return {
    async writeImpactMap(map: ChangeImpactMap): Promise<void> {
      await prepare();
      await writeAtomic(join(impactDirectory, 'change-impact.json'), `${JSON.stringify(map, null, 2)}\n`);
      await writeAtomic(join(impactDirectory, 'change-impact.md'), renderChangeImpactMarkdown(map));
    },
    async writeContextPlan(plan: ReviewContextPlan): Promise<void> {
      await prepare();
      await writeAtomic(join(impactDirectory, 'context-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
      await writeAtomic(join(impactDirectory, 'context-plan.md'), renderContextPlanMarkdown(plan));
    },
  };
}
