export const SPEC_TRACE_LAYOUT = {
	requirements: 'specs/requirements',
	architecture: 'specs/architecture',
	workItems: 'specs/work-items',
	verification: 'specs/verification',
	workbenchConfig: '.workbench/config.json'
} as const;

export const SPEC_TRACE_ARTIFACT_PREFIXES = ['SPEC-', 'ARC-', 'WI-', 'VER-'] as const;
export const SPEC_TRACE_REQUIREMENT_PREFIX = 'REQ-';

export const WORKBENCH_VALIDATION_PROFILES = ['core', 'traceable', 'auditable'] as const;
export const WORKBENCH_VALIDATION_CATEGORIES = [
	'profile',
	'schema',
	'keyword',
	'placement',
	'identifier',
	'duplicate-id',
	'unresolved-reference',
	'downstream-missing',
	'verification-missing',
	'reciprocal-mismatch',
	'orphan-artifact',
	'body-mismatch',
	'scope',
	'repo-state'
] as const;

export type WorkbenchValidationCategory = typeof WORKBENCH_VALIDATION_CATEGORIES[number];
