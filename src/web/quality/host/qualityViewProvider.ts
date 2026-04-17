import * as vscode from 'vscode';

import { SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE } from '../../editor/host/specificationCustomEditor.js';
import { MARKDOWN_ARTIFACT_CUSTOM_EDITOR_VIEW_TYPE } from '../../editor/markdown/host/markdownArtifactCustomEditor.js';
import {
	analyzeQualityArtifactSource,
	buildLocalReferenceIndex,
	discoverCanonicalArtifactSources,
	discoverQualityArtifactSources,
	resolveLocalReferenceToken,
	type LocalReferenceIndex,
	type LocalReferenceTarget,
	type QualityArtifactSnapshot,
	type QualityWorkspaceSnapshot
} from '../core.js';

export const QUALITY_VIEW_COMMAND = 'spec-trace-vsce.openQualityView';

type QualityViewHostMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'selectArtifact'; uri: string }
	| { type: 'openArtifact' }
	| { type: 'openReference'; token: string };

type QualityViewSyncMessage = {
	type: 'sync';
	snapshot: QualityWorkspaceSnapshot;
	selectedUri?: string;
};

function isQualityViewHostMessage(value: unknown): value is QualityViewHostMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as { type?: unknown };
	switch (candidate.type) {
		case 'ready':
		case 'refresh':
		case 'openArtifact':
			return true;
		case 'selectArtifact':
			return typeof (value as { uri?: unknown }).uri === 'string';
		case 'openReference':
			return typeof (value as { token?: unknown }).token === 'string';
		default:
			return false;
	}
}

export class QualityViewProvider implements vscode.Disposable {
	private readonly _watchers: vscode.Disposable[] = [];
	private _panel: vscode.WebviewPanel | undefined;
	private _webviewReady = false;
	private _snapshot: QualityWorkspaceSnapshot = {
		state: 'missing',
		message: 'Open a workspace folder to inspect quality artifacts.',
		artifacts: []
	};
	private _selectedArtifactUri: string | undefined;
	private _referenceIndex: LocalReferenceIndex = emptyReferenceIndex();
	private _refreshPromise: Promise<void> | undefined;

	public constructor(
		private readonly extensionContext: vscode.ExtensionContext
	) {}

	public dispose(): void {
		this.disposeWatchers();
		this._panel?.dispose();
		this._panel = undefined;
	}

	public async openQualityView(): Promise<void> {
		const workspaceFolder = this.workspaceFolder;
		if (!workspaceFolder) {
			void vscode.window.showErrorMessage('Open a workspace folder before viewing quality artifacts.');
			return;
		}

		if (this._panel) {
			this._panel.reveal(vscode.ViewColumn.Beside);
			await this.refresh();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'spec-trace-vsce.qualityView',
			'Spec Trace Quality',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'web')
				]
			}
		);

		this._panel = panel;
		this._webviewReady = false;
		panel.webview.html = this.getWebviewHtml(panel.webview);
		panel.onDidDispose(() => {
			if (this._panel === panel) {
				this._panel = undefined;
				this._webviewReady = false;
			}
			this.disposeWatchers();
		});

		panel.webview.onDidReceiveMessage((message: unknown) => {
			if (!isQualityViewHostMessage(message)) {
				return;
			}

			if (message.type === 'ready') {
				this._webviewReady = true;
				void this.refresh();
				return;
			}

			if (message.type === 'refresh') {
				void this.refresh();
				return;
			}

			if (message.type === 'selectArtifact') {
				this._selectedArtifactUri = message.uri;
				void this.syncIfReady();
				return;
			}

			if (message.type === 'openArtifact') {
				void this.openSelectedArtifact();
				return;
			}

			if (message.type === 'openReference') {
				void this.openReference(message.token);
			}
		});

		this.ensureWatchers();
		await this.refresh();
	}

	public async refresh(): Promise<void> {
		if (this._refreshPromise) {
			await this._refreshPromise;
			await this.syncIfReady();
			return;
		}

		this._refreshPromise = this.rebuildSnapshot()
			.catch((error) => {
				console.error('[spec-trace-vsce] Failed to refresh quality view', error);
			})
			.finally(() => {
				this._refreshPromise = undefined;
			});

		await this._refreshPromise;
	}

	private async rebuildSnapshot(): Promise<void> {
		const workspaceFolder = this.workspaceFolder;
		if (!workspaceFolder) {
			this._snapshot = {
				state: 'missing',
				message: 'Open a workspace folder before viewing quality artifacts.',
				artifacts: []
			};
			this._referenceIndex = emptyReferenceIndex();
			this._selectedArtifactUri = undefined;
			await this.syncIfReady();
			return;
		}

		const [qualitySources, canonicalSources] = await Promise.all([
			discoverQualityArtifactSources(workspaceFolder),
			discoverCanonicalArtifactSources(workspaceFolder)
		]);

		this._referenceIndex = buildLocalReferenceIndex(canonicalSources);
		const artifacts = qualitySources.map((source) => analyzeQualityArtifactSource(source, this._referenceIndex));
		artifacts.sort((left, right) => compareQualityArtifacts(left, right));

		const selectedUri = this.resolveSelectedUri(artifacts);
		this._snapshot = {
			state: artifacts.length === 0 ? 'missing' : artifacts.some((artifact) => artifact.health === 'error' || artifact.health === 'warning') ? 'warning' : 'ok',
			message: artifacts.length === 0
				? 'No local quality or attestation artifacts were found in this workspace.'
				: artifacts.some((artifact) => artifact.health === 'error' || artifact.health === 'warning')
					? 'Some quality artifacts are malformed or incomplete.'
					: 'Quality artifacts were discovered locally.',
			artifacts
		};
		this._selectedArtifactUri = selectedUri;
		await this.syncIfReady();
	}

	private resolveSelectedUri(artifacts: readonly QualityArtifactSnapshot[]): string | undefined {
		if (this._selectedArtifactUri && artifacts.some((artifact) => artifact.uri.toString() === this._selectedArtifactUri)) {
			return this._selectedArtifactUri;
		}

		return artifacts[0]?.uri.toString();
	}

	private async openSelectedArtifact(): Promise<void> {
		const selected = this.getSelectedArtifact();
		if (!selected) {
			void vscode.window.showInformationMessage('No quality artifact is selected.');
			return;
		}

		await vscode.commands.executeCommand('vscode.open', selected.uri);
	}

	private async openReference(token: string): Promise<void> {
		const target = resolveLocalReferenceToken(token, this._referenceIndex, this.workspaceFolder);
		if (!target) {
			void vscode.window.showErrorMessage(`Unable to resolve local reference "${token}".`);
			const selected = this.getSelectedArtifact();
			if (selected) {
				await vscode.commands.executeCommand('vscode.open', selected.uri);
			}
			return;
		}

		if (target.kind === 'requirement') {
			await vscode.commands.executeCommand('vscode.openWith', target.uri, SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE);
			return;
		}

		if (target.kind === 'markdown') {
			await vscode.commands.executeCommand('vscode.openWith', target.uri, MARKDOWN_ARTIFACT_CUSTOM_EDITOR_VIEW_TYPE);
			return;
		}

		await vscode.commands.executeCommand('vscode.open', target.uri);
	}

	private async syncIfReady(): Promise<void> {
		if (!this._panel || !this._webviewReady) {
			return;
		}

		const message: QualityViewSyncMessage = {
			type: 'sync',
			snapshot: this._snapshot,
			selectedUri: this._selectedArtifactUri
		};

		await this._panel.webview.postMessage(message);
	}

	private getSelectedArtifact(): QualityArtifactSnapshot | undefined {
		const selectedUri = this._selectedArtifactUri;
		if (!selectedUri) {
			return this._snapshot.artifacts[0];
		}

		return this._snapshot.artifacts.find((artifact) => artifact.uri.toString() === selectedUri) ?? this._snapshot.artifacts[0];
	}

	private ensureWatchers(): void {
		if (this._watchers.length > 0) {
			return;
		}

		const workspaceFolder = this.workspaceFolder;
		if (!workspaceFolder) {
			return;
		}

		const refresh = () => {
			void this.refresh();
		};

		const patterns = [
			'quality/testing-intent.yaml',
			'quality/testing-intent.yml',
			'artifacts/quality/**/*',
			'specs/requirements/**/*.json',
			'specs/architecture/**/*.md',
			'specs/work-items/**/*.md',
			'specs/verification/**/*.md'
		];

		for (const pattern of patterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, pattern), false, false, false);
			watcher.onDidCreate(refresh);
			watcher.onDidChange(refresh);
			watcher.onDidDelete(refresh);
			this._watchers.push(watcher);
		}
	}

	private disposeWatchers(): void {
		for (const watcher of this._watchers) {
			watcher.dispose();
		}

		this._watchers.length = 0;
	}

	private get workspaceFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	private getWebviewHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'web', 'quality', 'webview', 'main.js')
		);
		const nonce = createNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Spec Trace Quality</title>
	<style>
		:root {
			color-scheme: light dark;
			font-family: var(--vscode-font-family);
			--surface: var(--vscode-editor-background, #1e1e1e);
			--surface-raised: color-mix(in srgb, var(--surface) 94%, var(--vscode-editor-foreground) 6%);
			--surface-muted: color-mix(in srgb, var(--surface) 90%, var(--vscode-editor-foreground) 10%);
			--border: color-mix(in srgb, var(--vscode-panel-border, #888) 72%, transparent);
		}
		html, body {
			margin: 0;
			min-height: 100%;
			background: radial-gradient(circle at top, color-mix(in srgb, var(--vscode-editor-background) 74%, #102040 26%), var(--surface));
			color: var(--vscode-foreground);
		}
		#app {
			box-sizing: border-box;
			min-height: 100vh;
			padding: 20px;
		}
		.panel {
			display: grid;
			gap: 16px;
			max-width: 1360px;
			margin: 0 auto;
		}
		.card {
			border: 1px solid var(--border);
			border-radius: 14px;
			background: color-mix(in srgb, var(--surface) 96%, var(--vscode-editor-foreground) 4%);
			box-shadow: 0 12px 30px rgba(0, 0, 0, 0.12);
			padding: 16px;
		}
		.summary-title {
			margin-bottom: 8px;
			font-size: 1.05rem;
			font-weight: 600;
		}
		.hero {
			display: grid;
			gap: 12px;
		}
		.hero__header {
			display: flex;
			flex-wrap: wrap;
			justify-content: space-between;
			gap: 12px;
			align-items: flex-start;
		}
		.hero__title {
			display: grid;
			gap: 6px;
		}
		.hero__title h1,
		.card h2 {
			margin: 0;
		}
		.muted {
			color: var(--vscode-descriptionForeground);
		}
		.toolbar,
		.chips,
		.row {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: center;
		}
		.toolbar {
			justify-content: flex-end;
		}
		.chip {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 4px 10px;
			border-radius: 999px;
			background: var(--surface-muted);
			border: 1px solid var(--border);
			font-size: 12px;
			font-weight: 600;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px 16px;
		}
		.field {
			display: grid;
			gap: 6px;
			min-width: 0;
		}
		.field--wide {
			grid-column: 1 / -1;
		}
		label {
			font-size: 12px;
			font-weight: 700;
			color: var(--vscode-descriptionForeground);
		}
		select, button {
			font: inherit;
		}
		select {
			width: 100%;
			box-sizing: border-box;
			border-radius: 8px;
			border: 1px solid var(--border);
			background: color-mix(in srgb, var(--surface) 95%, var(--vscode-editor-foreground) 5%);
			color: var(--vscode-foreground);
			padding: 8px 10px;
		}
		button {
			border: 1px solid var(--border);
			border-radius: 999px;
			padding: 7px 12px;
			background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 86%, var(--surface) 14%);
			color: var(--vscode-button-foreground, #fff);
			cursor: pointer;
		}
		button.secondary {
			background: var(--surface-muted);
			color: var(--vscode-foreground);
		}
		button:disabled {
			opacity: 0.55;
			cursor: not-allowed;
		}
		.summary-grid {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 12px;
		}
		.metric {
			display: grid;
			gap: 4px;
			padding: 12px;
			border-radius: 12px;
			background: color-mix(in srgb, var(--surface) 88%, var(--vscode-editor-foreground) 12%);
			border: 1px solid var(--border);
		}
		.metric__value {
			font-size: 20px;
			font-weight: 700;
		}
		.metric__label {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
		}
		.stack {
			display: grid;
			gap: 12px;
		}
		.list {
			display: grid;
			gap: 8px;
			margin: 0;
			padding: 0;
			list-style: none;
		}
		.list-item {
			display: grid;
			gap: 4px;
			padding: 10px 12px;
			border-radius: 10px;
			border: 1px solid var(--border);
			background: color-mix(in srgb, var(--surface) 92%, var(--vscode-editor-foreground) 8%);
		}
		.list-item__row {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
		}
		.list-item__title {
			font-weight: 600;
		}
		.list-item__meta {
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
		}
		details {
			border: 1px solid var(--border);
			border-radius: 12px;
			padding: 12px 14px;
			background: color-mix(in srgb, var(--surface) 90%, var(--vscode-editor-foreground) 10%);
		}
		summary {
			cursor: pointer;
			font-weight: 700;
		}
		pre {
			white-space: pre-wrap;
			word-break: break-word;
			font: inherit;
			margin: 0;
		}
		.banner {
			padding: 10px 12px;
			border-radius: 10px;
			border: 1px solid var(--border);
			background: color-mix(in srgb, var(--surface-muted) 88%, var(--vscode-editor-foreground) 12%);
		}
		.banner--warning {
			border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #c58b00) 50%, var(--border));
		}
		.banner--error {
			border-color: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 50%, var(--border));
		}
		.empty {
			display: grid;
			gap: 10px;
			padding: 24px;
			text-align: center;
		}
		@media (max-width: 960px) {
			.grid,
			.summary-grid {
				grid-template-columns: 1fr;
			}
			.field--wide {
				grid-column: auto;
			}
		}
	</style>
</head>
<body>
	<div id="app" class="panel">
		<section class="card hero">
			<div class="hero__header">
				<div class="hero__title">
					<h1>Spec Trace Quality</h1>
					<div class="muted">Read-only view over workspace-local quality and attestation artifacts.</div>
				</div>
				<div class="toolbar">
					<button id="refresh-button" class="secondary" type="button">Refresh</button>
					<button id="open-raw-button" type="button">Open raw</button>
				</div>
			</div>
			<div id="banner-slot"></div>
			<div class="row">
				<div class="field field--wide">
					<label for="artifact-select">Artifact</label>
					<select id="artifact-select"></select>
				</div>
			</div>
			<div id="status-chips" class="chips"></div>
		</section>
		<section id="summary-card" class="card stack"></section>
		<section id="detail-card" class="card stack"></section>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function compareQualityArtifacts(left: QualityArtifactSnapshot, right: QualityArtifactSnapshot): number {
	const kindOrder = qualityKindOrder(left.kind) - qualityKindOrder(right.kind);
	if (kindOrder !== 0) {
		return kindOrder;
	}

	return left.relativePath.localeCompare(right.relativePath);
}

function qualityKindOrder(kind: QualityArtifactSnapshot['kind']): number {
	switch (kind) {
		case 'quality_report':
			return 0;
		case 'attestation':
			return 1;
		case 'coverage':
			return 2;
		case 'report':
			return 3;
		case 'markdown':
			return 4;
		case 'testing_intent':
			return 5;
		case 'unknown':
			return 6;
	}
}

function emptyReferenceIndex(): LocalReferenceIndex {
	return {
		artifactTargets: new Map<string, LocalReferenceTarget>(),
		requirementTargets: new Map<string, LocalReferenceTarget>(),
		pathTargets: new Map<string, LocalReferenceTarget>()
	};
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let output = '';
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	for (const byte of bytes) {
		output += alphabet[byte % alphabet.length];
	}

	return output;
}
