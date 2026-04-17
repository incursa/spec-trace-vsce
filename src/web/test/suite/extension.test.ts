import * as assert from 'assert';

import * as vscode from 'vscode';

suite('Web Extension Test Suite', () => {
	test('registers repository management commands', async () => {
		const extension = vscode.extensions.getExtension('incursa.spec-trace-vsce');
		await extension?.activate();

		const commands = await vscode.commands.getCommands(true);

		assert.ok(commands.includes('spec-trace-vsce.initializeRepository'));
		assert.ok(commands.includes('spec-trace-vsce.createArtifact'));
		assert.ok(commands.includes('spec-trace-vsce.openRepositoryExplorer'));
		assert.ok(commands.includes('spec-trace-vsce.openQualityView'));
	});
});
