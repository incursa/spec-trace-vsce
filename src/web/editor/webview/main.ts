/// <reference lib="dom" />

import '@incursa/ui-kit/web-components/style.css';
import '@incursa/ui-kit/web-components';

import {
	cloneSpecificationDocument,
	createEmptyRequirement,
	serializeSpecificationDocument,
	summarizeRequirementCoverage,
	summarizeSpecificationCoverage,
	SpecificationDocument,
	SpecificationRequirement,
	ValidationIssue,
	validateSpecificationDocument
} from '../core/specification.js';

interface VsCodeApi {
	postMessage(message: unknown): void;
	setState<T>(state: T): void;
	getState<T>(): T | undefined;
}

type SpecificationEditorSyncMessage = {
	type: 'sync';
	document: SpecificationDocument;
	issues: ValidationIssue[];
	isDirty: boolean;
	externalConflict: boolean;
};

type SpecificationEditorHostMessage = {
	type: 'ready' | 'edit' | 'save' | 'openText' | 'reveal';
	document?: SpecificationDocument;
	cardPath?: string;
};

type SpecificationEditorIncomingMessage = SpecificationEditorSyncMessage | SpecificationEditorHostMessage;

interface SpecificationEditorWebviewState {
	document?: SpecificationDocument;
	issues?: ValidationIssue[];
	isDirty?: boolean;
	externalConflict?: boolean;
	lastCommittedSerialized?: string;
	expandedCardPaths?: string[];
	coverageRequirementSelectionKey?: string;
	requirementsViewMode?: RequirementViewMode;
	requirementSearchQuery?: string;
	requirementIndexFilter?: RequirementIndexFilter;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const appElement = document.getElementById('app');

if (!appElement) {
	throw new Error('Spec Trace editor root element is missing.');
}

const app = appElement as HTMLElement;

let currentDocument: SpecificationDocument | undefined;
let currentIssues: ValidationIssue[] = [];
let currentDirty = false;
let currentExternalConflict = false;
let lastCommittedSerialized = '';
let expandedCardPaths = new Set<string>();
let pendingRevealCardPaths = new Set<string>();
let pendingOpenRequirementIndex: number | undefined;
let coverageRequirementSelectionKey = '';
let currentRequirementViewMode: RequirementViewMode = 'index';
let requirementSearchQuery = '';
let requirementIndexFilter: RequirementIndexFilter = 'all';

const statusOptions = ['draft', 'review', 'approved', 'active', 'deprecated', 'archived'];
type TopLevelListField = 'tags' | 'related_artifacts' | 'open_questions' | 'supplemental_sections';
type RequirementViewMode = 'index' | 'detail';
type RequirementIndexFilter = 'all' | 'issues' | 'missing' | 'partial' | 'covered';
const requirementIndexFilters: RequirementIndexFilter[] = ['all', 'issues', 'missing', 'partial', 'covered'];

interface CoverageSelection {
	key: string;
	index: number;
}

interface RequirementIndexEntry {
	requirement: SpecificationRequirement;
	index: number;
	path: string;
	issueCount: number;
	coverageSummary: ReturnType<typeof summarizeRequirementCoverage>;
	searchText: string;
}

window.addEventListener('message', (event: MessageEvent<SpecificationEditorIncomingMessage>) => {
	const message = event.data;
	if (!message) {
		return;
	}

	if (message.type === 'sync') {
		applyHostState(message);
		return;
	}

	if (message.type === 'reveal' && message.cardPath) {
		pendingRevealCardPaths.add(message.cardPath);
		flushPendingRevealCards();
	}
});

vscode.postMessage({ type: 'ready' } satisfies SpecificationEditorHostMessage);

const persistedState = vscode.getState<SpecificationEditorWebviewState>();

if (persistedState?.document) {
	currentDocument = normalizeEditableDocument(cloneSpecificationDocument(persistedState.document));
	currentIssues = persistedState.issues ?? validateSpecificationDocument(currentDocument);
	currentDirty = persistedState.isDirty ?? false;
	currentExternalConflict = persistedState.externalConflict ?? false;
	lastCommittedSerialized = persistedState.lastCommittedSerialized ?? serializeSpecificationDocument(currentDocument);
	expandedCardPaths = new Set(persistedState.expandedCardPaths ?? []);
	coverageRequirementSelectionKey = persistedState.coverageRequirementSelectionKey ?? '';
	currentRequirementViewMode = persistedState.requirementsViewMode ?? 'index';
	requirementSearchQuery = persistedState.requirementSearchQuery ?? '';
	requirementIndexFilter = persistedState.requirementIndexFilter ?? 'all';
	ensureRequirementIndexState();
	renderEditor();
	refreshChrome();
	renderValidationState();
} else {
	renderLoading();
}

function applyHostState(message: SpecificationEditorSyncMessage): void {
	syncExpandedCardPathsFromDom();
	currentDocument = normalizeEditableDocument(cloneSpecificationDocument(message.document));
	currentIssues = message.issues;
	currentDirty = message.isDirty;
	currentExternalConflict = message.externalConflict;
	lastCommittedSerialized = serializeSpecificationDocument(currentDocument);
	ensureCoverageSelectionKey();
	ensureRequirementViewMode();
	ensureRequirementIndexState();

	renderEditor();
	persistWebviewState();
	refreshChrome();
	renderValidationState();
}

function renderLoading(): void {
	app.replaceChildren(createCard('Spec Trace editor', 'Loading structured editor...'));
}

function shouldRenderRequirementDetail(): boolean {
	return currentRequirementViewMode === 'detail' && (currentDocument?.requirements?.length ?? 0) > 0;
}

function ensureRequirementViewMode(): void {
	if ((currentDocument?.requirements?.length ?? 0) === 0) {
		currentRequirementViewMode = 'index';
	}
}

function ensureRequirementIndexState(): void {
	if (!requirementIndexFilters.includes(requirementIndexFilter)) {
		requirementIndexFilter = 'all';
	}

	if (typeof requirementSearchQuery !== 'string') {
		requirementSearchQuery = '';
	}
}

function openRequirementEditorByIndex(index: number): void {
	if (!currentDocument) {
		return;
	}

	const requirement = currentDocument.requirements?.[index];
	if (!requirement) {
		return;
	}

	setCoverageRequirementSelectionKey(coverageSelectionKeyForRequirement(requirement, index));
	currentRequirementViewMode = 'detail';
	persistWebviewState();
}

function returnToRequirementIndex(): void {
	currentRequirementViewMode = 'index';
	persistWebviewState();
}

function setRequirementSearchQuery(query: string): void {
	requirementSearchQuery = query;
	persistWebviewState();
}

function setRequirementIndexFilter(filter: RequirementIndexFilter): void {
	requirementIndexFilter = filter;
	persistWebviewState();
}

function navigateRequirementByOffset(offset: number): void {
	if (!currentDocument?.requirements?.length) {
		return;
	}

	const currentIndex = resolveCoverageRequirementSelection(currentDocument.requirements).index;
	const nextIndex = currentIndex + offset;
	if (nextIndex < 0 || nextIndex >= currentDocument.requirements.length) {
		return;
	}

	openRequirementEditorByIndex(nextIndex);
	renderEditor();
	refreshChrome();
	renderValidationState();
}

function renderEditor(): void {
	if (!currentDocument) {
		renderLoading();
		return;
	}

	syncExpandedCardPathsFromDom();
	const autoOpenRequirementIndex = pendingOpenRequirementIndex;
	const page = document.createElement('inc-page');
	page.className = 'editor-page';

	const header = createHero();
	header.slot = 'header';

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = 'editor-root';
	body.append(createValidationSummaryCard(), createRequirementsCard(autoOpenRequirementIndex));

	if (!shouldRenderRequirementDetail()) {
		body.append(
			createCoverageSection(),
			createDocumentFieldsCard(),
			createTopLevelListCard(
				'Tags',
				'Short keywords used for discovery and filtering.',
				'tags',
				currentDocument?.tags ?? [],
				{
					multiline: false,
					placeholder: 'Tag',
					addLabel: 'Add tag'
				}
			),
			createTopLevelListCard(
				'Related artifacts',
				'Cross-links to supporting or dependent artifacts.',
				'related_artifacts',
				currentDocument?.related_artifacts ?? [],
				{
					multiline: false,
					placeholder: 'Artifact reference',
					addLabel: 'Add artifact'
				}
			),
			createTopLevelListCard(
				'Open questions',
				'Outstanding questions and unresolved decisions.',
				'open_questions',
				currentDocument?.open_questions ?? [],
				{
					multiline: false,
					placeholder: 'Question',
					addLabel: 'Add question'
				}
			),
			createTopLevelListCard(
				'Supplemental sections',
				'Repeatable text blocks that round out the document.',
				'supplemental_sections',
				currentDocument?.supplemental_sections ?? [],
				{
					multiline: true,
					placeholder: 'Section text',
					addLabel: 'Add section'
				}
			)
		);
	}

	page.append(header, body);
	app.replaceChildren(page);
	pendingOpenRequirementIndex = undefined;
	persistWebviewState();
	flushPendingRevealCards();
}

function createHero(): HTMLElement {
	const header = document.createElement('inc-page-header');
	header.setAttribute('dense', '');
	header.setAttribute('variant', 'detail');

	const titleSlot = document.createElement('div');
	titleSlot.slot = 'title';
	titleSlot.className = 'page-header-title';

	const title = document.createElement('h1');
	title.className = 'inc-heading inc-heading--h3';
	title.id = 'hero-title';
	title.textContent = currentDocument?.title?.trim() || currentDocument?.artifact_id?.trim() || 'Untitled specification';

	const subtitle = document.createElement('div');
	subtitle.className = 'inc-text inc-text--small inc-text--muted page-header-subtitle';
	subtitle.id = 'hero-subtitle';
	subtitle.textContent = formatHeroSubtitle();

	titleSlot.append(title, subtitle);

	const bodySlot = document.createElement('div');
	bodySlot.slot = 'body';
	bodySlot.className = 'page-header-body';
	bodySlot.append(createHeroStatusStrip());

	const actionsSlot = document.createElement('inc-button-toolbar');
	actionsSlot.slot = 'actions';
	actionsSlot.className = 'hero-actions';
	actionsSlot.append(
		createActionButton('Save', 'Save the current specification', () => {
			void vscode.postMessage({ type: 'save' });
		}, { variant: 'primary' }),
		createActionButton('Open JSON', 'Open the same file in the text editor', () => {
			void vscode.postMessage({ type: 'openText' });
		}, { variant: 'outline-secondary' }),
		createActionButton('Add requirement', 'Add a new requirement record', () => {
			ensureEditableDocument();
			currentDocument!.requirements = currentDocument!.requirements ?? [];
			pendingOpenRequirementIndex = currentDocument!.requirements.length;
			currentDocument!.requirements.push(createEmptyRequirement());
			setCoverageRequirementSelectionKey(`index:${pendingOpenRequirementIndex}`);
			currentRequirementViewMode = 'detail';
			commitCurrentDocument(true);
			renderEditor();
			refreshChrome();
			renderValidationState();
		}, { variant: 'secondary' })
	);

	header.append(titleSlot, bodySlot, actionsSlot);
	return header;
}

function formatHeroSubtitle(): string {
	if (!currentDocument) {
		return 'Waiting for document...';
	}

	const requirementCount = currentDocument.requirements?.length ?? 0;
	return `${currentDocument.artifact_id?.trim() || 'specification'} · ${requirementCount} requirement${requirementCount === 1 ? '' : 's'}`;
}

function createStatusChip(id: string, label: string): HTMLElement {
	const chip = createBadge(label, 'info', 'status-chip');
	chip.id = id;
	return chip;
}

function createBadge(label: string, tone: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info', className = ''): HTMLElement {
	const badge = document.createElement('inc-badge');
	badge.setAttribute('tone', tone);
	badge.setAttribute('pill', '');
	if (className) {
		badge.className = className;
	}
	badge.textContent = label;
	return badge;
}

function createHeroStatusStrip(): HTMLElement {
	const strip = document.createElement('div');
	strip.className = 'hero-status-strip';

	const chips = document.createElement('div');
	chips.className = 'hero-status-strip__chips';
	chips.append(
		createStatusChip('sync-chip', 'Synced'),
		createStatusChip('dirty-chip', 'Clean'),
		createStatusChip('conflict-chip', 'No conflict'),
		createStatusChip('validation-chip', '0 issues'),
		createCoverageSummaryChip()
	);

	const meta = document.createElement('div');
	meta.id = 'coverage-meta';
	meta.className = 'inc-text inc-text--small inc-text--muted hero-status-strip__meta';
	meta.textContent = 'Add requirements to start tracking coverage.';

	strip.append(chips, meta);
	return strip;
}

function createCoverageSummaryChip(): HTMLElement {
	const badge = createBadge('No requirements', 'info', 'status-chip');
	badge.id = 'coverage-chip';
	return badge;
}

function createSummaryBlock(title: string, body: HTMLElement): HTMLElement {
	const block = document.createElement('inc-summary-block');
	block.setAttribute('tone', 'info');

	const header = document.createElement('div');
	header.slot = 'header';
	header.textContent = title;

	const bodySlot = document.createElement('div');
	bodySlot.slot = 'body';
	bodySlot.append(body);

	block.append(header, bodySlot);
	return block;
}

function createCoverageSection(): HTMLElement {
	const summary = summarizeSpecificationCoverage(currentDocument ?? { requirements: [] });
	const body = document.createElement('div');
	body.className = 'coverage-body';
	body.id = 'coverage-section-body';
	body.append(
		createCoverageOverview(summary),
		createCoverageDetailCard()
	);

	return createCollapsibleCard(
		'Coverage',
		'Derived test coverage and requirement drill-down.',
		body,
		{
			className: 'coverage-card',
			cardPath: 'coverage-summary',
			open: true
		}
	);
}

function createCoverageOverview(summary: ReturnType<typeof summarizeSpecificationCoverage>): HTMLElement {
	const overview = document.createElement('inc-summary-overview');
	overview.setAttribute('columns', '4');
	overview.setAttribute('dense', '');

	overview.append(
		createSummaryBlock('Total', createCoverageMetric(String(summary.totalRequirements), 'requirements', 'info')),
		createSummaryBlock('Covered', createCoverageMetric(String(summary.coveredCount), 'requirements', 'success')),
		createSummaryBlock('Partial', createCoverageMetric(String(summary.partialCount), 'requirements', 'warning')),
		createSummaryBlock('Missing', createCoverageMetric(String(summary.missingCount), 'requirements', 'danger'))
	);

	return overview;
}

function createCoverageMetric(value: string, suffix: string, tone: 'info' | 'success' | 'warning' | 'danger'): HTMLElement {
	const container = document.createElement('div');
	container.className = 'coverage-metric';

	const badge = createBadge(value, tone, 'coverage-metric__value');
	const caption = document.createElement('div');
	caption.className = 'inc-text inc-text--small inc-text--muted coverage-metric__caption';
	caption.textContent = suffix;

	container.append(badge, caption);
	return container;
}

function createCoverageDetailCard(): HTMLElement {
	const detail = document.createElement('inc-card');
	detail.className = 'coverage-detail-card';
	detail.setAttribute('elevated', '');

	const header = document.createElement('div');
	header.slot = 'header';
	header.append(
		createSectionHeading('Requirement drill-down', 'Inspect coverage, trace, and notes evidence for a single requirement.')
	);

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = 'coverage-detail-body';
	body.id = 'coverage-detail-body';
	body.append(renderCoverageDetail());

	detail.append(header, body);
	return detail;
}

function renderCoverageDetail(): HTMLElement {
	const requirements = currentDocument?.requirements ?? [];
	const selection = resolveCoverageRequirementSelection(requirements);
	const requirement = selection.index >= 0 ? requirements[selection.index] : undefined;
	const coverageSummary = requirement ? summarizeRequirementCoverage(requirement) : undefined;

	const container = document.createElement('div');
	container.className = 'coverage-detail';

	if (!requirement || !coverageSummary) {
		container.append(createCard('No requirements yet', 'Add a requirement to start tracking coverage.'));
		return container;
	}

	container.append(
		createCoverageSelector(requirements, selection),
		createCoverageSelectedRequirementCard(requirement, coverageSummary, selection.index)
	);
	return container;
}

function createCoverageSelector(requirements: SpecificationRequirement[], selection: CoverageSelection): HTMLElement {
	const field = document.createElement('inc-field');
	field.setAttribute('label', 'Requirement');
	field.setAttribute('hint', 'Select a requirement to inspect its evidence.');
	field.setAttribute('dense', '');
	field.dataset.validationPath = 'coverage-summary.requirement';
	field.className = 'coverage-selector';

	const select = document.createElement('select');
	select.className = 'inc-form__select';
	select.id = 'coverage-requirement-select';
	select.slot = 'control';

	requirements.forEach((requirement, index) => {
		const option = document.createElement('option');
		option.value = coverageSelectionKeyForRequirement(requirement, index);
		option.textContent = formatCoverageRequirementOption(requirement, index);
		select.append(option);
	});

	select.value = selection.key;
	select.addEventListener('change', () => {
		setCoverageRequirementSelectionKey(select.value);
		renderEditor();
		refreshChrome();
		renderValidationState();
	});

	field.append(select, createErrorRegion());
	return field;
}

function createCoverageSelectedRequirementCard(
	requirement: SpecificationRequirement,
	coverageSummary: ReturnType<typeof summarizeRequirementCoverage>,
	requirementIndex: number
): HTMLElement {
	const card = document.createElement('inc-card');
	card.className = 'coverage-selected-card';

	const header = document.createElement('div');
	header.slot = 'header';
	header.append(
		createSectionHeading(
			'Selected requirement',
			'Read-only coverage evidence for the selected requirement.'
		)
	);

	const actions = createButtonToolbar('Coverage actions', 'section-actions');
	actions.slot = 'footer';
	actions.append(
		createActionButton('Reveal in editor', 'Reveal the selected requirement in the editor', () => {
			void vscode.postMessage({ type: 'reveal', cardPath: `requirements[${requirementIndex}]` });
		}, { variant: 'secondary', size: 'sm' })
	);

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = 'coverage-selected-body';
	body.append(
		createCoverageRequirementMetaGrid(requirement, coverageSummary),
		createCoverageEvidenceDisclosure('Coverage entries', requirement.coverage ?? [], 'No coverage evidence has been recorded yet.', requirementIndex, 'coverage'),
		createCoverageEvidenceDisclosure('Trace entries', requirement.trace ?? [], 'No trace evidence has been recorded yet.', requirementIndex, 'trace'),
		createCoverageEvidenceDisclosure('Notes entries', requirement.notes ?? [], 'No notes have been recorded yet.', requirementIndex, 'notes')
	);

	card.append(header, actions, body);
	return card;
}

function createCoverageRequirementMetaGrid(
	requirement: SpecificationRequirement,
	coverageSummary: ReturnType<typeof summarizeRequirementCoverage>
): HTMLElement {
	const grid = document.createElement('inc-key-value-grid');
	grid.className = 'coverage-meta-grid';
	grid.setAttribute('columns', '2');
	grid.setAttribute('dense', '');

	grid.append(
		createReadonlyField('Requirement id', stringValue(requirement.id) || '—', undefined, 'coverage-selected-id'),
		createReadonlyField('Title', stringValue(requirement.title) || 'Untitled requirement', undefined, 'coverage-selected-title'),
		createReadonlyField('Status', formatCoverageStatusLabel(coverageSummary.status), undefined, 'coverage-selected-status'),
		createReadonlyField('Statement', stringValue(requirement.statement) || 'No statement recorded.', 'Normative statement text.', 'coverage-selected-statement'),
		createReadonlyField('Coverage entries', String(coverageSummary.coverageCount), undefined, 'coverage-selected-coverage-count'),
		createReadonlyField('Trace entries', String(coverageSummary.traceCount), undefined, 'coverage-selected-trace-count'),
		createReadonlyField('Notes entries', String(coverageSummary.notesCount), undefined, 'coverage-selected-notes-count')
	);

	return grid;
}

function createCoverageEvidenceDisclosure(
	title: string,
	items: string[],
	emptyMessage: string,
	requirementIndex: number,
	fieldName: 'coverage' | 'trace' | 'notes'
): HTMLElement {
	const body = document.createElement('div');
	body.className = 'coverage-evidence-body';

	if (items.length === 0) {
		body.append(createCard(title, emptyMessage));
	} else {
		const list = document.createElement('inc-list-group');
		list.setAttribute('dense', '');
		list.className = 'coverage-evidence-list';
		items.forEach((item, index) => {
			const entry = document.createElement('div');
			entry.textContent = item;
			entry.dataset.validationPath = `requirements[${requirementIndex}].${fieldName}[${index}]`;
			list.append(entry);
		});
		body.append(list);
	}

	return createCollapsibleCard(
		title,
		`${items.length} item${items.length === 1 ? '' : 's'}`,
		body,
		{
			className: `coverage-evidence-card coverage-evidence-card--${fieldName}`,
			cardPath: `coverage-summary.requirements[${requirementIndex}].${fieldName}`,
			open: false
		}
	);
}

function setCoverageRequirementSelectionKey(key: string): void {
	coverageRequirementSelectionKey = key;
	persistWebviewState();
}

function ensureCoverageSelectionKey(): void {
	if (!currentDocument) {
		coverageRequirementSelectionKey = '';
		return;
	}

	const { key } = resolveCoverageRequirementSelection(currentDocument.requirements ?? []);
	coverageRequirementSelectionKey = key;
}

function resolveCoverageRequirementSelection(requirements: SpecificationRequirement[]): CoverageSelection {
	if (requirements.length === 0) {
		return {
			key: '',
			index: -1
		};
	}

	const normalizedKey = coverageRequirementSelectionKey.trim();
	if (normalizedKey.length > 0) {
		if (normalizedKey.startsWith('id:')) {
			const requirementId = normalizedKey.slice(3);
			const index = requirements.findIndex((requirement) => stringValue(requirement.id).trim() === requirementId);
			if (index >= 0) {
				return {
					key: normalizedKey,
					index
				};
			}
		} else if (normalizedKey.startsWith('index:')) {
			const index = Number.parseInt(normalizedKey.slice(6), 10);
			if (Number.isFinite(index)) {
				const resolvedIndex = Math.min(Math.max(index, 0), requirements.length - 1);
				const requirement = requirements[resolvedIndex];
				const requirementId = stringValue(requirement?.id).trim();
				if (requirementId.length > 0) {
					const upgradedKey = `id:${requirementId}`;
					coverageRequirementSelectionKey = upgradedKey;
					return {
						key: upgradedKey,
						index: resolvedIndex
					};
				}

				return {
					key: normalizedKey,
					index: resolvedIndex
				};
			}
		}
	}

	const firstRequirement = requirements[0];
	const firstRequirementId = stringValue(firstRequirement?.id).trim();
	const key = firstRequirementId.length > 0 ? `id:${firstRequirementId}` : 'index:0';
	coverageRequirementSelectionKey = key;
	return {
		key,
		index: 0
	};
}

function coverageSelectionKeyForRequirement(requirement: SpecificationRequirement, index: number): string {
	const requirementId = stringValue(requirement.id).trim();
	return requirementId.length > 0 ? `id:${requirementId}` : `index:${index}`;
}

function formatCoverageRequirementOption(requirement: SpecificationRequirement, index: number): string {
	const requirementId = stringValue(requirement.id).trim() || `Requirement ${index + 1}`;
	const requirementTitle = stringValue(requirement.title).trim() || 'Untitled requirement';
	return `${requirementId} · ${requirementTitle}`;
}

function formatCoverageStatusLabel(status: ReturnType<typeof summarizeRequirementCoverage>['status']): string {
	switch (status) {
		case 'covered':
			return 'Covered';
		case 'partial':
			return 'Partial';
		default:
			return 'Missing';
	}
}

function formatCoverageStatusTone(status: ReturnType<typeof summarizeRequirementCoverage>['status']): 'success' | 'warning' | 'danger' {
	switch (status) {
		case 'covered':
			return 'success';
		case 'partial':
			return 'warning';
		default:
			return 'danger';
	}
}

function createReadonlyField(labelText: string, valueText: string, metaText?: string, id?: string): HTMLElement {
	const field = document.createElement('inc-readonly-field');
	field.setAttribute('dense', '');
	field.setAttribute('label', labelText);
	field.setAttribute('value', valueText);
	if (id) {
		field.id = id;
	}

	if (metaText) {
		const meta = document.createElement('span');
		meta.slot = 'meta';
		meta.className = 'inc-text inc-text--small inc-text--muted';
		meta.textContent = metaText;
		field.append(meta);
	}

	return field;
}

function createDocumentFieldsCard(): HTMLElement {
	const grid = document.createElement('div');
	grid.className = 'form-grid';

	const metadataGrid = document.createElement('inc-key-value-grid');
	metadataGrid.className = 'editor-field--wide';
	metadataGrid.setAttribute('columns', '2');
	metadataGrid.setAttribute('dense', '');
	metadataGrid.append(
		createKeyValueCard('Artifact id', stringValue(currentDocument?.artifact_id), 'Top-level file identifier.'),
		createKeyValueCard('Artifact type', stringValue(currentDocument?.artifact_type) || 'specification', 'Canonical document type.')
	);

	grid.append(
		metadataGrid,
		createTextField('title', 'Title', stringValue(currentDocument?.title), false, 'Specification title', 'Top-level document title.'),
		createTextField('domain', 'Domain', stringValue(currentDocument?.domain), false, 'Domain slug', 'Workspace or product domain slug.'),
		createTextField('capability', 'Capability', stringValue(currentDocument?.capability), false, 'Capability slug', 'Capability or workflow slug.'),
		createStatusField(),
		createTextField('owner', 'Owner', stringValue(currentDocument?.owner), false, 'Owning team or person', 'Owning team or person.'),
		createTextAreaField('purpose', 'Purpose', stringValue(currentDocument?.purpose), 'Why this specification exists.', 'Why this specification exists.'),
		createTextAreaField('scope', 'Scope', stringValue(currentDocument?.scope), 'What is included and excluded.', 'What is included and excluded.'),
		createTextAreaField('context', 'Context', stringValue(currentDocument?.context), 'Background and constraints.', 'Background and constraints.')
	);

	return createCollapsibleCard(
		'Document fields',
		'Top-level metadata and descriptive fields. Collapsed by default.',
		grid,
		{
			className: 'document-fields-card',
			validationPath: 'document-fields',
			cardPath: 'document-fields',
			open: false
		}
	);
}

function createStatusField(): HTMLElement {
	const field = document.createElement('inc-field');
	field.setAttribute('label', 'Status');
	field.setAttribute('hint', 'Choose the current lifecycle state.');
	field.setAttribute('dense', '');
	field.dataset.validationPath = 'status';

	const select = document.createElement('select');
	select.className = 'inc-form__select';
	select.id = 'status-input';
	select.spellcheck = false;
	select.slot = 'control';

	const currentStatus = stringValue(currentDocument?.status);
	const hasKnownStatus = statusOptions.includes(currentStatus);
	const isCustomStatus = currentStatus.length > 0 && !hasKnownStatus;

	const placeholder = document.createElement('option');
	placeholder.value = '';
	placeholder.textContent = 'Select status';
	placeholder.disabled = true;
	placeholder.selected = currentStatus.length === 0;
	select.append(placeholder);

	if (isCustomStatus) {
		const customOption = document.createElement('option');
		customOption.value = currentStatus;
		customOption.textContent = `${currentStatus} (custom)`;
		select.append(customOption);
	}

	for (const option of statusOptions) {
		const optionNode = document.createElement('option');
		optionNode.value = option;
		optionNode.textContent = option;
		select.append(optionNode);
	}

	select.value = currentStatus;
	select.addEventListener('change', () => {
		ensureEditableDocument();
		currentDocument!.status = select.value;
		commitCurrentDocument();
	});

	field.append(select, createErrorRegion());
	return field;
}

function createTextField(
	path: string,
	labelText: string,
	value: string,
	multiline: boolean,
	placeholder: string,
	hint?: string
): HTMLElement {
	const field = document.createElement('inc-field');
	field.className = multiline ? 'editor-field editor-field--wide' : 'editor-field';
	field.setAttribute('label', labelText);
	field.setAttribute('dense', '');
	field.dataset.validationPath = path;
	if (hint) {
		field.setAttribute('hint', hint);
	}

	const input = multiline ? document.createElement('textarea') : document.createElement('input');
	input.className = multiline ? 'inc-form__control editor-field__control editor-field__control--textarea' : 'inc-form__control editor-field__control';
	input.id = `${path}-input`;
	input.value = value;
	input.placeholder = placeholder;
	input.spellcheck = true;
	input.slot = 'control';
	if (multiline) {
		input.setAttribute('rows', '3');
	}
	input.addEventListener('input', () => {
		ensureEditableDocument();
		setPropertyValue(path, input.value);
		commitCurrentDocument();
	});

	field.append(input, createErrorRegion());
	return field;
}

function createTextAreaField(path: string, labelText: string, value: string, placeholder: string, hint?: string): HTMLElement {
	return createTextField(path, labelText, value, true, placeholder, hint);
}

function createKeyValueCard(labelText: string, valueText: string, metaText?: string): HTMLElement {
	const item = document.createElement('inc-key-value');
	item.setAttribute('card', '');

	const label = document.createElement('span');
	label.slot = 'label';
	label.className = 'inc-key-value__label';
	label.textContent = labelText;

	const value = document.createElement('span');
	value.slot = 'value';
	value.className = 'inc-key-value__value inc-key-value__value--data';
	value.textContent = valueText;

	item.append(label, value);

	if (metaText) {
		const meta = document.createElement('span');
		meta.slot = 'meta';
		meta.textContent = metaText;
		item.append(meta);
	}

	return item;
}

function createTopLevelListCard(
	title: string,
	description: string,
	fieldName: TopLevelListField,
	items: string[],
	options: {
		multiline: boolean;
		placeholder: string;
		addLabel: string;
	}
): HTMLElement {
	const body = createListEditor(title, description, fieldName, items, options);
	const itemLabel = items.length === 1 ? '1 item' : `${items.length} items`;
	return createCollapsibleCard(
		title,
		itemLabel,
		body,
		{
			className: `${fieldName}-card`,
			validationPath: fieldName,
			cardPath: fieldName,
			open: false
		}
	);
}

function createDisclosureSummary(title: string, description: string, countLabel?: string): HTMLElement {
	const summary = document.createElement('span');
	summary.className = 'disclosure-summary';

	const row = document.createElement('span');
	row.className = 'disclosure-summary__row';

	const titleWrap = document.createElement('span');
	titleWrap.className = 'disclosure-summary__title';

	const titleText = document.createElement('span');
	titleText.className = 'disclosure-summary__title-text';
	titleText.textContent = title;

	titleWrap.append(titleText);

	if (countLabel) {
		const badge = createBadge(countLabel, 'info', 'disclosure-summary__badge');
		titleWrap.append(badge);
	}

	const descriptionNode = document.createElement('span');
	descriptionNode.className = 'disclosure-summary__description inc-text inc-text--small inc-text--muted';
	descriptionNode.textContent = description;

	row.append(titleWrap);
	summary.append(row, descriptionNode);
	return summary;
}

function createRequirementsCard(autoOpenRequirementIndex: number | undefined): HTMLElement {
	if (autoOpenRequirementIndex !== undefined) {
		openRequirementEditorByIndex(autoOpenRequirementIndex);
	}

	const section = document.createElement('inc-section');
	section.setAttribute('dense', '');
	section.dataset.validationPath = 'requirements';
	ensureRequirementViewMode();

	const header = document.createElement('div');
	header.slot = 'header';
	header.append(
		createSectionHeading(
			'Requirements',
			shouldRenderRequirementDetail()
				? 'Focused requirement editing with the rest of the document chrome out of the way.'
				: 'Scan the full requirement set in one dense list, then open a requirement into its own editing screen.'
		)
	);

	const actions = createButtonToolbar('Requirement actions', 'section-actions');
	actions.slot = 'actions';
	if (shouldRenderRequirementDetail()) {
		actions.append(
			createActionButton('Back to requirements', 'Return to the requirements index', () => {
				returnToRequirementIndex();
				renderEditor();
				refreshChrome();
				renderValidationState();
			}, { variant: 'outline-secondary' })
		);
	} else {
		actions.append(
			createActionButton('Add requirement', 'Add a new requirement record', () => {
				ensureEditableDocument();
				currentDocument!.requirements = currentDocument!.requirements ?? [];
				pendingOpenRequirementIndex = currentDocument!.requirements.length;
				currentDocument!.requirements.push(createEmptyRequirement());
				setCoverageRequirementSelectionKey(`index:${pendingOpenRequirementIndex}`);
				currentRequirementViewMode = 'detail';
				commitCurrentDocument(true);
				renderEditor();
				refreshChrome();
				renderValidationState();
			}, { variant: 'secondary' })
		);
	}

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = shouldRenderRequirementDetail() ? 'requirements-screen requirements-screen--detail' : 'requirements-screen requirements-screen--index';

	const requirements = currentDocument?.requirements ?? [];
	const selection = resolveCoverageRequirementSelection(requirements);

	if (shouldRenderRequirementDetail()) {
		body.append(createRequirementDetailCard(requirements, selection), createErrorRegion());
	} else {
		body.append(createRequirementsIndexCard(requirements, selection), createErrorRegion());
	}

	section.append(header, actions, body);
	return section;
}

function createRequirementsIndexCard(
	requirements: SpecificationRequirement[],
	selection: CoverageSelection
): HTMLElement {
	const card = document.createElement('inc-card');
	card.className = 'requirements-index-card';

	const header = document.createElement('div');
	header.slot = 'header';
	header.append(
		createSectionHeading(
			'Requirement index',
			requirements.length === 0
				? 'Add a requirement to start building the specification.'
				: `${requirements.length} requirement${requirements.length === 1 ? '' : 's'} in file order. Open one when you need to edit it.`
		)
	);

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = 'requirements-index-shell';

	if (requirements.length === 0) {
		body.append(createCard('No requirements yet', 'Add the first requirement to start editing the specification.'));
		card.append(header, body);
		return card;
	}

	const entries = createRequirementIndexEntries(requirements);
	const visibleEntries = filterRequirementIndexEntries(entries);
	body.append(createRequirementIndexToolbar(entries.length, visibleEntries.length));

	if (visibleEntries.length === 0) {
		body.append(createRequirementIndexEmptyState(entries.length));
		card.append(header, body);
		return card;
	}

	const list = document.createElement('div');
	list.className = 'inc-list-group inc-list-group--flush inc-list-group--dense requirement-index-list';
	visibleEntries.forEach((entry) => {
		list.append(createRequirementIndexRow(entry, selection));
	});

	body.append(list);
	card.append(header, body);
	return card;
}

function createRequirementIndexEntries(requirements: SpecificationRequirement[]): RequirementIndexEntry[] {
	return requirements.map((requirement, index) => {
		const path = `requirements[${index}]`;
		return {
			requirement,
			index,
			path,
			issueCount: countIssuesForPath(path),
			coverageSummary: summarizeRequirementCoverage(requirement),
			searchText: [
				stringValue(requirement.id),
				stringValue(requirement.title),
				stringValue(requirement.statement)
			].join(' ').toLocaleLowerCase()
		};
	});
}

function filterRequirementIndexEntries(entries: RequirementIndexEntry[]): RequirementIndexEntry[] {
	const query = requirementSearchQuery.trim().toLocaleLowerCase();
	return entries.filter((entry) => {
		if (requirementIndexFilter === 'issues' && entry.issueCount === 0) {
			return false;
		}

		if (requirementIndexFilter !== 'all' && requirementIndexFilter !== 'issues' && entry.coverageSummary.status !== requirementIndexFilter) {
			return false;
		}

		if (query.length > 0 && !entry.searchText.includes(query)) {
			return false;
		}

		return true;
	});
}

function createRequirementIndexToolbar(totalCount: number, visibleCount: number): HTMLElement {
	const toolbar = document.createElement('div');
	toolbar.className = 'requirement-index-toolbar';

	const searchField = document.createElement('inc-field');
	searchField.className = 'requirement-index-search-field';
	searchField.setAttribute('dense', '');

	const searchLabel = document.createElement('div');
	searchLabel.slot = 'label';
	searchLabel.className = 'inc-form__label';
	searchLabel.textContent = 'Find requirement';

	const searchControl = document.createElement('div');
	searchControl.slot = 'control';
	searchControl.className = 'requirement-index-search-control';

	const searchInput = document.createElement('input');
	searchInput.id = 'requirement-search-input';
	searchInput.type = 'search';
	searchInput.className = 'inc-form__control requirement-index-search-input';
	searchInput.placeholder = 'Search id, title, or statement';
	searchInput.value = requirementSearchQuery;
	searchInput.setAttribute('aria-label', 'Search requirements');
	searchInput.addEventListener('input', () => {
		const selectionStart = searchInput.selectionStart ?? searchInput.value.length;
		const selectionEnd = searchInput.selectionEnd ?? selectionStart;
		setRequirementSearchQuery(searchInput.value);
		renderEditor();
		refreshChrome();
		renderValidationState();
		window.setTimeout(() => {
			const refreshedInput = document.getElementById('requirement-search-input') as HTMLInputElement | null;
			if (!refreshedInput) {
				return;
			}

			refreshedInput.focus();
			refreshedInput.setSelectionRange(selectionStart, selectionEnd);
		}, 0);
	});

	searchControl.append(searchInput);
	searchField.append(searchLabel, searchControl);

	const filters = createButtonGroup('Requirement index filters', 'requirement-index-filter-group');
	for (const filter of requirementIndexFilters) {
		filters.append(createRequirementFilterButton(filter));
	}

	const meta = document.createElement('div');
	meta.className = 'inc-text inc-text--small inc-text--muted requirement-index-results';
	meta.textContent = visibleCount === totalCount
		? `${totalCount} requirement${totalCount === 1 ? '' : 's'} shown`
		: `${visibleCount} of ${totalCount} requirement${totalCount === 1 ? '' : 's'} shown`;

	toolbar.append(searchField, filters, meta);
	return toolbar;
}

function createRequirementFilterButton(filter: RequirementIndexFilter): HTMLElement {
	const labels: Record<RequirementIndexFilter, string> = {
		all: 'All',
		issues: 'Issues',
		missing: 'Missing',
		partial: 'Partial',
		covered: 'Covered'
	};

	return createActionButton(
		labels[filter],
		`Show ${labels[filter].toLowerCase()} requirements`,
		() => {
			setRequirementIndexFilter(filter);
			renderEditor();
			refreshChrome();
			renderValidationState();
		},
		{
			variant: requirementIndexFilter === filter ? 'secondary' : 'outline-secondary',
			size: 'sm'
		}
	);
}

function createRequirementIndexEmptyState(totalCount: number): HTMLElement {
	const hasQuery = requirementSearchQuery.trim().length > 0;
	const filtered = requirementIndexFilter !== 'all';
	const filterLabel = requirementIndexFilter === 'issues' ? 'issues' : requirementIndexFilter;
	const criteria: string[] = [];
	if (hasQuery) {
		criteria.push('the current search');
	}
	if (filtered) {
		criteria.push(`the ${filterLabel} filter`);
	}
	const description = hasQuery || filtered
		? `No requirements match ${criteria.join(' and ')}.`
		: 'No requirements are available.';

	return createCard(
		totalCount === 0 ? 'No requirements yet' : 'No matching requirements',
		description
	);
}

function createRequirementIndexRow(
	entry: RequirementIndexEntry,
	selection: CoverageSelection
): HTMLElement {
	const { requirement, index, path, coverageSummary, issueCount } = entry;
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'inc-list-group__item inc-list-group__item--action requirement-index-row';
	button.setAttribute('aria-label', `Edit ${stringValue(requirement.id).trim() || `Requirement ${index + 1}`}`);
	button.dataset.validationPath = path;
	button.dataset.cardPath = path;
	button.dataset.requirementRowPath = path;
	const isSelected = selection.index === index;
	if (isSelected) {
		button.classList.add('active');
	}
	if (issueCount > 0) {
		button.classList.add('requirement-index-row--warning');
	}

	button.addEventListener('click', () => {
		openRequirementEditorByIndex(index);
		renderEditor();
		refreshChrome();
		renderValidationState();
	});

	const rowHeader = document.createElement('span');
	rowHeader.className = 'requirement-index-header';

	const summaryCopy = document.createElement('span');
	summaryCopy.className = 'requirement-summary-copy';
	summaryCopy.dataset.requirementSummaryPath = path;

	const summaryLine = document.createElement('span');
	summaryLine.className = 'requirement-summary-line';

	const summaryIdentifier = document.createElement('span');
	summaryIdentifier.className = 'requirement-summary-id';
	summaryIdentifier.textContent = stringValue(requirement.id).trim() || `Requirement ${index + 1}`;

	const summaryTitle = document.createElement('span');
	summaryTitle.className = 'requirement-summary-title';
	summaryTitle.textContent = stringValue(requirement.title).trim() || 'Untitled requirement';

	const summaryDescription = document.createElement('span');
	summaryDescription.className = 'requirement-summary-statement';
	summaryDescription.textContent = stringValue(requirement.statement).trim() || 'Add the requirement statement.';

	summaryLine.append(summaryIdentifier, summaryTitle);
	summaryCopy.append(summaryLine, summaryDescription);

	const meta = document.createElement('span');
	meta.className = 'requirement-index-meta';
	meta.dataset.requirementMetaPath = path;

	const coverageBadge = createBadge(
		formatCoverageStatusLabel(coverageSummary.status),
		formatCoverageStatusTone(coverageSummary.status),
		'requirement-summary-state'
	);
	coverageBadge.dataset.coveragePath = path;
	meta.append(coverageBadge);

	if (issueCount > 0) {
		const issuesBadge = createRequirementIssueBadge(path, issueCount, true);
		meta.append(issuesBadge);
	}

	const evidence = document.createElement('span');
	evidence.className = 'inc-text inc-text--small inc-text--muted requirement-index-evidence';
	evidence.dataset.requirementEvidencePath = path;
	evidence.textContent = formatRequirementEvidenceSummary(coverageSummary);
	meta.append(evidence);

	rowHeader.append(summaryCopy, meta);
	button.append(rowHeader);
	return button;
}

function createRequirementIssueBadge(requirementPath: string, issueCount: number, compact = false): HTMLElement {
	const tone = issueCount > 0 ? 'warning' : 'success';
	const label = compact ? `${issueCount} issue${issueCount === 1 ? '' : 's'}` : (issueCount > 0 ? String(issueCount) : '0');
	const badge = createBadge(label, tone, compact ? 'requirements-issue-badge' : 'requirements-issue-count');
	badge.dataset.requirementIssuesPath = requirementPath;
	return badge;
}

function formatRequirementEvidenceSummary(summary: ReturnType<typeof summarizeRequirementCoverage>): string {
	const parts: string[] = [];
	if (summary.traceCount > 0) {
		parts.push(`Trace ${summary.traceCount}`);
	}
	if (summary.notesCount > 0) {
		parts.push(`Notes ${summary.notesCount}`);
	}

	return parts.length > 0 ? parts.join(' · ') : 'No trace or notes yet';
}

function createRequirementDetailCard(
	requirements: SpecificationRequirement[],
	selection: CoverageSelection
): HTMLElement {
	const detail = document.createElement('inc-card');
	detail.className = 'requirement-detail-card';

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = 'requirement-detail-body';

	if (selection.index < 0 || !requirements[selection.index]) {
		body.append(createCard('Select a requirement', 'Choose a row from the requirement table to edit its details.'));
		detail.append(body);
		return detail;
	}

	const requirement = requirements[selection.index];
	const path = `requirements[${selection.index}]`;
	const coverageSummary = summarizeRequirementCoverage(requirement);
	const issueCount = countIssuesForPath(path);

	const header = document.createElement('div');
	header.slot = 'header';
	header.className = 'requirement-detail-header';

	const titleBlock = document.createElement('div');
	titleBlock.className = 'requirement-detail-heading';

	const title = document.createElement('h2');
	title.className = 'inc-heading inc-heading--h5';
	title.id = 'selected-requirement-title';
	title.textContent = stringValue(requirement.title).trim() || 'Untitled requirement';

	const subtitle = document.createElement('p');
	subtitle.className = 'inc-text inc-text--small inc-text--muted requirement-detail-subtitle';
	subtitle.id = 'selected-requirement-subtitle';
	subtitle.textContent = `${stringValue(requirement.id).trim() || `Requirement ${selection.index + 1}`} · ${selection.index + 1} of ${requirements.length}`;

	titleBlock.append(title, subtitle);

	const actions = createButtonToolbar('Selected requirement actions', 'requirement-toolbar');
	actions.append(
		createActionButton(
			'Previous',
			'Open the previous requirement',
			() => navigateRequirementByOffset(-1),
			{ variant: 'outline-secondary', size: 'sm', disabled: selection.index === 0 }
		),
		createActionButton(
			'Next',
			'Open the next requirement',
			() => navigateRequirementByOffset(1),
			{ variant: 'outline-secondary', size: 'sm', disabled: selection.index === requirements.length - 1 }
		),
		createIconButton('↑', 'Move requirement up', () => moveRequirement(selection.index, selection.index - 1), selection.index === 0),
		createIconButton('↓', 'Move requirement down', () => moveRequirement(selection.index, selection.index + 1), selection.index === requirements.length - 1),
		createIconButton('×', 'Remove requirement', () => removeRequirement(selection.index), false, 'outline-danger')
	);

	header.append(titleBlock, actions);

	body.append(
		createSelectedRequirementOverview(selection.index, requirements.length, coverageSummary, issueCount),
		createRequirementField(path, 'id', 'Requirement id', stringValue(requirement.id), false, 'REQ-EXAMPLE-0001'),
		createRequirementField(path, 'title', 'Title', stringValue(requirement.title), false, 'Requirement title'),
		createRequirementField(path, 'statement', 'Statement', stringValue(requirement.statement), true, 'Normative requirement statement'),
		createRequirementListField(path, 'coverage', 'Coverage', requirement.coverage ?? [], false, 'Coverage item'),
		createRequirementListField(path, 'trace', 'Trace', requirement.trace ?? [], false, 'Trace item'),
		createRequirementListField(path, 'notes', 'Notes', requirement.notes ?? [], true, 'Note')
	);

	detail.append(header, body, createErrorRegion());
	return detail;
}

function createSelectedRequirementOverview(
	index: number,
	totalRequirements: number,
	coverageSummary: ReturnType<typeof summarizeRequirementCoverage>,
	issueCount: number
): HTMLElement {
	const overview = document.createElement('inc-summary-overview');
	overview.setAttribute('columns', '4');
	overview.setAttribute('dense', '');
	overview.className = 'requirement-detail-overview';

	overview.append(
		createSummaryBlock('Order', createMetricBadge('selected-requirement-order', `${index + 1}/${totalRequirements}`, 'info')),
		createSummaryBlock('Coverage', createMetricBadge('selected-requirement-coverage-count', String(coverageSummary.coverageCount), coverageSummary.coverageCount > 0 ? 'success' : 'info')),
		createSummaryBlock('Trace / Notes', createMetricBadge('selected-requirement-evidence-count', `${coverageSummary.traceCount} / ${coverageSummary.notesCount}`, (coverageSummary.traceCount > 0 || coverageSummary.notesCount > 0) ? 'warning' : 'info')),
		createSummaryBlock('Issues', createMetricBadge('selected-requirement-issue-count', issueCount > 0 ? String(issueCount) : '0', issueCount > 0 ? 'warning' : 'success'))
	);

	return overview;
}

function createMetricBadge(id: string, label: string, tone: 'info' | 'success' | 'warning' | 'danger'): HTMLElement {
	const badge = createBadge(label, tone, 'requirement-detail-metric');
	badge.id = id;
	return badge;
}

function countIssuesForPath(path: string): number {
	return currentIssues.filter((issue) => issueMatchesPath(issue.path, path)).length;
}

function createRequirementField(
	requirementPath: string,
	fieldName: 'id' | 'title' | 'statement',
	labelText: string,
	value: string,
	multiline: boolean,
	placeholder: string
): HTMLElement {
	const fieldPath = `${requirementPath}.${fieldName}`;
	const field = document.createElement('inc-field');
	field.className = multiline ? 'editor-field editor-field--wide' : 'editor-field';
	field.setAttribute('label', labelText);
	field.setAttribute('dense', '');
	field.dataset.validationPath = fieldPath;

	const input = multiline ? document.createElement('textarea') : document.createElement('input');
	input.className = multiline ? 'inc-form__control editor-field__control editor-field__control--textarea' : 'inc-form__control editor-field__control';
	input.id = `${fieldPath}-input`;
	input.placeholder = placeholder;
	input.value = value;
	input.spellcheck = true;
	input.slot = 'control';
	if (multiline) {
		input.setAttribute('rows', '3');
	}
	input.addEventListener('input', () => {
		ensureEditableDocument();
		const requirementIndex = parseRequirementIndex(requirementPath);
		const requirement = currentDocument!.requirements?.[requirementIndex];
		if (!requirement) {
			return;
		}

		setRequirementField(requirement, fieldName, input.value);
		if (fieldName === 'id') {
			setCoverageRequirementSelectionKey(coverageSelectionKeyForRequirement(requirement, requirementIndex));
		}
		commitCurrentDocument();
	});

	field.append(input, createErrorRegion());
	return field;
}

function createRequirementListField(
	requirementPath: string,
	fieldName: 'coverage' | 'trace' | 'notes',
	labelText: string,
	items: string[],
	multiline: boolean,
	placeholder: string
): HTMLElement {
	const fieldPath = `${requirementPath}.${fieldName}`;
	const field = document.createElement('inc-field');
	field.className = 'list-field wide';
	field.setAttribute('dense', '');
	field.dataset.validationPath = fieldPath;

	const label = document.createElement('div');
	label.slot = 'label';
	label.className = 'inc-form__label';
	label.textContent = labelText;

	const hint = document.createElement('p');
	hint.slot = 'hint';
	hint.className = 'inc-form__hint';
	hint.textContent = multiline ? 'Each item can span multiple lines.' : 'Each item is a separate string entry.';

	const control = document.createElement('div');
	control.slot = 'control';
	control.className = 'list-field__control inc-form__control';

	const itemsContainer = document.createElement('inc-list-group');
	itemsContainer.className = 'requirements-list';
	itemsContainer.setAttribute('flush', '');
	itemsContainer.setAttribute('dense', '');

	items.forEach((item, index) => {
		itemsContainer.append(createListRow(fieldPath, items, index, item, multiline, placeholder));
	});

	const addButton = createActionButton('Add item', `Add a ${labelText.toLowerCase()} entry`, () => {
		ensureEditableDocument();
		const requirementIndex = parseRequirementIndex(requirementPath);
		const requirement = currentDocument!.requirements?.[requirementIndex];
		if (!requirement) {
			return;
		}

		const list = getRequirementArray(requirement, fieldName);
		list.push('');
		commitCurrentDocument(true);
		renderEditor();
		refreshChrome();
		renderValidationState();
	}, { variant: 'secondary', size: 'sm' });

	const actions = createButtonToolbar(`${labelText} actions`, 'section-actions');
	actions.append(addButton);

	control.append(itemsContainer, actions);
	field.append(label, hint, control, createErrorRegion());
	return field;
}

function createListEditor(
	fieldLabel: string,
	fieldHint: string,
	fieldName: TopLevelListField,
	items: string[],
	options: {
		multiline: boolean;
		placeholder: string;
		addLabel: string;
	}
): HTMLElement {
	const field = document.createElement('inc-field');
	field.className = 'list-field wide';
	field.setAttribute('dense', '');
	field.dataset.validationPath = fieldName;

	const label = document.createElement('div');
	label.slot = 'label';
	label.className = 'inc-form__label';
	label.textContent = fieldLabel;

	const hint = document.createElement('p');
	hint.slot = 'hint';
	hint.className = 'inc-form__hint';
	hint.textContent = fieldHint;

	const control = document.createElement('div');
	control.slot = 'control';
	control.className = 'list-field__control inc-form__control';

	const itemsContainer = document.createElement('inc-list-group');
	itemsContainer.className = 'requirements-list';
	itemsContainer.setAttribute('flush', '');
	itemsContainer.setAttribute('dense', '');

	items.forEach((item, index) => {
		itemsContainer.append(createListRow(fieldName, items, index, item, options.multiline, options.placeholder));
	});

	const entryLabel = options.addLabel.replace(/^Add\s+/i, '').trim().toLowerCase();
	const addButton = createActionButton(options.addLabel, `Add ${entryLabel} entry`, () => {
		ensureEditableDocument();
		const list = getTopLevelArray(fieldName);
		setCardExpanded(fieldName, true);
		list.push('');
		commitCurrentDocument(true);
		renderEditor();
		forceCardOpenAfterRender(fieldName);
		refreshChrome();
		renderValidationState();
	}, { variant: 'secondary', size: 'sm' });

	const actions = createButtonToolbar(`${options.addLabel} actions`, 'section-actions');
	actions.append(addButton);

	control.append(itemsContainer, actions);
	field.append(label, hint, control, createErrorRegion());
	return field;
}

function createListRow(
	fieldPath: string,
	items: string[],
	index: number,
	value: string,
	multiline: boolean,
	placeholder: string
): HTMLElement {
	const rowPath = `${fieldPath}[${index}]`;
	const row = document.createElement('div');
	row.className = 'list-row';
	row.dataset.validationPath = rowPath;

	const input = multiline ? document.createElement('textarea') : document.createElement('input');
	input.className = multiline ? 'inc-form__control editor-field__control editor-field__control--textarea' : 'inc-form__control editor-field__control';
	input.placeholder = placeholder;
	input.value = value;
	input.spellcheck = true;
	if (multiline) {
		(input as HTMLTextAreaElement).rows = 3;
	}
	input.addEventListener('input', () => {
		ensureEditableDocument();
		items[index] = input.value;
		commitCurrentDocument();
	});

	const up = createIconButton('↑', 'Move item up', () => moveArrayItem(items, index, index - 1), index === 0);
	const down = createIconButton('↓', 'Move item down', () => moveArrayItem(items, index, index + 1), index === items.length - 1);
	const remove = createIconButton('×', 'Remove item', () => removeArrayItem(items, index));

	const controls = createButtonGroup('List row actions', 'list-row__controls', 'sm');
	controls.append(up, down, remove);

	row.append(input, controls, createErrorRegion());
	return row;
}

function createIconButton(
	label: string,
	title: string,
	onClick: () => void,
	disabled = false,
	variant: 'outline-secondary' | 'outline-danger' = 'outline-secondary'
): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = `inc-btn inc-btn--${variant} inc-btn--micro`;
	button.textContent = label;
	button.title = title;
	button.disabled = disabled;
	button.addEventListener('click', onClick);
	return button;
}

function createSectionHeading(title: string, description: string): HTMLElement {
	const container = document.createElement('div');
	container.className = 'section-heading';
	const heading = document.createElement('h2');
	heading.className = 'inc-heading inc-heading--h5';
	heading.textContent = title;

	const copy = document.createElement('div');
	copy.className = 'section-copy inc-text inc-text--small inc-text--muted';
	copy.textContent = description;

	container.append(heading, copy);
	return container;
}

function createCollapsibleCard(
	title: string,
	description: string,
	body: HTMLElement,
	options?: {
		className?: string;
		validationPath?: string;
		cardPath?: string;
		open?: boolean;
	}
): HTMLElement {
	const card = document.createElement('inc-disclosure');
	card.className = ['collapsible-card', options?.className].filter(Boolean).join(' ');
	const cardPath = options?.cardPath;
	const open = options?.open ?? false;
	const isOpen = cardPath ? isCardExpanded(cardPath) || open : open;

	if (options?.validationPath !== undefined) {
		card.dataset.validationPath = options.validationPath;
	}

	if (cardPath) {
		card.dataset.cardPath = cardPath;
	}

	const summary = document.createElement('span');
	summary.slot = 'summary';
	summary.className = 'collapsible-card-summary';
	summary.append(createDisclosureSummary(title, description));

	const bodyContainer = document.createElement('div');
	bodyContainer.slot = 'content';
	bodyContainer.append(body);

	if (isOpen && cardPath) {
		setCardExpanded(cardPath, true);
	}
	if (isOpen) {
		card.setAttribute('open', '');
	} else {
		card.removeAttribute('open');
	}
	card.append(summary, bodyContainer);
	card.addEventListener('toggle', () => {
		if (!cardPath) {
			return;
		}

		setCardExpanded(cardPath, card.hasAttribute('open'));
		persistWebviewState();
	});
	return card;
}

function createActionButton(
	label: string,
	title: string,
	onClick: () => void,
	options?: {
		variant?: string;
		size?: 'sm' | 'lg' | 'micro';
		disabled?: boolean;
		loading?: boolean;
	}
): HTMLElement {
	const button = document.createElement('inc-button');
	button.setAttribute('type', 'button');
	button.setAttribute('variant', options?.variant ?? 'secondary');
	button.setAttribute('label', title);
	button.title = title;
	if (options?.size) {
		button.setAttribute('size', options.size);
	}
	if (options?.disabled) {
		button.setAttribute('disabled', '');
	}
	if (options?.loading) {
		button.setAttribute('loading', '');
	}
	button.textContent = label;
	button.addEventListener('click', onClick);
	return button;
}

function createButtonToolbar(label: string, className: string): HTMLElement {
	const toolbar = document.createElement('inc-button-toolbar');
	toolbar.className = className;
	toolbar.setAttribute('label', label);
	return toolbar;
}

function createButtonGroup(label: string, className: string, size: 'sm' | 'lg' | 'micro' = 'sm'): HTMLElement {
	const group = document.createElement('inc-button-group');
	group.className = className;
	group.setAttribute('label', label);
	group.setAttribute('size', size);
	return group;
}

function createCard(title: string, description: string): HTMLElement {
	const panel = document.createElement('inc-state-panel');
	panel.className = 'loading-panel inc-state-panel inc-state-panel--info';
	panel.setAttribute('variant', 'info');
	panel.setAttribute('title', title);
	panel.setAttribute('body', description);
	panel.setAttribute('status', 'Loading');
	return panel;
}

function createValidationSummaryCard(): HTMLElement {
	const summary = document.createElement('inc-validation-summary');
	summary.id = 'validation-summary';
	summary.setAttribute('live', 'polite');
	return summary;
}

function createErrorRegion(): HTMLElement {
	const region = document.createElement('div');
	region.className = 'field-errors inc-form__invalid-feedback';
	region.dataset.validationSlot = 'errors';
	return region;
}

function refreshChrome(): void {
	const syncChip = document.getElementById('sync-chip');
	const dirtyChip = document.getElementById('dirty-chip');
	const conflictChip = document.getElementById('conflict-chip');
	const validationChip = document.getElementById('validation-chip');
	const coverageChip = document.getElementById('coverage-chip');
	const coverageMeta = document.getElementById('coverage-meta');
	const validationSummary = document.getElementById('validation-summary');
	const heroTitle = document.getElementById('hero-title');
	const heroSubtitle = document.getElementById('hero-subtitle');

	if (syncChip) {
		syncChip.textContent = currentDirty ? 'Unsaved changes' : 'Synced';
		setBadgeTone(syncChip, currentDirty ? 'warning' : 'success');
	}

	if (dirtyChip) {
		dirtyChip.textContent = currentDirty ? 'Dirty' : 'Clean';
		setBadgeTone(dirtyChip, currentDirty ? 'warning' : 'success');
	}

	if (conflictChip) {
		conflictChip.textContent = currentExternalConflict ? 'External conflict' : 'No conflict';
		setBadgeTone(conflictChip, currentExternalConflict ? 'danger' : 'success');
	}

	if (validationChip) {
		validationChip.textContent = currentIssues.length === 0 ? 'No validation issues' : `${currentIssues.length} issues`;
		setBadgeTone(validationChip, currentIssues.length > 0 ? 'warning' : 'success');
	}

	if (validationSummary) {
		const isValid = currentIssues.length === 0;
		validationSummary.setAttribute('title', isValid
			? 'No validation issues.'
			: (currentIssues.length === 1 ? '1 validation issue prevents save.' : `${currentIssues.length} validation issues prevent save.`));
		validationSummary.setAttribute('count', String(currentIssues.length));
		validationSummary.replaceChildren();
		if (!isValid) {
			for (const issue of currentIssues.slice(0, 8)) {
				const line = document.createElement('li');
				line.slot = 'item';
				line.textContent = `${issue.path || 'document'}: ${issue.message}`;
				validationSummary.append(line);
			}
		}
	}

	if (heroTitle) {
		heroTitle.textContent = currentDocument?.title?.trim() || currentDocument?.artifact_id?.trim() || 'Untitled specification';
	}

	if (heroSubtitle) {
		heroSubtitle.textContent = formatHeroSubtitle();
	}

	refreshCoverageViews(coverageChip, coverageMeta);
}

function refreshCoverageViews(coverageChip?: HTMLElement | null, coverageMeta?: HTMLElement | null): void {
	if (!currentDocument) {
		return;
	}

	const summary = summarizeSpecificationCoverage(currentDocument);
	const state = getCoverageSummaryState(summary);

	if (coverageChip) {
		coverageChip.textContent = state.label;
		setBadgeTone(coverageChip, state.tone);
	}

	if (coverageMeta) {
		coverageMeta.textContent = state.meta;
	}

	const coverageBody = document.getElementById('coverage-section-body');
	if (coverageBody) {
		coverageBody.replaceChildren(
			createCoverageOverview(summary),
			createCoverageDetailCard()
		);
	}

	const requirementSummaryBadges = Array.from(document.querySelectorAll<HTMLElement>('[data-coverage-path]'));
	for (const badge of requirementSummaryBadges) {
		const requirementPath = badge.dataset.coveragePath;
		if (!requirementPath) {
			continue;
		}

		const requirementIndex = parseRequirementIndex(requirementPath);
		const requirement = currentDocument.requirements?.[requirementIndex];
		if (!requirement) {
			continue;
		}

		const requirementSummary = summarizeRequirementCoverage(requirement);
		badge.textContent = formatCoverageStatusLabel(requirementSummary.status);
		setBadgeTone(badge, formatCoverageStatusTone(requirementSummary.status));
	}

	const requirementSummaryRows = Array.from(document.querySelectorAll<HTMLElement>('[data-requirement-summary-path]'));
	for (const row of requirementSummaryRows) {
		const requirementPath = row.dataset.requirementSummaryPath;
		if (!requirementPath) {
			continue;
		}

		const requirementIndex = parseRequirementIndex(requirementPath);
		const requirement = currentDocument.requirements?.[requirementIndex];
		if (!requirement) {
			continue;
		}

		const requirementSummary = summarizeRequirementCoverage(requirement);
		const requirementId = row.querySelector<HTMLElement>('.requirement-summary-id');
		const requirementTitle = row.querySelector<HTMLElement>('.requirement-summary-title');
		const requirementStatement = row.querySelector<HTMLElement>('.requirement-summary-statement');
		const requirementStatus = row.querySelector<HTMLElement>('.requirement-summary-state');

		if (requirementId) {
			requirementId.textContent = stringValue(requirement.id).trim() || `Requirement ${requirementIndex + 1}`;
		}

		if (requirementTitle) {
			requirementTitle.textContent = stringValue(requirement.title).trim() || 'Untitled requirement';
		}

		if (requirementStatement) {
			requirementStatement.textContent = stringValue(requirement.statement).trim() || 'Add the requirement statement.';
		}

		if (requirementStatus) {
			requirementStatus.textContent = formatCoverageStatusLabel(requirementSummary.status);
			setBadgeTone(requirementStatus, formatCoverageStatusTone(requirementSummary.status));
		}
	}

	const requirementIssueBadges = Array.from(document.querySelectorAll<HTMLElement>('[data-requirement-issues-path]'));
	for (const badge of requirementIssueBadges) {
		const requirementPath = badge.dataset.requirementIssuesPath;
		if (!requirementPath) {
			continue;
		}

		const issueCount = countIssuesForPath(requirementPath);
		badge.textContent = badge.classList.contains('requirements-issue-badge')
			? `${issueCount} issue${issueCount === 1 ? '' : 's'}`
			: String(issueCount);
		setBadgeTone(badge, issueCount > 0 ? 'warning' : 'success');
	}

	const requirementEvidenceValues = Array.from(document.querySelectorAll<HTMLElement>('[data-requirement-evidence-path]'));
	for (const value of requirementEvidenceValues) {
		const requirementPath = value.dataset.requirementEvidencePath;
		if (!requirementPath) {
			continue;
		}

		const requirementIndex = parseRequirementIndex(requirementPath);
		const requirement = currentDocument.requirements?.[requirementIndex];
		if (!requirement) {
			continue;
		}

		const requirementSummary = summarizeRequirementCoverage(requirement);
		value.textContent = formatRequirementEvidenceSummary(requirementSummary);
	}

	const requirementRows = Array.from(document.querySelectorAll<HTMLElement>('[data-requirement-row-path]'));
	for (const row of requirementRows) {
		const requirementPath = row.dataset.requirementRowPath;
		if (!requirementPath) {
			continue;
		}

		const requirementIndex = parseRequirementIndex(requirementPath);
		const issueCount = countIssuesForPath(requirementPath);
		const selected = resolveCoverageRequirementSelection(currentDocument.requirements ?? []).index === requirementIndex;

		row.classList.toggle('active', selected);
		row.classList.toggle('requirement-index-row--warning', issueCount > 0);
		row.toggleAttribute('aria-current', selected);
	}

	const selectedRequirement = resolveCoverageRequirementSelection(currentDocument.requirements ?? []);
	if (selectedRequirement.index >= 0) {
		const requirement = currentDocument.requirements?.[selectedRequirement.index];
		if (requirement) {
			const selectedTitle = document.getElementById('selected-requirement-title');
			const selectedSubtitle = document.getElementById('selected-requirement-subtitle');
			const selectedOrder = document.getElementById('selected-requirement-order');
			const selectedCoverageCount = document.getElementById('selected-requirement-coverage-count');
			const selectedEvidenceCount = document.getElementById('selected-requirement-evidence-count');
			const selectedIssueCount = document.getElementById('selected-requirement-issue-count');
			const requirementSummary = summarizeRequirementCoverage(requirement);
			const issueCount = countIssuesForPath(`requirements[${selectedRequirement.index}]`);

			if (selectedTitle) {
				selectedTitle.textContent = stringValue(requirement.title).trim() || 'Untitled requirement';
			}

			if (selectedSubtitle) {
				selectedSubtitle.textContent = `${stringValue(requirement.id).trim() || `Requirement ${selectedRequirement.index + 1}`} · ${selectedRequirement.index + 1} of ${currentDocument.requirements?.length ?? 0}`;
			}

			if (selectedOrder) {
				selectedOrder.textContent = `${selectedRequirement.index + 1}/${currentDocument.requirements?.length ?? 0}`;
			}

			if (selectedCoverageCount) {
				selectedCoverageCount.textContent = String(requirementSummary.coverageCount);
				setBadgeTone(selectedCoverageCount, requirementSummary.coverageCount > 0 ? 'success' : 'info');
			}

			if (selectedEvidenceCount) {
				selectedEvidenceCount.textContent = `${requirementSummary.traceCount} / ${requirementSummary.notesCount}`;
				setBadgeTone(selectedEvidenceCount, (requirementSummary.traceCount > 0 || requirementSummary.notesCount > 0) ? 'warning' : 'info');
			}

			if (selectedIssueCount) {
				selectedIssueCount.textContent = issueCount > 0 ? String(issueCount) : '0';
				setBadgeTone(selectedIssueCount, issueCount > 0 ? 'warning' : 'success');
			}
		}
	}

	persistWebviewState();
}

function getCoverageSummaryState(summary: ReturnType<typeof summarizeSpecificationCoverage>): {
	label: string;
	meta: string;
	tone: 'info' | 'success' | 'warning' | 'danger';
} {
	if (summary.totalRequirements === 0) {
		return {
			label: 'No requirements',
			meta: 'Add requirements to start tracking coverage.',
			tone: 'info'
		};
	}

	const coverageLabel = `${summary.coveredCount}/${summary.totalRequirements} covered`;
	if (summary.missingCount === 0 && summary.partialCount === 0) {
		return {
			label: coverageLabel,
			meta: 'All requirements have coverage evidence.',
			tone: 'success'
		};
	}

	if (summary.missingCount === 0) {
		return {
			label: coverageLabel,
			meta: `${summary.partialCount} partial requirement${summary.partialCount === 1 ? '' : 's'} still need coverage entries.`,
			tone: 'warning'
		};
	}

	return {
		label: coverageLabel,
		meta: `${summary.partialCount} partial and ${summary.missingCount} missing requirement${summary.missingCount === 1 ? '' : 's'}.`,
		tone: 'danger'
	};
}

function setBadgeTone(element: HTMLElement, tone: 'success' | 'warning' | 'danger' | 'info'): void {
	if (element.tagName === 'INC-BADGE') {
		element.setAttribute('tone', tone);
		element.setAttribute('pill', '');
		return;
	}

	const tokens = ['inc-badge--info', 'inc-badge--success', 'inc-badge--warning', 'inc-badge--danger'];
	tokens.forEach((token) => element.classList.remove(token));
	element.classList.add(`inc-badge--${tone}`);
}

function renderValidationState(): void {
	const validationSummary = document.getElementById('validation-summary');
	if (!validationSummary) {
		return;
	}

	const validationContainers = Array.from(document.querySelectorAll('[data-validation-path]')) as HTMLElement[];
	for (const container of validationContainers) {
		const path = container.dataset.validationPath;
		if (!path) {
			continue;
		}

		const relevantIssues = currentIssues.filter((issue) => issueMatchesPath(issue.path, path));
		container.classList.toggle('has-errors', relevantIssues.length > 0);
		if (container.tagName === 'INC-FIELD') {
			container.toggleAttribute('invalid', relevantIssues.length > 0);
		}
		const control = container.classList.contains('list-row') ? container.querySelector<HTMLElement>('input, textarea, select') : null;
		if (control) {
			control.classList.toggle('is-invalid', relevantIssues.length > 0);
			if (relevantIssues.length > 0) {
				control.setAttribute('aria-invalid', 'true');
			} else if (control.getAttribute('aria-invalid') === 'true') {
				control.removeAttribute('aria-invalid');
			}
		}

		const errorSlot = container.querySelector<HTMLElement>('[data-validation-slot="errors"]');
		if (!errorSlot) {
			continue;
		}

		errorSlot.replaceChildren();
		for (const issue of relevantIssues) {
			const line = document.createElement('div');
			line.textContent = issue.message;
			errorSlot.append(line);
		}
	}
}

function syncExpandedCardPathsFromDom(): void {
	const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-card-path]'));
	if (cards.length === 0) {
		return;
	}

	for (const card of cards) {
		const cardPath = card.dataset.cardPath;
		if (cardPath && card.hasAttribute('open')) {
			expandedCardPaths.add(cardPath);
		}
	}
}

function isCardExpanded(cardPath: string): boolean {
	return expandedCardPaths.has(cardPath);
}

function setCardExpanded(cardPath: string, isOpen: boolean): void {
	if (isOpen) {
		expandedCardPaths.add(cardPath);
	} else {
		expandedCardPaths.delete(cardPath);
	}
}

function forceCardOpenAfterRender(cardPath: string): void {
	window.setTimeout(() => {
		const card = findCardByPath(cardPath);
		if (!card) {
			return;
		}

		if (!card.hasAttribute('open')) {
			card.setAttribute('open', '');
		}

		setCardExpanded(cardPath, true);
		persistWebviewState();
	}, 0);
}

function flushPendingRevealCards(): void {
	if (pendingRevealCardPaths.size === 0) {
		return;
	}

	const cardPaths = Array.from(pendingRevealCardPaths);
	let selectedRequirementPath: string | undefined;
	for (const cardPath of cardPaths) {
		if (cardPath.startsWith('requirements[') && currentDocument) {
			const requirementIndex = parseRequirementIndex(cardPath);
			const requirement = currentDocument.requirements?.[requirementIndex];
			if (requirement) {
				pendingRevealCardPaths.delete(cardPath);
				setCoverageRequirementSelectionKey(coverageSelectionKeyForRequirement(requirement, requirementIndex));
				currentRequirementViewMode = 'detail';
				selectedRequirementPath = cardPath;
				continue;
			}
		}

		const card = findCardByPath(cardPath);
		if (!card) {
			continue;
		}

		pendingRevealCardPaths.delete(cardPath);
		if (!card.hasAttribute('open')) {
			card.setAttribute('open', '');
		}

		setCardExpanded(cardPath, true);
		persistWebviewState();
		card.scrollIntoView({ behavior: 'smooth', block: 'center' });
		const summary = card.querySelector<HTMLElement>('[slot="summary"], summary');
		summary?.focus?.();
	}

	if (selectedRequirementPath) {
		renderEditor();
		refreshChrome();
		renderValidationState();
		window.setTimeout(() => {
			const row = findCardByPath(selectedRequirementPath!);
			row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			const focusTarget = row?.querySelector<HTMLElement>('.requirement-index-row')
				?? document.getElementById('selected-requirement-title')
				?? row;
			focusTarget?.focus?.();
		}, 0);
		return;
	}

	if (pendingRevealCardPaths.size > 0) {
		window.setTimeout(flushPendingRevealCards, 50);
	}
}

function findCardByPath(cardPath: string): HTMLElement | null {
	const escapedPath = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
		? CSS.escape(cardPath)
		: cardPath.replace(/["\\]/g, '\\$&');

	return document.querySelector<HTMLElement>(`[data-card-path="${escapedPath}"]`);
}

function persistWebviewState(): void {
	if (!currentDocument) {
		return;
	}

	vscode.setState({
		document: cloneSpecificationDocument(currentDocument),
		issues: currentIssues,
		isDirty: currentDirty,
		externalConflict: currentExternalConflict,
		lastCommittedSerialized,
		expandedCardPaths: Array.from(expandedCardPaths),
		coverageRequirementSelectionKey,
		requirementsViewMode: currentRequirementViewMode,
		requirementSearchQuery,
		requirementIndexFilter
	} satisfies SpecificationEditorWebviewState);
}

function commitCurrentDocument(force = false): void {
	if (!currentDocument) {
		return;
	}

	const serialized = serializeSpecificationDocument(currentDocument);
	if (!force && serialized === lastCommittedSerialized) {
		refreshChrome();
		renderValidationState();
		return;
	}

	currentIssues = validateSpecificationDocument(currentDocument);
	currentDirty = true;
	lastCommittedSerialized = serialized;
	persistWebviewState();
	void vscode.postMessage({
		type: 'edit',
		document: cloneSpecificationDocument(currentDocument)
	});
	refreshChrome();
	renderValidationState();
}

function issueMatchesPath(issuePath: string, path: string): boolean {
	if (path.length === 0) {
		return true;
	}

	return issuePath === path || issuePath.startsWith(`${path}.`) || issuePath.startsWith(`${path}[`);
}

function ensureEditableDocument(): void {
	if (!currentDocument) {
		throw new Error('Specification document is not available.');
	}
}

function normalizeEditableDocument(document: SpecificationDocument): SpecificationDocument {
	const normalized = cloneSpecificationDocument(document);
	normalized.artifact_id = stringValue(normalized.artifact_id);
	normalized.artifact_type = stringValue(normalized.artifact_type) || 'specification';
	normalized.title = stringValue(normalized.title);
	normalized.domain = stringValue(normalized.domain);
	normalized.capability = stringValue(normalized.capability);
	normalized.status = stringValue(normalized.status);
	normalized.owner = stringValue(normalized.owner);
	normalized.purpose = stringValue(normalized.purpose);
	normalized.scope = stringValue(normalized.scope);
	normalized.context = stringValue(normalized.context);
	normalized.tags = normalizeStringArray(normalized.tags);
	normalized.related_artifacts = normalizeStringArray(normalized.related_artifacts);
	normalized.open_questions = normalizeStringArray(normalized.open_questions);
	normalized.supplemental_sections = normalizeStringArray(normalized.supplemental_sections);
	normalized.requirements = Array.isArray(normalized.requirements)
		? (normalized.requirements as unknown[]).map((requirement: unknown) => normalizeRequirement(requirement))
		: [];
	return normalized;
}

function normalizeRequirement(requirement: unknown): SpecificationRequirement {
	if (!isPlainObject(requirement)) {
		return createEmptyRequirement();
	}

	const normalized = cloneSpecificationDocument(requirement as SpecificationRequirement);
	normalized.id = stringValue(normalized.id);
	normalized.title = stringValue(normalized.title);
	normalized.statement = stringValue(normalized.statement);
	normalized.coverage = normalizeStringArray(normalized.coverage);
	normalized.trace = normalizeStringArray(normalized.trace);
	normalized.notes = normalizeStringArray(normalized.notes);
	return normalized;
}

function normalizeStringArray(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.map((item) => (typeof item === 'string' ? item : ''));
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequirementIndex(requirementPath: string): number {
	const match = /^requirements\[(\d+)\]$/.exec(requirementPath);
	return match ? Number(match[1]) : -1;
}

function setPropertyValue(path: string, value: string): void {
	ensureEditableDocument();
	if (Object.prototype.hasOwnProperty.call(currentDocument!, path)) {
		(currentDocument as Record<string, unknown>)[path] = value;
	}
}

function setRequirementField(
	requirement: SpecificationRequirement,
	fieldName: 'id' | 'title' | 'statement' | 'coverage' | 'trace' | 'notes',
	value: string
): void {
	switch (fieldName) {
		case 'id':
		case 'title':
		case 'statement':
			requirement[fieldName] = value;
			return;
		case 'coverage':
		case 'trace':
		case 'notes':
			requirement[fieldName] = value.length === 0 ? [] : [value];
			return;
		default:
			requirement[fieldName] = value;
	}
}

function getRequirementArray(requirement: SpecificationRequirement, fieldName: 'coverage' | 'trace' | 'notes'): string[] {
	switch (fieldName) {
		case 'coverage':
			requirement.coverage = requirement.coverage ?? [];
			return requirement.coverage;
		case 'trace':
			requirement.trace = requirement.trace ?? [];
			return requirement.trace;
		case 'notes':
			requirement.notes = requirement.notes ?? [];
			return requirement.notes;
	}
}

function getTopLevelArray(fieldName: TopLevelListField): string[] {
	ensureEditableDocument();
	switch (fieldName) {
		case 'tags':
			currentDocument!.tags = currentDocument!.tags ?? [];
			return currentDocument!.tags;
		case 'related_artifacts':
			currentDocument!.related_artifacts = currentDocument!.related_artifacts ?? [];
			return currentDocument!.related_artifacts;
		case 'open_questions':
			currentDocument!.open_questions = currentDocument!.open_questions ?? [];
			return currentDocument!.open_questions;
		case 'supplemental_sections':
			currentDocument!.supplemental_sections = currentDocument!.supplemental_sections ?? [];
			return currentDocument!.supplemental_sections;
	}

	throw new Error(`Unsupported top-level list field: ${fieldName}`);
}

function moveRequirement(currentIndex: number, targetIndex: number): void {
	ensureEditableDocument();
	const requirements = currentDocument!.requirements ?? [];
	if (targetIndex < 0 || targetIndex >= requirements.length) {
		return;
	}

	const currentSelection = resolveCoverageRequirementSelection(requirements);
	const selectedRequirement = currentSelection.index >= 0 ? requirements[currentSelection.index] : undefined;
	moveArrayItem(requirements, currentIndex, targetIndex);
	if (selectedRequirement) {
		const nextSelectionIndex = requirements.indexOf(selectedRequirement);
		if (nextSelectionIndex >= 0) {
			setCoverageRequirementSelectionKey(coverageSelectionKeyForRequirement(selectedRequirement, nextSelectionIndex));
		}
	}
	commitCurrentDocument(true);
	renderEditor();
	refreshChrome();
	renderValidationState();
}

function removeRequirement(index: number): void {
	ensureEditableDocument();
	currentDocument!.requirements = currentDocument!.requirements ?? [];
	const requirements = currentDocument!.requirements;
	const currentSelection = resolveCoverageRequirementSelection(requirements);
	const selectedRequirement = currentSelection.index >= 0 ? requirements[currentSelection.index] : undefined;
	requirements.splice(index, 1);
	if (requirements.length === 0) {
		setCoverageRequirementSelectionKey('');
		currentRequirementViewMode = 'index';
	} else if (selectedRequirement && requirements.includes(selectedRequirement)) {
		const nextSelectionIndex = requirements.indexOf(selectedRequirement);
		setCoverageRequirementSelectionKey(coverageSelectionKeyForRequirement(selectedRequirement, nextSelectionIndex));
	} else {
		const nextSelectionIndex = Math.min(index, requirements.length - 1);
		setCoverageRequirementSelectionKey(coverageSelectionKeyForRequirement(requirements[nextSelectionIndex], nextSelectionIndex));
	}
	commitCurrentDocument(true);
	renderEditor();
	refreshChrome();
	renderValidationState();
}

function moveArrayItem<T extends string | SpecificationRequirement>(items: T[], currentIndex: number, targetIndex: number): void {
	if (targetIndex < 0 || targetIndex >= items.length) {
		return;
	}

	const [item] = items.splice(currentIndex, 1);
	items.splice(targetIndex, 0, item);
}

function removeArrayItem<T extends string | SpecificationRequirement>(items: T[], index: number): void {
	if (index < 0 || index >= items.length) {
		return;
	}

	items.splice(index, 1);
	commitCurrentDocument(true);
	renderEditor();
	refreshChrome();
	renderValidationState();
}
