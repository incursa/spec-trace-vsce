import {
	normalizeManagedMarkdownDocument,
	parseManagedMarkdownDocument,
	validateManagedMarkdownDocument
} from '../editor/markdown/core.js';
import { parseSpecificationDocument } from '../editor/core/specificationValidation.js';
import {
	SPEC_TRACE_ARTIFACT_PREFIXES,
	SPEC_TRACE_REQUIREMENT_PREFIX,
	type WorkbenchValidationCategory
} from '../../shared/contracts.js';

export interface CanonicalSource {
	readonly path: string;
	readonly text: string;
}

export interface TraceReference {
	readonly sourceId: string;
	readonly sourcePath: string;
	readonly field: string;
	readonly targetId: string;
	readonly resolved: boolean;
}

export interface TraceBacklink {
	readonly targetId: string;
	readonly sourceId: string;
	readonly sourcePath: string;
	readonly field: string;
}

export interface TraceFinding {
	readonly category: WorkbenchValidationCategory;
	readonly severity: 'error' | 'warning';
	readonly message: string;
	readonly path: string;
	readonly itemId?: string;
	readonly targetId?: string;
}

export interface ProvenanceSummary {
	readonly artifactId: string;
	readonly path: string;
	readonly references: readonly string[];
	readonly hasProvenance: boolean;
}

export interface TraceabilitySnapshot {
	readonly artifacts: number;
	readonly requirements: number;
	readonly references: readonly TraceReference[];
	readonly backlinks: readonly TraceBacklink[];
	readonly findings: readonly TraceFinding[];
	readonly provenance: readonly ProvenanceSummary[];
}

interface ParsedItem {
	readonly id: string;
	readonly kind: 'artifact' | 'requirement';
	readonly path: string;
	readonly references: readonly FieldReference[];
	readonly provenance: readonly string[];
}

interface FieldReference {
	readonly field: string;
	readonly targetId: string;
}

const requirementTraceFields = [
	'satisfied_by',
	'implemented_by',
	'verified_by',
	'derived_from',
	'supersedes',
	'upstream_refs',
	'related'
] as const;

const markdownTraceFields = [
	'related_artifacts',
	'satisfies',
	'addresses',
	'design_links',
	'verification_links',
	'verifies'
] as const;

const provenanceFields = ['source_refs', 'source_references', 'provenance', 'upstream_refs'] as const;

export function analyzeTraceability(sources: readonly CanonicalSource[]): TraceabilitySnapshot {
	const parsedItems: ParsedItem[] = [];
	const parseFindings: TraceFinding[] = [];

	for (const source of [...sources].sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path)))) {
		const validationFindings = validateCanonicalSource(source);
		parseFindings.push(...validationFindings);
		try {
			const parsed = parseCanonicalSource(source);
			parsedItems.push(...parsed);
		} catch (error) {
			if (validationFindings.length === 0) {
				parseFindings.push({
					category: 'schema',
					severity: 'error',
					message: error instanceof Error ? error.message : 'Unable to parse canonical artifact.',
					path: normalizePath(source.path)
				});
			}
		}
	}

	const idGroups = groupById(parsedItems);
	const knownIds = new Set(parsedItems.map((item) => item.id));
	const references: TraceReference[] = [];
	const backlinks: TraceBacklink[] = [];
	const findings = [...parseFindings];

	for (const [id, items] of idGroups) {
		if (items.length < 2) {
			continue;
		}

		for (const duplicate of items.slice(1)) {
			findings.push({
				category: 'duplicate-id',
				severity: 'error',
				message: `Duplicate canonical ID "${id}".`,
				path: duplicate.path,
				itemId: id
			});
		}
	}

	for (const item of parsedItems) {
		for (const reference of item.references) {
			if (!isCanonicalId(reference.targetId)) {
				continue;
			}

			const resolved = knownIds.has(reference.targetId);
			references.push({
				sourceId: item.id,
				sourcePath: item.path,
				field: reference.field,
				targetId: reference.targetId,
				resolved
			});
			if (resolved) {
				backlinks.push({
					targetId: reference.targetId,
					sourceId: item.id,
					sourcePath: item.path,
					field: reference.field
				});
			} else {
				findings.push({
					category: 'unresolved-reference',
					severity: 'error',
					message: `Unresolved canonical reference "${reference.targetId}" in ${reference.field}.`,
					path: item.path,
					itemId: item.id,
					targetId: reference.targetId
				});
			}
		}

		if (item.kind === 'requirement') {
			const verified = item.references.some((reference) => reference.field === 'trace.verified_by' && reference.targetId.trim().length > 0);
			if (!verified) {
				findings.push({
					category: 'verification-missing',
					severity: 'warning',
					message: `Requirement "${item.id}" has no Verified By proof link.`,
					path: item.path,
					itemId: item.id
				});
			}
		}
	}

	const provenance = parsedItems
		.filter((item) => item.kind === 'artifact')
		.map((item) => ({
			artifactId: item.id,
			path: item.path,
			references: item.provenance,
			hasProvenance: item.provenance.length > 0
		}));

	return {
		artifacts: parsedItems.filter((item) => item.kind === 'artifact').length,
		requirements: parsedItems.filter((item) => item.kind === 'requirement').length,
		references: references.sort(compareReferences),
		backlinks: backlinks.sort((left, right) => left.targetId.localeCompare(right.targetId) || left.sourceId.localeCompare(right.sourceId)),
		findings: findings.sort(compareFindings),
		provenance: provenance.sort((left, right) => left.artifactId.localeCompare(right.artifactId))
	};
}

function parseCanonicalSource(source: CanonicalSource): ParsedItem[] {
	const path = normalizePath(source.path);
	if (path.toLowerCase().endsWith('.json')) {
		return parseSpecification(path, source.text);
	}

	if (path.toLowerCase().endsWith('.md')) {
		return parseMarkdown(path, source.text);
	}

	return [];
}

function validateCanonicalSource(source: CanonicalSource): TraceFinding[] {
	const path = normalizePath(source.path);
	if (path.toLowerCase().endsWith('.json')) {
		const parsed = parseSpecificationDocument(source.text);
		return parsed.issues.map((issue) => ({
			category: 'schema',
			severity: 'error',
			message: issue.path ? `${issue.path}: ${issue.message}` : issue.message,
			path,
			itemId: stringValue(parsed.document?.artifact_id) || undefined
		}));
	}

	if (path.toLowerCase().endsWith('/_index.md')) {
		return [];
	}

	if (path.toLowerCase().endsWith('.md')) {
		const document = normalizeManagedMarkdownDocument(parseManagedMarkdownDocument(source.text));
		return validateManagedMarkdownDocument(document, path).map((issue) => ({
			category: 'schema',
			severity: issue.severity,
			message: `${issue.path}: ${issue.message}`,
			path,
			itemId: stringValue(document.artifact_id) || undefined
		}));
	}

	return [];
}

function parseSpecification(path: string, text: string): ParsedItem[] {
	const value = JSON.parse(text) as Record<string, unknown>;
	const artifactId = stringValue(value.artifact_id);
	if (!artifactId) {
		throw new Error('Canonical specification JSON is missing artifact_id.');
	}

	const items: ParsedItem[] = [{
		id: artifactId,
		kind: 'artifact',
		path,
		references: collectObjectReferences(value, ['related_artifacts']),
		provenance: collectProvenance(value)
	}];

	if (!Array.isArray(value.requirements)) {
		return items;
	}

	for (const requirementValue of value.requirements) {
		if (!isRecord(requirementValue)) {
			continue;
		}

		const requirementId = stringValue(requirementValue.id);
		if (!requirementId) {
			continue;
		}

		const trace = isRecord(requirementValue.trace) ? requirementValue.trace : {};
		items.push({
			id: requirementId,
			kind: 'requirement',
			path,
			references: requirementTraceFields.flatMap((field) => collectStringReferences(trace[field], `trace.${field}`)),
			provenance: collectProvenance({ ...requirementValue, ...trace })
		});
	}

	return items;
}

function parseMarkdown(path: string, text: string): ParsedItem[] {
	const document = normalizeManagedMarkdownDocument(parseManagedMarkdownDocument(text));
	const artifactId = stringValue(document.artifact_id);
	if (!artifactId) {
		return [];
	}

	return [{
		id: artifactId,
		kind: 'artifact',
		path,
		references: markdownTraceFields.flatMap((field) => collectStringReferences(document[field], field)),
		provenance: collectProvenance(document.frontMatterExtras)
	}];
}

function collectObjectReferences(value: Record<string, unknown>, fields: readonly string[]): FieldReference[] {
	return fields.flatMap((field) => collectStringReferences(value[field], field));
}

function collectStringReferences(value: unknown, field: string): FieldReference[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter(Boolean)
		.map((targetId) => ({ field, targetId }));
}

function collectProvenance(value: Record<string, unknown>): string[] {
	const references = provenanceFields.flatMap((field) => {
		const item = value[field];
		if (Array.isArray(item)) {
			return item.filter((entry): entry is string => typeof entry === 'string');
		}

		return typeof item === 'string' ? [item] : [];
	});

	return Array.from(new Set(references.map((item) => item.trim()).filter(Boolean))).sort();
}

function groupById(items: readonly ParsedItem[]): Map<string, ParsedItem[]> {
	const groups = new Map<string, ParsedItem[]>();
	for (const item of items) {
		const group = groups.get(item.id) ?? [];
		group.push(item);
		groups.set(item.id, group);
	}

	return groups;
}

function isCanonicalId(value: string): boolean {
	return value.startsWith(SPEC_TRACE_REQUIREMENT_PREFIX)
		|| SPEC_TRACE_ARTIFACT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function compareReferences(left: TraceReference, right: TraceReference): number {
	return left.sourceId.localeCompare(right.sourceId)
		|| left.field.localeCompare(right.field)
		|| left.targetId.localeCompare(right.targetId);
}

function compareFindings(left: TraceFinding, right: TraceFinding): number {
	return left.category.localeCompare(right.category)
		|| left.path.localeCompare(right.path)
		|| (left.itemId ?? '').localeCompare(right.itemId ?? '');
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
