import * as vscode from 'vscode';

import { SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE, SpecificationCustomEditorProvider } from './editor/host/specificationCustomEditor.js';
import { registerSpecTraceExplorer } from './navigation/specTraceExplorer.js';
import {
	RepositoryManager,
	SPEC_TRACE_CREATE_ARTIFACT_COMMAND,
	SPEC_TRACE_INITIALIZE_REPOSITORY_COMMAND
} from './management/repositoryManager.js';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new SpecificationCustomEditorProvider(context);
	const repositoryManager = new RepositoryManager();
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
	const initializeRepository = vscode.commands.registerCommand(SPEC_TRACE_INITIALIZE_REPOSITORY_COMMAND, async () => {
		await repositoryManager.promptAndInitializeRepository();
	});
	const createArtifact = vscode.commands.registerCommand(SPEC_TRACE_CREATE_ARTIFACT_COMMAND, async (options?: { kind?: 'specification' | 'architecture' | 'workItem' | 'verification'; domain?: string }) => {
		await repositoryManager.promptAndCreateArtifact(options);
	});
	const explorer = registerSpecTraceExplorer(context, provider, repositoryManager);

	context.subscriptions.push(
		openSmokeFixture,
		initializeRepository,
		createArtifact,
		vscode.window.registerCustomEditorProvider(SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE, provider, {
			supportsMultipleEditorsPerDocument: false,
			webviewOptions: {
				retainContextWhenHidden: true
			}
		}),
		explorer
	);
}

export function deactivate(): void {}
