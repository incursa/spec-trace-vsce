import * as assert from 'assert';

import { analyzeTraceability } from '../../traceability/core.js';

suite('Portable traceability core', () => {
	test('derives resolved links, backlinks, missing proof, duplicates, and provenance', () => {
		const snapshot = analyzeTraceability([
			{
				path: 'specs/requirements/payments/SPEC-PAYMENTS.json',
				text: JSON.stringify({
					artifact_id: 'SPEC-PAYMENTS',
					artifact_type: 'specification',
					source_references: ['docs/payment-policy.md'],
					requirements: [
						{
							id: 'REQ-PAYMENTS-0001',
							trace: {
								satisfied_by: ['ARC-PAYMENTS'],
								verified_by: ['VER-PAYMENTS']
							}
						},
						{
							id: 'REQ-PAYMENTS-0002',
							trace: {
								implemented_by: ['WI-MISSING']
							}
						}
					]
				})
			},
			{
				path: 'specs/architecture/payments/ARC-PAYMENTS.md',
				text: managedMarkdown('ARC-PAYMENTS', 'architecture', 'satisfies', ['REQ-PAYMENTS-0001'])
			},
			{
				path: 'specs/verification/payments/VER-PAYMENTS.md',
				text: managedMarkdown('VER-PAYMENTS', 'verification', 'verifies', ['REQ-PAYMENTS-0001'])
			},
			{
				path: 'specs/work-items/payments/WI-DUPLICATE.md',
				text: managedMarkdown('ARC-PAYMENTS', 'work_item', 'addresses', ['REQ-PAYMENTS-0001'])
			}
		]);

		assert.strictEqual(snapshot.artifacts, 4);
		assert.strictEqual(snapshot.requirements, 2);
		assert.ok(snapshot.references.some((reference) => reference.targetId === 'VER-PAYMENTS' && reference.resolved));
		assert.ok(snapshot.backlinks.some((backlink) => backlink.targetId === 'REQ-PAYMENTS-0001' && backlink.sourceId === 'VER-PAYMENTS'));
		assert.ok(snapshot.findings.some((finding) => finding.category === 'duplicate-id' && finding.itemId === 'ARC-PAYMENTS'));
		assert.ok(snapshot.findings.some((finding) => finding.category === 'unresolved-reference' && finding.targetId === 'WI-MISSING'));
		assert.ok(snapshot.findings.some((finding) => finding.category === 'verification-missing' && finding.itemId === 'REQ-PAYMENTS-0002'));
		assert.ok(!snapshot.findings.some((finding) => finding.category === 'verification-missing' && finding.itemId === 'REQ-PAYMENTS-0001'));
		assert.deepStrictEqual(snapshot.provenance.find((entry) => entry.artifactId === 'SPEC-PAYMENTS')?.references, ['docs/payment-policy.md']);
	});

	test('turns malformed canonical JSON into a bounded schema finding', () => {
		const snapshot = analyzeTraceability([{
			path: 'specs/requirements/example/SPEC-EXAMPLE.json',
			text: '{ invalid'
		}]);

		assert.strictEqual(snapshot.artifacts, 0);
		assert.strictEqual(snapshot.findings.length, 1);
		assert.strictEqual(snapshot.findings[0].category, 'schema');
		assert.strictEqual(snapshot.findings[0].path, 'specs/requirements/example/SPEC-EXAMPLE.json');
	});
});

function managedMarkdown(artifactId: string, artifactType: string, traceField: string, references: readonly string[]): string {
	return [
		'---',
		`artifact_id: ${artifactId}`,
		`artifact_type: ${artifactType}`,
		`title: ${artifactId}`,
		'domain: payments',
		'status: planned',
		'owner: payments-maintainers',
		`${traceField}:`,
		...references.map((reference) => `  - ${reference}`),
		'---',
		'## Summary',
		'',
		'Fixture.',
		''
	].join('\n');
}
