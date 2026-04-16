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

export interface SpecificationRequirement {
	id?: string;
	title?: string;
	statement?: string;
	coverage?: string[];
	trace?: string[];
	notes?: string[];
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
	supplemental_sections?: string[];
	requirements?: SpecificationRequirement[];
	[key: string]: unknown;
}

export const specificationWorkspaceRootSegment = 'specs/requirements';

const requirementIdPattern = /^REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{4}$/;
const normativeWordPattern = /\b(MUST(?: NOT)?|SHALL(?: NOT)?|SHOULD(?: NOT)?|MAY(?: NOT)?)\b/;

export function normalizeWorkspaceRelativePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function isSpecificationPath(workspaceRelativePath: string): boolean {
	const normalized = normalizeWorkspaceRelativePath(workspaceRelativePath).toLowerCase();
	return normalized.startsWith(`${specificationWorkspaceRootSegment}/`) && normalized.endsWith('.json');
}

export function parseSpecificationDocument(text: string): {
	document: SpecificationDocument | undefined;
	issues: ValidationIssue[];
} {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			document: undefined,
			issues: [
				{
					path: '',
					message: error instanceof Error ? error.message : 'Invalid JSON.'
				}
			]
		};
	}

	if (!isPlainObject(parsed)) {
		return {
			document: undefined,
			issues: [
				{
					path: '',
					message: 'Specification documents must be JSON objects.'
				}
			]
		};
	}

	return {
		document: parsed as SpecificationDocument,
		issues: validateSpecificationDocument(parsed)
	};
}

export function validateSpecificationDocument(value: unknown): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	if (!isPlainObject(value)) {
		issues.push({
			path: '',
			message: 'Specification documents must be JSON objects.'
		});
		return issues;
	}

	validateStringField(value.artifact_id, 'artifact_id', issues);
	validateStringField(value.artifact_type, 'artifact_type', issues);
	validateStringField(value.title, 'title', issues);
	validateStringField(value.domain, 'domain', issues);
	validateStringField(value.capability, 'capability', issues);
	validateStringField(value.status, 'status', issues);
	validateStringField(value.owner, 'owner', issues);
	validateStringField(value.purpose, 'purpose', issues);
	validateStringField(value.scope, 'scope', issues);
	validateStringField(value.context, 'context', issues);
	validateStringArrayField(value.tags, 'tags', issues);
	validateStringArrayField(value.related_artifacts, 'related_artifacts', issues, false);
	validateStringArrayField(value.open_questions, 'open_questions', issues, false);
	validateStringArrayField(value.supplemental_sections, 'supplemental_sections', issues, false);

	if (typeof value.artifact_type === 'string' && value.artifact_type.trim() !== 'specification') {
		issues.push({
			path: 'artifact_type',
			message: 'artifact_type must be "specification".'
		});
	}

	if (typeof value.title === 'string' && value.title.trim().length === 0) {
		issues.push({
			path: 'title',
			message: 'title cannot be empty.'
		});
	}

	if (typeof value.domain === 'string' && value.domain.trim().length === 0) {
		issues.push({
			path: 'domain',
			message: 'domain cannot be empty.'
		});
	}

	if (typeof value.capability === 'string' && value.capability.trim().length === 0) {
		issues.push({
			path: 'capability',
			message: 'capability cannot be empty.'
		});
	}

	if (typeof value.status === 'string' && value.status.trim().length === 0) {
		issues.push({
			path: 'status',
			message: 'status cannot be empty.'
		});
	}

	if (typeof value.owner === 'string' && value.owner.trim().length === 0) {
		issues.push({
			path: 'owner',
			message: 'owner cannot be empty.'
		});
	}

	if (typeof value.purpose === 'string' && value.purpose.trim().length === 0) {
		issues.push({
			path: 'purpose',
			message: 'purpose cannot be empty.'
		});
	}

	if (typeof value.scope === 'string' && value.scope.trim().length === 0) {
		issues.push({
			path: 'scope',
			message: 'scope cannot be empty.'
		});
	}

	if (typeof value.context === 'string' && value.context.trim().length === 0) {
		issues.push({
			path: 'context',
			message: 'context cannot be empty.'
		});
	}

	if (Array.isArray(value.requirements)) {
		const seenRequirementIds = new Map<string, number>();

		value.requirements.forEach((requirement, index) => {
			const requirementPath = `requirements[${index}]`;

			if (!isPlainObject(requirement)) {
				issues.push({
					path: requirementPath,
					message: 'Each requirement must be a JSON object.'
				});
				return;
			}

			validateStringField(requirement.id, `${requirementPath}.id`, issues);
			validateStringField(requirement.title, `${requirementPath}.title`, issues);
			validateStringField(requirement.statement, `${requirementPath}.statement`, issues);
			validateStringArrayField(requirement.coverage, `${requirementPath}.coverage`, issues, false);
			validateStringArrayField(requirement.trace, `${requirementPath}.trace`, issues, false);
			validateStringArrayField(requirement.notes, `${requirementPath}.notes`, issues, false);

			const requirementId = typeof requirement.id === 'string' ? requirement.id.trim() : '';
			if (requirementId.length > 0) {
				const firstIndex = seenRequirementIds.get(requirementId);
				if (firstIndex !== undefined) {
					issues.push({
						path: `${requirementPath}.id`,
						message: `Duplicate requirement id "${requirementId}" also appears at requirements[${firstIndex}].id.`
					});
				} else {
					seenRequirementIds.set(requirementId, index);
				}

				if (!requirementIdPattern.test(requirementId)) {
					issues.push({
						path: `${requirementPath}.id`,
						message: 'Requirement ids should use the REQ-...-0001 pattern.'
					});
				}
			}

			const requirementStatement = typeof requirement.statement === 'string' ? requirement.statement.trim() : '';
			if (requirementStatement.length > 0 && !normativeWordPattern.test(requirementStatement)) {
				issues.push({
					path: `${requirementPath}.statement`,
					message: 'Requirement statements should include a normative verb such as MUST, SHOULD, MAY, or SHALL.'
				});
			}
		});

		if (value.requirements.length === 0) {
			issues.push({
				path: 'requirements',
				message: 'Specification documents should contain at least one requirement.'
			});
		}
	} else if (value.requirements === undefined || value.requirements === null) {
		issues.push({
			path: 'requirements',
			message: 'Missing required field.'
		});
	} else {
		issues.push({
			path: 'requirements',
			message: 'requirements must be an array.'
		});
	}

	return issues;
}

export function isCanonicalSpecificationDocument(value: unknown, workspaceRelativePath: string): boolean {
	return isSpecificationPath(workspaceRelativePath) && validateSpecificationDocument(value).length === 0;
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
	appendArrayField(output, 'tags', document.tags, { required: true });
	appendArrayField(output, 'related_artifacts', document.related_artifacts);
	appendArrayField(output, 'open_questions', document.open_questions);
	appendArrayField(output, 'supplemental_sections', document.supplemental_sections);

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
		statement: '',
		coverage: [],
		trace: [],
		notes: []
	};
}

export function cloneSpecificationDocument<T extends SpecificationDocument | SpecificationRequirement>(document: T): T {
	return JSON.parse(JSON.stringify(document)) as T;
}

export function summarizeRequirementCoverage(requirement: SpecificationRequirement): RequirementCoverageSummary {
	const coverageCount = countMeaningfulStrings(requirement.coverage);
	const traceCount = countMeaningfulStrings(requirement.trace);
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
	appendArrayField(output, 'coverage', requirement.coverage);
	appendArrayField(output, 'trace', requirement.trace);
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

function appendStringField(target: Record<string, JsonValue>, key: string, value: string | undefined): void {
	if (value !== undefined) {
		target[key] = value;
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

function validateStringField(value: unknown, path: string, issues: ValidationIssue[]): void {
	if (value === undefined || value === null) {
		issues.push({
			path,
			message: 'Missing required field.'
		});
		return;
	}

	if (typeof value !== 'string') {
		issues.push({
			path,
			message: 'Expected a string.'
		});
	}
}

function validateStringArrayField(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
	required = true
): void {
	if (value === undefined || value === null) {
		if (required) {
			issues.push({
				path,
				message: 'Missing required field.'
			});
		}

		return;
	}

	if (!Array.isArray(value)) {
		issues.push({
			path,
			message: 'Expected an array.'
		});
		return;
	}

	value.forEach((item, index) => {
		if (typeof item !== 'string') {
			issues.push({
				path: `${path}[${index}]`,
				message: 'Expected a string.'
			});
			return;
		}

		if (item.trim().length === 0) {
			issues.push({
				path: `${path}[${index}]`,
				message: 'Items cannot be empty.'
			});
		}
	});
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
