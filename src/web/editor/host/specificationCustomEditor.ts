import * as vscode from 'vscode';

import {
	cloneSpecificationDocument,
	isSpecificationPath,
	normalizeWorkspaceRelativePath,
	serializeSpecificationDocument,
	SpecificationDocument,
	ValidationIssue
} from '../core/specification.js';
import {
	parseSpecificationDocument,
	validateSpecificationDocument
} from '../core/specificationValidation.js';

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
		type: 'reveal';
		cardPath: string;
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

	if (candidate.type === 'reveal') {
		const revealCandidate = value as { cardPath?: unknown };
		return typeof revealCandidate.cardPath === 'string' && revealCandidate.cardPath.length > 0;
	}

	if (candidate.type === 'edit') {
		const editCandidate = value as { document?: unknown };
		return typeof editCandidate.document === 'object' && editCandidate.document !== null;
	}

	return false;
}

export class SpecificationCustomEditorProvider implements vscode.CustomEditorProvider<SpecificationCustomDocument> {
	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SpecificationCustomDocument>>();
	private readonly _documents = new Map<string, SpecificationCustomDocument>();

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

		const customDocument = new SpecificationCustomDocument(workspaceFolder, uri, text, document, this);
		this._documents.set(uri.toString(), customDocument);
		return customDocument;
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
				document.markWebviewReady();
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
				void this.syncDocument(document, 'external');
				return;
			}

			if (message.type === 'reveal') {
				void document.revealCard(message.cardPath);
			}
		});
	}

	public async openSpecificationDocument(uri: vscode.Uri): Promise<void> {
		await vscode.commands.executeCommand('vscode.openWith', uri, SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE);
	}

	public async revealRequirement(uri: vscode.Uri, requirementIndex: number): Promise<void> {
		const cardPath = `requirements[${requirementIndex}]`;
		await this.openSpecificationDocument(uri);

		const document = await this.waitForOpenDocument(uri);
		if (!document) {
			return;
		}

		await document.revealCard(cardPath);
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
		await document.flushPendingReveals();
	}

	public releaseDocument(uri: vscode.Uri): void {
		this._documents.delete(uri.toString());
	}

	private async waitForOpenDocument(uri: vscode.Uri, timeoutMs = 1_500): Promise<SpecificationCustomDocument | undefined> {
		const deadline = Date.now() + timeoutMs;
		const key = uri.toString();

		while (Date.now() < deadline) {
			const document = this._documents.get(key);
			if (document) {
				return document;
			}

			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		}

		return undefined;
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
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'web', 'editor', 'webview', 'main.css')
		);
		const nonce = this.createNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Spec Trace Editor</title>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<script nonce="${nonce}">
		const vscodeTheme = document.body.classList.contains('vscode-dark')
			|| document.body.classList.contains('vscode-high-contrast')
			|| document.body.classList.contains('vscode-high-contrast-dark')
			? 'dark'
			: 'light';
		document.body.setAttribute('data-bs-theme', vscodeTheme);
		document.documentElement.setAttribute('data-bs-theme', vscodeTheme);
	</script>
	<div id="app" class="app-shell">
		<inc-state-panel class="loading-panel inc-state-panel inc-state-panel--info" variant="info">
			<div class="inc-state-panel__head">
				<span class="inc-state-panel__icon">Loading</span>
				<h2 class="inc-state-panel__title">Spec Trace editor</h2>
			</div>
			<p class="inc-state-panel__body">Loading structured editor...</p>
			<div class="inc-state-panel__actions"></div>
		</inc-state-panel>
	</div>
	<style nonce="${nonce}">
		html, body {
			margin: 0;
			min-height: 100%;
			background: var(--inc-surface-muted);
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
			color-scheme: light dark;
		}

		body[data-bs-theme="light"],
		html[data-bs-theme="light"] {
			--bs-secondary-bg: #f7f9fc;
			--bs-tertiary-bg: #e3e8f1;
			--bs-border-color: #95a0b1;
			--bs-border-color-translucent: rgba(42, 49, 66, 0.28);
		}

		#app,
		.app-shell,
		.editor-page {
			box-sizing: border-box;
			min-height: 100vh;
		}

		#app {
			padding: 24px;
		}

		.editor-page {
			display: block;
			--editor-content-max-width: 1400px;
		}

		.editor-hero {
			display: block;
			width: 100%;
			max-width: var(--editor-content-max-width);
			margin: 0 auto;
		}

		.editor-root {
			display: grid;
			gap: 1.25rem;
			width: 100%;
			max-width: var(--editor-content-max-width);
			margin: 0 auto;
		}

		.loading-panel {
			max-width: 540px;
		}

		.section-heading {
			display: grid;
			gap: 0.25rem;
		}

		.section-heading__title-row,
		.summary-block__header,
		.requirement-toolbar-label,
		.hero-status-strip__meta {
			display: inline-flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.45rem;
		}

		.section-heading h2 {
			margin: 0;
		}

		.section-copy {
			margin: 0;
			color: var(--vscode-descriptionForeground);
		}

		.card-header-row {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem 1rem;
		}

		.page-header-title,
		.page-header-body,
		.summary-overview,
		.form-grid,
		.list-field,
		.requirements-list,
		.requirements-screen,
		.requirements-index-shell,
		.requirement-detail-body,
		.field-errors {
			min-width: 0;
		}

		.page-header-title {
			display: grid;
			gap: 0.25rem;
		}

		.page-header-body {
			display: grid;
			gap: 0.5rem;
		}

		.page-header-subtitle {
			margin: 0;
		}

		.hero-status-strip {
			display: grid;
			gap: 0.4rem;
		}

		.hero-status-strip__chips {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			align-items: center;
		}

		.hero-status-strip__meta,
		.requirement-index-results {
			margin: 0;
		}

		.disclosure-summary {
			display: grid;
			gap: 0.25rem;
			width: 100%;
		}

		.disclosure-summary__row {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.disclosure-summary__title {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 0.5rem;
			min-width: 0;
		}

		.disclosure-summary__description {
			display: block;
		}

		.hero-actions,
		.card-header-actions,
		.section-actions,
		.requirement-toolbar {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			align-items: center;
		}

		.hero-actions {
			justify-content: flex-end;
		}

		.card-header-actions {
			justify-content: flex-end;
		}

		.summary-overview {
			width: 100%;
		}

		.coverage-summary-chip,
		.coverage-body,
		.coverage-detail,
		.coverage-selected-body,
		.coverage-evidence-body {
			display: grid;
			gap: 0.75rem;
			min-width: 0;
		}

		.coverage-summary-chip {
			gap: 0.35rem;
			justify-items: start;
		}

		.coverage-metric {
			display: grid;
			gap: 0.25rem;
			justify-items: start;
		}

		.coverage-metric__value {
			min-width: 5rem;
			justify-content: center;
		}

		.coverage-summary-meta {
			margin: 0;
		}

		.coverage-detail-card,
		.coverage-selected-card {
			min-width: 0;
		}

		.form-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.75rem 1rem;
		}

		.editor-field--wide {
			grid-column: 1 / -1;
		}

		.editor-field__control {
			width: 100%;
			box-sizing: border-box;
		}

		.editor-field__control--textarea {
			min-height: 7rem;
			resize: vertical;
		}

		.list-field {
			display: grid;
			gap: 0.75rem;
		}

		.list-field__control {
			display: grid;
			gap: 0.5rem;
			min-width: 0;
		}

		.requirements-screen {
			display: grid;
			gap: 0.75rem;
		}

		.requirements-index-card,
		.requirement-detail-card {
			min-width: 0;
		}

		.requirements-index-card {
			--bs-card-border-radius: 0.5rem;
		}

		.requirements-index-shell {
			display: grid;
			gap: 0.75rem;
		}

		.requirement-index-toolbar {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.75rem 1rem;
			align-items: start;
		}

		.requirement-toolbar-panel {
			display: grid;
			gap: 0.75rem;
			min-width: 0;
			padding: 0.9rem 0.95rem;
			border: 1px solid color-mix(in srgb, var(--vscode-panel-border, var(--inc-border-subtle, #d0d7de)) 75%, transparent);
			border-radius: 0.875rem;
			background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--inc-surface-panel, #ffffff)) 88%, transparent);
			box-shadow: var(--inc-surface-panel-shadow, none);
		}

		.requirement-toolbar-panel__header,
		.requirement-toolbar-panel__body,
		.requirement-toolbar-group,
		.requirement-density-switch {
			display: grid;
			gap: 0.5rem;
			min-width: 0;
		}

		.requirement-toolbar-panel__header {
			gap: 0.35rem;
		}

		.requirement-toolbar-panel__header .requirement-toolbar-label {
			font-size: 0.8125rem;
			font-weight: 600;
			color: var(--vscode-foreground);
		}

		.requirement-index-search-field,
		.requirement-index-search-input,
		.requirement-toolbar-group,
		.requirement-toolbar-panel__body {
			min-width: 0;
		}

		.requirement-index-search-control,
		.requirement-index-search-input,
		.requirement-index-sort-select {
			width: 100%;
		}

		.requirement-index-sort-controls {
			display: grid;
			grid-template-columns: minmax(0, auto) minmax(0, 1fr);
			gap: 0.5rem;
			align-items: center;
		}

		.requirement-index-sort-select {
			min-width: 0;
		}

		.requirement-index-filter-group {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			justify-content: flex-start;
		}

		.requirement-index-results {
			grid-column: 1 / -1;
		}

		.requirement-density-switch__choice {
			margin: 0;
		}

		.requirement-density-switch__choice .inc-form__check-label {
			font-size: 0.875rem;
		}

		.requirement-index-list {
			border-radius: 0;
			overflow: visible;
		}

		.requirement-index-list > .inc-list-group__item,
		.requirement-index-list > .inc-list-group__item:first-child,
		.requirement-index-list > .inc-list-group__item:last-child {
			border-radius: 0;
		}

		.requirements-list {
			display: grid;
			gap: 0.5rem;
		}

		.list-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.5rem;
			align-items: start;
			min-width: 0;
		}

		.list-row__controls {
			align-self: start;
		}

		.supplemental-section-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.75rem;
			align-items: start;
			min-width: 0;
			padding: 0.85rem;
			border: 1px solid color-mix(in srgb, var(--vscode-panel-border, var(--inc-border-subtle, #d0d7de)) 70%, transparent);
			border-radius: 0.75rem;
			background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--inc-surface-panel, #ffffff)) 92%, transparent);
		}

		.supplemental-section-fields {
			display: grid;
			gap: 0.75rem;
			min-width: 0;
		}

		.supplemental-section-controls {
			align-self: start;
		}

		.requirement-index-row {
			display: grid;
			gap: 0.45rem;
			width: 100%;
			padding: 0.85rem 0.95rem;
			border: 0;
			background: transparent;
			color: inherit;
			text-align: left;
			font: inherit;
			cursor: pointer;
			appearance: none;
		}

		.requirement-index-row.active {
			background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground, #cce6ff) 24%, transparent);
			color: var(--vscode-foreground);
			box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 55%, transparent);
		}

		.requirement-index-row.active .requirement-summary-statement,
		.requirement-index-row.active .requirement-index-evidence {
			color: color-mix(in srgb, var(--vscode-foreground) 68%, var(--vscode-descriptionForeground) 32%);
		}

		.requirement-index-row:focus-visible {
			outline: 2px solid var(--vscode-focusBorder);
			outline-offset: -2px;
			border-radius: 0;
		}

		.requirement-index-row--warning:not(.active) {
			background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, #fff4ce) 22%, transparent);
		}

		.requirement-index-header {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: 0.75rem;
			align-items: center;
		}

		.requirement-index-expand {
			align-self: center;
			white-space: nowrap;
		}

		.requirement-index-expand {
			min-width: 1.8rem;
			padding-inline: 0.45rem;
			font-weight: 700;
		}

		.requirement-summary {
			display: grid;
			gap: 0.25rem;
			width: 100%;
		}

		.requirement-index-open {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.75rem;
			align-items: center;
			width: 100%;
			padding: 0;
			border: 0;
			background: transparent;
			color: inherit;
			text-align: left;
			font: inherit;
			cursor: pointer;
			appearance: none;
		}

		.requirement-index-open-button {
			align-self: center;
			white-space: nowrap;
		}

		.requirement-summary-copy {
			display: grid;
			gap: 0.2rem;
			min-width: 0;
		}

		.requirement-summary-line {
			display: flex;
			gap: 0.5rem;
			flex-wrap: wrap;
			align-items: baseline;
			min-width: 0;
		}

		.requirement-summary-id {
			font-weight: 700;
		}

		.requirement-summary-title {
			font-weight: 600;
		}

		.requirement-summary-statement {
			color: var(--vscode-descriptionForeground);
			font-size: 0.875rem;
			display: -webkit-box;
			overflow: hidden;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
		}

		.requirement-summary-state {
			min-width: 5.5rem;
			justify-content: center;
		}

		.requirement-index-meta {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			align-items: center;
			justify-content: flex-end;
		}

		.requirement-index-evidence {
			white-space: nowrap;
		}

		.requirement-index-row--compact {
			padding-top: 0.7rem;
			padding-bottom: 0.7rem;
		}

		.requirement-index-row--compact .requirement-index-header {
			align-items: center;
		}

		.requirements-issue-badge,
		.requirements-issue-count,
		.requirement-detail-metric {
			min-width: 4rem;
			justify-content: center;
		}

		.info-hint {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 0.82rem;
			height: 0.82rem;
			border-radius: 999px;
			border: 1px solid color-mix(in srgb, var(--vscode-inputBorder, var(--vscode-contrastBorder, #6b7280)) 50%, transparent);
			background: transparent;
			color: color-mix(in srgb, var(--vscode-descriptionForeground) 82%, transparent);
			font-size: 0.56rem;
			font-weight: 600;
			line-height: 1;
			cursor: help;
			user-select: none;
			opacity: 0.85;
		}

		.inline-triangle-icon {
			display: block;
			width: 0.65rem;
			height: 0.65rem;
			flex: 0 0 auto;
		}

		.triangle-button-label {
			line-height: 1;
		}

		inc-button .inline-triangle-icon {
			width: 0.72rem;
			height: 0.72rem;
		}

		.info-hint:focus-visible {
			outline: 2px solid var(--vscode-focusBorder);
			outline-offset: 2px;
		}

		.requirement-detail-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 1rem;
		}

		.requirement-detail-heading {
			display: grid;
			gap: 0.25rem;
			min-width: 0;
		}

		.requirement-detail-heading h2,
		.requirement-detail-subtitle {
			margin: 0;
		}

		.requirement-detail-body {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.75rem 1rem;
		}

		.requirement-detail-overview,
		.requirement-detail-body .wide,
		.requirement-readonly-field.wide {
			grid-column: 1 / -1;
		}

		.requirement-readonly-field {
			width: 100%;
		}

		.field-errors {
			color: var(--vscode-errorForeground);
			font-size: 0.875rem;
		}

		.has-errors > .inc-disclosure,
		.has-errors.inc-disclosure {
			outline: 1px solid var(--vscode-errorForeground);
			outline-offset: -1px;
		}

		.list-row.has-errors,
		.requirement-card.has-errors {
			outline: 1px solid var(--vscode-errorForeground);
			outline-offset: -1px;
		}

		@media (max-width: 900px) {
			.form-grid,
			.requirement-detail-body {
				grid-template-columns: 1fr;
			}

			.editor-field--wide,
			.requirement-detail-overview,
			.requirement-detail-body .wide {
				grid-column: auto;
			}

			.list-row {
				grid-template-columns: 1fr;
			}

			.supplemental-section-row {
				grid-template-columns: 1fr;
			}

			.requirement-index-toolbar {
				grid-template-columns: 1fr;
			}

			.requirement-index-filter-group {
				justify-content: flex-start;
			}

			.requirement-index-sort-controls {
				grid-template-columns: 1fr;
				align-items: stretch;
			}

			.requirement-index-sort-select {
				width: 100%;
			}

			.requirement-index-meta {
				justify-content: flex-start;
			}

			.requirement-index-open {
				grid-template-columns: 1fr;
			}

			.hero-actions,
			.card-header-actions,
			.section-actions,
			.requirement-detail-header {
				justify-content: flex-start;
			}

			.requirement-detail-header {
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

	private _webviewReady = false;

	private readonly _pendingRevealCardPaths = new Set<string>();

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
		this._webviewReady = false;
		panel.onDidDispose(() => {
			if (this._panel === panel) {
				this._panel = undefined;
				this._webviewReady = false;
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

	public markWebviewReady(): void {
		this._webviewReady = true;
	}

	public async revealCard(cardPath: string): Promise<void> {
		this._pendingRevealCardPaths.add(cardPath);
		await this.flushPendingReveals();
	}

	public async flushPendingReveals(): Promise<void> {
		if (!this._webviewReady || !this._panel || this._pendingRevealCardPaths.size === 0) {
			return;
		}

		const pendingPaths = Array.from(this._pendingRevealCardPaths);
		this._pendingRevealCardPaths.clear();

		for (const cardPath of pendingPaths) {
			await this._panel.webview.postMessage({
				type: 'reveal',
				cardPath
			});
		}
	}

	public dispose(): void {
		this._watcher?.dispose();
		this._panel = undefined;
		this.provider.releaseDocument(this.uri);
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
