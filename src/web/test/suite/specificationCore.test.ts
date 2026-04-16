import * as assert from 'assert';

import {
	isSpecificationPath,
	serializeSpecificationDocument,
	SpecificationDocument,
	summarizeRequirementCoverage,
	summarizeSpecificationCoverage
} from '../../editor/core/specification.js';
import {
	isCanonicalSpecificationDocument,
	parseSpecificationDocument,
	validateSpecificationDocument
} from '../../editor/core/specificationValidation.js';

suite('Specification core', () => {
	test('recognizes canonical specification paths', () => {
		assert.strictEqual(isSpecificationPath('specs/requirements/spec-trace-vsce/SPEC-VSCE-EDITOR.json'), true);
		assert.strictEqual(isSpecificationPath('specs/architecture/WB/ARC-ROOT.json'), false);
		assert.strictEqual(isSpecificationPath('notes/spec-trace.json'), false);
	});

	test('parses and validates a canonical specification document', () => {
		const text = JSON.stringify(
			{
				artifact_id: 'SPEC-VSCE-EDITOR',
				artifact_type: 'specification',
				title: 'Spec Trace Spec File Custom Editor',
				domain: 'spec-trace-vsce',
				capability: 'spec-file-editor',
				status: 'draft',
				owner: 'spec-trace-vsce-maintainers',
				purpose: 'Define the browser-safe custom editor for canonical Spec Trace specification files.',
				scope: 'This specification covers opening, viewing, editing, validating, and saving canonical specification JSON files in a VS Code web extension.',
				context: 'The first extension deliverable should let authors edit existing specification files directly in browser-hosted VS Code.',
				tags: ['spec-trace', 'vsce', 'web-extension', 'custom-editor'],
				requirements: [
					{
						id: 'REQ-VSCE-EDITOR-0001',
						title: 'Run in the web extension host',
						statement: 'The extension MUST run in the VS Code web extension host.',
						coverage: {
							positive: 'required',
							negative: 'optional',
							edge: 'required',
							fuzz: 'deferred'
						},
						trace: {
							related: ['SPEC-VSCE-EDITOR']
						},
						notes: ['Seed note']
					}
				]
			},
			undefined,
			2
		);

		const parsed = parseSpecificationDocument(text);
		assert.ok(parsed.document);
		assert.deepStrictEqual(parsed.issues, []);
		assert.strictEqual(isCanonicalSpecificationDocument(parsed.document, 'specs/requirements/spec-trace-vsce/SPEC-VSCE-EDITOR.json'), true);
	});

	test('accepts structured supplemental sections and preserves them on serialization', () => {
		const document: SpecificationDocument = {
			artifact_id: 'SPEC-VSCE-EDITOR',
			artifact_type: 'specification',
			title: 'Spec Trace Spec File Custom Editor',
			domain: 'spec-trace-vsce',
			capability: 'spec-file-editor',
			status: 'draft',
			owner: 'spec-trace-vsce-maintainers',
			purpose: 'Define the browser-safe custom editor for canonical Spec Trace specification files.',
			scope: 'This specification covers opening, viewing, editing, validating, and saving canonical specification JSON files in a VS Code web extension.',
			context: 'The first extension deliverable should let authors edit existing specification files directly in browser-hosted VS Code.',
			tags: ['spec-trace'],
			supplemental_sections: [
				{
					heading: 'Decision Summary',
					content: 'Pipeline outside, reducer inside.',
					x_origin: 'imported'
				}
			],
			requirements: [
				{
					id: 'REQ-VSCE-EDITOR-0001',
					title: 'Run in the web extension host',
					statement: 'The extension MUST run in the VS Code web extension host.',
					coverage: {
						positive: 'required',
						negative: 'optional',
						edge: 'required',
						fuzz: 'deferred'
					},
					trace: {
						related: ['SPEC-VSCE-EDITOR']
					},
					notes: ['Seed note']
				}
			]
		};

		const issues = validateSpecificationDocument(document);
		assert.deepStrictEqual(issues, []);

		const payload = JSON.parse(serializeSpecificationDocument(document)) as {
			supplemental_sections: Array<{ heading: string; content: string; x_origin: string }>;
		};

		assert.deepStrictEqual(payload.supplemental_sections, [
			{
				content: 'Pipeline outside, reducer inside.',
				heading: 'Decision Summary',
				x_origin: 'imported'
			}
		]);
	});

	test('serializes deterministically and preserves extension fields', () => {
		const serialized = serializeSpecificationDocument({
			artifact_id: 'SPEC-VSCE-EDITOR',
			artifact_type: 'specification',
			title: 'Spec Trace Spec File Custom Editor',
			domain: 'spec-trace-vsce',
			capability: 'spec-file-editor',
			status: 'draft',
			owner: 'spec-trace-vsce-maintainers',
			purpose: 'Define the browser-safe custom editor for canonical Spec Trace specification files.',
			scope: 'This specification covers opening, viewing, editing, validating, and saving canonical specification JSON files in a VS Code web extension.',
			context: 'The first extension deliverable should let authors edit existing specification files directly in browser-hosted VS Code.',
			tags: ['spec-trace', 'vsce'],
			requirements: [
				{
					id: 'REQ-VSCE-EDITOR-0001',
					title: 'Run in the web extension host',
					statement: 'The extension MUST run in the VS Code web extension host.',
					coverage: {
						positive: 'required',
						negative: 'optional',
						edge: 'required',
						fuzz: 'deferred'
					},
					trace: {
						related: ['SPEC-VSCE-EDITOR']
					},
					notes: [],
					x_reviewed: true
				}
			],
			x_custom: {
				enabled: true,
				sequence: [2, 1]
			}
		});

		const payload = JSON.parse(serialized) as {
			x_custom: { enabled: boolean; sequence: number[] };
			requirements: Array<{ x_reviewed: boolean }>;
		};

		assert.strictEqual(serialized.startsWith('{\n  "artifact_id"'), true);
		assert.ok(serialized.indexOf('"requirements"') > serialized.indexOf('"context"'));
		assert.ok(serialized.indexOf('"x_custom"') > serialized.indexOf('"requirements"'));
		assert.ok(!serialized.includes('"related_artifacts"'));
		assert.deepStrictEqual(payload.x_custom, { enabled: true, sequence: [2, 1] });
		assert.strictEqual(payload.requirements[0].x_reviewed, true);
	});

	test('summarizes requirement coverage with trimmed string semantics', () => {
		assert.deepStrictEqual(
			summarizeRequirementCoverage({
				coverage: {
					positive: 'required',
					negative: 'optional',
					edge: 'required',
					fuzz: 'deferred'
				},
				trace: {
					related: ['  ']
				},
				notes: [''],
			}),
			{
				status: 'covered',
				coverageCount: 4,
				traceCount: 0,
				notesCount: 0
			}
		);

		assert.deepStrictEqual(
			summarizeRequirementCoverage({
				trace: {
					related: ['trace evidence']
				},
				notes: ['  note evidence  '],
			}),
			{
				status: 'partial',
				coverageCount: 0,
				traceCount: 1,
				notesCount: 1
			}
		);

		assert.deepStrictEqual(
			summarizeRequirementCoverage({
				notes: [],
			}),
			{
				status: 'missing',
				coverageCount: 0,
				traceCount: 0,
				notesCount: 0
			}
		);
	});

	test('summarizes specification coverage across requirement states', () => {
		const summary = summarizeSpecificationCoverage({
			requirements: [
				{
					coverage: {
						positive: 'required',
						negative: 'optional',
						edge: 'required',
						fuzz: 'deferred'
					},
					notes: []
				},
				{
					trace: {
						related: ['trace evidence']
					},
					notes: []
				},
				{
					notes: []
				},
				{
					trace: {
						related: ['   ']
					},
					notes: ['note evidence']
				}
			]
		});

		assert.deepStrictEqual(summary, {
			totalRequirements: 4,
			coveredCount: 1,
			partialCount: 2,
			missingCount: 1,
			requirementSummaries: [
				{ status: 'covered', coverageCount: 4, traceCount: 0, notesCount: 0 },
				{ status: 'partial', coverageCount: 0, traceCount: 1, notesCount: 0 },
				{ status: 'missing', coverageCount: 0, traceCount: 0, notesCount: 0 },
				{ status: 'partial', coverageCount: 0, traceCount: 0, notesCount: 1 }
			]
		});
	});

	test('reports duplicate ids and invalid requirement grammar', () => {
		const issues = validateSpecificationDocument({
			artifact_id: 'SPEC-VSCE-EDITOR',
			artifact_type: 'specification',
			title: 'Spec Trace Spec File Custom Editor',
			domain: 'spec-trace-vsce',
			capability: 'spec-file-editor',
			status: 'draft',
			owner: 'spec-trace-vsce-maintainers',
			purpose: 'Define the browser-safe custom editor for canonical Spec Trace specification files.',
			scope: 'This specification covers opening, viewing, editing, validating, and saving canonical specification JSON files in a VS Code web extension.',
			context: 'The first extension deliverable should let authors edit existing specification files directly in browser-hosted VS Code.',
			tags: ['spec-trace'],
			requirements: [
				{
					id: 'REQ-VSCE-EDITOR-0001',
					title: 'Run in the web extension host',
					statement: 'The extension must run in the VS Code web extension host.',
					coverage: {
						positive: 'required',
						negative: 'optional',
						edge: 'required',
						fuzz: 'deferred'
					},
					trace: {
						related: ['SPEC-VSCE-EDITOR']
					},
					notes: []
				},
				{
					id: 'REQ-VSCE-EDITOR-0001',
					title: 'Register a structured custom editor',
					statement: 'The extension MUST register a structured custom editor.',
					coverage: {
						positive: 'required',
						negative: 'optional',
						edge: 'required',
						fuzz: 'deferred'
					},
					trace: {
						related: ['SPEC-VSCE-EDITOR']
					},
					notes: []
				}
			]
		});

		assert.ok(issues.some((issue) => issue.path === 'requirements[0].statement'));
		assert.ok(issues.some((issue) => issue.path === 'requirements[1].id' && issue.message.includes('Duplicate requirement id')));
	});

	test('accepts structured requirement coverage and trace shapes', () => {
		const issues = validateSpecificationDocument({
			artifact_id: 'SPEC-VSCE-EDITOR',
			artifact_type: 'specification',
			title: 'Spec Trace Spec File Custom Editor',
			domain: 'spec-trace-vsce',
			capability: 'spec-file-editor',
			status: 'draft',
			owner: 'spec-trace-vsce-maintainers',
			purpose: 'Define the browser-safe custom editor for canonical Spec Trace specification files.',
			scope: 'This specification covers opening, viewing, editing, validating, and saving canonical specification JSON files in a VS Code web extension.',
			context: 'The first extension deliverable should let authors edit existing specification files directly in browser-hosted VS Code.',
			tags: ['spec-trace'],
			requirements: [
				{
					id: 'REQ-VSCE-EDITOR-0001',
					title: 'Run in the web extension host',
					statement: 'The extension MUST run in the VS Code web extension host.',
					coverage: {
						positive: 'required',
						negative: 'optional',
						edge: 'required',
						fuzz: 'deferred'
					},
					trace: {
						satisfied_by: ['ARC-WB-0001'],
						implemented_by: ['WI-WB-0001'],
						verified_by: ['VER-WB-0001'],
						derived_from: ['REQ-VSCE-EDITOR-0002'],
						supersedes: ['REQ-VSCE-EDITOR-0003'],
						upstream_refs: ['RFC-EXAMPLE'],
						related: ['SPEC-VSCE-EDITOR']
					},
					notes: ['Round-trip structured shapes.']
				}
			]
		});

		assert.deepStrictEqual(issues, []);
	});

	test('allows optional top-level specification fields to be omitted', () => {
		const issues = validateSpecificationDocument({
			artifact_id: 'SPEC-VSCE-EDITOR',
			artifact_type: 'specification',
			title: 'Spec Trace Spec File Custom Editor',
			domain: 'spec-trace-vsce',
			capability: 'spec-file-editor',
			status: 'draft',
			owner: 'spec-trace-vsce-maintainers',
			purpose: 'Define the browser-safe custom editor for canonical Spec Trace specification files.',
			requirements: [
				{
					id: 'REQ-VSCE-EDITOR-0001',
					title: 'Run in the web extension host',
					statement: 'The extension MUST run in the VS Code web extension host.'
				}
			]
		});

		assert.deepStrictEqual(issues, []);
	});
});
