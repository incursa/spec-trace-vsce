import * as assert from 'assert';

import * as vscode from 'vscode';

import { SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE } from '../../editor/host/specificationCustomEditor.js';
import { MARKDOWN_ARTIFACT_CUSTOM_EDITOR_VIEW_TYPE } from '../../editor/markdown/host/markdownArtifactCustomEditor.js';
import { renderArtifact } from '../../management/core.js';
import { RepositoryManager } from '../../management/repositoryManager.js';

suite('Repository manager', () => {
	test('initializes an empty repository with scaffold and starter specification', async () => {
		const { fileSystem, manager } = createManagerFixture();
		const workspaceFolder = createWorkspaceFolder(vscode.Uri.parse('memfs:/empty-root'));

		const plan = await manager.initializeRepository(workspaceFolder);

		assert.ok(plan);
		assert.strictEqual(plan?.state, 'missing');
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, '.workbench', 'config.json')), true);
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', '_index.md')), true);
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', 'getting-started', '_index.md')), true);
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', 'getting-started', 'SPEC-GETTING-STARTED.json')), true);

		const starterPayload = JSON.parse(fileSystem.readText(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', 'getting-started', 'SPEC-GETTING-STARTED.json'))) as {
			artifact_id: string;
			requirements: Array<{ id: string }>;
		};

		assert.strictEqual(starterPayload.artifact_id, 'SPEC-GETTING-STARTED');
		assert.strictEqual(starterPayload.requirements[0].id, 'REQ-GETTING-STARTED-0001');
	});

	test('repairs a partial repository additively without overwriting existing files', async () => {
		const { fileSystem, manager } = createManagerFixture();
		const workspaceFolder = createWorkspaceFolder(vscode.Uri.parse('memfs:/partial-root'));
		const preservedRequirementsIndex = [
			'# Requirements',
			'',
			'Preserve this custom requirements index during partial repair.',
			''
		].join('\n');

		await fileSystem.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements'));
		await fileSystem.writeFile(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', '_index.md'), new TextEncoder().encode(preservedRequirementsIndex));

		const plan = await manager.initializeRepository(workspaceFolder);

		assert.ok(plan);
		assert.strictEqual(plan?.state, 'partial');
		assert.strictEqual(fileSystem.readText(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', '_index.md')), preservedRequirementsIndex);
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, '.workbench', 'config.json')), true);
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'architecture', 'WB', '_index.md')), true);
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'verification', 'WB', '_index.md')), true);
		assert.strictEqual(fileSystem.exists(vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', 'getting-started', 'SPEC-GETTING-STARTED.json')), false);
	});

	test('creates a markdown artifact, seeds the domain index, and opens the managed editor', async () => {
		const { fileSystem, commands, manager } = createManagerFixture(['platform', 'Platform Overview', 'REQ-PLATFORM-0001, ARC-PLATFORM-0001']);
		const workspaceFolder = createWorkspaceFolder(vscode.Uri.parse('memfs:/artifact-root'));

		await manager.initializeRepository(workspaceFolder);
		await manager.promptAndCreateArtifact({ kind: 'architecture', domain: 'platform' }, workspaceFolder);

		const rendered = renderArtifact({
			kind: 'architecture',
			domain: 'platform',
			title: 'Platform Overview',
			traceLinks: ['REQ-PLATFORM-0001', 'ARC-PLATFORM-0001']
		});
		const artifactUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.relativePath.split('/'));
		const domainIndexUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.domainIndexPath.split('/'));

		assert.strictEqual(fileSystem.exists(artifactUri), true);
		assert.strictEqual(fileSystem.exists(domainIndexUri), true);
		assert.strictEqual(fileSystem.readText(domainIndexUri).includes('# Platform Architecture'), true);
		assert.strictEqual(commands.calls.length, 1);
		assert.strictEqual(commands.calls[0]?.command, 'vscode.openWith');
		assert.strictEqual((commands.calls[0]?.args[0] as vscode.Uri).toString(), artifactUri.toString());
		assert.strictEqual(commands.calls[0]?.args[1], MARKDOWN_ARTIFACT_CUSTOM_EDITOR_VIEW_TYPE);
	});

	test('creates a specification artifact and opens the custom editor', async () => {
		const { fileSystem, commands, manager } = createManagerFixture(['platform', 'Platform Overview', 'platform-capability']);
		const workspaceFolder = createWorkspaceFolder(vscode.Uri.parse('memfs:/spec-root'));

		await manager.initializeRepository(workspaceFolder);
		await manager.promptAndCreateArtifact({ kind: 'specification', domain: 'platform' }, workspaceFolder);

		const rendered = renderArtifact({
			kind: 'specification',
			domain: 'platform',
			title: 'Platform Overview',
			capability: 'platform-capability'
		});
		const artifactUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.relativePath.split('/'));
		const domainIndexUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.domainIndexPath.split('/'));

		assert.strictEqual(fileSystem.exists(artifactUri), true);
		assert.strictEqual(fileSystem.exists(domainIndexUri), true);
		assert.strictEqual(fileSystem.readText(domainIndexUri).includes('# Platform Requirements'), true);
		assert.strictEqual(commands.calls.length, 1);
		assert.strictEqual(commands.calls[0]?.command, 'vscode.openWith');
		assert.strictEqual((commands.calls[0]?.args[0] as vscode.Uri).toString(), artifactUri.toString());
		assert.strictEqual(commands.calls[0]?.args[1], SPECIFICATION_CUSTOM_EDITOR_VIEW_TYPE);
	});

	test('rejects artifact collisions without writing or opening anything', async () => {
		const { fileSystem, window, commands, manager } = createManagerFixture(['platform', 'Platform Overview', 'REQ-PLATFORM-0001']);
		const workspaceFolder = createWorkspaceFolder(vscode.Uri.parse('memfs:/collision-root'));

		await manager.initializeRepository(workspaceFolder);

		const rendered = renderArtifact({
			kind: 'architecture',
			domain: 'platform',
			title: 'Platform Overview',
			traceLinks: ['REQ-PLATFORM-0001']
		});
		const artifactUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.relativePath.split('/'));
		const domainIndexUri = vscode.Uri.joinPath(workspaceFolder.uri, ...rendered.domainIndexPath.split('/'));

		await fileSystem.writeFile(artifactUri, new TextEncoder().encode('Existing artifact content.\n'));

		await manager.promptAndCreateArtifact({ kind: 'architecture', domain: 'platform' }, workspaceFolder);

		assert.strictEqual(fileSystem.readText(artifactUri), 'Existing artifact content.\n');
		assert.strictEqual(fileSystem.exists(domainIndexUri), false);
		assert.strictEqual(commands.calls.length, 0);
		assert.deepStrictEqual(window.errorMessages, [
			`A Spec Trace artifact already exists at ${rendered.relativePath}. Choose a different title or domain.`
		]);
	});
});

class InMemoryFileSystem {
	private readonly directories = new Set<string>();
	private readonly files = new Map<string, Uint8Array>();

	public constructor() {}

	public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const key = normalizeUri(uri);
		if (this.files.has(key)) {
			return {
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: this.files.get(key)?.byteLength ?? 0
			};
		}

		if (this.directories.has(key)) {
			return {
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: 0,
				size: 0
			};
		}

		throw vscode.FileSystemError.FileNotFound(uri);
	}

	public async createDirectory(uri: vscode.Uri): Promise<void> {
		const normalizedPath = uri.path.replace(/\\/g, '/');
		const segments = normalizedPath.split('/').filter(Boolean);
		let current = `${uri.scheme}:/`;
		this.directories.add(current);
		for (const segment of segments) {
			current = current.endsWith('/') ? `${current}${segment}` : `${current}/${segment}`;
			this.directories.add(current);
		}
	}

	public async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		await this.createDirectory(parentUri(uri));
		this.files.set(normalizeUri(uri), content);
	}

	public async readDirectory(uri: vscode.Uri): Promise<readonly [string, vscode.FileType][]> {
		const base = normalizeUri(uri);
		const entries = new Map<string, vscode.FileType>();
		const prefix = base.endsWith('/') ? base : `${base}/`;

		for (const directory of this.directories) {
			if (!directory.startsWith(prefix) || directory === base) {
				continue;
			}

			const remainder = directory.slice(prefix.length);
			if (!remainder || remainder.includes('/')) {
				continue;
			}

			entries.set(remainder, vscode.FileType.Directory);
		}

		for (const file of this.files.keys()) {
			if (!file.startsWith(prefix)) {
				continue;
			}

			const remainder = file.slice(prefix.length);
			if (!remainder || remainder.includes('/')) {
				continue;
			}

			entries.set(remainder, vscode.FileType.File);
		}

		if (!this.directories.has(base) && entries.size === 0) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		return Array.from(entries.entries());
	}

	public exists(uri: vscode.Uri): boolean {
		const key = normalizeUri(uri);
		return this.directories.has(key) || this.files.has(key);
	}

	public readText(uri: vscode.Uri): string {
		const bytes = this.files.get(normalizeUri(uri));
		if (!bytes) {
			throw new Error(`File not found: ${uri.toString()}`);
		}

		return new TextDecoder().decode(bytes);
	}
}

function createWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder {
	return {
		uri,
		name: 'test-workspace',
		index: 0
	};
}

function createManagerFixture(inputResponses: Array<string | undefined> = []) {
	const fileSystem = new InMemoryFileSystem();
	const window = createWindowStub(inputResponses);
	const commands = createCommandStub();
	const manager = new RepositoryManager(fileSystem as never, window as never, commands as never);
	return { fileSystem, window, commands, manager };
}

function createWindowStub(inputResponses: Array<string | undefined> = []) {
	const responses = [...inputResponses];
	const errorMessages: string[] = [];
	const informationMessages: string[] = [];
	return {
		errorMessages,
		informationMessages,
		showErrorMessage: async (message: string) => {
			errorMessages.push(message);
			return undefined;
		},
		showInformationMessage: async (message: string) => {
			informationMessages.push(message);
			return undefined;
		},
		showInputBox: async () => responses.shift(),
		showQuickPick: async () => undefined
	};
}

function createCommandStub() {
	const calls: Array<{ command: string; args: unknown[] }> = [];
	return {
		calls,
		executeCommand: async (command: string, ...args: unknown[]) => {
			calls.push({ command, args });
			return undefined;
		}
	};
}

function normalizeUri(uri: vscode.Uri): string {
	const normalizedPath = uri.path.replace(/\\/g, '/').replace(/\/+$/, '');
	return `${uri.scheme}:${normalizedPath.length > 0 ? normalizedPath : '/'}`;
}

function parentUri(uri: vscode.Uri): vscode.Uri {
	const normalizedPath = uri.path.replace(/\\/g, '/');
	const lastSlashIndex = normalizedPath.lastIndexOf('/');
	return uri.with({
		path: lastSlashIndex > 0 ? normalizedPath.slice(0, lastSlashIndex) : '/'
	});
}
