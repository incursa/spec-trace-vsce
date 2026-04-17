import * as vscode from 'vscode';

import {
	parseSpecificationDocument
} from '../editor/core/specificationValidation.js';
import {
	getManagedMarkdownArtifactTypeFromPath,
	getTraceFieldForArtifactType,
	normalizeManagedMarkdownDocument,
	parseManagedMarkdownDocument,
	validateManagedMarkdownDocument,
	type ManagedMarkdownArtifactType,
	type ManagedMarkdownValidationIssue
} from '../editor/markdown/core.js';

import {
	SpecificationCustomEditorProvider
} from '../editor/host/specificationCustomEditor.js';
import {
	MarkdownArtifactCustomEditorProvider
} from '../editor/markdown/host/markdownArtifactCustomEditor.js';
import {
	RepositoryManager,
	SPEC_TRACE_CREATE_ARTIFACT_COMMAND,
	SPEC_TRACE_INITIALIZE_REPOSITORY_COMMAND
} from '../management/repositoryManager.js';
import type {
	ArtifactKind
} from '../management/repositoryManager.js';

export const SPEC_TRACE_EXPLORER_CONTAINER_ID = 'specTraceExplorer';
export const SPEC_TRACE_EXPLORER_VIEW_ID = 'specTraceExplorer.navigator';
export const SPEC_TRACE_OPEN_EXPLORER_COMMAND = 'spec-trace-vsce.openRepositoryExplorer';
export const SPEC_TRACE_REFRESH_EXPLORER_COMMAND = 'spec-trace-vsce.refreshRepositoryExplorer';
export const SPEC_TRACE_OPEN_TREE_ITEM_COMMAND = 'spec-trace-vsce.openTreeItem';

type ArtifactCategoryId = 'specifications' | 'architecture' | 'workItems' | 'verification';
type TreeNodeKind = 'category' | 'domain' | 'specification' | 'markdown' | 'requirement' | 'reference' | 'action';

interface CategoryDefinition {
	id: ArtifactCategoryId;
	label: string;
	rootPath: string;
	docPattern: string;
	description: string;
}

interface RepositorySnapshot {
	categories: CategorySnapshot[];
}

interface CategorySnapshot {
	id: ArtifactCategoryId;
	label: string;
	description: string;
	domains: DomainSnapshot[];
}

interface DomainSnapshot {
	id: string;
	label: string;
	description: string;
	documents: ArtifactDocumentSnapshot[];
}

interface ArtifactDocumentSnapshot {
	kind: 'specification' | 'markdown';
	uri: vscode.Uri;
	artifactId?: string;
	label: string;
	description: string;
	tooltip: string;
	health: 'ok' | 'warning' | 'error';
	healthMessage: string;
	managed: boolean;
	artifactType?: ManagedMarkdownArtifactType;
	summary?: string;
	references: ReferenceSnapshot[];
	requirements?: RequirementSnapshot[];
}

interface RequirementSnapshot {
	uri: vscode.Uri;
	id?: string;
	label: string;
	description: string;
	tooltip: string;
	index: number;
	references: ReferenceSnapshot[];
}

interface ReferenceSnapshot {
	field: string;
	value: string;
	kind: 'requirement' | 'artifact' | 'file';
	description: string;
	sourceUri: vscode.Uri;
	targetUri?: vscode.Uri;
	targetRequirementIndex?: number;
	targetOpenKind?: 'specification' | 'markdown' | 'text';
	resolved: boolean;
}

interface ResolvedReferenceTarget {
	kind: 'specification' | 'markdown' | 'requirement' | 'file';
	uri: vscode.Uri;
	managed?: boolean;
	requirementIndex?: number;
}

interface TreeNodeData {
	kind: TreeNodeKind;
	categoryId?: ArtifactCategoryId;
	domainId?: string;
	document?: ArtifactDocumentSnapshot;
	requirement?: RequirementSnapshot;
	reference?: ReferenceSnapshot;
	action?: {
		command: string;
		arguments?: unknown[];
	};
}

const categoryDefinitions: CategoryDefinition[] = [
	{
		id: 'specifications',
		label: 'Specifications',
		rootPath: 'specs/requirements',
		docPattern: 'specs/requirements/**/*.json',
		description: 'Canonical specification artifacts grouped by domain.'
	},
	{
		id: 'architecture',
		label: 'Architectural Views',
		rootPath: 'specs/architecture',
		docPattern: 'specs/architecture/**/*.md',
		description: 'Canonical architecture artifacts grouped by domain.'
	},
	{
		id: 'workItems',
		label: 'Work Items',
		rootPath: 'specs/work-items',
		docPattern: 'specs/work-items/**/*.md',
		description: 'Canonical work-item artifacts grouped by domain.'
	},
	{
		id: 'verification',
		label: 'Verification Documents',
		rootPath: 'specs/verification',
		docPattern: 'specs/verification/**/*.md',
		description: 'Canonical verification artifacts grouped by domain.'
	}
];

const excludedWorkspaceGlobs = '{**/node_modules/**,**/dist/**,**/.git/**,**/.vscode-test-web/**,**/.workbench/**,**/artifacts/**}';

export function registerSpecTraceExplorer(
	context: vscode.ExtensionContext,
	editorProvider: SpecificationCustomEditorProvider,
	markdownProvider: MarkdownArtifactCustomEditorProvider,
	repositoryManager: RepositoryManager
): SpecTraceExplorerProvider {
	const provider = new SpecTraceExplorerProvider(editorProvider, markdownProvider, repositoryManager);
	const treeView = vscode.window.createTreeView(SPEC_TRACE_EXPLORER_VIEW_ID, {
		treeDataProvider: provider,
		showCollapseAll: true
	});

	context.subscriptions.push(
		provider,
		treeView,
		vscode.commands.registerCommand(SPEC_TRACE_OPEN_EXPLORER_COMMAND, async () => {
			await vscode.commands.executeCommand(`workbench.view.extension.${SPEC_TRACE_EXPLORER_CONTAINER_ID}`);
		}),
		vscode.commands.registerCommand(SPEC_TRACE_REFRESH_EXPLORER_COMMAND, () => {
			provider.refresh();
		}),
		vscode.commands.registerCommand('spec-trace-vsce.filterRepositoryExplorer', async () => {
			const query = await vscode.window.showInputBox({
				title: 'Filter repository explorer',
				prompt: 'Filter artifacts and requirements by identifier, title, summary text, or reference token.',
				value: provider.filterQuery,
				ignoreFocusOut: true
			});
			provider.setFilterQuery(query?.trim() ?? '');
		}),
		vscode.commands.registerCommand('spec-trace-vsce.clearRepositoryExplorerFilter', () => {
			provider.setFilterQuery('');
		}),
		vscode.commands.registerCommand(SPEC_TRACE_OPEN_TREE_ITEM_COMMAND, async (item: SpecTraceTreeItem) => {
			await provider.openItem(item);
		})
	);

	return provider;
}

export class SpecTraceExplorerProvider implements vscode.TreeDataProvider<SpecTraceTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SpecTraceTreeItem | undefined | void>();

	private readonly _watchers: vscode.Disposable[] = [];

	private _snapshotPromise: Promise<RepositorySnapshot> | undefined;
	private _repositoryStatePromise: Promise<'missing' | 'partial' | 'ready'> | undefined;
	private _filterQuery = '';

	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	public constructor(
		private readonly editorProvider: SpecificationCustomEditorProvider,
		private readonly markdownProvider: MarkdownArtifactCustomEditorProvider,
		private readonly repositoryManager: RepositoryManager
	) {
		const workspaceFolder = this.workspaceFolder;
		if (!workspaceFolder) {
			return;
		}

		const watchPatterns = [
			'specs/**/_index.md',
			...categoryDefinitions.map((definition) => definition.docPattern)
		];

		for (const pattern of watchPatterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(workspaceFolder, pattern),
				false,
				false,
				false
			);

			const refresh = () => {
				this.refresh();
			};

			watcher.onDidCreate(refresh);
			watcher.onDidChange(refresh);
			watcher.onDidDelete(refresh);
			this._watchers.push(watcher);
		}
	}

	public dispose(): void {
		this._snapshotPromise = undefined;
		this._repositoryStatePromise = undefined;
		this._onDidChangeTreeData.dispose();
		for (const watcher of this._watchers) {
			watcher.dispose();
		}
	}

	public refresh(): void {
		this._snapshotPromise = undefined;
		this._repositoryStatePromise = undefined;
		this._onDidChangeTreeData.fire();
	}

	public get filterQuery(): string {
		return this._filterQuery;
	}

	public setFilterQuery(query: string): void {
		this._filterQuery = query.trim();
		this.refresh();
	}

	public getTreeItem(element: SpecTraceTreeItem): vscode.TreeItem {
		return element;
	}

	public async getChildren(element?: SpecTraceTreeItem): Promise<SpecTraceTreeItem[]> {
		const snapshot = await this.getSnapshot();
		const repositoryState = await this.getRepositoryState();

		if (!element) {
			return snapshot.categories.map((category) => createCategoryNode(category));
		}

		switch (element.data.kind) {
			case 'category': {
				if (repositoryState === 'missing') {
					return [createInitializeActionNode(element.data.categoryId!)];
				}

				const category = snapshot.categories.find((entry) => entry.id === element.data.categoryId);
				if (!category || category.domains.length === 0) {
					return [createCategoryActionNode(element.data.categoryId!)];
				}

				return [
					...category.domains.map((domain) => createDomainNode(category.id, domain)),
					createCategoryActionNode(category.id)
				];
			}
			case 'domain': {
				const category = snapshot.categories.find((entry) => entry.id === element.data.categoryId);
				const domain = category?.domains.find((entry) => entry.id === element.data.domainId);
				return domain
					? [
						...domain.documents.map((document) => createDocumentNode(element.data.categoryId!, domain.id, document)),
						createDomainActionNode(element.data.categoryId!, domain.id)
					]
					: [];
			}
			case 'specification': {
				if (!element.data.document) {
					return [];
				}

				return [
					createOpenManagedActionNode(element.data.document),
					createOpenTextActionNode(element.data.document),
					...element.data.document.references.map((reference) => createReferenceNode(element.data.document!, reference)),
					...(element.data.document.requirements ?? []).map((requirement) => createRequirementNode(element.data.document!, requirement))
				];
			}
			case 'markdown': {
				if (!element.data.document) {
					return [];
				}

				return [
					...(element.data.document.managed ? [createOpenManagedActionNode(element.data.document)] : []),
					createOpenTextActionNode(element.data.document),
					...element.data.document.references.map((reference) => createReferenceNode(element.data.document!, reference))
				];
			}
			case 'requirement': {
				if (!element.data.requirement) {
					return [];
				}

				return element.data.requirement.references.map((reference) => createReferenceNode(element.data.document!, reference));
			}
			case 'reference':
				return [];
			default:
				return [];
		}
	}

	public async openItem(item: SpecTraceTreeItem): Promise<void> {
		switch (item.data.kind) {
			case 'specification': {
				if (!item.data.document) {
					return;
				}

				if (item.data.document.health === 'error') {
					await vscode.commands.executeCommand('vscode.open', item.data.document.uri);
					return;
				}

				await this.editorProvider.openSpecificationDocument(item.data.document.uri);
				return;
			}
			case 'markdown': {
				if (!item.data.document) {
					return;
				}

				if (item.data.document.managed) {
					await this.markdownProvider.openManagedMarkdownDocument(item.data.document.uri);
					return;
				}

				await vscode.commands.executeCommand('vscode.open', item.data.document.uri);
				return;
			}
			case 'requirement': {
				if (!item.data.document || !item.data.requirement) {
					return;
				}

				await this.editorProvider.revealRequirement(item.data.document.uri, item.data.requirement.index);
				return;
			}
			case 'reference': {
				if (!item.data.reference) {
					return;
				}

				await this.openReference(item.data.reference);
				return;
			}
			case 'action': {
				const action = item.data.action;
				if (!action) {
					return;
				}

				await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
				this.refresh();
				return;
			}
			default:
				return;
		}
	}

	private async openReference(reference: ReferenceSnapshot): Promise<void> {
		const snapshot = await this.buildSnapshot();
		const resolved = resolveReferenceTarget(reference.value, snapshot);
		if (!resolved) {
			await vscode.commands.executeCommand('vscode.open', reference.sourceUri);
			return;
		}

		if (resolved.kind === 'requirement') {
			if (resolved.requirementIndex === undefined) {
				await vscode.commands.executeCommand('vscode.open', resolved.uri);
				return;
			}

			await this.editorProvider.revealRequirement(resolved.uri, resolved.requirementIndex);
			return;
		}

		if (resolved.kind === 'markdown') {
			if (resolved.managed) {
				await this.markdownProvider.openManagedMarkdownDocument(resolved.uri);
				return;
			}

			await vscode.commands.executeCommand('vscode.open', resolved.uri);
			return;
		}

		if (resolved.kind === 'specification') {
			await this.editorProvider.openSpecificationDocument(resolved.uri);
			return;
		}

		if (resolved.kind === 'file') {
			await vscode.commands.executeCommand('vscode.open', resolved.uri);
			return;
		}

		await vscode.commands.executeCommand('vscode.open', resolved.uri);
	}

	private async getSnapshot(): Promise<RepositorySnapshot> {
		if (!this._snapshotPromise) {
			this._snapshotPromise = this.buildSnapshot()
				.then((snapshot) => this.applyFilter(snapshot, this._filterQuery))
				.catch((error) => {
				console.error('[spec-trace-vsce] Failed to build tree snapshot', error);
				return { categories: [] } satisfies RepositorySnapshot;
			});
		}

		return this._snapshotPromise;
	}

	private async getRepositoryState(): Promise<'missing' | 'partial' | 'ready'> {
		if (!this._repositoryStatePromise) {
			this._repositoryStatePromise = this.repositoryManager.detectRepositoryState(this.workspaceFolder).catch((error) => {
				console.error('[spec-trace-vsce] Failed to detect repository state', error);
				return 'missing' as const;
			});
		}

		return this._repositoryStatePromise;
	}

	private async buildSnapshot(): Promise<RepositorySnapshot> {
		const workspaceFolder = this.workspaceFolder;
		if (!workspaceFolder) {
			return { categories: [] };
		}

		const categories = await Promise.all(categoryDefinitions.map(async (definition) => this.buildCategorySnapshot(workspaceFolder, definition)));
		return this.resolveSnapshotReferences({ categories });
	}

	private resolveSnapshotReferences(snapshot: RepositorySnapshot): RepositorySnapshot {
		for (const category of snapshot.categories) {
			for (const domain of category.domains) {
				for (const document of domain.documents) {
					for (const reference of document.references) {
						const resolved = resolveReferenceTarget(reference.value, snapshot);
						if (!resolved) {
							continue;
						}

						reference.resolved = true;
						reference.targetUri = resolved.uri;
						reference.targetOpenKind = resolved.kind === 'file'
							? 'text'
							: resolved.kind === 'requirement'
								? 'specification'
								: resolved.kind;
					}

					for (const requirement of document.requirements ?? []) {
						for (const reference of requirement.references) {
							const resolved = resolveReferenceTarget(reference.value, snapshot);
							if (!resolved) {
								continue;
							}

							reference.resolved = true;
							reference.targetUri = resolved.uri;
							reference.targetOpenKind = resolved.kind === 'file'
								? 'text'
								: resolved.kind === 'requirement'
									? 'specification'
									: resolved.kind;
						}
					}
				}
			}
		}

		return snapshot;
	}

	private applyFilter(snapshot: RepositorySnapshot, query: string): RepositorySnapshot {
		const normalizedQuery = query.trim().toLowerCase();
		if (normalizedQuery.length === 0) {
			return snapshot;
		}

		const categories = snapshot.categories
			.map((category) => {
				const matchedDomains = category.domains
					.map((domain) => this.filterDomain(domain, normalizedQuery))
					.filter((domain): domain is DomainSnapshot => domain !== undefined);
				if (matchedDomains.length === 0 && !matchesText(category.label, normalizedQuery) && !matchesText(category.description, normalizedQuery)) {
					return undefined;
				}

				return {
					...category,
					domains: matchedDomains
				};
			})
			.filter((category): category is CategorySnapshot => category !== undefined);

		return { categories };
	}

	private filterDomain(domain: DomainSnapshot, query: string): DomainSnapshot | undefined {
		const documents = domain.documents
			.map((document) => this.filterDocument(document, query))
			.filter((document): document is ArtifactDocumentSnapshot => document !== undefined);
		if (documents.length === 0 && !matchesText(domain.label, query) && !matchesText(domain.description, query)) {
			return undefined;
		}

		return {
			...domain,
			documents
		};
	}

	private filterDocument(document: ArtifactDocumentSnapshot, query: string): ArtifactDocumentSnapshot | undefined {
		const requirements = document.requirements?.map((requirement) => this.filterRequirement(requirement, query)).filter((requirement): requirement is RequirementSnapshot => requirement !== undefined) ?? [];
		const references = document.references.filter((reference) => referenceMatchesQuery(reference, query));
		const matches = documentMatchesQuery(document, query) || references.length > 0 || requirements.length > 0;
		if (!matches) {
			return undefined;
		}

		return {
			...document,
			requirements: document.kind === 'specification' ? requirements : document.requirements,
			references
		};
	}

	private filterRequirement(requirement: RequirementSnapshot, query: string): RequirementSnapshot | undefined {
		const references = requirement.references.filter((reference) => referenceMatchesQuery(reference, query));
		if (!requirementMatchesQuery(requirement, query) && references.length === 0) {
			return undefined;
		}

		return {
			...requirement,
			references
		};
	}

	private async buildCategorySnapshot(
		workspaceFolder: vscode.WorkspaceFolder,
		definition: CategoryDefinition
	): Promise<CategorySnapshot> {
		const domainIndexMap = await this.readDomainIndexMap(workspaceFolder, definition);
		const documents = await vscode.workspace.findFiles(definition.docPattern, excludedWorkspaceGlobs);
		const domains = new Map<string, DomainSnapshotBuilder>();

		for (const uri of documents) {
			const relativePath = normalizePath(vscode.workspace.asRelativePath(uri, false));
			const relativeToRoot = relativePath.slice(definition.rootPath.length + 1);
			const [domainId, ...rest] = relativeToRoot.split('/');
			if (!domainId || rest.length === 0) {
				continue;
			}

			const domain = domains.get(domainId) ?? this.createDomainSnapshotBuilder(domainId, domainIndexMap.get(domainId));
			const document = await this.describeDocument(uri, definition, domainId);
			domain.documents.push(document);
			if (!domain.description && document.kind === 'markdown' && isIndexMarkdown(uri)) {
				domain.description = document.description || document.label;
			}

			domains.set(domainId, domain);
		}

		const sortedDomains = Array.from(domains.values())
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((domain) => ({
				id: domain.id,
				label: domain.label,
				description: domain.description || 'Domain',
				documents: domain.documents.sort((left, right) => left.label.localeCompare(right.label))
			}));

		return {
			id: definition.id,
			label: definition.label,
			description: definition.description,
			domains: sortedDomains
		};
	}

	private async readDomainIndexMap(
		workspaceFolder: vscode.WorkspaceFolder,
		definition: CategoryDefinition
	): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		const rootDirectory = vscode.Uri.joinPath(workspaceFolder.uri, definition.rootPath);
		let children: readonly [string, vscode.FileType][];

		try {
			children = await vscode.workspace.fs.readDirectory(rootDirectory);
		} catch {
			return map;
		}

		for (const [name, fileType] of children) {
			if (fileType !== vscode.FileType.Directory) {
				continue;
			}

			const indexUri = vscode.Uri.joinPath(rootDirectory, name, '_index.md');
			const description = await this.readMarkdownSummary(indexUri);
			if (description) {
				map.set(name, description);
			}
		}

		return map;
	}

	private createDomainSnapshotBuilder(id: string, description?: string): DomainSnapshotBuilder {
		return {
			id,
			label: id,
			description: description ?? 'Domain',
			documents: []
		};
	}

	private async describeDocument(
		uri: vscode.Uri,
		definition: CategoryDefinition,
		domainId: string
	): Promise<ArtifactDocumentSnapshot> {
		switch (definition.id) {
			case 'specifications':
				return this.describeSpecificationDocument(uri);
			case 'architecture':
			case 'workItems':
			case 'verification':
				return this.describeMarkdownDocument(uri, domainId);
		}
	}

	private async describeSpecificationDocument(uri: vscode.Uri): Promise<ArtifactDocumentSnapshot> {
		const text = await this.readText(uri);
		const parsed = parseSpecificationDocument(text);
		const fileName = basenameFromUri(uri);

		if (!parsed.document) {
			const fallbackLabel = fileName.replace(/\.json$/i, '');
			return {
				kind: 'specification',
				uri,
				artifactId: fallbackLabel,
				label: fallbackLabel,
				description: 'Invalid specification JSON',
				tooltip: fileName,
				health: 'error',
				healthMessage: parsed.issues.map((issue) => issue.message).join('; ') || 'Invalid specification JSON',
				managed: true,
				references: [],
				requirements: []
			};
		}

		const document = parsed.document;
		const label = stringValue(document.artifact_id) || fileName.replace(/\.json$/i, '');
		const description = stringValue(document.title) || 'Specification';
		const tooltip = [
			stringValue(document.status) ? `Status: ${stringValue(document.status)}` : undefined,
			parsed.issues.length > 0 ? `${parsed.issues.length} validation issue${parsed.issues.length === 1 ? '' : 's'}` : undefined,
			uri.toString()
		].filter(Boolean).join('\n');

		const references = [
			...collectReferenceSnapshots(uri, 'related_artifacts', document.related_artifacts),
			...(document.requirements ?? []).flatMap((requirement) => collectRequirementReferences(uri, requirement))
		];

		return {
			kind: 'specification',
			uri,
			artifactId: label,
			label,
			description,
			tooltip,
			health: parsed.issues.length > 0 ? 'warning' : 'ok',
			healthMessage: parsed.issues.length > 0 ? parsed.issues.map((issue) => issue.message).join('; ') : 'Specification is valid.',
			managed: true,
			references,
			requirements: (document.requirements ?? []).map((requirement, index) => ({
				uri,
				id: stringValue(requirement.id),
				label: stripRequirementPrefix(stringValue(requirement.id), label) || `Requirement ${index + 1}`,
				description: stringValue(requirement.title) || 'Untitled requirement',
				tooltip: stringValue(requirement.statement) || 'Add a requirement statement.',
				index,
				references: collectRequirementReferences(uri, requirement)
			}))
		};
	}

	private async describeMarkdownDocument(uri: vscode.Uri, domainId: string): Promise<ArtifactDocumentSnapshot> {
		const text = await this.readText(uri);
		const relativePath = normalizePath(vscode.workspace.asRelativePath(uri, false));
		const parsed = normalizeManagedMarkdownDocument(parseManagedMarkdownDocument(text));
		const fileName = basenameFromUri(uri);
		const isIndex = isIndexMarkdown(uri);
		const expectedType = getManagedMarkdownArtifactTypeFromPath(relativePath);
		const managed = expectedType !== undefined && parsed.artifact_type === expectedType;
		const issues = managed ? validateManagedMarkdownDocument(parsed, relativePath) : [
			{
				path: '',
				message: parsed.artifact_type
					? `artifact_type "${parsed.artifact_type}" does not match the path family.`
					: 'Missing canonical artifact_type front matter.',
				severity: 'error' as const
			}
		];
		const label = parsed.artifact_id || (isIndex ? 'Index' : parsed.title) || fileName.replace(/\.md$/i, '');
		const description = parsed.title || parsed.summary || (isIndex ? `${domainId} index` : 'Markdown document');
		const tooltip = [
			parsed.status ? `Status: ${parsed.status}` : undefined,
			managed ? 'Managed canonical markdown artifact' : 'Legacy markdown artifact',
			issues.length > 0 ? `${issues.length} validation issue${issues.length === 1 ? '' : 's'}` : undefined,
			uri.toString()
		].filter(Boolean).join('\n');
		const traceField = parsed.artifact_type ? getTraceFieldForArtifactType(parsed.artifact_type) : undefined;
		const traceValues = traceField ? parsed[traceField] : undefined;
		const references = [
			...collectReferenceSnapshots(uri, 'related_artifacts', parsed.related_artifacts),
			...(traceField && traceValues ? collectReferenceSnapshots(uri, traceField, traceValues) : [])
		];

		return {
			kind: 'markdown',
			uri,
			artifactId: parsed.artifact_id || label,
			label,
			description,
			tooltip,
			health: issues.some((issue) => issue.severity === 'error') ? 'error' : (issues.length > 0 ? 'warning' : 'ok'),
			healthMessage: issues.map((issue) => issue.message).join('; ') || (managed ? 'Markdown artifact is valid.' : 'Legacy markdown artifact.'),
			managed,
			artifactType: parsed.artifact_type,
			summary: parsed.summary,
			references
		};
	}

	private async readMarkdownSummary(uri: vscode.Uri): Promise<string | undefined> {
		try {
			const text = await this.readText(uri);
			const metadata = parseMarkdownMetadata(text);
			return metadata.title || metadata.summary;
		} catch {
			return undefined;
		}
	}

	private async readText(uri: vscode.Uri): Promise<string> {
		const data = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(data);
	}

	private get workspaceFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}
}

class SpecTraceTreeItem extends vscode.TreeItem {
	public constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly data: TreeNodeData,
		description?: string,
		tooltip?: string,
		icon?: vscode.ThemeIcon
	) {
		super(label, collapsibleState);
		this.description = description;
		this.tooltip = tooltip;
		this.iconPath = icon;
		this.contextValue = data.kind;
		this.command = data.kind === 'category' || data.kind === 'domain'
			? undefined
			: {
				command: SPEC_TRACE_OPEN_TREE_ITEM_COMMAND,
				title: 'Open artifact',
				arguments: [this]
			};
	}
}

class DomainSnapshotBuilder {
	public readonly documents: ArtifactDocumentSnapshot[];

	public constructor(
		public readonly id: string,
		public readonly label: string,
		public description: string,
		documents: ArtifactDocumentSnapshot[]
	) {
		this.documents = documents;
	}
}

function createCategoryNode(category: CategorySnapshot): SpecTraceTreeItem {
	return new SpecTraceTreeItem(
		category.label,
		vscode.TreeItemCollapsibleState.Expanded,
		{
			kind: 'category',
			categoryId: category.id
		},
		category.domains.length === 0 ? 'No documents yet' : `${category.domains.length} domain${category.domains.length === 1 ? '' : 's'}`,
		category.description,
		new vscode.ThemeIcon('folder')
	);
}

function createDomainNode(categoryId: ArtifactCategoryId, domain: DomainSnapshot): SpecTraceTreeItem {
	return new SpecTraceTreeItem(
		domain.label,
		vscode.TreeItemCollapsibleState.Collapsed,
		{
			kind: 'domain',
			categoryId,
			domainId: domain.id
		},
		domain.description,
		domain.description,
		new vscode.ThemeIcon('folder-active')
	);
}

function createInitializeActionNode(categoryId: ArtifactCategoryId): SpecTraceTreeItem {
	return new SpecTraceTreeItem(
		'Initialize Spec Trace scaffold',
		vscode.TreeItemCollapsibleState.None,
		{
			kind: 'action',
			categoryId,
			action: {
				command: SPEC_TRACE_INITIALIZE_REPOSITORY_COMMAND
			}
		},
		'Create the initial folder structure and seed files for this workspace.',
		'Initialize the Spec Trace scaffold before creating artifacts.',
		new vscode.ThemeIcon('rocket')
	);
}

function createCategoryActionNode(categoryId: ArtifactCategoryId): SpecTraceTreeItem {
	const artifactKind = artifactKindForCategory(categoryId);
	return new SpecTraceTreeItem(
		`Create ${artifactLabelForKind(artifactKind)}`,
		vscode.TreeItemCollapsibleState.None,
		{
			kind: 'action',
			categoryId,
			action: {
				command: SPEC_TRACE_CREATE_ARTIFACT_COMMAND,
				arguments: [{ kind: artifactKind }]
			}
		},
		`Add a new ${artifactLabelForKind(artifactKind).toLowerCase()} using the bundled template.`,
		`Create a new ${artifactLabelForKind(artifactKind).toLowerCase()}.`,
		new vscode.ThemeIcon('add')
	);
}

function createDomainActionNode(categoryId: ArtifactCategoryId, domainId: string): SpecTraceTreeItem {
	const artifactKind = artifactKindForCategory(categoryId);
	return new SpecTraceTreeItem(
		`Create ${artifactLabelForKind(artifactKind)}`,
		vscode.TreeItemCollapsibleState.None,
		{
			kind: 'action',
			categoryId,
			domainId,
			action: {
				command: SPEC_TRACE_CREATE_ARTIFACT_COMMAND,
				arguments: [{ kind: artifactKind, domain: domainId }]
			}
		},
		`Add a new ${artifactLabelForKind(artifactKind).toLowerCase()} in the ${domainId} domain.`,
		`Create a new ${artifactLabelForKind(artifactKind).toLowerCase()} in ${domainId}.`,
		new vscode.ThemeIcon('add')
	);
}

function createDocumentNode(
	categoryId: ArtifactCategoryId,
	domainId: string,
	document: ArtifactDocumentSnapshot
): SpecTraceTreeItem {
	const hasChildren = (document.requirements?.length ?? 0) > 0 || document.references.length > 0;
	const healthLabel = document.health === 'ok' ? 'ok' : (document.health === 'warning' ? 'needs attention' : 'error');
	return new SpecTraceTreeItem(
		document.label,
		hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		{
			kind: document.kind,
			categoryId,
			domainId,
			document
		},
		document.description,
		`${document.tooltip}\nHealth: ${healthLabel}\n${document.healthMessage}`,
		document.kind === 'specification'
			? new vscode.ThemeIcon('symbol-namespace')
			: new vscode.ThemeIcon('markdown')
	);
}

function createRequirementNode(document: ArtifactDocumentSnapshot, requirement: RequirementSnapshot): SpecTraceTreeItem {
	return new SpecTraceTreeItem(
		requirement.label,
		requirement.references.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		{
			kind: 'requirement',
			document,
			requirement
		},
		requirement.description,
		`${requirement.tooltip}\n${requirement.references.length > 0 ? `${requirement.references.length} local reference${requirement.references.length === 1 ? '' : 's'}` : 'No local references'}`,
		new vscode.ThemeIcon('symbol-method')
	);
}

function createOpenManagedActionNode(document: ArtifactDocumentSnapshot): SpecTraceTreeItem {
	return new SpecTraceTreeItem(
		'Open managed editor',
		vscode.TreeItemCollapsibleState.None,
		{
			kind: 'action',
			document,
			action: {
				command: document.kind === 'specification'
					? 'vscode.openWith'
					: 'vscode.openWith',
				arguments: [
					document.uri,
					document.kind === 'specification'
						? 'spec-trace-vsce.specFileEditor'
						: 'spec-trace-vsce.markdownArtifactEditor'
				]
			}
		},
		'Open the artifact in the managed browser-safe editor.',
		'Open the managed editor.',
		new vscode.ThemeIcon('edit')
	);
}

function createOpenTextActionNode(document: ArtifactDocumentSnapshot): SpecTraceTreeItem {
	return new SpecTraceTreeItem(
		'Open as text',
		vscode.TreeItemCollapsibleState.None,
		{
			kind: 'action',
			document,
			action: {
				command: 'vscode.open',
				arguments: [document.uri]
			}
		},
		'Open the raw file in the standard text editor.',
		'Open the raw text editor.',
		new vscode.ThemeIcon('file-code')
	);
}

function createReferenceNode(document: ArtifactDocumentSnapshot, reference: ReferenceSnapshot): SpecTraceTreeItem {
	const label = `${reference.field}: ${reference.value}`;
	return new SpecTraceTreeItem(
		label,
		vscode.TreeItemCollapsibleState.None,
		{
			kind: 'reference',
			document,
			reference
		},
		reference.description,
		reference.resolved ? `${reference.description}\n${reference.value}` : `${reference.description}\nUnresolved locally`,
		reference.resolved ? new vscode.ThemeIcon('link') : new vscode.ThemeIcon('warning')
	);
}

function collectReferenceSnapshots(sourceUri: vscode.Uri, field: string, values: readonly string[] | undefined): ReferenceSnapshot[] {
	if (!Array.isArray(values)) {
		return [];
	}

	return values
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.map((value) => ({
			field,
			value,
			kind: guessReferenceKind(value),
			description: resolveReferenceDescription(value),
			sourceUri,
			resolved: false
		}));
}

function collectRequirementReferences(sourceUri: vscode.Uri, requirement: { trace?: Record<string, unknown> | undefined }): ReferenceSnapshot[] {
	const trace = requirement.trace;
	if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
		return [];
	}

	const fields = [
		'satisfied_by',
		'implemented_by',
		'verified_by',
		'derived_from',
		'supersedes',
		'upstream_refs',
		'related'
	] as const;

	const references: ReferenceSnapshot[] = [];
	for (const field of fields) {
		const values = trace[field];
		if (!Array.isArray(values)) {
			continue;
		}

		for (const value of values) {
			if (typeof value !== 'string') {
				continue;
			}

			const trimmed = value.trim();
			if (trimmed.length === 0) {
				continue;
			}

			references.push({
				field: `trace.${field}`,
				value: trimmed,
				kind: guessReferenceKind(trimmed),
				description: resolveReferenceDescription(trimmed),
				sourceUri,
				resolved: false
			});
		}
	}

	return references;
}

function guessReferenceKind(value: string): 'requirement' | 'artifact' | 'file' {
	if (/[\\/]/.test(value) || /\.md$|\.json$|\.yaml$|\.yml$/i.test(value)) {
		return 'file';
	}

	if (/^REQ-/.test(value)) {
		return 'requirement';
	}

	if (/^(SPEC|ARC|WI|VER)-/.test(value)) {
		return 'artifact';
	}

	return 'artifact';
}

function resolveReferenceDescription(value: string): string {
	if (/^REQ-/.test(value)) {
		return 'Requirement reference';
	}

	if (/^(SPEC|ARC|WI|VER)-/.test(value)) {
		return 'Artifact reference';
	}

	if (/[\\/]/.test(value) || /\.md$|\.json$|\.yaml$|\.yml$/i.test(value)) {
		return 'File reference';
	}

	return 'Local reference';
}

function resolveReferenceTarget(token: string, snapshot: RepositorySnapshot): ResolvedReferenceTarget | undefined {
	const normalized = token.trim();
	if (normalized.length === 0) {
		return undefined;
	}

	if (normalized.includes('/') || /\.md$|\.json$|\.yaml$|\.yml$/i.test(normalized)) {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			const candidate = vscode.Uri.joinPath(workspaceFolder.uri, ...normalized.split('/'));
			return {
				kind: 'file',
				uri: candidate
			};
		}
	}

	for (const category of snapshot.categories) {
		for (const domain of category.domains) {
			for (const document of domain.documents) {
				if (matchesDocumentIdentifier(document, normalized)) {
					return {
						kind: document.kind,
						uri: document.uri,
						managed: document.managed
					};
				}

				for (const requirement of document.requirements ?? []) {
					if (matchesRequirementIdentifier(requirement, normalized)) {
						return {
							kind: 'requirement',
							uri: requirement.uri,
							requirementIndex: requirement.index
						};
					}
				}
			}
		}
	}

	for (const category of snapshot.categories) {
		for (const domain of category.domains) {
			for (const document of domain.documents) {
				const relative = normalizePath(vscode.workspace.asRelativePath(document.uri, false));
				const basename = basenameFromUri(document.uri);
				if (relative === normalized || basename === normalized) {
					return {
						kind: document.kind,
						uri: document.uri,
						managed: document.managed
					};
				}
			}
		}
	}

	return undefined;
}

function matchesDocumentIdentifier(document: ArtifactDocumentSnapshot, token: string): boolean {
	return [
		document.artifactId,
		document.label
	].some((value) => stringValue(value) === token);
}

function matchesRequirementIdentifier(requirement: RequirementSnapshot, token: string): boolean {
	return [
		requirement.id,
		requirement.label
	].some((value) => stringValue(value) === token);
}

function matchesText(value: string | undefined, query: string): boolean {
	return stringValue(value).toLowerCase().includes(query);
}

function documentMatchesQuery(document: ArtifactDocumentSnapshot, query: string): boolean {
	const fields = [
		document.artifactId,
		document.label,
		document.description,
		document.healthMessage,
		document.summary,
		document.artifactType,
		document.tooltip
	];

	return fields.some((value) => matchesText(value, query)) || document.references.some((reference) => referenceMatchesQuery(reference, query));
}

function requirementMatchesQuery(requirement: RequirementSnapshot, query: string): boolean {
	return [
		requirement.id,
		requirement.label,
		requirement.description,
		requirement.tooltip
	].some((value) => matchesText(value, query)) || requirement.references.some((reference) => referenceMatchesQuery(reference, query));
}

function referenceMatchesQuery(reference: ReferenceSnapshot, query: string): boolean {
	return [
		reference.field,
		reference.value,
		reference.description
	].some((value) => matchesText(value, query));
}

function parseMarkdownMetadata(text: string): {
	artifactId?: string;
	title?: string;
	summary?: string;
} {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const frontMatter = parseFrontMatter(lines);
	if (frontMatter) {
		return frontMatter;
	}

	const title = findMarkdownHeading(lines);
	const summary = findMarkdownSummary(lines);
	return { title, summary };
}

function parseFrontMatter(lines: string[]): {
	artifactId?: string;
	title?: string;
	summary?: string;
} | undefined {
	if (lines[0] !== '---') {
		return undefined;
	}

	let index = 1;
	const entries = new Map<string, string>();
	while (index < lines.length && lines[index] !== '---') {
		const match = /^([A-Za-z0-9_ -]+?):\s*(.*)$/.exec(lines[index]);
		if (match) {
			entries.set(match[1].trim().toLowerCase(), match[2].trim());
		}
		index += 1;
	}

	if (index >= lines.length) {
		return undefined;
	}

	return {
		artifactId: entries.get('artifact_id'),
		title: entries.get('title'),
		summary: entries.get('summary') || entries.get('description')
	};
}

function findMarkdownHeading(lines: string[]): string | undefined {
	for (const line of lines) {
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match) {
			return match[1].trim();
		}
	}

	return undefined;
}

function findMarkdownSummary(lines: string[]): string | undefined {
	const headingIndex = lines.findIndex((line) => /^#\s+/.test(line));
	const startIndex = headingIndex >= 0 ? headingIndex + 1 : 0;
	const paragraphs: string[] = [];
	let collecting = false;

	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!collecting) {
			if (line.length === 0) {
				continue;
			}

			if (line.startsWith('#')) {
				continue;
			}

			collecting = true;
		}

		if (line.length === 0) {
			break;
		}

		paragraphs.push(line);
	}

	return paragraphs.length > 0 ? paragraphs.join(' ') : undefined;
}

function stripRequirementPrefix(requirementId: string, specArtifactId: string): string {
	const trimmed = requirementId.trim();
	if (trimmed.length === 0) {
		return '';
	}

	const derivedPrefix = specArtifactId.startsWith('SPEC-')
		? `REQ-${specArtifactId.slice('SPEC-'.length)}-`
		: undefined;

	if (derivedPrefix && trimmed.startsWith(derivedPrefix)) {
		return trimmed.slice(derivedPrefix.length);
	}

	const genericMatch = /^REQ-(?:[A-Z0-9]+-)*([A-Z0-9]+)$/.exec(trimmed);
	if (genericMatch) {
		return genericMatch[1];
	}

	return trimmed;
}

function isIndexMarkdown(uri: vscode.Uri): boolean {
	return basenameFromUri(uri).toLowerCase() === '_index.md';
}

function basenameFromUri(uri: vscode.Uri): string {
	const path = normalizePath(uri.path);
	const index = path.lastIndexOf('/');
	return index >= 0 ? path.slice(index + 1) : path;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, '/');
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function artifactKindForCategory(categoryId: ArtifactCategoryId): ArtifactKind {
	switch (categoryId) {
		case 'specifications':
			return 'specification';
		case 'architecture':
			return 'architecture';
		case 'workItems':
			return 'workItem';
		case 'verification':
			return 'verification';
	}

	const unsupportedCategory: never = categoryId;
	throw new Error(`Unsupported artifact category: ${unsupportedCategory}`);
}

function artifactLabelForKind(kind: ArtifactKind): string {
	switch (kind) {
		case 'specification':
			return 'Specification';
		case 'architecture':
			return 'Architecture Artifact';
		case 'workItem':
			return 'Work Item';
		case 'verification':
			return 'Verification Artifact';
	}

	return 'Artifact';
}
