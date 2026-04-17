export type ManagedMarkdownArtifactType = 'architecture' | 'work_item' | 'verification';

export type ManagedMarkdownTraceField = 'satisfies' | 'addresses' | 'design_links' | 'verification_links' | 'verifies';

export type ManagedMarkdownSectionKey =
	| 'purpose'
	| 'design_summary'
	| 'summary'
	| 'planned_changes'
	| 'verification_plan'
	| 'scope'
	| 'verification_method'
	| 'procedure'
	| 'expected_result';

export interface ManagedMarkdownValidationIssue {
	readonly path: string;
	readonly message: string;
	readonly severity: 'error' | 'warning';
}

export interface ManagedMarkdownSectionState {
	key: string;
	heading: string;
	content: string;
	editable: boolean;
	rawText?: string;
}

export interface ManagedMarkdownDocument {
	artifact_id?: string;
	artifact_type?: ManagedMarkdownArtifactType;
	title?: string;
	domain?: string;
	status?: string;
	owner?: string;
	summary?: string;
	related_artifacts?: string[];
	satisfies?: string[];
	addresses?: string[];
	design_links?: string[];
	verification_links?: string[];
	verifies?: string[];
	sections: ManagedMarkdownSectionState[];
	frontMatterExtras: Record<string, unknown>;
}

interface ManagedMarkdownDocumentData {
	artifact_id?: string;
	artifact_type?: string;
	title?: string;
	domain?: string;
	status?: string;
	owner?: string;
	summary?: string;
	related_artifacts?: string[];
	satisfies?: string[];
	addresses?: string[];
	design_links?: string[];
	verification_links?: string[];
	verifies?: string[];
	sections: ManagedMarkdownSectionState[];
	frontMatterExtras: Record<string, unknown>;
}

const traceFieldForArtifactType: Record<ManagedMarkdownArtifactType, ManagedMarkdownTraceField> = {
	architecture: 'satisfies',
	work_item: 'addresses',
	verification: 'verifies'
};

const requiredSectionsByType: Record<ManagedMarkdownArtifactType, ManagedMarkdownSectionKey[]> = {
	architecture: ['purpose', 'design_summary'],
	work_item: ['summary', 'planned_changes', 'verification_plan'],
	verification: ['scope', 'verification_method', 'procedure', 'expected_result']
};

const sectionHeadingByKey: Record<ManagedMarkdownSectionKey, string> = {
	purpose: 'Purpose',
	design_summary: 'Design Summary',
	summary: 'Summary',
	planned_changes: 'Planned Changes',
	verification_plan: 'Verification Plan',
	scope: 'Scope',
	verification_method: 'Verification Method',
	procedure: 'Procedure',
	expected_result: 'Expected Result'
};

export function getManagedMarkdownArtifactTypeFromPath(workspaceRelativePath: string): ManagedMarkdownArtifactType | undefined {
	const normalized = normalizeMarkdownPath(workspaceRelativePath).toLowerCase();
	if (normalized.startsWith('specs/architecture/') && normalized.endsWith('.md')) {
		return 'architecture';
	}

	if (normalized.startsWith('specs/work-items/') && normalized.endsWith('.md')) {
		return 'work_item';
	}

	if (normalized.startsWith('specs/verification/') && normalized.endsWith('.md')) {
		return 'verification';
	}

	return undefined;
}

export function getTraceFieldForArtifactType(artifactType: ManagedMarkdownArtifactType): ManagedMarkdownTraceField {
	return traceFieldForArtifactType[artifactType];
}

export function getManagedMarkdownSectionKeys(artifactType: ManagedMarkdownArtifactType): readonly ManagedMarkdownSectionKey[] {
	return requiredSectionsByType[artifactType];
}

export function getManagedMarkdownSectionHeading(sectionKey: ManagedMarkdownSectionKey): string {
	return sectionHeadingByKey[sectionKey];
}

export function isManagedMarkdownArtifact(document: ManagedMarkdownDocument, workspaceRelativePath: string): boolean {
	const expectedType = getManagedMarkdownArtifactTypeFromPath(workspaceRelativePath);
	return expectedType !== undefined && document.artifact_type === expectedType;
}

export function parseManagedMarkdownDocument(text: string): ManagedMarkdownDocumentData {
	const normalizedText = text.replace(/\r\n/g, '\n');
	const lines = normalizedText.split('\n');
	const frontMatter = parseFrontMatter(lines);
	const bodyStartLine = frontMatter?.nextLineIndex ?? 0;
	const bodyLines = lines.slice(bodyStartLine);
	const sections = parseBodySections(bodyLines, new Set(Object.values(sectionHeadingByKey)));

	return {
		artifact_id: stringValue(frontMatter?.data.artifact_id),
		artifact_type: parseArtifactType(stringValue(frontMatter?.data.artifact_type)),
		title: stringValue(frontMatter?.data.title),
		domain: stringValue(frontMatter?.data.domain),
		status: stringValue(frontMatter?.data.status),
		owner: stringValue(frontMatter?.data.owner),
		summary: stringValue(frontMatter?.data.summary),
		related_artifacts: parseStringList(frontMatter?.data.related_artifacts),
		satisfies: parseStringList(frontMatter?.data.satisfies),
		addresses: parseStringList(frontMatter?.data.addresses),
		design_links: parseStringList(frontMatter?.data.design_links),
		verification_links: parseStringList(frontMatter?.data.verification_links),
		verifies: parseStringList(frontMatter?.data.verifies),
		sections,
		frontMatterExtras: frontMatter?.extras ?? {}
	};
}

export function normalizeManagedMarkdownDocument(document: ManagedMarkdownDocumentData): ManagedMarkdownDocument {
	return {
		artifact_id: stringValue(document.artifact_id),
		artifact_type: parseArtifactType(stringValue(document.artifact_type)),
		title: stringValue(document.title),
		domain: stringValue(document.domain),
		status: stringValue(document.status),
		owner: stringValue(document.owner),
		summary: stringValue(document.summary),
		related_artifacts: normalizeOptionalList(document.related_artifacts),
		satisfies: normalizeOptionalList(document.satisfies),
		addresses: normalizeOptionalList(document.addresses),
		design_links: normalizeOptionalList(document.design_links),
		verification_links: normalizeOptionalList(document.verification_links),
		verifies: normalizeOptionalList(document.verifies),
		sections: normalizeSections(document.sections, parseArtifactType(stringValue(document.artifact_type))),
		frontMatterExtras: cloneExtras(document.frontMatterExtras)
	};
}

export function serializeManagedMarkdownDocument(document: ManagedMarkdownDocument): string {
	const frontMatter: Array<[string, unknown]> = [
		['artifact_id', trimOrUndefined(document.artifact_id)],
		['artifact_type', document.artifact_type],
		['title', trimOrUndefined(document.title)],
		['domain', trimOrUndefined(document.domain)],
		['status', trimOrUndefined(document.status)],
		['owner', trimOrUndefined(document.owner)],
		['summary', trimOrUndefined(document.summary)],
		['related_artifacts', document.related_artifacts],
		['satisfies', document.satisfies],
		['addresses', document.addresses],
		['design_links', document.design_links],
		['verification_links', document.verification_links],
		['verifies', document.verifies]
	];

	const extraKeys = Object.keys(document.frontMatterExtras).sort((left, right) => left.localeCompare(right));
	for (const key of extraKeys) {
		if (frontMatter.some(([entryKey]) => entryKey === key)) {
			continue;
		}

		frontMatter.push([key, document.frontMatterExtras[key]]);
	}

	const lines: string[] = ['---'];
	for (const [key, value] of frontMatter) {
		appendFrontMatterValue(lines, key, value);
	}
	lines.push('---');
	lines.push(...serializeSections(document.sections));

	return `${lines.join('\n').replace(/\n+$/u, '\n')}`;
}

export function validateManagedMarkdownDocument(document: ManagedMarkdownDocument, workspaceRelativePath: string): ManagedMarkdownValidationIssue[] {
	const issues: ManagedMarkdownValidationIssue[] = [];
	const artifactType = document.artifact_type;
	const artifactId = stringValue(document.artifact_id);
	const title = stringValue(document.title);
	const domain = stringValue(document.domain);
	const status = stringValue(document.status);
	const owner = stringValue(document.owner);
	const expectedType = getManagedMarkdownArtifactTypeFromPath(workspaceRelativePath);
	const expectedPrefix = artifactType ? expectedArtifactPrefix(artifactType) : undefined;
	if (!artifactType) {
		issues.push({ path: 'artifact_type', message: 'artifact_type is required.', severity: 'error' });
	} else if (expectedType && artifactType !== expectedType) {
		issues.push({
			path: 'artifact_type',
			message: `artifact_type must be "${expectedType}" for this path family.`,
			severity: 'error'
		});
	}

	if (artifactId.length === 0) {
		issues.push({ path: 'artifact_id', message: 'artifact_id is required.', severity: 'error' });
	} else if (expectedPrefix && !artifactId.startsWith(expectedPrefix)) {
		issues.push({
			path: 'artifact_id',
			message: `artifact_id should start with "${expectedPrefix}" for ${artifactType} artifacts.`,
			severity: 'error'
		});
	}

	if (title.length === 0) {
		issues.push({ path: 'title', message: 'title is required.', severity: 'error' });
	}

	if (domain.length === 0) {
		issues.push({ path: 'domain', message: 'domain is required.', severity: 'error' });
	}

	if (status.length === 0) {
		issues.push({ path: 'status', message: 'status is required.', severity: 'error' });
	}

	if (owner.length === 0) {
		issues.push({ path: 'owner', message: 'owner is required.', severity: 'error' });
	}

	for (const field of ['related_artifacts', 'satisfies', 'addresses', 'design_links', 'verification_links', 'verifies'] as const) {
		const duplicates = findDuplicateValues(document[field]);
		for (const duplicate of duplicates) {
			issues.push({
				path: field,
				message: `Duplicate reference "${duplicate}" in ${field}.`,
				severity: 'error'
			});
		}
	}

	const fileName = basenameFromPath(workspaceRelativePath);
	if (artifactId.length > 0 && fileName.length > 0) {
		const fileBase = fileName.replace(/\.md$/i, '');
		if (fileBase !== artifactId) {
			issues.push({
				path: 'artifact_id',
				message: 'artifact_id should match the file name for canonical markdown artifacts.',
				severity: 'warning'
			});
		}
	}

	const requiredKeys = artifactType ? requiredSectionsByType[artifactType] : [];
	for (const sectionKey of requiredKeys) {
		if (!document.sections.some((section) => section.key === sectionKey)) {
			issues.push({
				path: `sections.${sectionKey}`,
				message: `Missing ${sectionHeadingByKey[sectionKey]} section.`,
				severity: 'error'
			});
		}
	}

	return issues;
}

export function createEmptyManagedMarkdownDocument(artifactType: ManagedMarkdownArtifactType): ManagedMarkdownDocument {
	return {
		artifact_id: '',
		artifact_type: artifactType,
		title: '',
		domain: '',
		status: artifactType === 'architecture' ? 'draft' : (artifactType === 'work_item' ? 'planned' : 'planned'),
		owner: '',
		summary: '',
		related_artifacts: [],
		satisfies: artifactType === 'architecture' ? [] : undefined,
		addresses: artifactType === 'work_item' ? [] : undefined,
		design_links: artifactType === 'work_item' ? [] : undefined,
		verification_links: artifactType === 'work_item' ? [] : undefined,
		verifies: artifactType === 'verification' ? [] : undefined,
		sections: getManagedMarkdownSectionKeys(artifactType).map((key) => ({
			key,
			heading: getManagedMarkdownSectionHeading(key),
			content: '',
			editable: true
		})),
		frontMatterExtras: {}
	};
}

export function createManagedMarkdownTemplate(input: {
	readonly artifactId: string;
	readonly artifactType: ManagedMarkdownArtifactType;
	readonly domain: string;
	readonly title: string;
	readonly owner: string;
	readonly summary: string;
	readonly status: string;
	readonly relatedArtifacts?: readonly string[];
	readonly traceReferences?: readonly string[];
}): string {
	const document = createEmptyManagedMarkdownDocument(input.artifactType);
	document.artifact_id = input.artifactId;
	document.title = input.title;
	document.domain = input.domain;
	document.status = input.status;
	document.owner = input.owner;
	document.summary = input.summary;
	document.related_artifacts = dedupeTrimmedStrings(input.relatedArtifacts ?? []);
	const traceField = getTraceFieldForArtifactType(input.artifactType);
	switch (traceField) {
		case 'satisfies':
			document.satisfies = dedupeTrimmedStrings(input.traceReferences ?? []);
			break;
		case 'addresses':
			document.addresses = dedupeTrimmedStrings(input.traceReferences ?? []);
			break;
		case 'design_links':
			document.design_links = dedupeTrimmedStrings(input.traceReferences ?? []);
			break;
		case 'verification_links':
			document.verification_links = dedupeTrimmedStrings(input.traceReferences ?? []);
			break;
		case 'verifies':
			document.verifies = dedupeTrimmedStrings(input.traceReferences ?? []);
			break;
	}
	populateTemplateNarrative(document, input.artifactType, input.summary);
	return serializeManagedMarkdownDocument(document);
}

export function getCanonicalMarkdownEditFields(artifactType: ManagedMarkdownArtifactType): readonly ManagedMarkdownSectionKey[] {
	return requiredSectionsByType[artifactType];
}

function populateTemplateNarrative(document: ManagedMarkdownDocument, artifactType: ManagedMarkdownArtifactType, summary: string): void {
	const sections = document.sections.map((section) => ({ ...section }));
	const summaryText = summary.trim();
	switch (artifactType) {
		case 'architecture':
			setSectionContent(sections, 'purpose', summaryText || 'Describe the architectural intent and boundaries.');
			setSectionContent(sections, 'design_summary', 'Summarize the local design decisions, structure, and main tradeoffs.');
			break;
		case 'work_item':
			setSectionContent(sections, 'summary', summaryText || 'Summarize the implementation effort.');
			setSectionContent(sections, 'planned_changes', 'Describe the concrete changes planned for the work item.');
			setSectionContent(sections, 'verification_plan', 'Describe how the work will be verified locally.');
			break;
		case 'verification':
			setSectionContent(sections, 'scope', summaryText || 'Describe the verification scope.');
			setSectionContent(sections, 'verification_method', 'Describe how verification will be performed.');
			setSectionContent(sections, 'procedure', 'List the local verification procedure.');
			setSectionContent(sections, 'expected_result', 'Describe the expected result.');
			break;
	}

	document.sections = sections;
}

function setSectionContent(sections: ManagedMarkdownSectionState[], key: string, content: string): void {
	const section = sections.find((entry) => entry.key === key);
	if (section) {
		section.content = content;
	}
}

function normalizeSections(sections: ManagedMarkdownSectionState[] | undefined, artifactType: ManagedMarkdownArtifactType | undefined): ManagedMarkdownSectionState[] {
	const normalized = Array.isArray(sections)
		? sections.map((section) => ({
			key: stringValue(section.key) || normalizeHeading(section.heading),
			heading: stringValue(section.heading) || normalizeHeading(section.key),
			content: stringValue(section.content),
			editable: section.editable !== false,
			rawText: section.rawText
		}))
		: [];

	if (!artifactType) {
		return normalized;
	}

	const existingKeys = new Set(normalized.map((section) => section.key));
	const requiredSections = requiredSectionsByType[artifactType];
	for (const key of requiredSections) {
		if (!existingKeys.has(key)) {
			normalized.push({
				key,
				heading: sectionHeadingByKey[key],
				content: '',
				editable: true,
				rawText: undefined
			});
		}
	}

	return normalized;
}

function parseFrontMatter(lines: string[]): {
	data: Record<string, unknown>;
	extras: Record<string, unknown>;
	nextLineIndex: number;
} | undefined {
	if (lines[0] !== '---') {
		return undefined;
	}

	const data: Record<string, unknown> = {};
	const extras: Record<string, unknown> = {};
	let currentKey: string | undefined;
	let currentList: string[] | undefined;
	let index = 1;

	while (index < lines.length && lines[index] !== '---') {
		const line = lines[index];
		if (currentKey && currentList && /^\s*-\s+/.test(line)) {
			currentList.push(unquote(line.replace(/^\s*-\s+/, '').trim()));
			index += 1;
			continue;
		}

		currentKey = undefined;
		currentList = undefined;

		const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
		if (!match) {
			index += 1;
			continue;
		}

		const key = match[1].trim();
		const raw = (match[2] ?? '').trim();
		currentKey = key;
		if (raw.length === 0) {
			const list: string[] = [];
			data[key] = list;
			currentList = list;
		} else if (raw === '[]') {
			data[key] = [];
		} else if (raw.startsWith('[') && raw.endsWith(']')) {
			data[key] = parseFlowList(raw);
		} else if (raw === '|') {
			data[key] = '';
		} else if (key.startsWith('x_')) {
			extras[key] = parseScalar(raw);
		} else {
			data[key] = parseScalar(raw);
		}

		index += 1;
	}

	if (index >= lines.length) {
		return undefined;
	}

	return {
		data,
		extras,
		nextLineIndex: index + 1
	};
}

function parseBodySections(lines: string[], editableHeadings: Set<string>): ManagedMarkdownSectionState[] {
	const sections: ManagedMarkdownSectionState[] = [];
	let currentHeading: string | undefined;
	let currentLevel = 0;
	let currentContent: string[] = [];
	let preamble: string[] = [];
	let hasEncounteredHeading = false;

	const flush = () => {
		if (!currentHeading) {
			return;
		}

		const key = normalizeHeading(currentHeading);
		const content = trimTrailingBlankLines(currentContent).join('\n');
		sections.push({
			key,
			heading: currentHeading,
			content,
			editable: editableHeadings.has(currentHeading),
			rawText: renderSection(currentLevel, currentHeading, content)
		});
	};

	for (const line of lines) {
		const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (headingMatch) {
			flush();
			currentHeading = headingMatch[2].trim();
			currentLevel = headingMatch[1].length;
			currentContent = [];
			hasEncounteredHeading = true;
			continue;
		}

		if (!hasEncounteredHeading) {
			preamble.push(line);
			continue;
		}

		currentContent.push(line);
	}

	flush();

	if (preamble.length > 0) {
		sections.unshift({
			key: '__preamble__',
			heading: '',
			content: trimTrailingBlankLines(preamble).join('\n'),
			editable: false,
			rawText: trimTrailingBlankLines(preamble).join('\n')
		});
	}

	return sections;
}

function serializeSections(sections: ManagedMarkdownSectionState[]): string[] {
	const output: string[] = [];
	for (const section of sections) {
		if (section.key === '__preamble__') {
			if (section.rawText && section.rawText.trim().length > 0) {
				output.push(section.rawText);
			}
			continue;
		}

		if (!section.editable && section.rawText !== undefined) {
			output.push(section.rawText);
			continue;
		}

		output.push(`## ${section.heading}`);
		output.push('');
		output.push(section.content.trimEnd());
		output.push('');
	}

	while (output.length > 0 && output[output.length - 1].length === 0) {
		output.pop();
	}

	output.push('');
	return output;
}

function renderSection(level: number, heading: string, content: string): string {
	const prefix = '#'.repeat(Math.max(1, level));
	const normalizedContent = content.trimEnd();
	return normalizedContent.length > 0
		? `${prefix} ${heading}\n\n${normalizedContent}\n`
		: `${prefix} ${heading}\n`;
}

function appendFrontMatterValue(lines: string[], key: string, value: unknown): void {
	if (value === undefined) {
		return;
	}

	if (Array.isArray(value)) {
		if (value.length === 0) {
			lines.push(`${key}: []`);
			return;
		}

		lines.push(`${key}:`);
		for (const item of value) {
			lines.push(`  - ${serializeScalar(item)}`);
		}
		return;
	}

	lines.push(`${key}: ${serializeScalar(value)}`);
}

function parseArtifactType(value: string): ManagedMarkdownArtifactType | undefined {
	if (value === 'architecture' || value === 'work_item' || value === 'verification') {
		return value;
	}

	return undefined;
}

function expectedArtifactPrefix(artifactType: ManagedMarkdownArtifactType): string {
	switch (artifactType) {
		case 'architecture':
			return 'ARC-';
		case 'work_item':
			return 'WI-';
		case 'verification':
			return 'VER-';
	}
}

function parseStringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return dedupeTrimmedStrings(value.map((item) => stringValue(item)));
	}

	if (typeof value === 'string' && value.trim().length > 0) {
		return dedupeTrimmedStrings(value.split(','));
	}

	return undefined;
}

function normalizeOptionalList(value: string[] | undefined): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const normalized = dedupeTrimmedStrings(value);
	return normalized.length > 0 ? normalized : undefined;
}

function dedupeTrimmedStrings(values: readonly string[]): string[] {
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

function findDuplicateValues(values: string[] | undefined): string[] {
	if (!Array.isArray(values)) {
		return [];
	}

	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			continue;
		}

		if (seen.has(trimmed)) {
			duplicates.add(trimmed);
			continue;
		}

		seen.add(trimmed);
	}

	return Array.from(duplicates);
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

function serializeScalar(value: unknown): string {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return '""';
		}

		if (/^[A-Za-z0-9_.\/-]+$/.test(trimmed)) {
			return trimmed;
		}

		return JSON.stringify(trimmed);
	}

	if (value === null) {
		return 'null';
	}

	return JSON.stringify(value);
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

function normalizeHeading(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function trimTrailingBlankLines(lines: string[]): string[] {
	const trimmed = [...lines];
	while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim().length === 0) {
		trimmed.pop();
	}

	return trimmed;
}

function cloneExtras(extras: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(extras)) as Record<string, unknown>;
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function trimOrUndefined(value: string | undefined): string | undefined {
	const trimmed = stringValue(value);
	return trimmed.length > 0 ? trimmed : undefined;
}

function basenameFromPath(path: string): string {
	const normalized = normalizeMarkdownPath(path);
	const index = normalized.lastIndexOf('/');
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function normalizeMarkdownPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}
