import * as vscode from 'vscode';

import { parseSpecificationDocument } from '../editor/core/specificationValidation.js';
import {
	getManagedMarkdownArtifactTypeFromPath,
	normalizeManagedMarkdownDocument,
	parseManagedMarkdownDocument,
	type ManagedMarkdownArtifactType
} from '../editor/markdown/core.js';

export type QualityArtifactFormat = 'json' | 'yaml' | 'markdown' | 'html' | 'text';

export type QualityArtifactKind =
	| 'testing_intent'
	| 'quality_report'
	| 'attestation'
	| 'coverage'
	| 'report'
	| 'markdown'
	| 'unknown';

export type QualityHealth = 'missing' | 'ok' | 'warning' | 'error';

export interface QualityArtifactSource {
	readonly uri: vscode.Uri;
	readonly relativePath: string;
	readonly text: string;
}

export interface QualityArtifactSnapshot extends QualityArtifactSource {
	readonly kind: QualityArtifactKind;
	readonly format: QualityArtifactFormat;
	readonly label: string;
	readonly description: string;
	readonly summary: string;
	readonly status: string;
	readonly testResult: string;
	readonly coverage: string;
	readonly health: QualityHealth;
	readonly healthMessage: string;
	readonly rawPreview: string;
	readonly rawPreviewTruncated: boolean;
	readonly findings: string[];
	readonly coverageEvidence: string[];
	readonly criticalFiles: string[];
	readonly tests: string[];
	readonly attestationAggregates: string[];
	readonly references: QualityReferenceSnapshot[];
}

export interface QualityWorkspaceSnapshot {
	readonly state: QualityHealth;
	readonly message: string;
	readonly artifacts: QualityArtifactSnapshot[];
}

export interface QualityReferenceSnapshot {
	readonly field: string;
	readonly value: string;
	readonly description: string;
	readonly kind: 'requirement' | 'artifact' | 'file';
	readonly sourceUri: vscode.Uri;
	readonly resolved: boolean;
	readonly targetUri?: vscode.Uri;
	readonly targetRequirementIndex?: number;
	readonly targetOpenKind?: 'specification' | 'markdown' | 'text';
	readonly managed?: boolean;
}

export interface LocalReferenceTarget {
	readonly kind: 'specification' | 'markdown' | 'requirement' | 'file';
	readonly uri: vscode.Uri;
	readonly requirementIndex?: number;
	readonly managed?: boolean;
}

export interface LocalReferenceIndex {
	readonly artifactTargets: Map<string, LocalReferenceTarget>;
	readonly requirementTargets: Map<string, LocalReferenceTarget>;
	readonly pathTargets: Map<string, LocalReferenceTarget>;
}

export interface CanonicalArtifactSource {
	readonly uri: vscode.Uri;
	readonly relativePath: string;
	readonly text: string;
}

const canonicalWorkspaceGlobs = '{**/node_modules/**,**/dist/**,**/.git/**,**/.vscode-test-web/**,**/.workbench/**,**/artifacts/**}';
const qualityWorkspaceGlobs = '{**/node_modules/**,**/dist/**,**/.git/**,**/.vscode-test-web/**,**/.workbench/**}';

const qualitySourcePatterns = [
	'quality/testing-intent.yaml',
	'quality/testing-intent.yml',
	'artifacts/quality/**/*.{json,md,markdown,html,htm,yaml,yml,txt}'
];

export async function buildQualityWorkspaceSnapshot(
	workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<QualityWorkspaceSnapshot> {
	if (!workspaceFolder) {
		return {
			state: 'missing',
			message: 'Open a workspace folder to inspect local quality artifacts.',
			artifacts: []
		};
	}

	const [qualitySources, canonicalSources] = await Promise.all([
		discoverQualityArtifactSources(workspaceFolder),
		discoverCanonicalArtifactSources(workspaceFolder)
	]);

	const referenceIndex = buildLocalReferenceIndex(canonicalSources);
	const artifacts = qualitySources.map((source) => analyzeQualityArtifactSource(source, referenceIndex));
	artifacts.sort((left, right) => sortQualityArtifacts(left, right));

	const state = artifacts.length === 0
		? 'missing'
		: artifacts.some((artifact) => artifact.health === 'error' || artifact.health === 'warning')
			? 'warning'
			: 'ok';

	const message = artifacts.length === 0
		? 'No local quality or attestation artifacts were found in this workspace.'
		: state === 'warning'
			? 'Some quality artifacts are malformed or incomplete.'
			: 'Quality artifacts were discovered locally.';

	return {
		state,
		message,
		artifacts
	};
}

export async function discoverQualityArtifactSources(workspaceFolder: vscode.WorkspaceFolder): Promise<QualityArtifactSource[]> {
	const files = await Promise.all(qualitySourcePatterns.map(async (pattern) => vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, pattern), qualityWorkspaceGlobs)));
	const uris = dedupeUris(files.flat());
	const sources: QualityArtifactSource[] = [];

	for (const uri of uris) {
		const relativePath = normalizeWorkspaceRelativePath(vscode.workspace.asRelativePath(uri, false));
		const text = await readText(uri);
		sources.push({
			uri,
			relativePath,
			text
		});
	}

	return sources;
}

export async function discoverCanonicalArtifactSources(workspaceFolder: vscode.WorkspaceFolder): Promise<CanonicalArtifactSource[]> {
	const files = await Promise.all([
		vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, 'specs/requirements/**/*.json'), canonicalWorkspaceGlobs),
		vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, 'specs/architecture/**/*.md'), canonicalWorkspaceGlobs),
		vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, 'specs/work-items/**/*.md'), canonicalWorkspaceGlobs),
		vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, 'specs/verification/**/*.md'), canonicalWorkspaceGlobs)
	]);

	const uris = dedupeUris(files.flat());
	const sources: CanonicalArtifactSource[] = [];
	for (const uri of uris) {
		sources.push({
			uri,
			relativePath: normalizeWorkspaceRelativePath(vscode.workspace.asRelativePath(uri, false)),
			text: await readText(uri)
		});
	}

	return sources;
}

export function buildLocalReferenceIndex(sources: readonly CanonicalArtifactSource[]): LocalReferenceIndex {
	const artifactTargets = new Map<string, LocalReferenceTarget>();
	const requirementTargets = new Map<string, LocalReferenceTarget>();
	const pathTargets = new Map<string, LocalReferenceTarget>();

	for (const source of sources) {
		const relativePath = normalizeWorkspaceRelativePath(source.relativePath);
		const basename = basenameFromPath(relativePath);
		addPathAlias(pathTargets, relativePath, {
			kind: isSpecificationSource(relativePath) ? 'specification' : 'markdown',
			uri: source.uri,
			managed: isManagedMarkdownSource(source)
		});
		addPathAlias(pathTargets, basename, {
			kind: isSpecificationSource(relativePath) ? 'specification' : 'markdown',
			uri: source.uri,
			managed: isManagedMarkdownSource(source)
		});

		if (isSpecificationSource(relativePath)) {
			const parsed = parseSpecificationDocument(source.text);
			if (!parsed.document) {
				continue;
			}

			const artifactId = stringValue(parsed.document.artifact_id);
			if (artifactId.length > 0) {
				addAlias(artifactTargets, artifactId, {
					kind: 'specification',
					uri: source.uri
				});
				addAlias(pathTargets, artifactId, {
					kind: 'specification',
					uri: source.uri
				});
			}

			const title = stringValue(parsed.document.title);
			if (title.length > 0) {
				addAlias(artifactTargets, title, {
					kind: 'specification',
					uri: source.uri
				});
			}

			(parsed.document.requirements ?? []).forEach((requirement, index) => {
				const requirementId = stringValue(requirement.id);
				if (requirementId.length > 0) {
					addAlias(requirementTargets, requirementId, {
						kind: 'requirement',
						uri: source.uri,
						requirementIndex: index
					});
				}

				const requirementTitle = stringValue(requirement.title);
				if (requirementTitle.length > 0) {
					addAlias(requirementTargets, requirementTitle, {
						kind: 'requirement',
						uri: source.uri,
						requirementIndex: index
					});
				}
			});

			continue;
		}

		if (isManagedMarkdownSource(source)) {
			const parsed = normalizeManagedMarkdownDocument(parseManagedMarkdownDocument(source.text));
			if (!parsed.artifact_id || !parsed.artifact_type) {
				continue;
			}

			const expectedType = getManagedMarkdownArtifactTypeFromPath(relativePath);
			if (!expectedType || parsed.artifact_type !== expectedType) {
				continue;
			}

			addAlias(artifactTargets, parsed.artifact_id, {
				kind: 'markdown',
				uri: source.uri,
				managed: true
			});
			addAlias(artifactTargets, parsed.title ?? parsed.artifact_id, {
				kind: 'markdown',
				uri: source.uri,
				managed: true
			});
		}
	}

	return {
		artifactTargets,
		requirementTargets,
		pathTargets
	};
}

export function resolveLocalReferenceToken(
	token: string,
	referenceIndex: LocalReferenceIndex,
	workspaceFolder: vscode.WorkspaceFolder | undefined
): LocalReferenceTarget | undefined {
	const normalized = normalizeReferenceToken(token);
	if (normalized.length === 0) {
		return undefined;
	}

	if (looksLikeExplicitPath(normalized) && workspaceFolder) {
		const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...normalized.split('/'));
		return {
			kind: 'file',
			uri
		};
	}

	const exact = lookupTarget(referenceIndex.requirementTargets, normalized)
		?? lookupTarget(referenceIndex.artifactTargets, normalized)
		?? lookupTarget(referenceIndex.pathTargets, normalized);
	if (exact) {
		return exact;
	}

	const lowered = normalized.toLowerCase();
	return lookupTarget(referenceIndex.requirementTargets, lowered)
		?? lookupTarget(referenceIndex.artifactTargets, lowered)
		?? lookupTarget(referenceIndex.pathTargets, lowered);
}

export function analyzeQualityArtifactSource(
	source: QualityArtifactSource,
	referenceIndex: LocalReferenceIndex
): QualityArtifactSnapshot {
	const format = inferQualityFormat(source.uri);
	const parsed = parseQualityArtifactText(source.text, format);
	const metadata = extractQualityMetadata(parsed.data, source.text, format);
	const kind = classifyQualityArtifact(source.relativePath, source.text);
	const summary = metadata.summary || metadata.description || firstParagraph(source.text) || 'Quality artifact';
	const label = metadata.title || metadata.name || basenameFromPath(source.relativePath).replace(/\.[^.]+$/, '');
	const findings = collectEvidenceItems(parsed.data, ['findings', 'issues', 'warnings', 'problems', 'errors']);
	const coverageEvidence = collectEvidenceItems(parsed.data, ['coverage', 'trace', 'trace_evidence', 'requirements', 'requirement_coverage', 'coverage_evidence']);
	const criticalFiles = collectEvidenceItems(parsed.data, ['critical_files', 'files', 'changed_files', 'source_files']);
	const tests = collectEvidenceItems(parsed.data, ['tests', 'test_results', 'test_runs', 'critical_tests']);
	const attestationAggregates = collectEvidenceItems(parsed.data, ['attestations', 'aggregates', 'snapshots', 'attestation_aggregates']);
	const references = collectReferencesFromQualityContent(source, parsed.data, referenceIndex);
	const missingSignals = [
		metadata.status,
		metadata.testResult,
		metadata.coverage,
		summary
	].filter((value) => stringValue(value).length === 0).length;

	const health = parsed.error
		? 'error'
		: references.some((reference) => !reference.resolved)
			? 'warning'
			: missingSignals >= 3 && findings.length === 0 && coverageEvidence.length === 0 && criticalFiles.length === 0 && tests.length === 0 && attestationAggregates.length === 0
				? 'warning'
				: 'ok';

	const healthMessage = parsed.error
		? parsed.error
		: health === 'warning'
			? references.some((reference) => !reference.resolved)
				? 'Some local references could not be resolved.'
				: 'The artifact is readable, but it does not expose much local evidence yet.'
			: 'The artifact is readable and exposes local quality data.';

	return {
		uri: source.uri,
		relativePath: source.relativePath,
		text: source.text,
		kind,
		format,
		label,
		description: summary,
		summary,
		status: metadata.status || 'unknown',
		testResult: metadata.testResult || 'unknown',
		coverage: metadata.coverage || 'unknown',
		health,
		healthMessage,
		rawPreview: createRawPreview(source.text, format),
		rawPreviewTruncated: source.text.length > 8000,
		findings,
		coverageEvidence,
		criticalFiles,
		tests,
		attestationAggregates,
		references
	};
}

function collectReferencesFromQualityContent(
	source: QualityArtifactSource,
	data: unknown,
	referenceIndex: LocalReferenceIndex
): QualityReferenceSnapshot[] {
	const references = new Map<string, QualityReferenceSnapshot>();

	for (const token of collectReferenceTokens(data, source.text)) {
		const resolved = resolveLocalReferenceToken(token.value, referenceIndex, vscode.workspace.workspaceFolders?.[0]);
		const key = `${token.field}:${token.value}`;
		references.set(key, {
			field: token.field,
			value: token.value,
			description: token.description,
			kind: token.kind,
			sourceUri: source.uri,
			resolved: resolved !== undefined,
			targetUri: resolved?.uri,
			targetRequirementIndex: resolved?.requirementIndex,
			targetOpenKind: resolved ? openKindForTarget(resolved) : undefined,
			managed: resolved?.managed
		});
	}

	return Array.from(references.values());
}

function collectReferenceTokens(data: unknown, rawText: string): Array<{ field: string; value: string; description: string; kind: 'requirement' | 'artifact' | 'file' }> {
	const tokens: Array<{ field: string; value: string; description: string; kind: 'requirement' | 'artifact' | 'file' }> = [];
	const seen = new Set<string>();

	const visit = (value: unknown, path: string[]): void => {
		if (typeof value === 'string') {
			for (const token of splitReferenceCandidates(value)) {
				const kind = classifyReferenceToken(token);
				if (!kind) {
					continue;
				}

				const field = path[path.length - 1] ?? 'value';
				const key = `${field}:${token}`;
				if (seen.has(key)) {
					continue;
				}

				seen.add(key);
				tokens.push({
					field,
					value: token,
					description: describeReferenceToken(token),
					kind
				});
			}
			return;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item, path);
			}
			return;
		}

		if (typeof value !== 'object' || value === null) {
			return;
		}

		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			const lowered = key.toLowerCase();
			if (isReferenceField(lowered)) {
				visit(nested, [...path, key]);
				continue;
			}

			if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
				if (looksLikeReferenceObject(nested as Record<string, unknown>)) {
					visit(nested, [...path, key]);
				}
				continue;
			}

			if (typeof nested === 'string' && looksLikeReferenceToken(nested)) {
				visit(nested, [...path, key]);
			}
		}
	};

	visit(data, []);
	for (const token of splitReferenceCandidates(rawText)) {
		const kind = classifyReferenceToken(token);
		if (!kind) {
			continue;
		}

		const key = `raw:${token}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		tokens.push({
			field: 'raw',
			value: token,
			description: describeReferenceToken(token),
			kind
		});
	}

	return tokens;
}

function parseQualityArtifactText(text: string, format: QualityArtifactFormat): {
	data: unknown;
	error?: string;
} {
	try {
		switch (format) {
			case 'json':
				return { data: JSON.parse(text) };
			case 'yaml':
				return { data: parseLooseYaml(text) };
			case 'markdown':
				return { data: parseMarkdownQualityArtifact(text) };
			case 'html':
				return { data: parseHtmlQualityArtifact(text) };
			case 'text':
				return { data: { body: text, title: firstHeading(text), summary: firstParagraph(text) } };
		}
	} catch (error) {
		return {
			data: undefined,
			error: error instanceof Error ? error.message : 'The quality artifact could not be parsed.'
		};
	}
}

function extractQualityMetadata(data: unknown, rawText: string, format: QualityArtifactFormat): {
	title: string;
	name: string;
	description: string;
	summary: string;
	status: string;
	testResult: string;
	coverage: string;
} {
	const title = firstString(data, ['title', 'name', 'artifact_id', 'artifactId']) || firstHeading(rawText) || '';
	const description = firstString(data, ['description', 'summary', 'purpose', 'scope']) || firstParagraph(rawText) || '';
	const summary = firstString(data, ['summary', 'description', 'title', 'name']) || description;
	const status = firstString(data, ['status', 'state', 'overall_status', 'overallStatus', 'quality_status', 'qualityStatus', 'attestation_status', 'attestationStatus']) || '';
	const testResult = firstString(data, ['test_result', 'testResult', 'test_status', 'testStatus', 'result']) || '';
	const coverage = firstString(data, ['coverage', 'coverage_status', 'coverageStatus', 'coverage_percentage', 'coveragePercent']) || '';
	return {
		title,
		name: title,
		description,
		summary,
		status,
		testResult,
		coverage
	};
}

function classifyQualityArtifact(relativePath: string, rawText: string): QualityArtifactKind {
	const normalized = normalizeWorkspaceRelativePath(relativePath).toLowerCase();
	if (normalized.endsWith('testing-intent.yaml') || normalized.endsWith('testing-intent.yml')) {
		return 'testing_intent';
	}

	if (normalized.includes('/attestation/') || normalized.includes('/attestations/') || normalized.includes('attestation')) {
		return 'attestation';
	}

	if (normalized.includes('/coverage/') || normalized.includes('coverage')) {
		return 'coverage';
	}

	if (normalized.endsWith('.html') || normalized.endsWith('.htm') || /<html[\s>]/i.test(rawText)) {
		return 'report';
	}

	if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
		return 'markdown';
	}

	return 'quality_report';
}

function inferQualityFormat(uri: vscode.Uri): QualityArtifactFormat {
	const normalized = basenameFromPath(vscode.workspace.asRelativePath(uri, false)).toLowerCase();
	if (normalized.endsWith('.json')) {
		return 'json';
	}

	if (normalized.endsWith('.yaml') || normalized.endsWith('.yml')) {
		return 'yaml';
	}

	if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
		return 'markdown';
	}

	if (normalized.endsWith('.html') || normalized.endsWith('.htm')) {
		return 'html';
	}

	return 'text';
}

function parseMarkdownQualityArtifact(text: string): Record<string, unknown> {
	const normalized = text.replace(/\r\n/g, '\n');
	const frontMatter = parseSimpleFrontMatter(normalized);
	const body = frontMatter.body;
	const sections = parseMarkdownSections(body);
	return {
		...frontMatter.data,
		title: stringValue(frontMatter.data.title) || firstHeading(body) || stringValue(frontMatter.data.name),
		summary: stringValue(frontMatter.data.summary) || firstParagraph(body),
		body,
		sections
	};
}

function parseHtmlQualityArtifact(text: string): Record<string, unknown> {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
	const descriptionMatch = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(text);
	const bodyText = stripHtmlTags(text);
	return {
		title: titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : undefined,
		summary: descriptionMatch ? decodeHtmlEntities(descriptionMatch[1].trim()) : firstParagraph(bodyText),
		body: bodyText
	};
}

function parseLooseYaml(text: string): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	let currentKey: string | undefined;
	let currentList: string[] | undefined;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\t/g, '  ');
		if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
			continue;
		}

		if (currentKey && currentList && /^\s*-\s+/.test(line)) {
			currentList.push(unquote(line.replace(/^\s*-\s+/, '').trim()));
			continue;
		}

		currentKey = undefined;
		currentList = undefined;

		const match = /^\s*([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
		if (!match) {
			continue;
		}

		const key = match[1].trim();
		const rawValue = (match[2] ?? '').trim();
		if (rawValue.length === 0) {
			const list: string[] = [];
			root[key] = list;
			currentKey = key;
			currentList = list;
			continue;
		}

		if (rawValue === '[]') {
			root[key] = [];
			continue;
		}

		if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
			root[key] = parseFlowList(rawValue);
			continue;
		}

		root[key] = parseScalar(rawValue);
	}

	return root;
}

function parseSimpleFrontMatter(text: string): {
	data: Record<string, unknown>;
	body: string;
} {
	if (!text.startsWith('---\n')) {
		return {
			data: {},
			body: text
		};
	}

	const endIndex = text.indexOf('\n---\n', 4);
	if (endIndex < 0) {
		return {
			data: {},
			body: text
		};
	}

	const frontMatterText = text.slice(4, endIndex);
	const body = text.slice(endIndex + 5);
	return {
		data: parseLooseYaml(frontMatterText),
		body
	};
}

function parseMarkdownSections(body: string): Array<{ heading: string; content: string }> {
	const lines = body.replace(/\r\n/g, '\n').split('\n');
	const sections: Array<{ heading: string; content: string }> = [];
	let currentHeading: string | undefined;
	let currentContent: string[] = [];

	const flush = () => {
		if (!currentHeading) {
			return;
		}

		sections.push({
			heading: currentHeading,
			content: trimTrailingBlankLines(currentContent).join('\n')
		});
	};

	for (const line of lines) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (match) {
			flush();
			currentHeading = match[2].trim();
			currentContent = [];
			continue;
		}

		if (!currentHeading) {
			continue;
		}

		currentContent.push(line);
	}

	flush();
	return sections;
}

function collectEvidenceItems(data: unknown, candidateKeys: readonly string[]): string[] {
	const values = new Set<string>();
	const loweredCandidates = new Set(candidateKeys.map((key) => key.toLowerCase()));

	const visit = (value: unknown, key?: string): void => {
		if (value === undefined || value === null) {
			return;
		}

		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				values.add(trimmed);
			}
			return;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			values.add(String(value));
			return;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item, key);
			}
			return;
		}

		if (typeof value !== 'object') {
			return;
		}

		for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
			const lowered = entryKey.toLowerCase();
			if (loweredCandidates.has(lowered)) {
				visit(entryValue, lowered);
				continue;
			}

			if (isEvidenceField(lowered)) {
				visit(entryValue, lowered);
			}
		}
	};

	visit(data);
	return Array.from(values);
}

function addAlias(map: Map<string, LocalReferenceTarget>, key: string, target: LocalReferenceTarget): void {
	const normalized = normalizeReferenceToken(key);
	if (normalized.length === 0 || map.has(normalized)) {
		return;
	}

	map.set(normalized, target);
}

function addPathAlias(map: Map<string, LocalReferenceTarget>, key: string, target: LocalReferenceTarget): void {
	const normalized = normalizeWorkspaceRelativePath(key).toLowerCase();
	if (normalized.length === 0 || map.has(normalized)) {
		return;
	}

	map.set(normalized, target);
}

function lookupTarget(map: Map<string, LocalReferenceTarget>, key: string): LocalReferenceTarget | undefined {
	const normalized = normalizeReferenceToken(key);
	return map.get(normalized) ?? map.get(normalized.toLowerCase());
}

function classifyReferenceToken(token: string): 'requirement' | 'artifact' | 'file' | undefined {
	if (!looksLikeReferenceToken(token)) {
		return undefined;
	}

	if (/^REQ-/i.test(token)) {
		return 'requirement';
	}

	if (looksLikeExplicitPath(token)) {
		return 'file';
	}

	return 'artifact';
}

function describeReferenceToken(token: string): string {
	if (/^REQ-/i.test(token)) {
		return 'Requirement reference';
	}

	if (looksLikeExplicitPath(token)) {
		return 'File reference';
	}

	return 'Artifact reference';
}

function looksLikeReferenceToken(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return false;
	}

	if (/^REQ-/i.test(trimmed) || /^(SPEC|ARC|WI|VER)-/i.test(trimmed)) {
		return true;
	}

	if (looksLikeExplicitPath(trimmed)) {
		return true;
	}

	return /\.[a-z0-9]{2,5}$/i.test(trimmed);
}

function looksLikeReferenceObject(value: Record<string, unknown>): boolean {
	return ['id', 'path', 'uri', 'artifact_id', 'artifactId', 'requirement_id', 'requirementId', 'target', 'file', 'href'].some((key) => typeof value[key] === 'string');
}

function isReferenceField(key: string): boolean {
	return [
		'related_artifacts',
		'related',
		'references',
		'findings',
		'issues',
		'warnings',
		'problems',
		'errors',
		'coverage',
		'trace',
		'trace_evidence',
		'requirements',
		'requirement_coverage',
		'coverage_evidence',
		'files',
		'critical_files',
		'changed_files',
		'source_files',
		'tests',
		'test_results',
		'test_runs',
		'critical_tests',
		'attestations',
		'aggregates',
		'snapshots',
		'attestation_aggregates',
		'links',
		'targets'
	].includes(key);
}

function isEvidenceField(key: string): boolean {
	return isReferenceField(key) || key.includes('coverage') || key.includes('test') || key.includes('file') || key.includes('attestation') || key.includes('finding') || key.includes('issue');
}

function openKindForTarget(target: LocalReferenceTarget): 'specification' | 'markdown' | 'text' {
	if (target.kind === 'requirement' || target.kind === 'specification') {
		return 'specification';
	}

	if (target.kind === 'markdown') {
		return 'markdown';
	}

	return 'text';
}

function sortQualityArtifacts(left: QualityArtifactSnapshot, right: QualityArtifactSnapshot): number {
	const kindOrder = qualityKindOrder(left.kind) - qualityKindOrder(right.kind);
	if (kindOrder !== 0) {
		return kindOrder;
	}

	return left.relativePath.localeCompare(right.relativePath);
}

function qualityKindOrder(kind: QualityArtifactKind): number {
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

function dedupeUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
	const seen = new Set<string>();
	const output: vscode.Uri[] = [];
	for (const uri of uris) {
		const key = uri.toString();
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		output.push(uri);
	}

	return output;
}

function normalizeWorkspaceRelativePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

function normalizeReferenceToken(value: string): string {
	return value.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

function basenameFromPath(path: string): string {
	const normalized = normalizeWorkspaceRelativePath(path);
	const index = normalized.lastIndexOf('/');
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function looksLikeExplicitPath(value: string): boolean {
	return /[\\/]/.test(value) || /\.(md|markdown|json|yaml|yml|html|htm|txt)$/i.test(value);
}

function firstString(data: unknown, keys: readonly string[]): string {
	if (!data || typeof data !== 'object') {
		return '';
	}

	const entries = data as Record<string, unknown>;
	for (const key of keys) {
		const candidate = entries[key];
		if (typeof candidate === 'string' && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}

	return '';
}

function firstHeading(text: string): string {
	const match = /^#{1,6}\s+(.+?)\s*$/m.exec(text.replace(/\r\n/g, '\n'));
	return match ? match[1].trim() : '';
}

function firstParagraph(text: string): string {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const paragraphs: string[] = [];
	let collecting = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!collecting) {
			if (line.length === 0 || line.startsWith('#')) {
				continue;
			}

			collecting = true;
		}

		if (line.length === 0) {
			break;
		}

		paragraphs.push(line);
	}

	return paragraphs.join(' ').trim();
}

async function readText(uri: vscode.Uri): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return new TextDecoder().decode(bytes);
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function createRawPreview(text: string, format: QualityArtifactFormat): string {
	const normalized = text.replace(/\r\n/g, '\n').trim();
	const limit = format === 'html' ? 6000 : 4000;
	return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}\n\n[preview truncated]` : normalized;
}

function splitReferenceCandidates(text: string): string[] {
	const matches = new Set<string>();
	const tokenPatterns = [
		/\b(?:REQ|SPEC|ARC|WI|VER)-[A-Z0-9][A-Z0-9_-]*\b/g,
		/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-/]+\.(?:md|markdown|json|yaml|yml|html|htm|txt)\b/g
	];

	for (const pattern of tokenPatterns) {
		for (const match of text.matchAll(pattern)) {
			matches.add(match[0]);
		}
	}

	return Array.from(matches);
}

function trimTrailingBlankLines(lines: string[]): string[] {
	const trimmed = [...lines];
	while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim().length === 0) {
		trimmed.pop();
	}

	return trimmed;
}

function parseFlowList(value: string): string[] {
	return value
		.slice(1, -1)
		.split(',')
		.map((part) => unquote(part.trim()))
		.filter((part) => part.length > 0);
}

function parseScalar(value: string): string {
	return unquote(value);
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}

	return trimmed;
}

function stripHtmlTags(text: string): string {
	return text
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, '\'');
}

function isSpecificationSource(relativePath: string): boolean {
	return normalizeWorkspaceRelativePath(relativePath).toLowerCase().startsWith('specs/requirements/') && relativePath.toLowerCase().endsWith('.json');
}

function isManagedMarkdownSource(source: QualityArtifactSource | CanonicalArtifactSource): source is CanonicalArtifactSource {
	return getManagedMarkdownArtifactTypeFromPath(source.relativePath) !== undefined;
}
