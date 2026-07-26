import * as vscode from 'vscode';

import {
	getValidationFindings,
	type WorkbenchOperation,
	type WorkbenchValidationFinding
} from './contracts.js';
import {
	DEFAULT_WORKBENCH_MAX_OUTPUT_BYTES,
	DEFAULT_WORKBENCH_TIMEOUT_MS,
	discoverWorkbenchExecutable,
	runWorkbench
} from './runner.js';

export const WORKBENCH_DOCTOR_COMMAND = 'spec-trace-vsce.workbenchDoctor';
export const WORKBENCH_VALIDATE_COMMAND = 'spec-trace-vsce.workbenchValidate';
export const WORKBENCH_QUALITY_SHOW_COMMAND = 'spec-trace-vsce.workbenchQualityShow';
export const WORKBENCH_PROOF_HEALTH_COMMAND = 'spec-trace-vsce.workbenchProofHealth';
export const WORKBENCH_QUALITY_SYNC_COMMAND = 'spec-trace-vsce.workbenchQualitySync';

export function registerWorkbenchIntegration(context: vscode.ExtensionContext): vscode.Disposable {
	const disposables = [
		vscode.commands.registerCommand(WORKBENCH_DOCTOR_COMMAND, () => runAndDisplay('doctor')),
		vscode.commands.registerCommand(WORKBENCH_VALIDATE_COMMAND, () => runValidation()),
		vscode.commands.registerCommand(WORKBENCH_QUALITY_SHOW_COMMAND, () => runAndDisplay('quality-show')),
		vscode.commands.registerCommand(WORKBENCH_PROOF_HEALTH_COMMAND, () => runAndDisplay('quality-proof-health')),
		vscode.commands.registerCommand(WORKBENCH_QUALITY_SYNC_COMMAND, () => syncQuality())
	];

	return vscode.Disposable.from(...disposables);
}

async function runValidation(): Promise<void> {
	const response = await runOperation('validate');
	if (!response) {
		return;
	}

	const findings = getValidationFindings(response.payload);
	await showJson(response.payload, 'Workbench Validation');
	if (findings.length === 0) {
		void vscode.window.showInformationMessage('Workbench validation completed with no structured findings.');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		findings.map((finding) => ({
			label: `${finding.severity === 'error' ? '$(error)' : '$(warning)'} ${finding.artifactId ?? finding.targetId ?? finding.category ?? 'Finding'}`,
			description: finding.category,
			detail: finding.message,
			finding
		})),
		{
			title: 'Workbench validation findings',
			placeHolder: 'Select a finding to open its canonical source.',
			matchOnDescription: true,
			matchOnDetail: true
		}
	);
	if (picked) {
		await openFinding(picked.finding);
	}
}

async function syncQuality(): Promise<void> {
	const preview = await runOperation('quality-sync-preview');
	if (!preview) {
		return;
	}

	await showJson(preview.payload, 'Workbench Quality Sync Preview');
	const confirmation = await vscode.window.showWarningMessage(
		'Apply Workbench quality synchronization? This writes normalized quality artifacts inside the trusted workspace.',
		{ modal: true },
		'Apply synchronization'
	);
	if (confirmation !== 'Apply synchronization') {
		return;
	}

	await runAndDisplay('quality-sync');
}

async function runAndDisplay(operation: WorkbenchOperation): Promise<void> {
	const response = await runOperation(operation);
	if (response) {
		await showJson(response.payload, titleForOperation(operation));
	}
}

async function runOperation(operation: WorkbenchOperation) {
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		void vscode.window.showErrorMessage('Workbench integration is available only in the desktop extension host.');
		return undefined;
	}

	if (!vscode.workspace.isTrusted) {
		void vscode.window.showErrorMessage('Trust this workspace before launching the local Workbench executable.');
		return undefined;
	}

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
		void vscode.window.showErrorMessage('Open a local file-system workspace before launching Workbench.');
		return undefined;
	}

	const configuration = vscode.workspace.getConfiguration('specTrace.workbench');
	const executable = await discoverWorkbenchExecutable(
		configuration.get<string>('executable'),
		workspaceFolder.uri.fsPath
	);
	if (!executable) {
		const selection = await vscode.window.showErrorMessage(
			'Workbench was not found. Configure specTrace.workbench.executable or restore workbench.exe under .workbench/bin.',
			'Open Settings'
		);
		if (selection === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'specTrace.workbench.executable');
		}
		return undefined;
	}

	try {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `SpecTrace: ${titleForOperation(operation)}`,
				cancellable: true
			},
			async (_progress, token) => runWorkbench(
				{ operation, repositoryPath: workspaceFolder.uri.fsPath },
				{
					executable,
					timeoutMs: configuration.get<number>('timeoutMs', DEFAULT_WORKBENCH_TIMEOUT_MS),
					maxOutputBytes: configuration.get<number>('maxOutputBytes', DEFAULT_WORKBENCH_MAX_OUTPUT_BYTES),
					cancellation: token
				}
			)
		);
	} catch (error) {
		void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Workbench invocation failed.');
		return undefined;
	}
}

async function showJson(payload: unknown, title: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument({
		language: 'json',
		content: `${JSON.stringify({ title, payload }, undefined, 2)}\n`
	});
	await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function openFinding(finding: WorkbenchValidationFinding): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	const relativePath = finding.file ?? finding.targetFile;
	if (!workspaceFolder || !relativePath) {
		void vscode.window.showInformationMessage('The selected finding does not include a repository-relative file.');
		return;
	}

	const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '');
	if (normalized.startsWith('../') || normalized.includes('/../')) {
		void vscode.window.showErrorMessage('Workbench finding path escaped the workspace boundary.');
		return;
	}

	const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...normalized.split('/'));
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document, { preview: true });
	const token = finding.artifactId ?? finding.targetId;
	if (!token) {
		return;
	}

	const offset = document.getText().indexOf(token);
	if (offset >= 0) {
		const position = document.positionAt(offset);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}
}

function titleForOperation(operation: WorkbenchOperation): string {
	switch (operation) {
		case 'doctor':
			return 'Workbench Doctor';
		case 'validate':
			return 'Workbench Validation';
		case 'quality-show':
			return 'Workbench Quality';
		case 'quality-proof-health':
			return 'Workbench Proof Health';
		case 'quality-sync-preview':
			return 'Workbench Quality Sync Preview';
		case 'quality-sync':
			return 'Workbench Quality Sync';
	}
}
