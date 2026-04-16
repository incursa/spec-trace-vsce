import * as vscode from 'vscode';

import { SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE } from '../editor/host/specificationCustomEditor.js';

import {
	ArtifactKind,
	BootstrapPlan,
	createBootstrapPlan,
	detectRepositoryState,
	getScaffoldDirectories,
	getScaffoldFiles,
	normalizeDomain,
	normalizePath,
	RenderedArtifact,
	renderArtifact,
	RepositoryState
} from './core.js';

export type { ArtifactKind } from './core.js';

export const SPEC_TRACE_INITIALIZE_REPOSITORY_COMMAND = 'spec-trace-vsce.initializeRepository';
export const SPEC_TRACE_CREATE_ARTIFACT_COMMAND = 'spec-trace-vsce.createArtifact';

export interface CreateArtifactCommandOptions {
	readonly kind?: ArtifactKind;
	readonly domain?: string;
}

interface FileSystemLike {
	stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
	createDirectory(uri: vscode.Uri): Thenable<void>;
	writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
	readDirectory(uri: vscode.Uri): Thenable<readonly [string, vscode.FileType][]>;
}

interface WindowLike {
	showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
	showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
	showInputBox(options?: vscode.InputBoxOptions): Thenable<string | undefined>;
	showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[] | Thenable<readonly T[]>, options?: vscode.QuickPickOptions): Thenable<T | undefined>;
}

interface CommandsLike {
	executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T>;
}

export class RepositoryManager {
	public constructor(
		private readonly fileSystem: FileSystemLike = vscode.workspace.fs,
		private readonly windowApi: WindowLike = vscode.window,
		private readonly commandsApi: CommandsLike = vscode.commands
	) {}

	public async detectRepositoryState(workspaceFolder = this.getWorkspaceFolder()): Promise<RepositoryState> {
		if (!workspaceFolder) {
			return 'missing';
		}

		const existingPaths = await this.collectExistingScaffoldPaths(workspaceFolder);
		return detectRepositoryState(existingPaths);
	}

	public async initializeRepository(workspaceFolder = this.getWorkspaceFolder()): Promise<BootstrapPlan | undefined> {
		if (!workspaceFolder) {
			void this.windowApi.showErrorMessage('Open a workspace folder before initializing Spec Trace.');
			return undefined;
		}

		const existingPaths = await this.collectExistingScaffoldPaths(workspaceFolder);
		const plan = createBootstrapPlan(existingPaths);
		if (plan.missingDirectories.length === 0 && plan.missingFiles.length === 0) {
			void this.windowApi.showInformationMessage('Spec Trace scaffold is already present in this workspace.');
			return plan;
		}

		for (const relativePath of plan.missingDirectories) {
			await this.fileSystem.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, ...relativePath.split('/')));
		}

		for (const file of plan.missingFiles) {
			const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, ...file.path.split('/'));
			if (await this.pathExists(targetUri)) {
				continue;
			}

			await this.fileSystem.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, ...dirname(file.path).split('/')));
			await this.fileSystem.writeFile(targetUri, new TextEncoder().encode(file.content));
		}

		return plan;
	}

	public async promptAndInitializeRepository(workspaceFolder = this.getWorkspaceFolder()): Promise<void> {
		const plan = await this.initializeRepository(workspaceFolder);
		if (!plan) {
			return;
		}

		const starterSpecificationPath = this.findStarterSpecificationPath(plan);

		const selection = await this.windowApi.showInformationMessage(
			'Spec Trace scaffold initialized.',
			...(starterSpecificationPath ? ['Open starter spec'] : []),
			'Create artifact',
			'Open Explorer'
		);

		if (selection === 'Open starter spec' && starterSpecificationPath) {
			const workspaceFolder = this.getWorkspaceFolder();
			if (!workspaceFolder) {
				return;
			}

			const starterUri = vscode.Uri.joinPath(workspaceFolder.uri, ...starterSpecificationPath.split('/'));
			await this.commandsApi.executeCommand('vscode.openWith', starterUri, SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE);
			return;
		}

		if (selection === 'Create artifact') {
			await this.promptAndCreateArtifact(undefined, workspaceFolder);
			return;
		}

		if (selection === 'Open Explorer') {
			await this.commandsApi.executeCommand('spec-trace-vsce.openRepositoryExplorer');
		}
	}

	public async promptAndCreateArtifact(options?: CreateArtifactCommandOptions, workspaceFolder = this.getWorkspaceFolder()): Promise<void> {
		if (!workspaceFolder) {
			void this.windowApi.showErrorMessage('Open a workspace folder before creating Spec Trace artifacts.');
			return;
		}

		const initialState = await this.detectRepositoryState(workspaceFolder);
		if (initialState === 'missing') {
			const selection = await this.windowApi.showInformationMessage(
				'Spec Trace scaffold is missing. Initialize the repository before creating artifacts.',
				'Initialize repository',
				'Cancel'
			);

			if (selection !== 'Initialize repository') {
				return;
			}

			await this.promptAndInitializeRepository();
			return;
		}

		const kind = options?.kind ?? await this.promptForArtifactKind();
		if (!kind) {
			return;
		}

		const domain = await this.promptForDomain(kind, options?.domain);
		if (!domain) {
			return;
		}

		const title = await this.promptForRequiredInput(
			this.labelForArtifactKind(kind),
			`Enter a title for the ${this.labelForArtifactKind(kind).toLowerCase()}.`
		);
		if (!title) {
			return;
		}

		const capability = kind === 'specification'
				? await this.windowApi.showInputBox({
					prompt: 'Enter the capability identifier.',
					value: title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'capability',
					ignoreFocusOut: true,
				validateInput: (value) => value.trim().length === 0 ? 'Capability is required.' : undefined
			})
			: undefined;

		if (kind === 'specification' && !capability) {
			return;
		}

		const traceLinks = kind === 'specification'
			? []
				: this.parseTraceLinks(await this.windowApi.showInputBox({
					prompt: 'Optional trace links (comma-separated requirement or artifact ids).',
					placeHolder: 'REQ-EXAMPLE-0001, ARC-EXAMPLE',
					ignoreFocusOut: true
			}));

		const rendered = renderArtifact({
			kind,
			domain,
			title,
			capability,
			traceLinks
		});

		const created = await this.writeRenderedArtifact(workspaceFolder, rendered);
		if (!created) {
			void this.windowApi.showErrorMessage(`A Spec Trace artifact already exists at ${rendered.relativePath}. Choose a different title or domain.`);
			return;
		}

		await this.openRenderedArtifact(workspaceFolder, kind, rendered);
	}

	private async collectExistingScaffoldPaths(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
		const candidates = [
			...getScaffoldDirectories(),
			...getScaffoldFiles().map((file) => file.path)
		];

		const existing: string[] = [];
		await Promise.all(candidates.map(async (relativePath) => {
			const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...relativePath.split('/'));
			if (await this.pathExists(uri)) {
				existing.push(normalizePath(relativePath));
			}
		}));

		return existing;
	}

	private async promptForArtifactKind(): Promise<ArtifactKind | undefined> {
		const selection = await this.windowApi.showQuickPick(
			[
				{ label: 'Specification', value: 'specification' as const, description: 'Create a specification JSON artifact.' },
				{ label: 'Architecture', value: 'architecture' as const, description: 'Create an architecture markdown artifact.' },
				{ label: 'Work Item', value: 'workItem' as const, description: 'Create a work-item markdown artifact.' },
				{ label: 'Verification', value: 'verification' as const, description: 'Create a verification markdown artifact.' }
			],
			{
				title: 'Create Spec Trace artifact',
				ignoreFocusOut: true
			}
		);

		return selection?.value;
	}

	private async promptForDomain(kind: ArtifactKind, suggestedDomain?: string): Promise<string | undefined> {
		const defaultDomain = suggestedDomain
			? normalizeDomain(suggestedDomain)
			: await this.deriveSuggestedDomain(kind);

		const value = await this.windowApi.showInputBox({
			prompt: `Enter the domain for the ${this.labelForArtifactKind(kind).toLowerCase()}.`,
			value: defaultDomain,
			ignoreFocusOut: true,
			validateInput: (input) => input.trim().length === 0 ? 'Domain is required.' : undefined
		});

		return value ? normalizeDomain(value) : undefined;
	}

	private async deriveSuggestedDomain(kind: ArtifactKind): Promise<string> {
		const workspaceFolder = this.getWorkspaceFolder();
		if (!workspaceFolder) {
			return kind === 'specification' ? 'default' : 'wb';
		}

		const rootUri = vscode.Uri.joinPath(workspaceFolder.uri, ...this.rootPathForKind(kind).split('/'));
		try {
			const entries = await this.fileSystem.readDirectory(rootUri);
			const firstDomain = entries.find(([, type]) => type === vscode.FileType.Directory)?.[0];
			return firstDomain ? normalizeDomain(firstDomain) : (kind === 'specification' ? 'default' : 'wb');
		} catch {
			return kind === 'specification' ? 'default' : 'wb';
		}
	}

	private rootPathForKind(kind: ArtifactKind): string {
		switch (kind) {
			case 'specification':
				return 'specs/requirements';
			case 'architecture':
				return 'specs/architecture';
			case 'workItem':
				return 'specs/work-items';
			case 'verification':
				return 'specs/verification';
		}
	}

	private async promptForRequiredInput(title: string, prompt: string): Promise<string | undefined> {
		return this.windowApi.showInputBox({
			title,
			prompt,
			ignoreFocusOut: true,
			validateInput: (value) => value.trim().length === 0 ? 'A value is required.' : undefined
		});
	}

	private parseTraceLinks(input: string | undefined): string[] {
		if (!input) {
			return [];
		}

		return input.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
	}

	private async writeRenderedArtifact(workspaceFolder: vscode.WorkspaceFolder, rendered: RenderedArtifact): Promise<boolean> {
		const artifactUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.relativePath.split('/'));
		if (await this.pathExists(artifactUri)) {
			return false;
		}

		const domainIndexUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.domainIndexPath.split('/'));
		if (!await this.pathExists(domainIndexUri)) {
			await this.fileSystem.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, ...dirname(rendered.domainIndexPath).split('/')));
			await this.fileSystem.writeFile(domainIndexUri, new TextEncoder().encode(rendered.domainIndexContent));
		}

		await this.fileSystem.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, ...dirname(rendered.relativePath).split('/')));
		await this.fileSystem.writeFile(artifactUri, new TextEncoder().encode(rendered.content));
		return true;
	}

	private async openRenderedArtifact(
		workspaceFolder: vscode.WorkspaceFolder,
		kind: ArtifactKind,
		rendered: RenderedArtifact
	): Promise<void> {
		const artifactUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.relativePath.split('/'));
		if (kind === 'specification') {
			await this.commandsApi.executeCommand('vscode.openWith', artifactUri, SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE);
			return;
		}

		await this.commandsApi.executeCommand('vscode.open', artifactUri);
	}

	private labelForArtifactKind(kind: ArtifactKind): string {
		switch (kind) {
			case 'specification':
				return 'Specification';
			case 'architecture':
				return 'Architecture artifact';
			case 'workItem':
				return 'Work item';
			case 'verification':
				return 'Verification artifact';
		}
	}

	private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	private async pathExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await this.fileSystem.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private findStarterSpecificationPath(plan: BootstrapPlan): string | undefined {
		return plan.missingFiles.find((file) => file.path.endsWith('.json') && file.path.includes('/getting-started/'))?.path;
	}
}

function dirname(path: string): string {
	const normalized = normalizePath(path);
	const lastSlashIndex = normalized.lastIndexOf('/');
	return lastSlashIndex >= 0 ? normalized.slice(0, lastSlashIndex) : '';
}
