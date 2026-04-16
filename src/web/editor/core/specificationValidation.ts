import Ajv, { type ErrorObject } from 'ajv';

import canonicalSchema from './spec-trace-model.schema.json';
import {
	isSpecificationPath,
	type SpecificationDocument,
	type ValidationIssue
} from './specification.js';

const duplicateRequirementIdPattern = /^REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{4}$/;
const validateSpecificationArtifact = createSpecificationArtifactValidator();

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
	if (!isPlainObject(value)) {
		return [
			{
				path: '',
				message: 'Specification documents must be JSON objects.'
			}
		];
	}

	const issues = mapSchemaValidationIssues(value);
	appendDuplicateRequirementIdIssues(value, issues);
	return issues;
}

export function isCanonicalSpecificationDocument(value: unknown, workspaceRelativePath: string): boolean {
	return isSpecificationPath(workspaceRelativePath) && validateSpecificationDocument(value).length === 0;
}

function createSpecificationArtifactValidator() {
	const ajv = new Ajv({
		allErrors: true,
		strict: false,
		validateFormats: false
	});

	return ajv.compile({
		$defs: canonicalSchema.$defs,
		$ref: '#/$defs/specificationArtifact'
	});
}

function mapSchemaValidationIssues(value: unknown): ValidationIssue[] {
	if (validateSpecificationArtifact(value)) {
		return [];
	}

	return (validateSpecificationArtifact.errors ?? []).map((error) => ({
		path: formatSchemaValidationPath(error),
		message: formatSchemaValidationMessage(error)
	}));
}

function appendDuplicateRequirementIdIssues(value: Record<string, unknown>, issues: ValidationIssue[]): void {
	if (!Array.isArray(value.requirements)) {
		return;
	}

	const seenRequirementIds = new Map<string, number>();
	value.requirements.forEach((requirement, index) => {
		if (!isPlainObject(requirement)) {
			return;
		}

		const requirementId = typeof requirement.id === 'string' ? requirement.id.trim() : '';
		if (requirementId.length === 0 || !duplicateRequirementIdPattern.test(requirementId)) {
			return;
		}

		const firstIndex = seenRequirementIds.get(requirementId);
		if (firstIndex !== undefined) {
			issues.push({
				path: `requirements[${index}].id`,
				message: `Duplicate requirement id "${requirementId}" also appears at requirements[${firstIndex}].id.`
			});
			return;
		}

		seenRequirementIds.set(requirementId, index);
	});
}

function formatSchemaValidationPath(error: ErrorObject<string, Record<string, unknown>, unknown>): string {
	const basePath = jsonPointerToPath(error.instancePath);
	if (error.keyword === 'required') {
		const missingProperty = typeof error.params.missingProperty === 'string' ? error.params.missingProperty : '';
		return missingProperty.length === 0
			? basePath
			: (basePath.length === 0 ? missingProperty : `${basePath}.${missingProperty}`);
	}

	if (error.keyword === 'additionalProperties') {
		const property = typeof error.params.additionalProperty === 'string' ? error.params.additionalProperty : '';
		return property.length === 0
			? basePath
			: (basePath.length === 0 ? property : `${basePath}.${property}`);
	}

	return basePath;
}

function formatSchemaValidationMessage(error: ErrorObject<string, Record<string, unknown>, unknown>): string {
	if (error.keyword === 'required') {
		return 'Missing required field.';
	}

	if (error.keyword === 'additionalProperties') {
		return 'Property is not allowed by the canonical schema.';
	}

	if (error.keyword === 'type') {
		return `Expected ${String(error.params.type)}.`;
	}

	return error.message ?? 'Schema validation failed.';
}

function jsonPointerToPath(pointer: string): string {
	if (!pointer) {
		return '';
	}

	return pointer
		.split('/')
		.slice(1)
		.map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
		.map((segment, index) => (/^\d+$/.test(segment)
			? `[${segment}]`
			: (index === 0 ? segment : `.${segment}`)))
		.join('');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
