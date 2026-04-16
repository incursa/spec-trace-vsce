import { serializeSpecificationDocument } from '../editor/core/specification.js';

export type RepositoryState = 'missing' | 'partial' | 'ready';
export type ArtifactKind = 'specification' | 'architecture' | 'workItem' | 'verification';

export interface ScaffoldFileTemplate {
	readonly path: string;
	readonly content: string;
}

export interface BootstrapPlan {
	readonly state: RepositoryState;
	readonly missingDirectories: string[];
	readonly missingFiles: ScaffoldFileTemplate[];
}

export interface ArtifactCreationInput {
	readonly kind: ArtifactKind;
	readonly domain: string;
	readonly title: string;
	readonly capability?: string;
	readonly owner?: string;
	readonly summary?: string;
	readonly traceLinks?: string[];
}

export interface RenderedArtifact {
	readonly kind: ArtifactKind;
	readonly artifactId: string;
	readonly domain: string;
	readonly relativePath: string;
	readonly content: string;
	readonly domainIndexPath: string;
	readonly domainIndexContent: string;
}

const workbenchConfig = {
	Paths: {
		DocsRoot: 'overview',
		SpecsRoot: 'specs',
		ArchitectureDir: 'specs/architecture',
		WorkItemsSpecsDir: 'specs/work-items',
		GeneratedDir: 'specs/generated',
		SpecsTemplatesDir: 'specs/templates',
		SpecsSchemasDir: 'specs/schemas',
		WorkRoot: 'specs/work-items',
		ItemsDir: 'specs/work-items/WB'
	},
	Ids: {
		Width: 4
	},
	Git: {
		BranchPattern: 'work/{id}-{slug}',
		CommitMessagePattern: 'Promote {id}: {title}',
		DefaultBaseBranch: 'main',
		RequireCleanWorkingTree: true
	},
	Github: {
		Provider: 'octokit',
		DefaultDraft: false,
		Host: 'github.com',
		Owner: null,
		Repository: null,
		Sync: {
			Mode: 'generate',
			ConflictDefault: 'fail',
			ScheduleEnabled: false
		}
	},
	Validation: {
		LinkExclude: [],
		DocExclude: [],
		Profile: null
	},
	Tui: {
		Theme: 'powershell',
		UseEmoji: true,
		AutoRefreshSeconds: 60
	}
} as const;

const scaffoldDirectories = [
	'.workbench',
	'specs',
	'specs/architecture',
	'specs/architecture/WB',
	'specs/generated',
	'specs/requirements',
	'specs/schemas',
	'specs/templates',
	'specs/verification',
	'specs/verification/WB',
	'specs/work-items',
	'specs/work-items/WB'
] as const;

const scaffoldFiles: ScaffoldFileTemplate[] = [
	{
		path: '.workbench/config.json',
		content: `${JSON.stringify(workbenchConfig, undefined, '\t')}\n`
	},
	{
		path: 'specs/requirements/_index.md',
		content: [
			'# Requirements',
			'',
			'Canonical specification artifacts live under `specs/requirements/<domain>/`.',
			'',
			'## Index',
			'',
			'- Add domain folders here as requirements grow.',
			''
		].join('\n')
	},
	{
		path: 'specs/architecture/WB/_index.md',
		content: createStaticIndexContent('Architecture', 'Canonical architecture artifacts live under `specs/architecture/<domain>/`.', 'Add domain folders here as architecture grows.')
	},
	{
		path: 'specs/work-items/WB/_index.md',
		content: createStaticIndexContent('Work Items', 'Canonical work-item artifacts live under `specs/work-items/<domain>/`.', 'Add work items here as implementation work grows.')
	},
	{
		path: 'specs/verification/WB/_index.md',
		content: createStaticIndexContent('Verification', 'Canonical verification artifacts live under `specs/verification/<domain>/`.', 'Add verification artifacts here as coverage grows.')
	}
] as const;

const bootstrapStarterFiles: ScaffoldFileTemplate[] = [
	{
		path: 'specs/requirements/getting-started/_index.md',
		content: createDomainIndexContent('specification', 'getting-started')
	},
	{
		path: 'specs/requirements/getting-started/SPEC-GETTING-STARTED.json',
		content: renderBootstrapStarterSpecification()
	}
] as const;

const requiredScaffoldPaths = new Set<string>([
	...scaffoldDirectories,
	...scaffoldFiles.map((file) => file.path)
]);

export function getScaffoldDirectories(): readonly string[] {
	return scaffoldDirectories;
}

export function getScaffoldFiles(): readonly ScaffoldFileTemplate[] {
	return scaffoldFiles;
}

export function getBootstrapStarterFiles(): readonly ScaffoldFileTemplate[] {
	return bootstrapStarterFiles;
}

export function detectRepositoryState(existingPaths: Iterable<string>): RepositoryState {
	const normalized = new Set(Array.from(existingPaths, (path) => normalizePath(path)));
	const presentRequiredCount = Array.from(requiredScaffoldPaths).filter((path) => normalized.has(path)).length;
	if (presentRequiredCount === 0) {
		return 'missing';
	}

	return presentRequiredCount === requiredScaffoldPaths.size ? 'ready' : 'partial';
}

export function createBootstrapPlan(existingPaths: Iterable<string>): BootstrapPlan {
	const normalized = new Set(Array.from(existingPaths, (path) => normalizePath(path)));
	const state = detectRepositoryState(normalized);
	const starterFiles = state === 'missing'
		? bootstrapStarterFiles.filter((file) => !normalized.has(normalizePath(file.path)))
		: [];
	return {
		state,
		missingDirectories: scaffoldDirectories.filter((path) => !normalized.has(path)),
		missingFiles: [
			...scaffoldFiles.filter((file) => !normalized.has(normalizePath(file.path))),
			...starterFiles
		]
	};
}

export function renderArtifact(input: ArtifactCreationInput): RenderedArtifact {
	const normalizedKind = input.kind;
	const domain = normalizeDomain(input.domain);
	const title = input.title.trim() || fallbackTitleForKind(normalizedKind);
	const traceLinks = dedupeStringArray(input.traceLinks ?? []);

	switch (normalizedKind) {
		case 'specification':
			return renderSpecificationArtifact(input, domain, title);
		case 'architecture':
			return renderMarkdownArtifact(normalizedKind, domain, title, traceLinks, input);
		case 'workItem':
			return renderMarkdownArtifact(normalizedKind, domain, title, traceLinks, input);
		case 'verification':
			return renderMarkdownArtifact(normalizedKind, domain, title, traceLinks, input);
	}
}

export function getCategoryRoot(kind: ArtifactKind): string {
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

export function getDomainIndexPath(kind: ArtifactKind, domain: string): string {
	return `${getCategoryRoot(kind)}/${normalizeDomain(domain)}/_index.md`;
}

export function createDomainIndexContent(kind: ArtifactKind, domain: string): string {
	const normalizedDomain = normalizeDomain(domain);
	switch (kind) {
		case 'specification':
			return [
				`# ${formatDomainHeading(normalizedDomain)} Requirements`,
				'',
				`This folder contains canonical requirements for the \`${normalizedDomain}\` domain.`,
				'',
				'## Index',
				'',
				'- Add specification artifacts here as requirements grow.',
				''
			].join('\n');
		case 'architecture':
			return [
				`# ${formatDomainHeading(normalizedDomain)} Architecture`,
				'',
				`This folder contains canonical architecture artifacts for the \`${normalizedDomain}\` domain.`,
				'',
				'## Index',
				'',
				'- Add architecture artifacts here as design grows.',
				''
			].join('\n');
		case 'workItem':
			return [
				`# ${formatDomainHeading(normalizedDomain)} Work Items`,
				'',
				`This folder contains implementation-facing work items for the \`${normalizedDomain}\` domain.`,
				'',
				'## Index',
				'',
				'- Add work items here as implementation work grows.',
				''
			].join('\n');
		case 'verification':
			return [
				`# ${formatDomainHeading(normalizedDomain)} Verification`,
				'',
				`This folder contains verification artifacts for the \`${normalizedDomain}\` domain.`,
				'',
				'## Index',
				'',
				'- Add verification artifacts here as coverage grows.',
				''
			].join('\n');
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

export function normalizeDomain(domain: string): string {
	const normalized = domain.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
	return normalized.length > 0 ? normalized : 'default';
}

function createStaticIndexContent(title: string, summary: string, bullet: string): string {
	return [
		`# ${title}`,
		'',
		summary,
		'',
		'## Index',
		'',
		`- ${bullet}`,
		''
	].join('\n');
}

function renderSpecificationArtifact(input: ArtifactCreationInput, domain: string, title: string): RenderedArtifact {
	const capability = toKebabCase(input.capability?.trim() || title);
	const capabilityId = toUpperTokenSequence(input.capability?.trim() || title, 'CAPABILITY');
	const artifactId = `SPEC-${capabilityId}`;
	const owner = input.owner?.trim() || `${domain}-maintainers`;
	const requirementPrefix = artifactId.startsWith('SPEC-') ? artifactId.slice('SPEC-'.length) : artifactId;
	const document = {
		artifact_id: artifactId,
		artifact_type: 'specification',
		title,
		domain,
		capability,
		status: 'draft',
		owner,
		purpose: `Define ${title}.`,
		scope: `This specification covers ${title.toLowerCase()}.`,
		context: 'Created with the Spec Trace VS Code extension.',
		tags: ['spec-trace', domain],
		related_artifacts: [],
		open_questions: [],
		supplemental_sections: [],
		requirements: [
			{
				id: `REQ-${requirementPrefix}-0001`,
				title: `Define ${title}`,
				statement: `The system MUST define ${title.toLowerCase()}.`,
				notes: []
			}
		]
	};

	return {
		kind: 'specification',
		artifactId,
		domain,
		relativePath: `${getCategoryRoot('specification')}/${domain}/${artifactId}.json`,
		content: serializeSpecificationDocument(document),
		domainIndexPath: getDomainIndexPath('specification', domain),
		domainIndexContent: createDomainIndexContent('specification', domain)
	};
}

function renderMarkdownArtifact(
	kind: Exclude<ArtifactKind, 'specification'>,
	domain: string,
	title: string,
	traceLinks: readonly string[],
	input: ArtifactCreationInput
): RenderedArtifact {
	const prefix = getArtifactPrefix(kind);
	const artifactId = `${prefix}-${toUpperTokenSequence(title, fallbackTitleForKind(kind).toUpperCase())}`;
	const summary = (input.summary?.trim() || `Created from the Spec Trace VS Code extension for ${title}.`).trim();
	const traceHeading = getTraceHeading(kind);
	const traceSection = traceLinks.length > 0 ? traceLinks.map((value) => `- ${traceHeading}: \`${value}\``) : [`- ${traceHeading}: none yet`];

	const content = [
		'---',
		`artifact_id: ${artifactId}`,
		`title: ${title}`,
		`summary: ${summary}`,
		'---',
		`# ${artifactId}`,
		'',
		'## Purpose',
		'',
		summary,
		'',
		'## Trace Links',
		'',
		...traceSection,
		'',
		'## Notes',
		'',
		'- Add implementation-specific detail here.',
		''
	].join('\n');

	return {
		kind,
		artifactId,
		domain,
		relativePath: `${getCategoryRoot(kind)}/${domain}/${artifactId}.md`,
		content,
		domainIndexPath: getDomainIndexPath(kind, domain),
		domainIndexContent: createDomainIndexContent(kind, domain)
	};
}

function dedupeStringArray(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) {
			continue;
		}

		seen.add(trimmed);
		output.push(trimmed);
	}

	return output;
}

function formatDomainHeading(domain: string): string {
	return domain.split('-').filter(Boolean).map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`).join(' ');
}

function fallbackTitleForKind(kind: ArtifactKind): string {
	switch (kind) {
		case 'specification':
			return 'Specification';
		case 'architecture':
			return 'Architecture';
		case 'workItem':
			return 'Work Item';
		case 'verification':
			return 'Verification';
	}
}

function getArtifactPrefix(kind: Exclude<ArtifactKind, 'specification'>): string {
	switch (kind) {
		case 'architecture':
			return 'ARC';
		case 'workItem':
			return 'WI';
		case 'verification':
			return 'VER';
	}
}

function getTraceHeading(kind: Exclude<ArtifactKind, 'specification'>): string {
	switch (kind) {
		case 'architecture':
			return 'Satisfies';
		case 'workItem':
			return 'Addresses';
		case 'verification':
			return 'Verifies';
	}
}

function toUpperTokenSequence(value: string, fallback: string): string {
	const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
	return normalized.length > 0 ? normalized : fallback;
}

function toKebabCase(value: string): string {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
	return normalized.length > 0 ? normalized : 'capability';
}

function renderBootstrapStarterSpecification(): string {
	return serializeSpecificationDocument({
		artifact_id: 'SPEC-GETTING-STARTED',
		artifact_type: 'specification',
		title: 'Getting Started Specification',
		domain: 'getting-started',
		capability: 'getting-started',
		status: 'draft',
		owner: 'getting-started-maintainers',
		purpose: 'Define the initial starter specification created during Spec Trace bootstrap.',
		scope: 'This specification covers the initial bootstrap path for a newly initialized Spec Trace repository.',
		context: 'Created automatically by the Spec Trace VS Code extension during repository bootstrap.',
		tags: ['spec-trace', 'getting-started', 'bootstrap'],
		related_artifacts: [],
		open_questions: [],
		supplemental_sections: [],
		requirements: [
			{
				id: 'REQ-GETTING-STARTED-0001',
				title: 'Provide an initial starter specification',
				statement: 'The repository MUST include an initial starter specification after bootstrap.',
				notes: ['Revise or replace this starter artifact as domain requirements become concrete.']
			}
		]
	});
}
