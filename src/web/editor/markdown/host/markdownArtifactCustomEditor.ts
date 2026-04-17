import * as vscode from 'vscode';

import {
	createEmptyManagedMarkdownDocument,
	getManagedMarkdownArtifactTypeFromPath,
	getManagedMarkdownSectionHeading,
	getManagedMarkdownSectionKeys,
	getTraceFieldForArtifactType,
	normalizeManagedMarkdownDocument,
	parseManagedMarkdownDocument,
	serializeManagedMarkdownDocument,
	validateManagedMarkdownDocument,
	type ManagedMarkdownArtifactType,
	type ManagedMarkdownDocument,
	type ManagedMarkdownSectionKey,
	type ManagedMarkdownValidationIssue
} from '../core.js';
import { SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE } from '../../host/specificationCustomEditor.js';

export const MARKDOWN_ARTIFACT_CUSTOM_EDITOR_VIEW_TYPE = 'spec-trace-vsce.markdownArtifactEditor';

type ManagedMarkdownEditorHostMessage =
	| { type: 'ready' }
	| { type: 'edit'; document: ManagedMarkdownDocument }
	| { type: 'save' | 'openText' }
	| { type: 'openReference'; token: string };

type ManagedMarkdownEditorSyncMessage = {
	type: 'sync';
	document: ManagedMarkdownDocument;
	issues: ManagedMarkdownValidationIssue[];
	isDirty: boolean;
	externalConflict: boolean;
	referenceChoices: ReferenceChoice[];
};

interface ReferenceChoice {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly kind: 'requirement' | 'artifact' | 'file';
}

interface FileSystemLike {
	stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
	createDirectory(uri: vscode.Uri): Thenable<void>;
	writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
	readFile(uri: vscode.Uri): Thenable<Uint8Array>;
	readDirectory(uri: vscode.Uri): Thenable<readonly [string, vscode.FileType][]>;
}

interface WindowLike {
	showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
	showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

interface CommandsLike {
	executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T>;
}

function isManagedMarkdownEditorHostMessage(value: unknown): value is ManagedMarkdownEditorHostMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as { type?: unknown };
	if (candidate.type === 'ready' || candidate.type === 'save' || candidate.type === 'openText') {
		return true;
	}

	if (candidate.type === 'edit') {
		return typeof (value as { document?: unknown }).document === 'object';
	}

	if (candidate.type === 'openReference') {
		return typeof (value as { token?: unknown }).token === 'string';
	}

	return false;
}

export class MarkdownArtifactCustomEditorProvider implements vscode.CustomEditorProvider<ManagedMarkdownCustomDocument> {
	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ManagedMarkdownCustomDocument>>();
	private readonly _documents = new Map<string, ManagedMarkdownCustomDocument>();

	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	public constructor(
		private readonly extensionContext: vscode.ExtensionContext,
		public readonly fileSystem: FileSystemLike = vscode.workspace.fs,
		private readonly windowApi: WindowLike = vscode.window,
		private readonly commandsApi: CommandsLike = vscode.commands
	) {}

	public async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken
	): Promise<ManagedMarkdownCustomDocument> {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (!workspaceFolder) {
			throw new Error('Spec Trace markdown files can only be opened from a workspace folder.');
		}

		const relativePath = vscode.workspace.asRelativePath(uri, false);
		const expectedType = getManagedMarkdownArtifactTypeFromPath(relativePath);
		if (!expectedType) {
			throw new Error('Managed markdown editor only supports canonical architecture, work-item, and verification files.');
		}

		const { text, document } = await this.readDocumentSnapshot(uri, openContext);
		if (!document) {
			throw new Error('The document could not be parsed as markdown.');
		}

		if (document.artifact_type !== expectedType) {
			throw new Error('The file does not match the managed canonical markdown artifact type for this path.');
		}

		const customDocument = new ManagedMarkdownCustomDocument(workspaceFolder, uri, relativePath, text, document, this);
		this._documents.set(uri.toString(), customDocument);
		return customDocument;
	}

	public resolveCustomEditor(
		document: ManagedMarkdownCustomDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): void {
		document.attachWebviewPanel(webviewPanel);
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'web')]
		};
		webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview);
		webviewPanel.webview.onDidReceiveMessage((message: unknown) => {
			if (!isManagedMarkdownEditorHostMessage(message)) {
				return;
			}

			if (message.type === 'ready') {
				document.markWebviewReady();
				void this.syncDocument(document, 'open');
				return;
			}

			if (message.type === 'save') {
				void this.saveDocumentToUri(document, document.uri).catch((error) => {
					console.error('[spec-trace-vsce] managed markdown save failed', error);
				});
				return;
			}

			if (message.type === 'openText') {
				void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
				return;
			}

			if (message.type === 'openReference') {
				void this.openReference(message.token);
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
					label: 'Update managed markdown artifact',
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
			}
		});
	}

	public async openManagedMarkdownDocument(uri: vscode.Uri): Promise<void> {
		await vscode.commands.executeCommand('vscode.openWith', uri, MARKDOWN_ARTIFACT_CUSTOM_EDITOR_VIEW_TYPE);
	}

	public async saveCustomDocument(document: ManagedMarkdownCustomDocument, cancellation: vscode.CancellationToken): Promise<void> {
		await this.saveDocumentToUri(document, document.uri, cancellation);
	}

	public async saveCustomDocumentAs(
		document: ManagedMarkdownCustomDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		const destinationWorkspaceFolder = vscode.workspace.getWorkspaceFolder(destination);
		if (!destinationWorkspaceFolder || destinationWorkspaceFolder.uri.toString() !== document.workspaceFolder.uri.toString()) {
			throw new Error('Spec Trace markdown files can only be saved inside the current workspace repository root.');
		}

		await this.saveDocumentToUri(document, destination, cancellation);
	}

	public async revertCustomDocument(document: ManagedMarkdownCustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		const { text, document: parsed } = await this.readDocumentSnapshot(document.uri, undefined);
		if (!parsed) {
			throw new Error('The document could not be reloaded as markdown.');
		}

		document.replaceWithSnapshot(text, parsed);
		await this.syncDocument(document, 'revert');
	}

	public async backupCustomDocument(
		document: ManagedMarkdownCustomDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		const backupUri = this.createBackupUri(document, context);
		await this.ensureBackupFolderExists();
		await this.fileSystem.writeFile(backupUri, new TextEncoder().encode(serializeManagedMarkdownDocument(document.state)));

		return {
			id: backupUri.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(backupUri);
				} catch {
					// Ignore backup cleanup failures.
				}
			}
		};
	}

	public async syncDocument(document: ManagedMarkdownCustomDocument, _source: 'open' | 'undo' | 'redo' | 'revert' | 'save' | 'external'): Promise<void> {
		await document.postToWebview({
			type: 'sync',
			document: normalizeManagedMarkdownDocument(document.state),
			issues: await this.buildValidationIssues(document),
			isDirty: document.isDirty,
			externalConflict: document.externalConflict,
			referenceChoices: await this.collectReferenceChoices(document.workspaceFolder)
		});
		await document.flushPendingRefresh();
	}

	public releaseDocument(uri: vscode.Uri): void {
		this._documents.delete(uri.toString());
	}

	private async openReference(token: string): Promise<void> {
		const resolved = await this.resolveReference(token);
		if (!resolved) {
			void this.windowApi.showErrorMessage(`Unable to resolve reference "${token}".`);
			return;
		}

		if (resolved.kind === 'requirement') {
			await this.commandsApi.executeCommand('vscode.openWith', resolved.uri, SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE);
			return;
		}

		if (resolved.kind === 'artifact') {
			if (resolved.managedMarkdown) {
				await this.commandsApi.executeCommand('vscode.openWith', resolved.uri, MARKDOWN_ARTIFACT_CUSTOM_EDITOR_VIEW_TYPE);
				return;
			}

			await this.commandsApi.executeCommand('vscode.open', resolved.uri);
			return;
		}

		await this.commandsApi.executeCommand('vscode.open', resolved.uri);
	}

	private async resolveReference(token: string): Promise<ResolvedReference | undefined> {
		const workspaceFolder = this.getWorkspaceFolder();
		if (!workspaceFolder) {
			return undefined;
		}

		const normalized = token.trim();
		if (normalized.length === 0) {
			return undefined;
		}

		const explicitUri = await this.tryResolveExplicitWorkspacePath(workspaceFolder, normalized);
		if (explicitUri) {
			return { kind: 'file', uri: explicitUri };
		}

		const choices = await this.collectReferenceChoices(workspaceFolder);
		const match = choices.find((choice) => choice.value === normalized || choice.label === normalized);
		if (match) {
			return match.resolved;
		}

		return undefined;
	}

	private async tryResolveExplicitWorkspacePath(workspaceFolder: vscode.WorkspaceFolder, token: string): Promise<vscode.Uri | undefined> {
		if (!token.includes('/')) {
			return undefined;
		}

		const target = vscode.Uri.joinPath(workspaceFolder.uri, ...token.split('/'));
		try {
			await this.fileSystem.stat(target);
			return target;
		} catch {
			return undefined;
		}
	}

	private async collectReferenceChoices(workspaceFolder: vscode.WorkspaceFolder): Promise<ReferenceChoiceWithTarget[]> {
		const [specificationChoices, markdownChoices] = await Promise.all([
			this.collectSpecificationReferenceChoices(workspaceFolder),
			this.collectManagedMarkdownReferenceChoices(workspaceFolder)
		]);

		return [...specificationChoices, ...markdownChoices];
	}

	private async collectSpecificationReferenceChoices(workspaceFolder: vscode.WorkspaceFolder): Promise<ReferenceChoiceWithTarget[]> {
		const results: ReferenceChoiceWithTarget[] = [];
		const files = await vscode.workspace.findFiles('specs/requirements/**/*.json', EXCLUDED_WORKSPACE_GLOBS);
		for (const uri of files) {
			const text = await this.readText(uri);
			try {
				const parsed = JSON.parse(text) as {
					artifact_id?: string;
					title?: string;
					requirements?: Array<{ id?: string; title?: string }>;
				};
				const artifactId = stringValue(parsed.artifact_id);
				const title = stringValue(parsed.title) || basenameFromUri(uri).replace(/\.json$/i, '');
				if (artifactId.length > 0) {
					results.push({
						value: artifactId,
						label: artifactId,
						description: title,
						kind: 'artifact',
						resolved: { kind: 'artifact', uri, managedMarkdown: false }
					});
				}

				const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
				for (const [index, requirement] of requirements.entries()) {
					const requirementId = stringValue(requirement?.id);
					if (requirementId.length === 0) {
						continue;
					}

					results.push({
						value: requirementId,
						label: requirementId,
						description: requirement?.title ? `${title} • ${requirement.title}` : title,
						kind: 'requirement',
						resolved: { kind: 'requirement', uri, requirementIndex: index }
					});
				}
			} catch {
				// Ignore malformed specification files for picker purposes.
			}
		}

		return results;
	}

	private async collectManagedMarkdownReferenceChoices(workspaceFolder: vscode.WorkspaceFolder): Promise<ReferenceChoiceWithTarget[]> {
		const results: ReferenceChoiceWithTarget[] = [];
		const files = await vscode.workspace.findFiles('{specs/architecture/**/*.md,specs/work-items/**/*.md,specs/verification/**/*.md}', EXCLUDED_WORKSPACE_GLOBS);
		for (const uri of files) {
			const relativePath = vscode.workspace.asRelativePath(uri, false);
			const text = await this.readText(uri);
			const parsed = parseManagedMarkdownDocument(text);
			const managedDocument = normalizeManagedMarkdownDocument(parsed);
			if (!managedDocument.artifact_id || !managedDocument.artifact_type) {
				continue;
			}

			const expectedType = getManagedMarkdownArtifactTypeFromPath(relativePath);
			if (!expectedType || managedDocument.artifact_type !== expectedType) {
				continue;
			}

			results.push({
				value: managedDocument.artifact_id,
				label: managedDocument.artifact_id,
				description: `${managedDocument.title || managedDocument.artifact_id} • ${managedDocument.artifact_type}`,
				kind: 'artifact',
				resolved: { kind: 'artifact', uri, managedMarkdown: true }
			});
		}

		return results;
	}

	private async buildValidationIssues(document: ManagedMarkdownCustomDocument): Promise<ManagedMarkdownValidationIssue[]> {
		const issues = validateManagedMarkdownDocument(document.state, document.workspaceRelativePath);
		const choices = await this.collectReferenceChoices(document.workspaceFolder);
		const referenceValues = new Set(choices.map((choice) => choice.value));
		for (const field of ['related_artifacts', getTraceFieldForArtifactType(document.state.artifact_type ?? 'architecture')] as const) {
			const values = document.state[field];
			if (!Array.isArray(values)) {
				continue;
			}

			for (const value of values) {
				const trimmed = value.trim();
				if (trimmed.length === 0 || referenceValues.has(trimmed)) {
					continue;
				}

				issues.push({
					path: field,
					message: `Reference "${trimmed}" is not currently discoverable in this workspace.`,
					severity: 'warning'
				});
			}
		}

		return issues;
	}

	private async saveDocumentToUri(
		document: ManagedMarkdownCustomDocument,
		targetUri: vscode.Uri,
		_cancellation?: vscode.CancellationToken
	): Promise<void> {
		const issues = await this.buildValidationIssues(document);
		const blockingIssues = issues.filter((issue) => issue.severity === 'error');
		if (blockingIssues.length > 0) {
			const summary = blockingIssues.slice(0, 3).map((issue) => `${issue.path || 'document'}: ${issue.message}`).join('; ');
			throw new Error(`Cannot save an invalid markdown artifact: ${summary}`);
		}

		const serialized = serializeManagedMarkdownDocument(document.state);
		const diskText = await this.readRawTextIfPresent(targetUri);
		if (diskText !== undefined && diskText !== document.lastDiskText && diskText !== serialized) {
			throw new Error('The markdown artifact has changed on disk since it was loaded. Reopen or revert before saving.');
		}

		await this.ensureDirectoryExists(targetUri);
		await this.fileSystem.writeFile(targetUri, new TextEncoder().encode(serialized));
		document.markSaved(serialized);
		await this.syncDocument(document, 'save');
	}

	private async readDocumentSnapshot(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext | undefined
	): Promise<{
		text: string;
		document: ManagedMarkdownDocument | undefined;
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

		const parsed = parseManagedMarkdownDocument(text);
		const document = normalizeManagedMarkdownDocument(parsed);
		return {
			text,
			document: document.artifact_type ? document : undefined
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
		const bytes = await this.fileSystem.readFile(uri);
		return new TextDecoder().decode(bytes);
	}

	private async readText(uri: vscode.Uri): Promise<string> {
		return this.readTextFromUri(uri);
	}

	private async ensureDirectoryExists(uri: vscode.Uri): Promise<void> {
		const directoryUri = uri.with({
			path: uri.path.substring(0, uri.path.lastIndexOf('/')) || '/'
		});
		await this.fileSystem.createDirectory(directoryUri);
	}

	private createBackupUri(document: ManagedMarkdownCustomDocument, context: vscode.CustomDocumentBackupContext): vscode.Uri {
		const backupFolder = vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'spec-trace-vsce', 'markdown-backups');
		const key = uriToHex(document.uri.toString());
		return vscode.Uri.joinPath(backupFolder, `${key}.md`);
	}

	private async ensureBackupFolderExists(): Promise<void> {
		const backupFolder = vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'spec-trace-vsce', 'markdown-backups');
		await this.fileSystem.createDirectory(backupFolder);
	}

	private getWebviewHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'web', 'editor', 'markdown', 'webview', 'main.js')
		);
		const nonce = createNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Spec Trace Managed Markdown Editor</title>
	<style>
		:root {
			color-scheme: light dark;
			font-family: var(--vscode-font-family);
			--panel-border: color-mix(in srgb, var(--vscode-panel-border, #888) 70%, transparent);
			--surface: var(--vscode-editor-background, #1e1e1e);
			--surface-muted: color-mix(in srgb, var(--surface) 88%, var(--vscode-editor-foreground, #fff) 12%);
		}
		html, body {
			margin: 0;
			min-height: 100%;
			background: var(--surface);
			color: var(--vscode-foreground);
		}
		#app {
			box-sizing: border-box;
			min-height: 100vh;
			padding: 20px;
		}
		.editor-shell {
			display: grid;
			gap: 16px;
			max-width: 1280px;
			margin: 0 auto;
		}
		.card {
			border: 1px solid var(--panel-border);
			border-radius: 12px;
			background: color-mix(in srgb, var(--surface) 96%, var(--vscode-editor-foreground) 4%);
			padding: 16px;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px 16px;
		}
		.field {
			display: grid;
			gap: 6px;
		}
		.field--wide {
			grid-column: 1 / -1;
		}
		label {
			font-size: 12px;
			font-weight: 600;
			color: var(--vscode-descriptionForeground);
		}
		input, select, textarea, button {
			font: inherit;
		}
		input, select, textarea {
			width: 100%;
			box-sizing: border-box;
			border: 1px solid var(--panel-border);
			border-radius: 8px;
			background: color-mix(in srgb, var(--surface) 94%, var(--vscode-editor-foreground) 6%);
			color: var(--vscode-foreground);
			padding: 8px 10px;
		}
		textarea {
			min-height: 108px;
			resize: vertical;
		}
		.small {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
		}
		.actions {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: center;
		}
		.list-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 8px;
			align-items: start;
		}
		.list-items {
			display: grid;
			gap: 8px;
		}
		.list-item {
			display: grid;
			gap: 6px;
			border: 1px solid var(--panel-border);
			border-radius: 10px;
			padding: 10px;
			background: color-mix(in srgb, var(--surface) 92%, var(--vscode-editor-foreground) 8%);
		}
		.list-item__controls {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
		}
		.preview-shell {
			display: grid;
			gap: 12px;
		}
		.validation-list {
			display: grid;
			gap: 4px;
			margin: 0;
			padding-left: 18px;
		}
		.validation-item--warning {
			color: var(--vscode-editorWarning-foreground, #c58b00);
		}
		.validation-item--error {
			color: var(--vscode-errorForeground, #f14c4c);
		}
		details {
			border: 1px solid var(--panel-border);
			border-radius: 10px;
			padding: 10px 12px;
		}
		summary {
			cursor: pointer;
			font-weight: 600;
		}
		pre {
			white-space: pre-wrap;
			word-break: break-word;
			margin: 0;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
		}
		@media (max-width: 900px) {
			.grid {
				grid-template-columns: 1fr;
			}
			.field--wide {
				grid-column: auto;
			}
			.list-row {
				grid-template-columns: 1fr;
			}
		}
	</style>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}
}

class ManagedMarkdownCustomDocument implements vscode.CustomDocument {
	public readonly uri: vscode.Uri;

	public readonly workspaceFolder: vscode.WorkspaceFolder;

	public readonly workspaceRelativePath: string;

	private readonly provider: MarkdownArtifactCustomEditorProvider;

	private _history: ManagedMarkdownDocument[];
	private _historyIndex = 0;
	private _savedHistoryIndex = 0;
	private _lastDiskText: string;
	private _externalConflict = false;
	private _panel: vscode.WebviewPanel | undefined;
	private _watcher: vscode.FileSystemWatcher | undefined;
	private _webviewReady = false;
	private readonly _pendingRefresh = new Set<'sync'>();

	public constructor(
		workspaceFolder: vscode.WorkspaceFolder,
		uri: vscode.Uri,
		workspaceRelativePath: string,
		initialDiskText: string,
		initialDocument: ManagedMarkdownDocument,
		provider: MarkdownArtifactCustomEditorProvider
	) {
		this.workspaceFolder = workspaceFolder;
		this.uri = uri;
		this.workspaceRelativePath = workspaceRelativePath;
		this.provider = provider;
		this._history = [cloneDocument(initialDocument)];
		this._historyIndex = 0;
		this._savedHistoryIndex = 0;
		this._lastDiskText = initialDiskText;
		this._watcher = this.createWatcher();
	}

	public get state(): ManagedMarkdownDocument {
		return this._history[this._historyIndex];
	}

	public get historyIndex(): number {
		return this._historyIndex;
	}

	public get externalConflict(): boolean {
		return this._externalConflict;
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

	public applyEdit(nextState: ManagedMarkdownDocument): number {
		const currentText = serializeManagedMarkdownDocument(this.state);
		const nextText = serializeManagedMarkdownDocument(nextState);
		if (currentText === nextText) {
			return this._historyIndex;
		}

		this._history = this._history.slice(0, this._historyIndex + 1);
		this._history.push(cloneDocument(nextState));
		this._historyIndex = this._history.length - 1;
		return this._historyIndex;
	}

	public setHistoryIndex(index: number): void {
		if (index < 0 || index >= this._history.length) {
			return;
		}

		this._historyIndex = index;
	}

	public replaceWithSnapshot(diskText: string, snapshot: ManagedMarkdownDocument): void {
		this._history = [cloneDocument(snapshot)];
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

	public async postToWebview(message: ManagedMarkdownEditorSyncMessage): Promise<boolean | undefined> {
		return this._panel?.webview.postMessage(message);
	}

	public markWebviewReady(): void {
		this._webviewReady = true;
	}

	public async flushPendingRefresh(): Promise<void> {
		if (!this._webviewReady || !this._panel || this._pendingRefresh.size === 0) {
			return;
		}

		this._pendingRefresh.clear();
	}

	public dispose(): void {
		this._watcher?.dispose();
		this._panel = undefined;
		this.provider.releaseDocument(this.uri);
	}

	private createWatcher(): vscode.FileSystemWatcher {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.workspaceFolder, this.workspaceRelativePath),
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

		const parsed = parseManagedMarkdownDocument(diskText);
		const normalized = normalizeManagedMarkdownDocument(parsed);
		if (!normalized.artifact_type) {
			this.markExternalConflict();
			await this.provider.syncDocument(this, 'external');
			return;
		}

		if (this.isDirty) {
			this.markExternalConflict();
			await this.provider.syncDocument(this, 'external');
			return;
		}

		this.replaceWithSnapshot(diskText, normalized);
		await this.provider.syncDocument(this, 'external');
	}

	private async readTextFromUri(uri: vscode.Uri): Promise<string> {
		const bytes = await this.provider.fileSystem.readFile(uri);
		return new TextDecoder().decode(bytes);
	}
}

interface ResolvedReference {
	readonly kind: 'artifact' | 'requirement' | 'file';
	readonly uri: vscode.Uri;
	readonly requirementIndex?: number;
	readonly managedMarkdown?: boolean;
}

interface ReferenceChoiceWithTarget extends ReferenceChoice {
	readonly resolved: ResolvedReference;
}

function cloneDocument(document: ManagedMarkdownDocument): ManagedMarkdownDocument {
	return JSON.parse(JSON.stringify(document)) as ManagedMarkdownDocument;
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	const randomValues = crypto.getRandomValues(new Uint8Array(16));
	for (const value of randomValues) {
		result += alphabet[value % alphabet.length];
	}

	return result;
}

function uriToHex(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let output = '';
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, '0');
	}

	return output;
}

const EXCLUDED_WORKSPACE_GLOBS = '{**/node_modules/**,**/dist/**,**/.git/**,**/.vscode-test-web/**,**/.workbench/**,**/artifacts/**}';

function basenameFromUri(uri: vscode.Uri): string {
	const normalized = uri.path.replace(/\\/g, '/');
	const index = normalized.lastIndexOf('/');
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}
