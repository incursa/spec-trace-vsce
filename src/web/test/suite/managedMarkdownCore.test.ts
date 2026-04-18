import * as assert from 'assert';

import {
	createManagedMarkdownTemplate,
	normalizeManagedMarkdownDocument,
	parseManagedMarkdownDocument,
	validateManagedMarkdownDocument
} from '../../editor/markdown/core.js';

suite('Managed markdown core', () => {
	test('round-trips canonical architecture markdown with stable front matter and sections', () => {
		const content = createManagedMarkdownTemplate({
			artifactId: 'ARC-PLATFORM-0001',
			artifactType: 'architecture',
			domain: 'platform',
			title: 'Platform Architecture',
			owner: 'platform-maintainers',
			summary: 'Describe the platform architecture.',
			status: 'draft',
			traceReferences: ['REQ-PLATFORM-0001']
		});

		const parsed = normalizeManagedMarkdownDocument(parseManagedMarkdownDocument(content));

		assert.strictEqual(parsed.artifact_id, 'ARC-PLATFORM-0001');
		assert.strictEqual(parsed.artifact_type, 'architecture');
		assert.deepStrictEqual(parsed.satisfies, ['REQ-PLATFORM-0001']);
		assert.ok(parsed.sections.some((section) => section.key === 'purpose'));
		assert.ok(parsed.sections.some((section) => section.key === 'design_summary'));
		assert.deepStrictEqual(validateManagedMarkdownDocument(parsed, 'specs/architecture/platform/ARC-PLATFORM-0001.md'), []);
	});

	test('round-trips canonical work-item markdown with stable front matter and sections', () => {
		const content = createManagedMarkdownTemplate({
			artifactId: 'WI-PLATFORM-0001',
			artifactType: 'work_item',
			domain: 'platform',
			title: 'Platform Work Item',
			owner: 'platform-maintainers',
			summary: 'Implement the platform work item.',
			status: 'planned',
			traceReferences: ['REQ-PLATFORM-0001']
		});

		const parsed = normalizeManagedMarkdownDocument(parseManagedMarkdownDocument(content));

		assert.strictEqual(parsed.artifact_id, 'WI-PLATFORM-0001');
		assert.strictEqual(parsed.artifact_type, 'work_item');
		assert.deepStrictEqual(parsed.addresses, ['REQ-PLATFORM-0001']);
		assert.ok(parsed.sections.some((section) => section.key === 'summary'));
		assert.ok(parsed.sections.some((section) => section.key === 'planned_changes'));
		assert.ok(parsed.sections.some((section) => section.key === 'verification_plan'));
		assert.deepStrictEqual(validateManagedMarkdownDocument(parsed, 'specs/work-items/platform/WI-PLATFORM-0001.md'), []);
	});

	test('round-trips canonical verification markdown with stable front matter and sections', () => {
		const content = createManagedMarkdownTemplate({
			artifactId: 'VER-PLATFORM-0001',
			artifactType: 'verification',
			domain: 'platform',
			title: 'Platform Verification',
			owner: 'platform-maintainers',
			summary: 'Verify the platform work item.',
			status: 'planned',
			traceReferences: ['REQ-PLATFORM-0001']
		});

		const parsed = normalizeManagedMarkdownDocument(parseManagedMarkdownDocument(content));

		assert.strictEqual(parsed.artifact_id, 'VER-PLATFORM-0001');
		assert.strictEqual(parsed.artifact_type, 'verification');
		assert.deepStrictEqual(parsed.verifies, ['REQ-PLATFORM-0001']);
		assert.ok(parsed.sections.some((section) => section.key === 'scope'));
		assert.ok(parsed.sections.some((section) => section.key === 'verification_method'));
		assert.ok(parsed.sections.some((section) => section.key === 'procedure'));
		assert.ok(parsed.sections.some((section) => section.key === 'expected_result'));
		assert.deepStrictEqual(validateManagedMarkdownDocument(parsed, 'specs/verification/platform/VER-PLATFORM-0001.md'), []);
	});
});
