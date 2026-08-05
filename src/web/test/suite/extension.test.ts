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
		assert.ok(commands.includes('spec-trace-vsce.planRepositoryRepair'));
		assert.ok(commands.includes('spec-trace-vsce.validateRepository'));

		const manifest = extension?.packageJSON as {
			main?: string;
			browser?: string;
			contributes?: {
				commands?: Array<{ title?: string; category?: string }>;
				menus?: {
					commandPalette?: Array<{ command?: string; when?: string }>;
				};
			};
		};
		const specTraceCommands = manifest.contributes?.commands?.filter((entry) => entry.category === 'SpecTrace') ?? [];
		assert.ok(specTraceCommands.length > 0);
		assert.ok(specTraceCommands.every((entry) => !entry.title?.startsWith('SpecTrace:')), 'Command titles must not duplicate their category.');
		assert.strictEqual(manifest.browser, './dist/web/extension.js');
		assert.strictEqual(manifest.main, './dist/node/extension.cjs');
		const desktopMenuEntries = manifest.contributes?.menus?.commandPalette?.filter((entry) => entry.command?.startsWith('spec-trace-vsce.workbench')) ?? [];
		assert.ok(desktopMenuEntries.length > 0);
		assert.ok(desktopMenuEntries.every((entry) => entry.when === '!isWeb'), 'Desktop commands must be hidden from the web command palette.');
	});
});
