export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
	JsonPrimitive
	| JsonValue[]
	| {
		readonly [key: string]: JsonValue;
	};

export interface ValidationIssue {
	readonly path: string;
	readonly message: string;
}

export type RequirementCoverageStatus = 'covered' | 'partial' | 'missing';
export type CoverageExpectationStatus = 'required' | 'optional' | 'not_applicable' | 'deferred';

export interface RequirementCoverageExpectation {
	positive?: CoverageExpectationStatus;
	negative?: CoverageExpectationStatus;
	edge?: CoverageExpectationStatus;
	fuzz?: CoverageExpectationStatus;
	[key: string]: unknown;
}

export interface RequirementTrace {
	satisfied_by?: string[];
	implemented_by?: string[];
	verified_by?: string[];
	derived_from?: string[];
	supersedes?: string[];
	upstream_refs?: string[];
	related?: string[];
	[key: string]: unknown;
}

export interface SpecificationRequirement {
	id?: string;
	title?: string;
	statement?: string;
	coverage?: RequirementCoverageExpectation;
	trace?: RequirementTrace;
	notes?: string[];
	[key: string]: unknown;
}

export interface SupplementalSection {
	heading?: string;
	content?: string;
	[key: string]: unknown;
}

export interface RequirementCoverageSummary {
	readonly status: RequirementCoverageStatus;
	readonly coverageCount: number;
	readonly traceCount: number;
	readonly notesCount: number;
}

export interface SpecificationCoverageSummary {
	readonly totalRequirements: number;
	readonly coveredCount: number;
	readonly partialCount: number;
	readonly missingCount: number;
	readonly requirementSummaries: RequirementCoverageSummary[];
}

export interface SpecificationDocument {
	artifact_id?: string;
	artifact_type?: string;
	title?: string;
	domain?: string;
	capability?: string;
	status?: string;
	owner?: string;
	purpose?: string;
	scope?: string;
	context?: string;
	tags?: string[];
	related_artifacts?: string[];
	open_questions?: string[];
	supplemental_sections?: SupplementalSection[];
	requirements?: SpecificationRequirement[];
	[key: string]: unknown;
}

export const specificationWorkspaceRootSegment = 'specs/requirements';

export function normalizeWorkspaceRelativePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function isSpecificationPath(workspaceRelativePath: string): boolean {
	const normalized = normalizeWorkspaceRelativePath(workspaceRelativePath).toLowerCase();
	return normalized.startsWith(`${specificationWorkspaceRootSegment}/`) && normalized.endsWith('.json');
}

export function serializeSpecificationDocument(document: SpecificationDocument): string {
	const output: Record<string, JsonValue> = {};

	appendStringField(output, 'artifact_id', document.artifact_id);
	appendStringField(output, 'artifact_type', document.artifact_type);
	appendStringField(output, 'title', document.title);
	appendStringField(output, 'domain', document.domain);
	appendStringField(output, 'capability', document.capability);
	appendStringField(output, 'status', document.status);
	appendStringField(output, 'owner', document.owner);
	appendStringField(output, 'purpose', document.purpose);
	appendStringField(output, 'scope', document.scope);
	appendStringField(output, 'context', document.context);
	appendArrayField(output, 'tags', document.tags);
	appendArrayField(output, 'related_artifacts', document.related_artifacts);
	appendArrayField(output, 'open_questions', document.open_questions);
	appendUnknownArrayField(output, 'supplemental_sections', document.supplemental_sections);

	output.requirements = Array.isArray(document.requirements)
		? document.requirements.map((requirement) => serializeRequirement(requirement))
		: [];

	for (const key of Object.keys(document).sort((left, right) => left.localeCompare(right))) {
		if (key in output) {
			continue;
		}

		const value = document[key];
		if (value !== undefined) {
			output[key] = canonicalizeUnknownValue(value);
		}
	}

	return `${JSON.stringify(output, undefined, 2)}\n`;
}

export function createEmptyRequirement(): SpecificationRequirement {
	return {
		id: '',
		title: '',
		statement: ''
	};
}

export function cloneSpecificationDocument<T extends SpecificationDocument | SpecificationRequirement | SupplementalSection>(document: T): T {
	return JSON.parse(JSON.stringify(document)) as T;
}

export function summarizeRequirementCoverage(requirement: SpecificationRequirement): RequirementCoverageSummary {
	const coverageCount = countMeaningfulCoverage(requirement.coverage);
	const traceCount = countMeaningfulTraceReferences(requirement.trace);
	const notesCount = countMeaningfulStrings(requirement.notes);

	return {
		status: coverageCount > 0 ? 'covered' : (traceCount > 0 || notesCount > 0 ? 'partial' : 'missing'),
		coverageCount,
		traceCount,
		notesCount
	};
}

export function summarizeSpecificationCoverage(document: SpecificationDocument): SpecificationCoverageSummary {
	const requirementSummaries = (document.requirements ?? []).map((requirement) => summarizeRequirementCoverage(requirement));
	return {
		totalRequirements: requirementSummaries.length,
		coveredCount: requirementSummaries.filter((summary) => summary.status === 'covered').length,
		partialCount: requirementSummaries.filter((summary) => summary.status === 'partial').length,
		missingCount: requirementSummaries.filter((summary) => summary.status === 'missing').length,
		requirementSummaries
	};
}

function serializeRequirement(requirement: SpecificationRequirement): Record<string, JsonValue> {
	const output: Record<string, JsonValue> = {};

	appendStringField(output, 'id', requirement.id);
	appendStringField(output, 'title', requirement.title);
	appendStringField(output, 'statement', requirement.statement);
	appendUnknownField(output, 'coverage', requirement.coverage);
	appendUnknownField(output, 'trace', requirement.trace);
	appendArrayField(output, 'notes', requirement.notes);

	for (const key of Object.keys(requirement).sort((left, right) => left.localeCompare(right))) {
		if (key in output) {
			continue;
		}

		const value = requirement[key];
		if (value !== undefined) {
			output[key] = canonicalizeUnknownValue(value);
		}
	}

	return output;
}

function canonicalizeUnknownValue(value: unknown): JsonValue {
	if (Array.isArray(value)) {
		return value.map((item) => canonicalizeUnknownValue(item));
	}

	if (isPlainObject(value)) {
		const output: Record<string, JsonValue> = {};

		for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
			output[key] = canonicalizeUnknownValue(value[key]);
		}

		return output;
	}

	return value as JsonValue;
}

function countMeaningfulStrings(value: string[] | undefined): number {
	if (!Array.isArray(value)) {
		return 0;
	}

	return value.filter((item) => typeof item === 'string' && item.trim().length > 0).length;
}

function countMeaningfulCoverage(value: RequirementCoverageExpectation | undefined): number {
	if (!isPlainObject(value)) {
		return 0;
	}

	return ['positive', 'negative', 'edge', 'fuzz']
		.filter((key) => typeof value[key] === 'string' && value[key].trim().length > 0)
		.length;
}

function countMeaningfulTraceReferences(value: RequirementTrace | undefined): number {
	if (!isPlainObject(value)) {
		return 0;
	}

	return [
		value.satisfied_by,
		value.implemented_by,
		value.verified_by,
		value.derived_from,
		value.supersedes,
		value.upstream_refs,
		value.related
	].reduce<number>((total, item) => total + countMeaningfulStrings(item), 0);
}

function appendStringField(target: Record<string, JsonValue>, key: string, value: string | undefined): void {
	if (value !== undefined) {
		target[key] = value;
	}
}

function appendUnknownField(target: Record<string, JsonValue>, key: string, value: unknown): void {
	if (value !== undefined) {
		target[key] = canonicalizeUnknownValue(value);
	}
}

function appendArrayField(
	target: Record<string, JsonValue>,
	key: string,
	value: string[] | undefined,
	options?: {
		required?: boolean;
	}
): void {
	if (!Array.isArray(value)) {
		if (options?.required) {
			target[key] = [];
		}

		return;
	}

	if (value.length === 0 && options?.required !== true) {
		return;
	}

	target[key] = value.map((item) => item);
}

function appendUnknownArrayField(
	target: Record<string, JsonValue>,
	key: string,
	value: unknown[] | undefined,
	options?: {
		required?: boolean;
	}
): void {
	if (!Array.isArray(value)) {
		if (options?.required) {
			target[key] = [];
		}

		return;
	}

	if (value.length === 0 && options?.required !== true) {
		return;
	}

	target[key] = value.map((item) => canonicalizeUnknownValue(item));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
