/// <reference lib="dom" />

import '@incursa/ui-kit/web-components/style.css';
import '@incursa/ui-kit/web-components';

import {
	cloneSpecificationDocument,
	createEmptyRequirement,
	serializeSpecificationDocument,
	summarizeRequirementCoverage,
	summarizeSpecificationCoverage,
	RequirementCoverageExpectation,
	RequirementTrace,
	SpecificationDocument,
	SpecificationRequirement,
	SupplementalSection,
	ValidationIssue
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
	requirementSortKey?: RequirementSortKey;
	requirementSortDirection?: RequirementSortDirection;
	requirementCompactRows?: boolean;
	expandedRequirementRowPaths?: string[];
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
let requirementSortKey: RequirementSortKey = 'file';
let requirementSortDirection: RequirementSortDirection = 'asc';
let requirementCompactRows = true;
let expandedRequirementRowPaths = new Set<string>();

const statusOptions = ['draft', 'review', 'approved', 'active', 'deprecated', 'archived'];
type TopLevelListField = 'tags' | 'related_artifacts' | 'open_questions';
type RequirementViewMode = 'index' | 'view' | 'edit';
type RequirementIndexFilter = 'all' | 'issues' | 'missing' | 'partial' | 'covered';
type RequirementSortKey = 'file' | 'id' | 'title';
type RequirementSortDirection = 'asc' | 'desc';
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
	currentIssues = persistedState.issues ?? [];
	currentDirty = persistedState.isDirty ?? false;
	currentExternalConflict = persistedState.externalConflict ?? false;
	lastCommittedSerialized = persistedState.lastCommittedSerialized ?? serializeSpecificationDocument(currentDocument);
	expandedCardPaths = new Set(persistedState.expandedCardPaths ?? []);
	coverageRequirementSelectionKey = persistedState.coverageRequirementSelectionKey ?? '';
	currentRequirementViewMode = persistedState.requirementsViewMode ?? 'index';
	requirementSearchQuery = persistedState.requirementSearchQuery ?? '';
	requirementIndexFilter = persistedState.requirementIndexFilter ?? 'all';
	requirementSortKey = persistedState.requirementSortKey ?? 'file';
	requirementSortDirection = persistedState.requirementSortDirection ?? 'asc';
	requirementCompactRows = persistedState.requirementCompactRows ?? true;
	expandedRequirementRowPaths = new Set(persistedState.expandedRequirementRowPaths ?? []);
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
	return currentRequirementViewMode !== 'index' && (currentDocument?.requirements?.length ?? 0) > 0;
}

function shouldRenderRequirementEdit(): boolean {
	return currentRequirementViewMode === 'edit';
}

function shouldRenderRequirementView(): boolean {
	return currentRequirementViewMode === 'view';
}

function ensureRequirementViewMode(): void {
	if ((currentDocument?.requirements?.length ?? 0) === 0) {
		currentRequirementViewMode = 'index';
		return;
	}

	if (!['index', 'view', 'edit'].includes(currentRequirementViewMode)) {
		currentRequirementViewMode = 'view';
	}
}

function ensureRequirementIndexState(): void {
	if (!requirementIndexFilters.includes(requirementIndexFilter)) {
		requirementIndexFilter = 'all';
	}

	if (typeof requirementSearchQuery !== 'string') {
		requirementSearchQuery = '';
	}

	if (!['file', 'id', 'title'].includes(requirementSortKey)) {
		requirementSortKey = 'file';
	}

	if (!['asc', 'desc'].includes(requirementSortDirection)) {
		requirementSortDirection = 'asc';
	}

	if (typeof requirementCompactRows !== 'boolean') {
		requirementCompactRows = true;
	}
}

function addRequirementAndOpenEditor(): void {
	ensureEditableDocument();
	currentDocument!.requirements = currentDocument!.requirements ?? [];
	pendingOpenRequirementIndex = currentDocument!.requirements.length;
	currentDocument!.requirements.push(createEmptyRequirement());
	setCoverageRequirementSelectionKey(`index:${pendingOpenRequirementIndex}`);
	currentRequirementViewMode = 'edit';
	commitCurrentDocument(true);
	renderEditor();
	refreshChrome();
	renderValidationState();
}

function openRequirementByIndex(index: number, mode: Exclude<RequirementViewMode, 'index'> = 'view'): void {
	if (!currentDocument) {
		return;
	}

	const requirement = currentDocument.requirements?.[index];
	if (!requirement) {
		return;
	}

	setCoverageRequirementSelectionKey(coverageSelectionKeyForRequirement(requirement, index));
	currentRequirementViewMode = mode;
	persistWebviewState();
}

function openRequirementViewByIndex(index: number): void {
	openRequirementByIndex(index, 'view');
}

function openRequirementEditorByIndex(index: number): void {
	openRequirementByIndex(index, 'edit');
}

function returnToRequirementIndex(): void {
	currentRequirementViewMode = 'index';
	persistWebviewState();
}

function startEditingSelectedRequirement(): void {
	if (!currentDocument?.requirements?.length) {
		return;
	}

	currentRequirementViewMode = 'edit';
	persistWebviewState();
}

function returnToRequirementView(): void {
	if (!currentDocument?.requirements?.length) {
		currentRequirementViewMode = 'index';
	} else {
		currentRequirementViewMode = 'view';
	}
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

function setRequirementSortKey(sortKey: RequirementSortKey): void {
	requirementSortKey = sortKey;
	persistWebviewState();
}

function toggleRequirementSortDirection(): void {
	requirementSortDirection = requirementSortDirection === 'asc' ? 'desc' : 'asc';
	persistWebviewState();
}

function toggleRequirementCompactRows(): void {
	requirementCompactRows = !requirementCompactRows;
	persistWebviewState();
}

function isRequirementRowExpanded(path: string): boolean {
	return expandedRequirementRowPaths.has(path);
}

function toggleRequirementRowExpanded(path: string): void {
	if (expandedRequirementRowPaths.has(path)) {
		expandedRequirementRowPaths.delete(path);
	} else {
		expandedRequirementRowPaths.add(path);
	}
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

	openRequirementByIndex(nextIndex, shouldRenderRequirementEdit() ? 'edit' : 'view');
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
	if (currentIssues.length > 0) {
		body.append(createValidationSummaryCard());
	}
	body.append(createRequirementsCard(autoOpenRequirementIndex));

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
			createSupplementalSectionsCard(
				'Supplemental sections',
				'Structured supporting sections with a heading and longer content block.',
				currentDocument?.supplemental_sections ?? []
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
	header.className = 'editor-hero';
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
	if (shouldRenderRequirementEdit()) {
		actionsSlot.append(
			createActionButton('Save', 'Save the current specification', () => {
				void vscode.postMessage({ type: 'save' });
			}, { variant: 'primary' })
		);
	}
	actionsSlot.append(
		createActionButton('Open JSON', 'Open the same file in the text editor', () => {
			void vscode.postMessage({ type: 'openText' });
		}, { variant: 'outline-secondary' })
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

function createInfoHint(helpText: string, label = 'More information'): HTMLElement {
	const hint = document.createElement('span');
	hint.className = 'info-hint';
	hint.tabIndex = 0;
	hint.title = helpText;
	hint.setAttribute('aria-label', `${label}. ${helpText}`);
	hint.textContent = 'i';
	return hint;
}

function getCoverageStatusExplanation(status: ReturnType<typeof summarizeRequirementCoverage>['status']): string {
	switch (status) {
		case 'covered':
			return 'Covered requirements define one or more coverage expectation fields.';
		case 'partial':
			return 'Partial requirements have trace links or notes, but no coverage expectation fields yet.';
		case 'missing':
			return 'Missing requirements have no coverage expectations, trace links, or notes yet.';
	}
}

function getCoverageDefinitionsHelpText(): string {
	return [
		getCoverageStatusExplanation('covered'),
		getCoverageStatusExplanation('partial'),
		getCoverageStatusExplanation('missing')
	].join(' ');
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
	meta.className = 'inc-text inc-text--small inc-text--muted hero-status-strip__meta';
	const metaText = document.createElement('span');
	metaText.id = 'coverage-meta-text';
	metaText.textContent = 'Add requirements to start tracking coverage.';
	meta.append(metaText, createInfoHint(getCoverageDefinitionsHelpText(), 'Coverage definitions'));

	strip.append(chips, meta);
	return strip;
}

function createCoverageSummaryChip(): HTMLElement {
	const badge = createBadge('No requirements', 'info', 'status-chip');
	badge.id = 'coverage-chip';
	badge.title = getCoverageDefinitionsHelpText();
	badge.setAttribute('aria-label', `Coverage summary. ${getCoverageDefinitionsHelpText()}`);
	return badge;
}

function createSummaryBlock(title: string, body: HTMLElement, infoTitle?: string): HTMLElement {
	const block = document.createElement('inc-summary-block');
	block.setAttribute('tone', 'info');

	const header = document.createElement('div');
	header.slot = 'header';
	header.className = 'summary-block__header';
	const titleText = document.createElement('span');
	titleText.textContent = title;
	header.append(titleText);
	if (infoTitle) {
		header.append(createInfoHint(infoTitle, `${title} definition`));
	}

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
		createSummaryBlock('Covered', createCoverageMetric(String(summary.coveredCount), 'requirements', 'success'), getCoverageStatusExplanation('covered')),
		createSummaryBlock('Partial', createCoverageMetric(String(summary.partialCount), 'requirements', 'warning'), getCoverageStatusExplanation('partial')),
		createSummaryBlock('Missing', createCoverageMetric(String(summary.missingCount), 'requirements', 'danger'), getCoverageStatusExplanation('missing'))
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
			'Read-only coverage expectations, trace links, and notes for the selected requirement.'
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
		createCoverageEvidenceDisclosure('Coverage', requirement.coverage, 'No coverage expectations have been recorded yet.', requirementIndex, 'coverage'),
		createCoverageEvidenceDisclosure('Trace', requirement.trace, 'No trace links have been recorded yet.', requirementIndex, 'trace'),
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
		createReadonlyField('Coverage fields', String(coverageSummary.coverageCount), undefined, 'coverage-selected-coverage-count'),
		createReadonlyField('Trace refs', String(coverageSummary.traceCount), undefined, 'coverage-selected-trace-count'),
		createReadonlyField('Notes entries', String(coverageSummary.notesCount), undefined, 'coverage-selected-notes-count')
	);

	return grid;
}

function createCoverageEvidenceDisclosure(
	title: string,
	value: unknown,
	emptyMessage: string,
	requirementIndex: number,
	fieldName: 'coverage' | 'trace' | 'notes'
): HTMLElement {
	const body = document.createElement('div');
	body.className = 'coverage-evidence-body';
	body.append(renderReadonlyStructuredValue(value, emptyMessage, `requirements[${requirementIndex}].${fieldName}`));

	return createCollapsibleCard(
		title,
		`${countStructuredValueEntries(value)} item${countStructuredValueEntries(value) === 1 ? '' : 's'}`,
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

function createSupplementalSectionsCard(title: string, description: string, items: SupplementalSection[]): HTMLElement {
	const body = createSupplementalSectionsEditor(items, description);
	const itemLabel = items.length === 1 ? '1 section' : `${items.length} sections`;
	return createCollapsibleCard(
		title,
		itemLabel,
		body,
		{
			className: 'supplemental_sections-card',
			validationPath: 'supplemental_sections',
			cardPath: 'supplemental_sections',
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
	if (shouldRenderRequirementDetail()) {
		header.append(
			createSectionHeading(
				'Requirements',
				shouldRenderRequirementEdit()
					? 'Requirement editing with the rest of the document chrome out of the way.'
					: 'Read-only requirement details with a separate step for editing.'
			)
		);
	}

	const actions = createButtonToolbar('Requirement actions', 'section-actions');
	actions.slot = 'actions';
	if (shouldRenderRequirementDetail()) {
		const backLabel = shouldRenderRequirementEdit() ? 'Back to details' : 'Back to requirements';
		const backTitle = shouldRenderRequirementEdit()
			? 'Return to the read-only requirement details page'
			: 'Return to the requirements index';
		actions.append(
			createActionButton(backLabel, backTitle, () => {
				if (shouldRenderRequirementEdit()) {
					returnToRequirementView();
				} else {
					returnToRequirementIndex();
				}
				renderEditor();
				refreshChrome();
				renderValidationState();
			}, { variant: 'outline-secondary' })
		);
	}

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = shouldRenderRequirementDetail() ? 'requirements-screen requirements-screen--detail' : 'requirements-screen requirements-screen--index';

	const requirements = currentDocument?.requirements ?? [];
	const selection = resolveCoverageRequirementSelection(requirements);

	if (shouldRenderRequirementEdit()) {
		body.append(createRequirementEditCard(requirements, selection), createErrorRegion());
	} else if (shouldRenderRequirementView()) {
		body.append(createRequirementViewCard(requirements, selection), createErrorRegion());
	} else {
		body.append(createRequirementsIndexCard(requirements, selection), createErrorRegion());
	}

	if (shouldRenderRequirementDetail()) {
		section.append(header, actions, body);
	} else {
		section.append(body);
	}
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
	header.className = 'card-header-row';
	header.append(
		createSectionHeading(
			'Requirement index',
			requirements.length === 0
				? 'Add a requirement to start building the specification.'
				: `${requirements.length} requirement${requirements.length === 1 ? '' : 's'} ready to scan. Open one when you need to edit it.`,
			getCoverageDefinitionsHelpText()
		),
		createCardHeaderActions(
			'Requirement index actions',
			createActionButton('Add requirement', 'Add a new requirement record', () => {
				addRequirementAndOpenEditor();
			}, { variant: 'secondary', size: 'sm' })
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
	const visibleEntries = getVisibleRequirementIndexEntries(entries);
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

function getVisibleRequirementIndexEntries(entries: RequirementIndexEntry[]): RequirementIndexEntry[] {
	return filterRequirementIndexEntries(entries).sort(compareRequirementIndexEntries);
}

function compareRequirementIndexEntries(left: RequirementIndexEntry, right: RequirementIndexEntry): number {
	let result = 0;
	if (requirementSortKey === 'file') {
		result = left.index - right.index;
	} else if (requirementSortKey === 'id') {
		result = compareRequirementIndexText(getRequirementIdLabel(left), getRequirementIdLabel(right));
	} else {
		result = compareRequirementIndexText(getRequirementTitleLabel(left), getRequirementTitleLabel(right));
	}

	if (result === 0) {
		result = left.index - right.index;
	}

	return requirementSortDirection === 'asc' ? result : -result;
}

function compareRequirementIndexText(left: string, right: string): number {
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function getRequirementIdLabel(entry: RequirementIndexEntry): string {
	return stringValue(entry.requirement.id).trim() || `Requirement ${entry.index + 1}`;
}

function getRequirementTitleLabel(entry: RequirementIndexEntry): string {
	return stringValue(entry.requirement.title).trim() || 'Untitled requirement';
}

function getRequirementSortKeyLabel(sortKey: RequirementSortKey): string {
	switch (sortKey) {
		case 'id':
			return 'ID';
		case 'title':
			return 'Title';
		default:
			return 'File order';
	}
}

function getRequirementSortDirectionLabel(direction: RequirementSortDirection): string {
	return direction === 'asc' ? 'Ascending' : 'Descending';
}

function getRequirementSortDirectionButtonLabel(direction: RequirementSortDirection): string {
	return direction === 'asc' ? 'Asc' : 'Desc';
}

function createToolbarLabel(text: string, infoTitle?: string): HTMLElement {
	const label = document.createElement('div');
	label.className = 'requirement-toolbar-label inc-text inc-text--small inc-text--muted';

	const labelText = document.createElement('span');
	labelText.textContent = text;
	label.append(labelText);

	if (infoTitle) {
		label.append(createInfoHint(infoTitle, `${text} help`));
	}

	return label;
}

function createRequirementToolbarPanel(title: string, helpText: string, ...children: HTMLElement[]): HTMLElement {
	const panel = document.createElement('div');
	panel.className = 'requirement-toolbar-panel';

	const header = document.createElement('div');
	header.className = 'requirement-toolbar-panel__header';
	header.append(createToolbarLabel(title, helpText));

	const body = document.createElement('div');
	body.className = 'requirement-toolbar-panel__body';
	body.append(...children);

	panel.append(header, body);
	return panel;
}

function createTriangleIcon(direction: 'right' | 'down' | 'up'): SVGSVGElement {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(namespace, 'svg');
	svg.setAttribute('viewBox', '0 0 12 12');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('inline-triangle-icon', `inline-triangle-icon--${direction}`);

	const path = document.createElementNS(namespace, 'path');
	if (direction === 'right') {
		path.setAttribute('d', 'M4 2.5 8.5 6 4 9.5Z');
	} else if (direction === 'down') {
		path.setAttribute('d', 'M2.5 4 6 8.5 9.5 4Z');
	} else {
		path.setAttribute('d', 'M2.5 8 6 3.5 9.5 8Z');
	}
	path.setAttribute('fill', 'currentColor');
	svg.append(path);
	return svg;
}

function applyTriangleLabel(button: HTMLElement, direction: 'up' | 'down', text: string): void {
	const label = document.createElement('span');
	label.className = 'triangle-button-label';
	label.textContent = text;
	button.replaceChildren(createTriangleIcon(direction), label);
}

function createRequirementSearchControl(): HTMLElement {
	const input = document.createElement('input');
	input.id = 'requirement-search-input';
	input.type = 'search';
	input.className = 'inc-form__control requirement-index-search-input';
	input.placeholder = 'Search id, title, or statement';
	input.value = requirementSearchQuery;
	input.setAttribute('aria-label', 'Search requirements');
	input.addEventListener('input', () => {
		const selectionStart = input.selectionStart ?? input.value.length;
		const selectionEnd = input.selectionEnd ?? selectionStart;
		setRequirementSearchQuery(input.value);
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

	return input;
}

function createRequirementSortSelect(): HTMLSelectElement {
	const select = document.createElement('select');
	select.className = 'inc-form__select requirement-index-sort-select';
	select.setAttribute('aria-label', 'Sort requirements by');

	[
		{ value: 'file', label: 'File order' },
		{ value: 'id', label: 'Requirement ID' },
		{ value: 'title', label: 'Title' }
	].forEach((option) => {
		const optionNode = document.createElement('option');
		optionNode.value = option.value;
		optionNode.textContent = option.label;
		select.append(optionNode);
	});

	select.value = requirementSortKey;
	select.addEventListener('change', () => {
		setRequirementSortKey(select.value as RequirementSortKey);
		renderEditor();
		refreshChrome();
		renderValidationState();
	});

	return select;
}

function createCompactRowsSwitch(): HTMLElement {
	const wrapper = document.createElement('div');
	wrapper.className = 'requirement-density-switch';

	const choice = document.createElement('div');
	choice.className = 'inc-form__check inc-form__switch requirement-density-switch__choice';

	const input = document.createElement('input');
	input.id = 'requirement-collapsed-rows';
	input.type = 'checkbox';
	input.className = 'inc-form__check-input';
	input.checked = requirementCompactRows;
	input.setAttribute('aria-label', 'Toggle collapsed requirement rows');
	input.addEventListener('change', () => {
		toggleRequirementCompactRows();
		renderEditor();
		refreshChrome();
		renderValidationState();
	});

	const label = document.createElement('label');
	label.className = 'inc-form__check-label';
	label.htmlFor = input.id;
	label.textContent = 'Collapsed rows';
	label.title = requirementCompactRows
		? 'Collapsed rows are on. Use the chevron to expand a row inline.'
		: 'Collapsed rows are off. Each row stays fully open.';

	choice.append(input, label);
	wrapper.append(choice);
	return wrapper;
}

function createRequirementIndexToolbar(totalCount: number, visibleCount: number): HTMLElement {
	const toolbar = document.createElement('div');
	toolbar.className = 'requirement-index-toolbar';

	const searchControl = createRequirementSearchControl();

	const filters = createButtonGroup('Requirement index filters', 'requirement-index-filter-group');
	for (const filter of requirementIndexFilters) {
		filters.append(createRequirementFilterButton(filter));
	}

	const filterGroup = document.createElement('div');
	filterGroup.className = 'requirement-toolbar-group';
	filterGroup.append(
		createToolbarLabel('Status filters', getCoverageDefinitionsHelpText()),
		filters
	);

	const sortControls = document.createElement('div');
	sortControls.className = 'requirement-index-sort-controls';

	const sortSelect = createRequirementSortSelect();

	const directionLabel = getRequirementSortDirectionLabel(requirementSortDirection);
	const directionButton = createActionButton(
		getRequirementSortDirectionButtonLabel(requirementSortDirection),
		`Sort direction is currently ${directionLabel.toLowerCase()}. Click to toggle.`,
		() => {
			toggleRequirementSortDirection();
			renderEditor();
			refreshChrome();
			renderValidationState();
		},
		{
			variant: 'outline-secondary',
			size: 'sm'
		}
	);
	applyTriangleLabel(directionButton, requirementSortDirection === 'asc' ? 'up' : 'down', getRequirementSortDirectionButtonLabel(requirementSortDirection));

	sortControls.append(directionButton, createCompactRowsSwitch());

	const sortGroup = document.createElement('div');
	sortGroup.className = 'requirement-toolbar-group';
	sortGroup.append(
		createToolbarLabel('Sort by'),
		sortSelect,
		sortControls
	);

	const meta = document.createElement('div');
	meta.className = 'inc-text inc-text--small inc-text--muted requirement-index-results';
	const countText = visibleCount === totalCount
		? `${totalCount} requirement${totalCount === 1 ? '' : 's'} shown`
		: `${visibleCount} of ${totalCount} requirement${totalCount === 1 ? '' : 's'} shown`;
	meta.textContent = `${countText} · ${getRequirementSortKeyLabel(requirementSortKey)} ${getRequirementSortDirectionLabel(requirementSortDirection).toLowerCase()}`;

	const findPanel = createRequirementToolbarPanel(
		'Find and filter',
		'Search by requirement ID, title, or statement, then narrow the list by status.',
		searchControl,
		filterGroup
	);

	const sortPanel = document.createElement('div');
	sortPanel.className = 'requirement-toolbar-panel';
	sortPanel.append(sortGroup);

	toolbar.append(findPanel, sortPanel, meta);
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

	const descriptions: Record<RequirementIndexFilter, string> = {
		all: 'Show every requirement in the file.',
		issues: 'Show only requirements with validation issues.',
		missing: getCoverageStatusExplanation('missing'),
		partial: getCoverageStatusExplanation('partial'),
		covered: getCoverageStatusExplanation('covered')
	};

	return createActionButton(
		labels[filter],
		descriptions[filter],
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
	const row = document.createElement('div');
	row.className = 'inc-list-group__item requirement-index-row';
	row.dataset.validationPath = path;
	row.dataset.cardPath = path;
	row.dataset.requirementRowPath = path;
	const isSelected = selection.index === index;
	if (isSelected) {
		row.classList.add('active');
	}
	if (issueCount > 0) {
		row.classList.add('requirement-index-row--warning');
	}
	if (requirementCompactRows) {
		row.classList.add('requirement-index-row--compact');
	}
	if (isRequirementRowExpanded(path)) {
		row.classList.add('requirement-index-row--expanded');
	}
	row.addEventListener('click', (event) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest('.requirement-index-expand') || target?.closest('.requirement-index-open-button')) {
			return;
		}

		openRequirementViewByIndex(index);
		renderEditor();
		refreshChrome();
		renderValidationState();
	});

	const rowHeader = document.createElement('div');
	rowHeader.className = 'requirement-index-header';

	if (requirementCompactRows) {
		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.className = 'inc-btn inc-btn--outline-secondary inc-btn--micro requirement-index-expand';
		toggle.title = isRequirementRowExpanded(path) ? 'Collapse row' : 'Expand row';
		toggle.setAttribute('aria-expanded', isRequirementRowExpanded(path) ? 'true' : 'false');
		toggle.setAttribute('aria-label', `${isRequirementRowExpanded(path) ? 'Collapse' : 'Expand'} ${getRequirementIdLabel(entry)}`);
		toggle.append(createTriangleIcon(isRequirementRowExpanded(path) ? 'down' : 'right'));
		toggle.addEventListener('click', (event) => {
			event.stopPropagation();
			toggleRequirementRowExpanded(path);
			renderEditor();
			refreshChrome();
			renderValidationState();
		});
		rowHeader.append(toggle);
	}

	const summaryCopy = document.createElement('span');
	summaryCopy.className = 'requirement-summary-copy';
	summaryCopy.dataset.requirementSummaryPath = path;

	const summaryLine = document.createElement('span');
	summaryLine.className = 'requirement-summary-line';

	const summaryIdentifier = document.createElement('span');
	summaryIdentifier.className = 'requirement-summary-id';
	summaryIdentifier.textContent = getRequirementIdLabel(entry);

	const summaryTitle = document.createElement('span');
	summaryTitle.className = 'requirement-summary-title';
	summaryTitle.textContent = getRequirementTitleLabel(entry);

	summaryLine.append(summaryIdentifier, summaryTitle);
	summaryCopy.append(summaryLine);
	if (!requirementCompactRows || isRequirementRowExpanded(path)) {
		const summaryDescription = document.createElement('span');
		summaryDescription.className = 'requirement-summary-statement';
		summaryDescription.textContent = stringValue(requirement.statement).trim() || 'Add the requirement statement.';
		summaryCopy.append(summaryDescription);
	}

	const meta = document.createElement('span');
	meta.className = 'requirement-index-meta';
	meta.dataset.requirementMetaPath = path;

	const coverageBadge = createBadge(
		formatCoverageStatusLabel(coverageSummary.status),
		formatCoverageStatusTone(coverageSummary.status),
		'requirement-summary-state'
	);
	coverageBadge.dataset.coveragePath = path;
	coverageBadge.title = getCoverageStatusExplanation(coverageSummary.status);
	coverageBadge.setAttribute('aria-label', `${formatCoverageStatusLabel(coverageSummary.status)}. ${getCoverageStatusExplanation(coverageSummary.status)}`);
	meta.append(coverageBadge);

	if (issueCount > 0) {
		const issuesBadge = createRequirementIssueBadge(path, issueCount, true);
		meta.append(issuesBadge);
	}

	if (!requirementCompactRows || isRequirementRowExpanded(path)) {
		const evidence = document.createElement('span');
		evidence.className = 'inc-text inc-text--small inc-text--muted requirement-index-evidence';
		evidence.dataset.requirementEvidencePath = path;
		evidence.textContent = formatRequirementEvidenceSummary(coverageSummary);
		meta.append(evidence);
	}

	const openButton = document.createElement('button');
	openButton.type = 'button';
	openButton.className = 'requirement-index-open';
	openButton.setAttribute('aria-label', `Open details for ${getRequirementIdLabel(entry)}`);
	openButton.append(summaryCopy, meta);

	const explicitOpenButton = createActionButton(
		'Open',
		`Open details for ${getRequirementIdLabel(entry)}`,
		() => {
			openRequirementViewByIndex(index);
			renderEditor();
			refreshChrome();
			renderValidationState();
		},
		{ variant: 'outline-secondary', size: 'sm' }
	);
	explicitOpenButton.classList.add('requirement-index-open-button');
	explicitOpenButton.addEventListener('click', (event) => {
		event.stopPropagation();
	});

	rowHeader.append(openButton, explicitOpenButton);
	row.append(rowHeader);
	return row;
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

function createRequirementViewCard(
	requirements: SpecificationRequirement[],
	selection: CoverageSelection
): HTMLElement {
	const detail = document.createElement('inc-card');
	detail.className = 'requirement-detail-card';

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = 'requirement-detail-body';

	if (selection.index < 0 || !requirements[selection.index]) {
		body.append(createCard('Select a requirement', 'Choose a row from the requirement table to inspect its details.'));
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
		createActionButton(
			'Edit requirement',
			'Switch to requirement editing',
			() => {
				startEditingSelectedRequirement();
				renderEditor();
				refreshChrome();
				renderValidationState();
			},
			{ variant: 'secondary', size: 'sm' }
		)
	);

	header.append(titleBlock, actions);

	body.append(
		createSelectedRequirementOverview(selection.index, requirements.length, coverageSummary, issueCount),
		createReadonlyRequirementField('Requirement id', stringValue(requirement.id).trim() || '—', 'Canonical requirement identifier.'),
		createReadonlyRequirementField('Title', stringValue(requirement.title).trim() || 'Untitled requirement'),
		createReadonlyRequirementField('Statement', stringValue(requirement.statement).trim() || 'No requirement statement recorded.', 'Normative statement text.', true),
		createRequirementEvidenceViewCard('Coverage', requirement.coverage, 'No coverage expectations recorded yet.'),
		createRequirementEvidenceViewCard('Trace', requirement.trace, 'No trace links recorded yet.'),
		createRequirementEvidenceViewCard('Notes', requirement.notes ?? [], 'No notes recorded yet.')
	);

	detail.append(header, body, createErrorRegion());
	return detail;
}

function createRequirementEditCard(
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
			'Open the previous requirement for editing',
			() => navigateRequirementByOffset(-1),
			{ variant: 'outline-secondary', size: 'sm', disabled: selection.index === 0 }
		),
		createActionButton(
			'Next',
			'Open the next requirement for editing',
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
		createRequirementListField(path, 'notes', 'Notes', requirement.notes ?? [], true, 'Note'),
		createRequirementEvidenceViewCard(
			'Coverage',
			requirement.coverage,
			'No coverage expectations recorded yet.',
			'Coverage is shown for reference here and is usually produced outside this editor.'
		),
		createRequirementEvidenceViewCard(
			'Trace',
			requirement.trace,
			'No trace links recorded yet.',
			'Trace is shown for reference here and is usually produced outside this editor.'
		)
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

function createReadonlyRequirementField(
	labelText: string,
	valueText: string,
	metaText?: string,
	wide = false
): HTMLElement {
	const field = createReadonlyField(labelText, valueText, metaText);
	field.classList.add('requirement-readonly-field');
	if (wide) {
		field.classList.add('wide');
	}
	return field;
}

function createRequirementEvidenceViewCard(
	title: string,
	value: unknown,
	emptyMessage: string,
	descriptionText?: string
): HTMLElement {
	const card = document.createElement('inc-card');
	card.className = 'requirement-readonly-evidence-card wide';

	const header = document.createElement('div');
	header.slot = 'header';
	header.append(
		createSectionHeading(
			title,
			descriptionText ?? (() => {
				const itemCount = countStructuredValueEntries(value);
				return itemCount === 0 ? emptyMessage : `${itemCount} item${itemCount === 1 ? '' : 's'} recorded.`;
			})()
		)
	);

	const body = document.createElement('div');
	body.slot = 'body';
	body.className = 'coverage-evidence-body';
	body.append(renderReadonlyStructuredValue(value, emptyMessage));

	card.append(header, body);
	return card;
}

function renderReadonlyStructuredValue(value: unknown, emptyMessage: string, pathPrefix?: string): HTMLElement {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return createReadonlyEmptyState(emptyMessage);
		}

		const list = document.createElement('inc-list-group');
		list.setAttribute('dense', '');
		list.className = 'coverage-evidence-list';
		value.forEach((item, index) => {
			const entry = document.createElement('div');
			entry.textContent = typeof item === 'string' ? item : JSON.stringify(item);
			if (pathPrefix) {
				entry.dataset.validationPath = `${pathPrefix}[${index}]`;
			}
			list.append(entry);
		});
		return list;
	}

	if (isPlainObject(value)) {
		const entries = Object.entries(value).filter(([, item]) => {
			if (Array.isArray(item)) {
				return item.length > 0;
			}

			return typeof item === 'string' && item.trim().length > 0;
		});

		if (entries.length === 0) {
			return createReadonlyEmptyState(emptyMessage);
		}

		const list = document.createElement('inc-list-group');
		list.setAttribute('dense', '');
		list.className = 'coverage-evidence-list';
		entries.forEach(([key, item]) => {
			const entry = document.createElement('div');
			entry.textContent = Array.isArray(item)
				? `${key}: ${item.join(', ')}`
				: `${key}: ${String(item)}`;
			if (pathPrefix) {
				entry.dataset.validationPath = `${pathPrefix}.${key}`;
			}
			list.append(entry);
		});
		return list;
	}

	return createReadonlyEmptyState(emptyMessage);
}

function createReadonlyEmptyState(message: string): HTMLElement {
	const emptyState = document.createElement('p');
	emptyState.className = 'inc-text inc-text--small inc-text--muted requirement-readonly-empty';
	emptyState.textContent = message;
	return emptyState;
}

function countStructuredValueEntries(value: unknown): number {
	if (Array.isArray(value)) {
		return value.length;
	}

	if (isPlainObject(value)) {
		return Object.values(value).reduce<number>((total, item) => {
			if (Array.isArray(item)) {
				return total + item.length;
			}

			return total + (typeof item === 'string' && item.trim().length > 0 ? 1 : 0);
		}, 0);
	}

	return 0;
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
	fieldName: 'notes',
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

function createSupplementalSectionsEditor(items: SupplementalSection[], hintText: string): HTMLElement {
	const field = document.createElement('inc-field');
	field.className = 'list-field wide supplemental-sections-field';
	field.setAttribute('dense', '');
	field.dataset.validationPath = 'supplemental_sections';

	const label = document.createElement('div');
	label.slot = 'label';
	label.className = 'inc-form__label';
	label.textContent = 'Supplemental sections';

	const hint = document.createElement('p');
	hint.slot = 'hint';
	hint.className = 'inc-form__hint';
	hint.textContent = hintText;

	const control = document.createElement('div');
	control.slot = 'control';
	control.className = 'list-field__control inc-form__control';

	const itemsContainer = document.createElement('div');
	itemsContainer.className = 'requirements-list supplemental-sections-list';

	items.forEach((item, index) => {
		itemsContainer.append(createSupplementalSectionRow(items, index, item));
	});

	const addButton = createActionButton('Add section', 'Add a supplemental section entry', () => {
		getSupplementalSections().push(createEmptySupplementalSection());
		setCardExpanded('supplemental_sections', true);
		commitCurrentDocument(true);
		renderEditor();
		forceCardOpenAfterRender('supplemental_sections');
		refreshChrome();
		renderValidationState();
	}, { variant: 'secondary', size: 'sm' });

	const actions = createButtonToolbar('Supplemental section actions', 'section-actions');
	actions.append(addButton);

	control.append(itemsContainer, actions);
	field.append(label, hint, control, createErrorRegion());
	return field;
}

function createSupplementalSectionRow(
	items: SupplementalSection[],
	index: number,
	section: SupplementalSection
): HTMLElement {
	const rowPath = `supplemental_sections[${index}]`;
	const row = document.createElement('div');
	row.className = 'supplemental-section-row';
	row.dataset.validationPath = rowPath;

	const fields = document.createElement('div');
	fields.className = 'supplemental-section-fields';

	const headingField = document.createElement('inc-field');
	headingField.className = 'editor-field supplemental-section-heading-field';
	headingField.setAttribute('label', 'Heading');
	headingField.setAttribute('dense', '');
	headingField.dataset.validationPath = `${rowPath}.heading`;

	const headingInput = document.createElement('input');
	headingInput.className = 'inc-form__control editor-field__control';
	headingInput.slot = 'control';
	headingInput.placeholder = 'Section heading';
	headingInput.value = stringValue(section.heading);
	headingInput.spellcheck = true;
	headingInput.addEventListener('input', () => {
		section.heading = headingInput.value;
		commitCurrentDocument();
	});
	headingField.append(headingInput, createErrorRegion());

	const contentField = document.createElement('inc-field');
	contentField.className = 'editor-field editor-field--wide supplemental-section-content-field';
	contentField.setAttribute('label', 'Content');
	contentField.setAttribute('dense', '');
	contentField.dataset.validationPath = `${rowPath}.content`;

	const contentInput = document.createElement('textarea');
	contentInput.className = 'inc-form__control editor-field__control editor-field__control--textarea';
	contentInput.slot = 'control';
	contentInput.placeholder = 'Section content';
	contentInput.value = stringValue(section.content);
	contentInput.spellcheck = true;
	contentInput.setAttribute('rows', '6');
	contentInput.addEventListener('input', () => {
		section.content = contentInput.value;
		commitCurrentDocument();
	});
	contentField.append(contentInput, createErrorRegion());

	fields.append(headingField, contentField);

	const controls = document.createElement('div');
	controls.className = 'list-row__controls supplemental-section-controls';
	controls.append(
		createIconButton('×', 'Remove supplemental section', () => {
			getSupplementalSections().splice(index, 1);
			commitCurrentDocument(true);
			renderEditor();
			forceCardOpenAfterRender('supplemental_sections');
			refreshChrome();
			renderValidationState();
		}, false, 'outline-danger')
	);

	row.append(fields, controls);
	return row;
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

function createSectionHeading(title: string, description: string, infoTitle?: string): HTMLElement {
	const container = document.createElement('div');
	container.className = 'section-heading';
	const titleRow = document.createElement('div');
	titleRow.className = 'section-heading__title-row';
	const heading = document.createElement('h2');
	heading.className = 'inc-heading inc-heading--h5';
	heading.textContent = title;
	titleRow.append(heading);
	if (infoTitle) {
		titleRow.append(createInfoHint(infoTitle, `${title} help`));
	}

	const copy = document.createElement('div');
	copy.className = 'section-copy inc-text inc-text--small inc-text--muted';
	copy.textContent = description;

	container.append(titleRow, copy);
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

function createCardHeaderActions(label: string, ...items: HTMLElement[]): HTMLElement {
	const actions = createButtonToolbar(label, 'card-header-actions');
	actions.append(...items);
	return actions;
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
	const coverageMeta = document.getElementById('coverage-meta-text');
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
		validationSummary.hidden = isValid;
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
		coverageChip.title = getCoverageDefinitionsHelpText();
		coverageChip.setAttribute('aria-label', `Coverage summary. ${state.label}. ${getCoverageDefinitionsHelpText()}`);
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
		badge.title = getCoverageStatusExplanation(requirementSummary.status);
		badge.setAttribute('aria-label', `${formatCoverageStatusLabel(requirementSummary.status)}. ${getCoverageStatusExplanation(requirementSummary.status)}`);
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
			requirementStatus.title = getCoverageStatusExplanation(requirementSummary.status);
			requirementStatus.setAttribute('aria-label', `${formatCoverageStatusLabel(requirementSummary.status)}. ${getCoverageStatusExplanation(requirementSummary.status)}`);
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
			meta: 'All requirements are covered.',
			tone: 'success'
		};
	}

	if (summary.missingCount === 0) {
		return {
			label: coverageLabel,
			meta: `${summary.partialCount} partial requirement${summary.partialCount === 1 ? ' still needs' : 's still need'} coverage expectations.`,
			tone: 'warning'
		};
	}

	const missingLabel = `${summary.missingCount} missing requirement${summary.missingCount === 1 ? ' has' : 's have'} no evidence`;
	const partialLabel = summary.partialCount > 0
		? ` ${summary.partialCount} partial requirement${summary.partialCount === 1 ? ' still needs' : 's still need'} coverage expectations.`
		: '';

	return {
		label: coverageLabel,
		meta: `${missingLabel}.${partialLabel}`.trim(),
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
				currentRequirementViewMode = 'view';
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
		requirementIndexFilter,
		requirementSortKey,
		requirementSortDirection,
		requirementCompactRows,
		expandedRequirementRowPaths: Array.from(expandedRequirementRowPaths)
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
	normalized.tags = normalizeOptionalStringArray(normalized.tags);
	normalized.related_artifacts = normalizeOptionalStringArray(normalized.related_artifacts);
	normalized.open_questions = normalizeOptionalStringArray(normalized.open_questions);
	normalized.supplemental_sections = normalizeSupplementalSectionArray(normalized.supplemental_sections);
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
	normalized.coverage = normalizeRequirementCoverageExpectation(normalized.coverage);
	normalized.trace = normalizeRequirementTrace(normalized.trace);
	normalized.notes = normalizeOptionalStringArray(normalized.notes);
	return normalized;
}

function normalizeStringArray(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.map((item) => (typeof item === 'string' ? item : ''));
}

function normalizeOptionalStringArray(value: string[] | undefined): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	if (value.length === 0) {
		return undefined;
	}

	return normalizeStringArray(value);
}

function normalizeSupplementalSectionArray(value: SupplementalSection[] | undefined): SupplementalSection[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	if (value.length === 0) {
		return undefined;
	}

	return value.map((item) => {
		if (!isPlainObject(item)) {
			return createEmptySupplementalSection();
		}

		const normalized = cloneSpecificationDocument(item as SupplementalSection);
		normalized.heading = stringValue(normalized.heading);
		normalized.content = stringValue(normalized.content);
		return normalized;
	});
}

function createEmptySupplementalSection(): SupplementalSection {
	return {
		heading: '',
		content: ''
	};
}

function normalizeRequirementCoverageExpectation(value: RequirementCoverageExpectation | undefined): RequirementCoverageExpectation | undefined {
	if (!isPlainObject(value)) {
		return undefined;
	}

	const normalized = cloneSpecificationDocument(value as RequirementCoverageExpectation);
	normalized.positive = stringValue(normalized.positive) as RequirementCoverageExpectation['positive'];
	normalized.negative = stringValue(normalized.negative) as RequirementCoverageExpectation['negative'];
	normalized.edge = stringValue(normalized.edge) as RequirementCoverageExpectation['edge'];
	normalized.fuzz = stringValue(normalized.fuzz) as RequirementCoverageExpectation['fuzz'];
	return normalized;
}

function normalizeRequirementTrace(value: RequirementTrace | undefined): RequirementTrace | undefined {
	if (!isPlainObject(value)) {
		return undefined;
	}

	const normalized = cloneSpecificationDocument(value as RequirementTrace);
	normalized.satisfied_by = normalizeOptionalStringArray(normalized.satisfied_by);
	normalized.implemented_by = normalizeOptionalStringArray(normalized.implemented_by);
	normalized.verified_by = normalizeOptionalStringArray(normalized.verified_by);
	normalized.derived_from = normalizeOptionalStringArray(normalized.derived_from);
	normalized.supersedes = normalizeOptionalStringArray(normalized.supersedes);
	normalized.upstream_refs = normalizeOptionalStringArray(normalized.upstream_refs);
	normalized.related = normalizeOptionalStringArray(normalized.related);
	return normalized;
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
	fieldName: 'id' | 'title' | 'statement',
	value: string
): void {
	switch (fieldName) {
		case 'id':
		case 'title':
		case 'statement':
			requirement[fieldName] = value;
			return;
		default:
			requirement[fieldName] = value;
	}
}

function getRequirementArray(requirement: SpecificationRequirement, fieldName: 'notes'): string[] {
	switch (fieldName) {
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
	}

	throw new Error(`Unsupported top-level list field: ${fieldName}`);
}

function getSupplementalSections(): SupplementalSection[] {
	ensureEditableDocument();
	currentDocument!.supplemental_sections = currentDocument!.supplemental_sections ?? [];
	return currentDocument!.supplemental_sections;
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
