import * as assert from 'assert';

import {
	createBootstrapPlan,
	detectRepositoryState,
	getScaffoldDirectories,
	getScaffoldFiles,
	renderArtifact
} from '../../management/core.js';

suite('Repository management core', () => {
	test('detects missing, partial, and ready repository scaffold states', () => {
		assert.strictEqual(detectRepositoryState([]), 'missing');
		assert.strictEqual(detectRepositoryState(['specs', 'specs/requirements']), 'partial');

		const readyPaths = [
			...getScaffoldDirectories(),
			...getScaffoldFiles().map((file) => file.path)
		];
		assert.strictEqual(detectRepositoryState(readyPaths), 'ready');
	});

	test('builds a bootstrap plan for an empty repository', () => {
		const plan = createBootstrapPlan([]);

		assert.strictEqual(plan.state, 'missing');
		assert.ok(plan.missingDirectories.includes('specs/requirements'));
		assert.ok(plan.missingDirectories.includes('.workbench'));
		assert.ok(plan.missingFiles.some((file) => file.path === '.workbench/config.json'));
		assert.ok(plan.missingFiles.some((file) => file.path === 'specs/requirements/_index.md'));
		assert.ok(plan.missingFiles.some((file) => file.path === 'specs/requirements/getting-started/_index.md'));
		assert.ok(plan.missingFiles.some((file) => file.path === 'specs/requirements/getting-started/SPEC-GETTING-STARTED.json'));
	});

	test('omits existing scaffold paths from the bootstrap plan', () => {
		const existingPaths = [
			'.workbench',
			'.workbench/config.json',
			'specs',
			'specs/requirements',
			'specs/requirements/_index.md'
		];
		const plan = createBootstrapPlan(existingPaths);

		assert.strictEqual(plan.state, 'partial');
		assert.ok(!plan.missingDirectories.includes('.workbench'));
		assert.ok(!plan.missingFiles.some((file) => file.path === '.workbench/config.json'));
		assert.ok(!plan.missingFiles.some((file) => file.path === 'specs/requirements/_index.md'));
		assert.ok(!plan.missingFiles.some((file) => file.path === 'specs/requirements/getting-started/SPEC-GETTING-STARTED.json'));
	});

	test('renders a deterministic starter specification artifact', () => {
		const rendered = renderArtifact({
			kind: 'specification',
			domain: 'Payments Platform',
			title: 'Bootstrap Management',
			capability: 'bootstrap-management'
		});

		assert.strictEqual(rendered.artifactId, 'SPEC-BOOTSTRAP-MANAGEMENT');
		assert.strictEqual(rendered.relativePath, 'specs/requirements/payments-platform/SPEC-BOOTSTRAP-MANAGEMENT.json');
		assert.strictEqual(rendered.domainIndexPath, 'specs/requirements/payments-platform/_index.md');

		const payload = JSON.parse(rendered.content) as {
			artifact_id: string;
			capability: string;
			requirements: Array<{ id: string; statement: string }>;
		};

		assert.strictEqual(payload.artifact_id, 'SPEC-BOOTSTRAP-MANAGEMENT');
		assert.strictEqual(payload.capability, 'bootstrap-management');
		assert.strictEqual(payload.requirements[0].id, 'REQ-BOOTSTRAP-MANAGEMENT-0001');
		assert.ok(payload.requirements[0].statement.includes('MUST'));
	});

	test('renders trace-aware markdown artifacts and domain indexes', () => {
		const rendered = renderArtifact({
			kind: 'verification',
			domain: 'spec-trace-vsce',
			title: 'Bootstrap First Flow',
			traceLinks: ['REQ-VSCE-MANAGEMENT-0001', 'REQ-VSCE-MANAGEMENT-0002']
		});

		assert.strictEqual(rendered.artifactId, 'VER-BOOTSTRAP-FIRST-FLOW');
		assert.strictEqual(rendered.relativePath, 'specs/verification/spec-trace-vsce/VER-BOOTSTRAP-FIRST-FLOW.md');
		assert.ok(rendered.content.includes('artifact_id: VER-BOOTSTRAP-FIRST-FLOW'));
		assert.ok(rendered.content.includes('artifact_type: verification'));
		assert.ok(rendered.content.includes('verifies:'));
		assert.ok(rendered.content.includes('REQ-VSCE-MANAGEMENT-0001'));
		assert.ok(rendered.content.includes('REQ-VSCE-MANAGEMENT-0002'));
		assert.ok(rendered.domainIndexContent.includes('spec-trace-vsce'));
	});

	test('bootstrapped starter specification is minimal valid canonical JSON', () => {
		const plan = createBootstrapPlan([]);
		const starterSpec = plan.missingFiles.find((file) => file.path === 'specs/requirements/getting-started/SPEC-GETTING-STARTED.json');

		assert.ok(starterSpec, 'Expected bootstrap to include a starter specification.');
		const payload = JSON.parse(starterSpec!.content) as {
			artifact_id: string;
			domain: string;
			capability: string;
			requirements: Array<{ id: string; statement: string }>;
		};

		assert.strictEqual(payload.artifact_id, 'SPEC-GETTING-STARTED');
		assert.strictEqual(payload.domain, 'getting-started');
		assert.strictEqual(payload.capability, 'getting-started');
		assert.strictEqual(payload.requirements[0].id, 'REQ-GETTING-STARTED-0001');
		assert.ok(payload.requirements[0].statement.includes('MUST'));
	});
});
