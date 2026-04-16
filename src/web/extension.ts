import * as vscode from 'vscode';

import { SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE, SpecificationCustomEditorProvider } from './editor/host/specificationCustomEditor.js';
import { registerSpecTraceExplorer } from './navigation/specTraceExplorer.js';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new SpecificationCustomEditorProvider(context);
	const openSmokeFixture = vscode.commands.registerCommand('spec-trace-vsce.openSmokeFixture', async () => {
		console.log('[spec-trace-vsce] openSmokeFixture command invoked');
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			throw new Error('No workspace folder is open.');
		}

		const target = vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', 'spec-trace-vsce', 'SPEC-VSCE-EDITOR.json');
		console.log('[spec-trace-vsce] opening smoke fixture', target.toString());
		await vscode.commands.executeCommand('vscode.openWith', target, SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE);
		console.log('[spec-trace-vsce] requested custom editor open');
	});

	context.subscriptions.push(
		openSmokeFixture,
		vscode.window.registerCustomEditorProvider(SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE, provider, {
			supportsMultipleEditorsPerDocument: false,
			webviewOptions: {
				retainContextWhenHidden: true
			}
		}),
		registerSpecTraceExplorer(context, provider)
	);
}

export function deactivate(): void {}
