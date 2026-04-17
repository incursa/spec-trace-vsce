import * as assert from 'assert';

import * as vscode from 'vscode';

import { serializeSpecificationDocument } from '../../editor/core/specification.js';
import { createManagedMarkdownTemplate } from '../../editor/markdown/core.js';
import {
	analyzeQualityArtifactSource,
	buildLocalReferenceIndex,
	type CanonicalArtifactSource,
	type LocalReferenceIndex,
	type LocalReferenceTarget,
	type QualityArtifactSource
} from '../../quality/core.js';

suite('Quality core', () => {
	test('analyzes a quality report and resolves local references', () => {
		const specSource = canonicalSource(
			'specs/requirements/quality/SPEC-QUALITY-0001.json',
			serializeSpecificationDocument({
				artifact_id: 'SPEC-QUALITY-0001',
				artifact_type: 'specification',
				title: 'Quality Baseline',
				domain: 'quality',
				capability: 'quality-baseline',
				status: 'draft',
				owner: 'quality-maintainers',
				purpose: 'Define the quality baseline.',
				scope: 'Define the quality baseline.',
				context: 'Test fixture.',
				tags: ['spec-trace', 'quality'],
				related_artifacts: ['ARC-QUALITY-0001'],
				open_questions: [],
				supplemental_sections: [],
				requirements: [
					{
						id: 'REQ-QUALITY-0001',
						title: 'Maintain quality posture',
						statement: 'The system MUST maintain a local quality posture.',
						notes: []
					}
				]
			})
		);
		const architectureSource = canonicalSource(
			'specs/architecture/quality/ARC-QUALITY-0001.md',
			createManagedMarkdownTemplate({
				artifactId: 'ARC-QUALITY-0001',
				artifactType: 'architecture',
				domain: 'quality',
				title: 'Quality Architecture',
				owner: 'quality-maintainers',
				summary: 'Architecture for the quality lane.',
				status: 'draft',
				traceReferences: ['REQ-QUALITY-0001']
			})
		);
		const referenceIndex = buildLocalReferenceIndex([specSource, architectureSource]);

		const snapshot = analyzeQualityArtifactSource(
			qualitySource(
				'artifacts/quality/nightly/quality-report.json',
				JSON.stringify({
					title: 'Nightly Quality Snapshot',
					status: 'warning',
					test_result: 'passed',
					coverage: 'partial',
					findings: ['Latency regression noted.'],
					critical_files: ['specs/requirements/quality/SPEC-QUALITY-0001.json'],
					tests: ['vitest integration suite'],
					attestations: ['attestation-summary'],
					related_artifacts: ['SPEC-QUALITY-0001', 'ARC-QUALITY-0001', 'REQ-QUALITY-0001']
				})
			),
			referenceIndex
		);

		assert.strictEqual(snapshot.label, 'Nightly Quality Snapshot');
		assert.strictEqual(snapshot.status, 'warning');
		assert.strictEqual(snapshot.testResult, 'passed');
		assert.strictEqual(snapshot.coverage, 'partial');
		assert.ok(snapshot.findings.some((entry) => entry.includes('Latency regression noted')));
		assert.ok(snapshot.references.some((reference) => reference.value === 'SPEC-QUALITY-0001' && reference.resolved));
		assert.ok(snapshot.references.some((reference) => reference.value === 'ARC-QUALITY-0001' && reference.resolved));
		assert.ok(snapshot.references.some((reference) => reference.value === 'REQ-QUALITY-0001' && reference.resolved));
	});

	test('reports malformed quality artifacts as errors', () => {
		const snapshot = analyzeQualityArtifactSource(
			qualitySource('artifacts/quality/nightly/broken-report.json', '{'),
			emptyReferenceIndex()
		);

		assert.strictEqual(snapshot.health, 'error');
		assert.ok(snapshot.healthMessage.length > 0);
	});
});

function canonicalSource(relativePath: string, text: string): CanonicalArtifactSource {
	return {
		uri: vscode.Uri.parse(`memfs:/${relativePath}`),
		relativePath,
		text
	};
}

function qualitySource(relativePath: string, text: string): QualityArtifactSource {
	return {
		uri: vscode.Uri.parse(`memfs:/${relativePath}`),
		relativePath,
		text
	};
}

function emptyReferenceIndex() {
	return {
		artifactTargets: new Map<string, LocalReferenceTarget>(),
		requirementTargets: new Map<string, LocalReferenceTarget>(),
		pathTargets: new Map<string, LocalReferenceTarget>()
	} satisfies LocalReferenceIndex;
}
