import * as vscode from 'vscode';

import {
	cloneSpecificationDocument,
	isSpecificationPath,
	normalizeWorkspaceRelativePath,
	parseSpecificationDocument,
	serializeSpecificationDocument,
	SpecificationDocument,
	ValidationIssue,
	validateSpecificationDocument
} from '../core/specification.js';

export const SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE = 'spec-trace-vsce.specFileEditor';

type SpecificationEditorHostMessage =
	| {
		type: 'ready';
	}
	| {
		type: 'edit';
		document: SpecificationDocument;
	}
	| {
		type: 'save' | 'openText';
	};

type SpecificationEditorSyncMessage = {
	type: 'sync';
	document: SpecificationDocument;
	issues: ValidationIssue[];
	isDirty: boolean;
	externalConflict: boolean;
};

function isSpecificationEditorHostMessage(value: unknown): value is SpecificationEditorHostMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as { type?: unknown };
	if (candidate.type === 'ready') {
		return true;
	}

	if (candidate.type === 'save' || candidate.type === 'openText') {
		return true;
	}

	if (candidate.type === 'edit') {
		const editCandidate = value as { document?: unknown };
		return typeof editCandidate.document === 'object' && editCandidate.document !== null;
	}

	return false;
}

export class SpecificationCustomEditorProvider implements vscode.CustomEditorProvider<SpecificationCustomDocument> {
	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SpecificationCustomDocument>>();

	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	public constructor(private readonly extensionContext: vscode.ExtensionContext) {}

	public async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken
	): Promise<SpecificationCustomDocument> {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (!workspaceFolder) {
			throw new Error('Spec Trace specification files can only be opened from a workspace folder.');
		}

		const relativePath = vscode.workspace.asRelativePath(uri, false);
		if (!isSpecificationPath(relativePath)) {
			throw new Error('Spec Trace custom editor only supports files under specs/requirements/*.json.');
		}

		const { text, document } = await this.readDocumentSnapshot(uri, openContext);
		if (!document) {
			throw new Error('The document could not be parsed as JSON.');
		}

		return new SpecificationCustomDocument(workspaceFolder, uri, text, document, this);
	}

	public resolveCustomEditor(
		document: SpecificationCustomDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): void {
		document.attachWebviewPanel(webviewPanel);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'web')
			]
		};

		webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview);

		webviewPanel.webview.onDidReceiveMessage((message: unknown) => {
			if (!isSpecificationEditorHostMessage(message)) {
				return;
			}

			if (message.type === 'ready') {
				void this.syncDocument(document, 'open');
				return;
			}

			if (message.type === 'save') {
				void this.saveDocumentToUri(document, document.uri).catch((error) => {
					console.error('[spec-trace-vsce] save failed', error);
				});
				return;
			}

			if (message.type === 'openText') {
				void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
				return;
			}

			if (message.type === 'edit') {
				const previousIndex = document.historyIndex;
				const nextIndex = document.applyEdit(message.document);
				if (nextIndex === previousIndex) {
					return;
				}

				this._onDidChangeCustomDocument.fire({
					document,
					label: 'Update specification',
					undo: () => {
						document.setHistoryIndex(previousIndex);
						void this.syncDocument(document, 'undo');
					},
					redo: () => {
						document.setHistoryIndex(nextIndex);
						void this.syncDocument(document, 'redo');
					}
				});
			}
		});
	}

	public async saveCustomDocument(document: SpecificationCustomDocument, cancellation: vscode.CancellationToken): Promise<void> {
		await this.saveDocumentToUri(document, document.uri, cancellation);
	}

	public async saveCustomDocumentAs(
		document: SpecificationCustomDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		const destinationWorkspaceFolder = vscode.workspace.getWorkspaceFolder(destination);
		if (!destinationWorkspaceFolder || destinationWorkspaceFolder.uri.toString() !== document.workspaceFolder.uri.toString()) {
			throw new Error('Spec Trace files can only be saved inside the current workspace repository root.');
		}

		await this.saveDocumentToUri(document, destination, cancellation);
	}

	public async revertCustomDocument(document: SpecificationCustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		const { text, document: parsed } = await this.readDocumentSnapshot(document.uri, undefined);
		if (!parsed) {
			throw new Error('The document could not be reloaded as JSON.');
		}

		document.replaceWithSnapshot(text, parsed);
		await this.syncDocument(document, 'revert');
	}

	public async backupCustomDocument(
		document: SpecificationCustomDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		const backupUri = this.createBackupUri(document, context);
		await this.ensureBackupFolderExists();
		await vscode.workspace.fs.writeFile(backupUri, new TextEncoder().encode(serializeSpecificationDocument(document.state)));

		return {
			id: backupUri.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(backupUri);
				} catch {
					// Ignore delete failures. Backups are best-effort.
				}
			}
		};
	}

	public async syncDocument(document: SpecificationCustomDocument, source: 'open' | 'undo' | 'redo' | 'revert' | 'save' | 'external'): Promise<void> {
		await document.postToWebview({
			type: 'sync',
			document: cloneSpecificationDocument(document.state),
			issues: validateSpecificationDocument(document.state),
			isDirty: document.isDirty,
			externalConflict: document.externalConflict
		});
	}

	private async saveDocumentToUri(
		document: SpecificationCustomDocument,
		targetUri: vscode.Uri,
		_cancellation?: vscode.CancellationToken
	): Promise<void> {
		const validationIssues = validateSpecificationDocument(document.state);
		if (validationIssues.length > 0) {
			const summary = validationIssues.slice(0, 3).map((issue) => `${issue.path || 'document'}: ${issue.message}`).join('; ');
			throw new Error(`Cannot save an invalid specification: ${summary}`);
		}

		const serialized = serializeSpecificationDocument(document.state);
		const diskText = await this.readRawTextIfPresent(targetUri);

		if (diskText !== undefined && diskText !== document.lastDiskText && diskText !== serialized) {
			throw new Error('The specification has changed on disk since it was loaded. Reopen or revert before saving.');
		}

		await this.ensureDirectoryExists(targetUri);
		await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(serialized));
		document.markSaved(serialized);
		await this.syncDocument(document, 'save');
	}

	private async readDocumentSnapshot(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext | undefined
	): Promise<{
		text: string;
		document: SpecificationDocument | undefined;
	}> {
		let text: string;

		if (openContext?.backupId) {
			try {
				text = await this.readTextFromUri(vscode.Uri.parse(openContext.backupId));
			} catch {
				text = await this.readTextFromUri(uri);
			}
		} else {
			text = await this.readTextFromUri(uri);
		}

		const parsed = parseSpecificationDocument(text);
		return {
			text,
			document: parsed.document
		};
	}

	private async readRawTextIfPresent(uri: vscode.Uri): Promise<string | undefined> {
		try {
			return await this.readTextFromUri(uri);
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				return undefined;
			}

			throw error;
		}
	}

	private async readTextFromUri(uri: vscode.Uri): Promise<string> {
		const data = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(data);
	}

	private async ensureDirectoryExists(uri: vscode.Uri): Promise<void> {
		const directoryUri = uri.with({
			path: uri.path.substring(0, uri.path.lastIndexOf('/')) || '/'
		});
		await vscode.workspace.fs.createDirectory(directoryUri);
	}

	private createBackupUri(document: SpecificationCustomDocument, context: vscode.CustomDocumentBackupContext): vscode.Uri {
		const backupFolder = vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'spec-trace-vsce', 'backups');
		const key = this.uriToHex(document.uri.toString());
		return vscode.Uri.joinPath(backupFolder, `${key}.json`);
	}

	private uriToHex(value: string): string {
		const bytes = new TextEncoder().encode(value);
		let output = '';
		for (const byte of bytes) {
			output += byte.toString(16).padStart(2, '0');
		}

		return output;
	}

	private async ensureBackupFolderExists(): Promise<void> {
		const backupFolder = vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'spec-trace-vsce', 'backups');
		await vscode.workspace.fs.createDirectory(backupFolder);
	}

	private getWebviewHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'web', 'editor', 'webview', 'main.js')
		);
		const nonce = this.createNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Spec Trace Editor</title>
</head>
<body>
	<div id="app" class="app-shell">
		<div class="loading-card">
			<div class="loading-title">Spec Trace editor</div>
			<div class="loading-body">Loading structured editor...</div>
		</div>
	</div>
	<style nonce="${nonce}">
		:root {
			color-scheme: light dark;
			--page-padding: 16px;
			--panel-gap: 12px;
			--card-radius: 14px;
			--card-border: color-mix(in srgb, var(--vscode-panel-border) 52%, var(--vscode-foreground) 24%);
			--control-border: color-mix(in srgb, var(--card-border) 78%, var(--vscode-foreground) 22%);
			--page-bg: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
			--card-bg: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-sideBar-background) 16%);
			--card-bg-strong: color-mix(in srgb, var(--vscode-editor-background) 76%, var(--vscode-sideBar-background) 24%);
			--accent: var(--vscode-focusBorder);
			--muted: var(--vscode-descriptionForeground);
			--danger: var(--vscode-errorForeground);
			--text: var(--vscode-foreground);
			--input-bg: color-mix(in srgb, var(--vscode-input-background) 82%, var(--vscode-sideBar-background) 18%);
			--input-border: color-mix(in srgb, var(--vscode-input-border, var(--card-border)) 66%, var(--vscode-foreground) 22%);
			--control-bg: color-mix(in srgb, var(--vscode-input-background) 76%, var(--vscode-sideBar-background) 24%);
			--control-bg-strong: color-mix(in srgb, var(--vscode-input-background) 68%, var(--vscode-sideBar-background) 32%);
			--control-shadow: 0 1px 0 rgba(255, 255, 255, 0.72) inset, 0 1px 2px rgba(0, 0, 0, 0.05);
			--control-shadow-strong: 0 1px 0 rgba(255, 255, 255, 0.84) inset, 0 2px 5px rgba(0, 0, 0, 0.08);
		}

		body.vscode-light,
		body.vscode-high-contrast-light {
			background:
				radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 18%, transparent) 0%, transparent 32%),
				radial-gradient(circle at bottom right, color-mix(in srgb, #84b0ff 14%, transparent) 0%, transparent 34%),
				linear-gradient(180deg, color-mix(in srgb, var(--page-bg) 92%, #ffffff) 0%, var(--page-bg) 100%);
			--accent: #1f57d8;
			--card-border: #b0bfd4;
			--control-border: #90a6c3;
			--page-bg: #d9e5f4;
			--card-bg: #ffffff;
			--card-bg-strong: #ecf3fc;
			--input-bg: #f5faff;
			--input-border: #879fbf;
			--control-bg: #e0ebfa;
			--control-bg-strong: #cdddf2;
			--muted: #42546b;
			--control-shadow: 0 1px 0 rgba(255, 255, 255, 0.94) inset, 0 1px 2px rgba(38, 52, 74, 0.07);
			--control-shadow-strong: 0 1px 0 rgba(255, 255, 255, 0.98) inset, 0 2px 7px rgba(38, 52, 74, 0.1);
		}

		html, body {
			margin: 0;
			min-height: 100%;
			background:
				radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 8%, transparent) 0%, transparent 34%),
				linear-gradient(180deg, color-mix(in srgb, var(--page-bg) 96%, #ffffff) 0%, var(--page-bg) 100%);
			color: var(--text);
			font-family: var(--vscode-font-family);
		}

		.app-shell {
			box-sizing: border-box;
			min-height: 100vh;
			padding: var(--page-padding);
		}

		.loading-card,
		.hero,
		.card {
			border: 1px solid var(--card-border);
			background: linear-gradient(180deg, color-mix(in srgb, var(--card-bg-strong) 24%, var(--card-bg) 76%) 0%, var(--card-bg) 100%);
			border-radius: var(--card-radius);
			box-shadow: var(--control-shadow-strong);
		}

		.loading-card {
			padding: 24px;
			max-width: 520px;
		}

		.loading-title {
			font-size: 18px;
			font-weight: 600;
			margin-bottom: 8px;
		}

		.loading-body {
			color: var(--muted);
		}

		.editor-root {
			display: grid;
			gap: var(--panel-gap);
			max-width: 1400px;
			margin: 0 auto;
		}

		.hero {
			padding: 14px 16px;
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 14px;
		}

		.hero-title {
			font-size: 20px;
			font-weight: 700;
			margin: 0 0 6px 0;
		}

		.hero-subtitle {
			color: var(--muted);
			font-size: 13px;
		}

		.hero-meta {
			display: grid;
			gap: 8px;
			justify-items: end;
		}

		.status-row {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			justify-content: flex-end;
		}

		.hero-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			justify-content: flex-end;
		}

		.status-chip {
			border-radius: 999px;
			padding: 6px 10px;
			font-size: 12px;
			line-height: 1;
			border: 1px solid var(--card-border);
			background: linear-gradient(180deg, color-mix(in srgb, var(--control-bg-strong) 74%, var(--accent) 26%) 0%, var(--control-bg) 100%);
		}

		.status-chip.warning {
			border-color: color-mix(in srgb, var(--danger) 55%, var(--card-border));
			color: var(--danger);
		}

		.card {
			padding: 14px 16px 16px;
		}

		.card h2,
		.card h3 {
			margin: 0 0 14px 0;
		}

		.section-heading {
			display: grid;
			gap: 4px;
		}

		.section-heading h2 {
			margin: 0;
			font-size: 16px;
		}

		.section-heading .section-copy {
			margin: 0;
		}

		.section-copy {
			color: var(--muted);
			font-size: 13px;
		}

		.section-heading-row {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
		}

		.section-heading-row .section-heading {
			flex: 1 1 auto;
		}

		.section-heading-row .action-button {
			flex: 0 0 auto;
		}

		.collapsible-card {
			padding: 0;
			overflow: clip;
		}

		.collapsible-card > summary {
			list-style: none;
			cursor: pointer;
			padding: 14px 16px;
			background: linear-gradient(180deg, var(--card-bg-strong) 0%, var(--card-bg) 100%);
		}

		.collapsible-card > summary::-webkit-details-marker {
			display: none;
		}

		.collapsible-card[open] > summary {
			border-bottom: 1px solid var(--card-border);
		}

		.collapsible-card-summary {
			display: block;
		}

		.collapsible-card-summary .section-heading {
			padding-right: 12px;
		}

		.card-body {
			padding: 12px 16px 16px;
			background: linear-gradient(180deg, color-mix(in srgb, var(--card-bg) 92%, var(--page-bg) 8%) 0%, var(--card-bg) 100%);
			border-top: 1px solid color-mix(in srgb, var(--card-border) 86%, transparent);
		}

		.form-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px 12px;
		}

		.form-field,
		.list-field,
		.requirement-card {
			display: grid;
			gap: 6px;
			background: linear-gradient(180deg, color-mix(in srgb, var(--card-bg-strong) 14%, var(--card-bg) 86%) 0%, var(--card-bg) 100%);
			border: 1px solid color-mix(in srgb, var(--card-border) 92%, transparent);
			border-radius: 10px;
			padding: 10px;
			box-shadow: var(--control-shadow);
		}

		.form-field.wide,
		.list-field.wide,
		.requirement-card {
			grid-column: 1 / -1;
		}

		.field-label {
			font-size: 12px;
			font-weight: 600;
			color: var(--muted);
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}

		.field-input,
		.field-textarea {
			width: 100%;
			box-sizing: border-box;
			border-radius: 10px;
			border: 1px solid var(--input-border);
			background: linear-gradient(180deg, color-mix(in srgb, var(--input-bg) 90%, #ffffff 10%) 0%, var(--input-bg) 100%);
			color: var(--text);
			padding: 8px 10px;
			font: inherit;
			box-shadow: var(--control-shadow);
		}

		.field-input {
			min-height: 36px;
		}

		.field-textarea {
			min-height: 76px;
			resize: vertical;
		}

		.field-input[readonly] {
			background: linear-gradient(180deg, color-mix(in srgb, var(--card-bg-strong) 56%, var(--page-bg) 44%) 0%, var(--card-bg) 100%);
			color: color-mix(in srgb, var(--text) 76%, var(--muted) 24%);
			opacity: 0.95;
		}

		.form-field.has-errors > .field-input,
		.form-field.has-errors > .field-textarea,
		.list-row.has-errors > .field-input,
		.list-row.has-errors > .field-textarea,
		.requirement-card.has-errors,
		.collapsible-card.has-errors {
			border-color: color-mix(in srgb, var(--danger) 42%, var(--card-border));
		}

		.field-errors,
		.summary-errors {
			color: var(--danger);
			font-size: 12px;
			display: grid;
			gap: 4px;
		}

		.summary-errors {
			margin-bottom: 12px;
		}

		.list-row,
		.requirement-toolbar {
			display: flex;
			align-items: flex-start;
			gap: 6px;
			border: 1px solid color-mix(in srgb, var(--card-border) 90%, transparent);
			border-radius: 10px;
			padding: 8px;
			background: linear-gradient(180deg, color-mix(in srgb, var(--control-bg-strong) 22%, var(--control-bg) 78%) 0%, var(--control-bg) 100%);
			box-shadow: var(--control-shadow);
		}

		.list-row .field-input,
		.list-row .field-textarea {
			flex: 1 1 auto;
		}

		.icon-button,
		.action-button {
			border: 1px solid var(--control-border);
			background: linear-gradient(180deg, var(--control-bg-strong) 0%, var(--control-bg) 100%);
			color: var(--text);
			border-radius: 8px;
			padding: 7px 10px;
			font: inherit;
			cursor: pointer;
			box-shadow: var(--control-shadow);
		}

		.action-button.primary {
			border-color: color-mix(in srgb, var(--accent) 64%, var(--control-border));
			background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 92%, #ffffff 8%) 0%, color-mix(in srgb, var(--accent) 86%, #000000 14%) 100%);
			color: #ffffff;
		}

		body.vscode-light .action-button.primary:hover,
		body.vscode-high-contrast-light .action-button.primary:hover {
			background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 84%, #ffffff 16%) 0%, color-mix(in srgb, var(--accent) 76%, #000000 24%) 100%);
		}

		.icon-button:disabled,
		.action-button:disabled {
			opacity: 0.45;
			cursor: not-allowed;
		}

		.requirements-list {
			display: grid;
			gap: 10px;
		}

		.requirement-card {
			padding: 0;
			border-radius: 12px;
			border: 1px solid var(--card-border);
			background: linear-gradient(180deg, var(--card-bg-strong) 0%, var(--card-bg) 100%);
		}

		.requirement-summary {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
			padding: 12px 14px;
			cursor: pointer;
			list-style: none;
			background: linear-gradient(180deg, var(--card-bg-strong) 0%, color-mix(in srgb, var(--card-bg) 88%, var(--page-bg) 12%) 100%);
		}

		.requirement-summary::-webkit-details-marker {
			display: none;
		}

		.requirement-summary-copy {
			flex: 1 1 auto;
			min-width: 0;
		}

		.requirement-summary-line {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 8px;
		}

		.requirement-summary-id {
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.03em;
			text-transform: uppercase;
		}

		.requirement-summary-title {
			font-size: 14px;
			font-weight: 600;
		}

		.requirement-summary-statement {
			color: var(--muted);
			font-size: 12px;
			margin-top: 4px;
		}

		.requirement-summary-state {
			flex: 0 0 auto;
			color: var(--muted);
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding-top: 3px;
		}

		.requirement-card[open] > .requirement-summary {
			border-bottom: 1px solid var(--card-border);
		}

		.requirement-body {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px 12px;
			padding: 12px 14px 14px;
			background: linear-gradient(180deg, color-mix(in srgb, var(--card-bg) 94%, var(--page-bg) 6%) 0%, var(--card-bg) 100%);
			border-top: 1px solid color-mix(in srgb, var(--card-border) 84%, transparent);
		}

		.requirement-body .wide {
			grid-column: 1 / -1;
		}

		.helper {
			color: var(--muted);
			font-size: 12px;
		}

		.field-input:focus-visible,
		.field-textarea:focus-visible,
		.icon-button:focus-visible,
		.action-button:focus-visible,
		.collapsible-card > summary:focus-visible,
		.requirement-summary:focus-visible {
			outline: none;
			box-shadow:
				0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent),
				0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent),
				var(--control-shadow-strong);
		}

		.icon-button:hover,
		.action-button:hover {
			background: linear-gradient(180deg, color-mix(in srgb, var(--control-bg-strong) 58%, var(--accent) 42%) 0%, var(--control-bg) 100%);
		}

		.icon-button:active,
		.action-button:active {
			transform: translateY(1px);
		}

		@media (max-width: 960px) {
			.form-grid,
			.requirement-body {
				grid-template-columns: 1fr;
			}

			.hero {
				flex-direction: column;
			}

			.hero-meta {
				justify-items: start;
			}

			.status-row {
				justify-content: flex-start;
			}

			.hero-actions {
				justify-content: flex-start;
			}

			.section-heading-row {
				flex-direction: column;
			}
		}
	</style>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private createNonce(): string {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		const randomValues = crypto.getRandomValues(new Uint8Array(16));
		for (const value of randomValues) {
			result += alphabet[value % alphabet.length];
		}

		return result;
	}
}

class SpecificationCustomDocument implements vscode.CustomDocument {
	public readonly uri: vscode.Uri;

	public readonly workspaceFolder: vscode.WorkspaceFolder;

	private readonly provider: SpecificationCustomEditorProvider;

	private _history: SpecificationDocument[];

	private _historyIndex = 0;

	private _savedHistoryIndex = 0;

	private _lastDiskText: string;

	private _externalConflict = false;

	private _panel: vscode.WebviewPanel | undefined;

	private _watcher: vscode.FileSystemWatcher | undefined;

	public constructor(
		workspaceFolder: vscode.WorkspaceFolder,
		uri: vscode.Uri,
		initialDiskText: string,
		initialDocument: SpecificationDocument,
		provider: SpecificationCustomEditorProvider
	) {
		this.workspaceFolder = workspaceFolder;
		this.uri = uri;
		this.provider = provider;
		this._history = [cloneSpecificationDocument(initialDocument)];
		this._historyIndex = 0;
		this._savedHistoryIndex = 0;
		this._lastDiskText = initialDiskText;
		this._watcher = this.createWatcher();
	}

	public get state(): SpecificationDocument {
		return this._history[this._historyIndex];
	}

	public get historyIndex(): number {
		return this._historyIndex;
	}

	public get externalConflict(): boolean {
		return this._externalConflict;
	}

	public set externalConflict(value: boolean) {
		this._externalConflict = value;
	}

	public get isDirty(): boolean {
		return this._historyIndex !== this._savedHistoryIndex;
	}

	public get lastDiskText(): string {
		return this._lastDiskText;
	}

	public attachWebviewPanel(panel: vscode.WebviewPanel): void {
		this._panel = panel;
		panel.onDidDispose(() => {
			if (this._panel === panel) {
				this._panel = undefined;
			}
		});
	}

	public applyEdit(nextState: SpecificationDocument): number {
		const currentText = serializeSpecificationDocument(this.state);
		const nextText = serializeSpecificationDocument(nextState);
		if (currentText === nextText) {
			return this._historyIndex;
		}

		this._history = this._history.slice(0, this._historyIndex + 1);
		this._history.push(cloneSpecificationDocument(nextState));
		this._historyIndex = this._history.length - 1;
		return this._historyIndex;
	}

	public setHistoryIndex(index: number): void {
		if (index < 0 || index >= this._history.length) {
			return;
		}

		this._historyIndex = index;
	}

	public replaceWithSnapshot(diskText: string, snapshot: SpecificationDocument): void {
		this._history = [cloneSpecificationDocument(snapshot)];
		this._historyIndex = 0;
		this._savedHistoryIndex = 0;
		this._lastDiskText = diskText;
		this._externalConflict = false;
	}

	public markSaved(serializedText: string): void {
		this._savedHistoryIndex = this._historyIndex;
		this._lastDiskText = serializedText;
		this._externalConflict = false;
	}

	public markExternalConflict(): void {
		this._externalConflict = true;
	}

	public async postToWebview(message: SpecificationEditorSyncMessage): Promise<boolean | undefined> {
		return this._panel?.webview.postMessage(message);
	}

	public dispose(): void {
		this._watcher?.dispose();
		this._panel = undefined;
	}

	private createWatcher(): vscode.FileSystemWatcher {
		const relativePath = normalizeWorkspaceRelativePath(vscode.workspace.asRelativePath(this.uri, false));
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.workspaceFolder, relativePath),
			false,
			false,
			false
		);

		const handleChange = () => {
			void this.handleExternalChange();
		};

		watcher.onDidChange(handleChange);
		watcher.onDidCreate(handleChange);
		watcher.onDidDelete(handleChange);
		return watcher;
	}

	private async handleExternalChange(): Promise<void> {
		let diskText: string | undefined;

		try {
			diskText = await this.readTextFromUri(this.uri);
		} catch {
			this.markExternalConflict();
			await this.provider.syncDocument(this, 'external');
			return;
		}

		if (diskText === this._lastDiskText) {
			return;
		}

		const parsed = parseSpecificationDocument(diskText);
		if (!parsed.document) {
			this.markExternalConflict();
			await this.provider.syncDocument(this, 'external');
			return;
		}

		if (this.isDirty) {
			this.markExternalConflict();
			await this.provider.syncDocument(this, 'external');
			return;
		}

		this.replaceWithSnapshot(diskText, parsed.document);
		await this.provider.syncDocument(this, 'external');
	}

	private async readTextFromUri(uri: vscode.Uri): Promise<string> {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(bytes);
	}
}
