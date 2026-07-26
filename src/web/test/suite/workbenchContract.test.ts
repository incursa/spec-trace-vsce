import * as assert from 'assert';

import contractFixture from '../../../shared/fixtures/workbench-contract.json';
import {
	SPEC_TRACE_ARTIFACT_PREFIXES,
	SPEC_TRACE_LAYOUT,
	SPEC_TRACE_REQUIREMENT_PREFIX,
	WORKBENCH_VALIDATION_CATEGORIES,
	WORKBENCH_VALIDATION_PROFILES
} from '../../../shared/contracts.js';
import { buildWorkbenchArguments, getValidationFindings } from '../../../node/workbench/contracts.js';

suite('Workbench contract parity', () => {
	test('keeps canonical layout, identifiers, profiles, and finding categories aligned with the fixture', () => {
		assert.deepStrictEqual(SPEC_TRACE_LAYOUT, contractFixture.layout);
		assert.deepStrictEqual([...SPEC_TRACE_ARTIFACT_PREFIXES], contractFixture.artifactPrefixes);
		assert.strictEqual(SPEC_TRACE_REQUIREMENT_PREFIX, contractFixture.requirementPrefix);
		assert.deepStrictEqual([...WORKBENCH_VALIDATION_PROFILES], contractFixture.validationProfiles);
		assert.deepStrictEqual([...WORKBENCH_VALIDATION_CATEGORIES], contractFixture.validationCategories);
	});

	test('maps only allowlisted operations to structured JSON CLI arguments', () => {
		assert.deepStrictEqual(
			buildWorkbenchArguments({ operation: 'doctor', repositoryPath: 'C:\\repo' }),
			['--repo', 'C:\\repo', '--format', 'json', 'doctor', '--json']
		);
		assert.deepStrictEqual(
			buildWorkbenchArguments({ operation: 'validate', repositoryPath: 'C:\\repo' }),
			['--repo', 'C:\\repo', '--format', 'json', 'validate']
		);
		assert.deepStrictEqual(
			buildWorkbenchArguments({ operation: 'quality-sync-preview', repositoryPath: 'C:\\repo' }),
			['--repo', 'C:\\repo', '--format', 'json', 'quality', 'sync', '--dry-run']
		);
	});

	test('reads structured Workbench validation findings without accepting arbitrary output', () => {
		const findings = getValidationFindings({
			ok: false,
			data: {
				findings: [{
					profile: 'traceable',
					category: 'unresolved-reference',
					severity: 'error',
					message: 'Unresolved reference.',
					file: 'specs/requirements/example/SPEC-EXAMPLE.json'
				}]
			}
		});

		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0].category, 'unresolved-reference');
		assert.deepStrictEqual(getValidationFindings({ data: { findings: 'not-an-array' } }), []);
	});
});
