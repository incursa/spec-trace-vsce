import * as vscode from 'vscode';

import {
	analyzeTraceability,
	type CanonicalSource,
	type TraceabilitySnapshot,
	type TraceBacklink,
	type TraceFinding,
	type TraceReference
} from './core.js';

export const TRACEABILITY_VIEW_ID = 'specTraceExplorer.traceability';
export const TRACEABILITY_VALIDATE_COMMAND = 'spec-trace-vsce.validateRepository';
export const TRACEABILITY_OPEN_COMMAND = 'spec-trace-vsce.openTraceabilityItem';

type RootGroup = 'validation' | 'traceability' | 'missing-proof' | 'broken-links' | 'duplicates' | 'backlinks' | 'provenance';

interface TraceabilityNodeData {
	readonly kind: 'group' | 'finding' | 'reference' | 'backlink' | 'provenance' | 'empty';
	readonly group?: RootGroup;
	readonly path?: string;
	readonly itemId?: string;
}

export class TraceabilityTreeItem extends vscode.TreeItem {
	public constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly data: TraceabilityNodeData,
		description?: string,
		tooltip?: string,
		icon?: vscode.ThemeIcon
	) {
		super(label, collapsibleState);
		this.description = description;
		this.tooltip = tooltip;
		this.iconPath = icon;
		if (data.path) {
			this.command = {
				command: TRACEABILITY_OPEN_COMMAND,
				title: 'Open canonical source',
				arguments: [this]
			};
		}
	}
}

export function registerTraceabilityView(context: vscode.ExtensionContext): TraceabilityProvider {
	const provider = new TraceabilityProvider();
	const view = vscode.window.createTreeView(TRACEABILITY_VIEW_ID, {
		treeDataProvider: provider,
		showCollapseAll: true
	});

	context.subscriptions.push(
		provider,
		view,
		vscode.commands.registerCommand(TRACEABILITY_VALIDATE_COMMAND, async () => {
			const snapshot = await provider.refreshAndGetSnapshot();
			await vscode.commands.executeCommand('workbench.view.extension.specTraceExplorer');
			const errors = snapshot.findings.filter((finding) => finding.severity === 'error').length;
			const warnings = snapshot.findings.length - errors;
			void vscode.window.showInformationMessage(
				`SpecTrace validation inspected ${snapshot.artifacts} artifacts and ${snapshot.requirements} requirements: ${errors} errors, ${warnings} warnings.`
			);
		}),
		vscode.commands.registerCommand(TRACEABILITY_OPEN_COMMAND, async (item: TraceabilityTreeItem) => {
			await provider.openItem(item);
		})
	);

	return provider;
}

export class TraceabilityProvider implements vscode.TreeDataProvider<TraceabilityTreeItem>, vscode.Disposable {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TraceabilityTreeItem | undefined | void>();
	private readonly watchers: vscode.Disposable[] = [];
	private snapshotPromise: Promise<TraceabilitySnapshot> | undefined;

	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	public constructor() {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return;
		}

		for (const pattern of ['specs/requirements/**/*.json', 'specs/architecture/**/*.md', 'specs/work-items/**/*.md', 'specs/verification/**/*.md']) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, pattern), false, false, false);
			watcher.onDidCreate(() => this.refresh());
			watcher.onDidChange(() => this.refresh());
			watcher.onDidDelete(() => this.refresh());
			this.watchers.push(watcher);
		}
	}

	public dispose(): void {
		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		this.onDidChangeTreeDataEmitter.dispose();
	}

	public getTreeItem(element: TraceabilityTreeItem): vscode.TreeItem {
		return element;
	}

	public async getChildren(element?: TraceabilityTreeItem): Promise<TraceabilityTreeItem[]> {
		const snapshot = await this.getSnapshot();
		if (!element) {
			return createRootGroups(snapshot);
		}

		if (element.data.kind !== 'group' || !element.data.group) {
			return [];
		}

		switch (element.data.group) {
			case 'validation':
				return findingNodes(snapshot.findings);
			case 'missing-proof':
				return findingNodes(snapshot.findings.filter((finding) => finding.category === 'verification-missing'));
			case 'broken-links':
				return findingNodes(snapshot.findings.filter((finding) => finding.category === 'unresolved-reference'));
			case 'duplicates':
				return findingNodes(snapshot.findings.filter((finding) => finding.category === 'duplicate-id'));
			case 'traceability':
				return referenceNodes(snapshot.references);
			case 'backlinks':
				return backlinkNodes(snapshot.backlinks);
			case 'provenance':
				return snapshot.provenance.length === 0
					? [emptyNode('No canonical artifacts were found.')]
					: snapshot.provenance.map((entry) => new TraceabilityTreeItem(
						entry.artifactId,
						vscode.TreeItemCollapsibleState.None,
						{ kind: 'provenance', path: entry.path, itemId: entry.artifactId },
						entry.hasProvenance ? `${entry.references.length} source reference${entry.references.length === 1 ? '' : 's'}` : 'No source reference recorded',
						entry.hasProvenance ? entry.references.join('\n') : 'No explicit source_refs, source_references, provenance, or upstream_refs field was found.',
						new vscode.ThemeIcon(entry.hasProvenance ? 'verified-filled' : 'question')
					));
		}
	}

	public refresh(): void {
		this.snapshotPromise = undefined;
		this.onDidChangeTreeDataEmitter.fire();
	}

	public async refreshAndGetSnapshot(): Promise<TraceabilitySnapshot> {
		this.refresh();
		return this.getSnapshot();
	}

	public async openItem(item: TraceabilityTreeItem): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder || !item.data.path) {
			return;
		}

		const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...item.data.path.split('/'));
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document, { preview: true });
		if (!item.data.itemId) {
			return;
		}

		const offset = document.getText().indexOf(item.data.itemId);
		if (offset < 0) {
			return;
		}

		const position = document.positionAt(offset);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private async getSnapshot(): Promise<TraceabilitySnapshot> {
		if (!this.snapshotPromise) {
			this.snapshotPromise = this.loadSnapshot();
		}

		return this.snapshotPromise;
	}

	private async loadSnapshot(): Promise<TraceabilitySnapshot> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return analyzeTraceability([]);
		}

		const patterns = [
			'specs/requirements/**/*.json',
			'specs/architecture/**/*.md',
			'specs/work-items/**/*.md',
			'specs/verification/**/*.md'
		];
		const uriGroups = await Promise.all(patterns.map((pattern) => vscode.workspace.findFiles(
			new vscode.RelativePattern(workspaceFolder, pattern),
			'{**/node_modules/**,**/dist/**,**/.git/**}',
			2000
		)));
		const uniqueUris = new Map(uriGroups.flat().map((uri) => [uri.toString(), uri]));
		const sources: CanonicalSource[] = [];
		for (const uri of uniqueUris.values()) {
			const bytes = await vscode.workspace.fs.readFile(uri);
			sources.push({
				path: vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'),
				text: new TextDecoder().decode(bytes)
			});
		}

		return analyzeTraceability(sources);
	}
}

function createRootGroups(snapshot: TraceabilitySnapshot): TraceabilityTreeItem[] {
	const brokenLinks = snapshot.findings.filter((finding) => finding.category === 'unresolved-reference').length;
	const missingProof = snapshot.findings.filter((finding) => finding.category === 'verification-missing').length;
	const duplicates = snapshot.findings.filter((finding) => finding.category === 'duplicate-id').length;
	return [
		groupNode('Validation Results', 'validation', snapshot.findings.length, 'warning'),
		groupNode('Traceability', 'traceability', snapshot.references.length, 'type-hierarchy'),
		groupNode('Missing Proof', 'missing-proof', missingProof, 'beaker-stop'),
		groupNode('Broken Links', 'broken-links', brokenLinks, 'debug-disconnect'),
		groupNode('Duplicate IDs', 'duplicates', duplicates, 'symbol-key'),
		groupNode('Backlinks', 'backlinks', snapshot.backlinks.length, 'references'),
		groupNode('Provenance', 'provenance', snapshot.provenance.length, 'verified')
	];
}

function groupNode(label: string, group: RootGroup, count: number, icon: string): TraceabilityTreeItem {
	return new TraceabilityTreeItem(
		label,
		vscode.TreeItemCollapsibleState.Collapsed,
		{ kind: 'group', group },
		String(count),
		`${count} ${label.toLowerCase()} item${count === 1 ? '' : 's'}`,
		new vscode.ThemeIcon(icon)
	);
}

function findingNodes(findings: readonly TraceFinding[]): TraceabilityTreeItem[] {
	return findings.length === 0
		? [emptyNode('No findings in this category.')]
		: findings.map((finding) => new TraceabilityTreeItem(
			finding.itemId ?? finding.targetId ?? finding.category,
			vscode.TreeItemCollapsibleState.None,
			{ kind: 'finding', path: finding.path, itemId: finding.itemId ?? finding.targetId },
			finding.category,
			`${finding.message}\n${finding.path}`,
			new vscode.ThemeIcon(finding.severity === 'error' ? 'error' : 'warning')
		));
}

function referenceNodes(references: readonly TraceReference[]): TraceabilityTreeItem[] {
	return references.length === 0
		? [emptyNode('No canonical trace references were found.')]
		: references.map((reference) => new TraceabilityTreeItem(
			`${reference.sourceId} → ${reference.targetId}`,
			vscode.TreeItemCollapsibleState.None,
			{ kind: 'reference', path: reference.sourcePath, itemId: reference.sourceId },
			reference.field,
			`${reference.resolved ? 'Resolved' : 'Unresolved'} ${reference.field} reference\n${reference.sourcePath}`,
			new vscode.ThemeIcon(reference.resolved ? 'link' : 'warning')
		));
}

function backlinkNodes(backlinks: readonly TraceBacklink[]): TraceabilityTreeItem[] {
	return backlinks.length === 0
		? [emptyNode('No resolved backlinks were found.')]
		: backlinks.map((backlink) => new TraceabilityTreeItem(
			`${backlink.targetId} ← ${backlink.sourceId}`,
			vscode.TreeItemCollapsibleState.None,
			{ kind: 'backlink', path: backlink.sourcePath, itemId: backlink.sourceId },
			backlink.field,
			`${backlink.sourceId} references ${backlink.targetId} through ${backlink.field}.\n${backlink.sourcePath}`,
			new vscode.ThemeIcon('references')
		));
}

function emptyNode(label: string): TraceabilityTreeItem {
	return new TraceabilityTreeItem(
		label,
		vscode.TreeItemCollapsibleState.None,
		{ kind: 'empty' },
		undefined,
		label,
		new vscode.ThemeIcon('info')
	);
}
