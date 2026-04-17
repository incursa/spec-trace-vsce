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
});
