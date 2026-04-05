/// <reference lib="dom" />

import {
	cloneSpecificationDocument,
	createEmptyRequirement,
	serializeSpecificationDocument,
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
	type: 'ready' | 'edit' | 'save' | 'openText';
	document?: SpecificationDocument;
};

interface SpecificationEditorWebviewState {
	document?: SpecificationDocument;
	issues?: ValidationIssue[];
	isDirty?: boolean;
	externalConflict?: boolean;
	lastCommittedSerialized?: string;
	expandedCardPaths?: string[];
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
let pendingOpenRequirementIndex: number | undefined;

const statusOptions = ['draft', 'review', 'approved', 'active', 'deprecated', 'archived'];
type TopLevelListField = 'tags' | 'related_artifacts' | 'open_questions' | 'supplemental_sections';

window.addEventListener('message', (event: MessageEvent<SpecificationEditorSyncMessage>) => {
	const message = event.data;
	if (!message || message.type !== 'sync') {
		return;
	}

	applyHostState(message);
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

	renderEditor();
	persistWebviewState();
	refreshChrome();
	renderValidationState();
}

function renderLoading(): void {
	app.replaceChildren(createCard('Spec Trace editor', 'Loading structured editor...'));
}

function renderEditor(): void {
	if (!currentDocument) {
		renderLoading();
		return;
	}

	syncExpandedCardPathsFromDom();
	const autoOpenRequirementIndex = pendingOpenRequirementIndex;
	const shell = document.createElement('div');
	shell.className = 'editor-root';

	shell.append(
		createHero(),
		createValidationSummaryCard(),
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
		),
		createRequirementsCard(autoOpenRequirementIndex)
	);

	app.replaceChildren(shell);
	pendingOpenRequirementIndex = undefined;
	persistWebviewState();
}

function createHero(): HTMLElement {
	const hero = document.createElement('section');
	hero.className = 'hero';

	const heading = document.createElement('div');
	const title = document.createElement('h1');
	title.className = 'hero-title';
	title.id = 'hero-title';
	title.textContent = currentDocument?.title?.trim() || currentDocument?.artifact_id?.trim() || 'Untitled specification';

	const subtitle = document.createElement('div');
	subtitle.className = 'hero-subtitle';
	subtitle.id = 'hero-subtitle';
	subtitle.textContent = currentDocument
		? `Editing ${currentDocument.artifact_id?.trim() || 'specification'}`
		: 'Waiting for document...';

	heading.append(title, subtitle);

	const statusRow = document.createElement('div');
	statusRow.className = 'status-row';
	statusRow.append(
		createStatusChip('sync-chip', 'Synced'),
		createStatusChip('dirty-chip', 'Clean'),
		createStatusChip('conflict-chip', 'No conflict'),
		createStatusChip('validation-chip', '0 issues')
	);

	const actionRow = document.createElement('div');
	actionRow.className = 'hero-actions';
	actionRow.append(
		createActionButton('Save', 'Save the current specification', () => {
			void vscode.postMessage({ type: 'save' });
		}, true),
		createActionButton('Open JSON', 'Open the same file in the text editor', () => {
			void vscode.postMessage({ type: 'openText' });
		})
	);

	const meta = document.createElement('div');
	meta.className = 'hero-meta';
	meta.append(statusRow, actionRow);

	hero.append(heading, meta);
	return hero;
}

function createStatusChip(id: string, label: string): HTMLElement {
	const chip = document.createElement('div');
	chip.className = 'status-chip';
	chip.id = id;
	chip.textContent = label;
	return chip;
}

function createDocumentFieldsCard(): HTMLElement {
	const grid = document.createElement('div');
	grid.className = 'form-grid';

	grid.append(
		createReadonlyField('artifact_id', 'Artifact id', stringValue(currentDocument?.artifact_id)),
		createReadonlyField('artifact_type', 'Artifact type', stringValue(currentDocument?.artifact_type) || 'specification'),
		createTextField('title', 'Title', stringValue(currentDocument?.title), false, 'Specification title'),
		createTextField('domain', 'Domain', stringValue(currentDocument?.domain), false, 'Domain slug'),
		createTextField('capability', 'Capability', stringValue(currentDocument?.capability), false, 'Capability slug'),
		createStatusField(),
		createTextField('owner', 'Owner', stringValue(currentDocument?.owner), false, 'Owning team or person'),
		createTextAreaField('purpose', 'Purpose', stringValue(currentDocument?.purpose), 'Why this specification exists.'),
		createTextAreaField('scope', 'Scope', stringValue(currentDocument?.scope), 'What is included and excluded.'),
		createTextAreaField('context', 'Context', stringValue(currentDocument?.context), 'Background and constraints.')
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
	const field = document.createElement('div');
	field.className = 'form-field';
	field.dataset.validationPath = 'status';

	const label = document.createElement('label');
	label.className = 'field-label';
	label.textContent = 'Status';
	label.htmlFor = 'status-input';

	const select = document.createElement('select');
	select.className = 'field-input';
	select.id = 'status-input';
	select.spellcheck = false;

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

	const helper = document.createElement('div');
	helper.className = 'helper';
	helper.textContent = 'Choose the current lifecycle state.';

	field.append(label, select, helper, createErrorRegion());
	return field;
}

function createReadonlyField(path: string, labelText: string, value: string): HTMLElement {
	const field = document.createElement('div');
	field.className = 'form-field';
	field.dataset.validationPath = path;

	const label = document.createElement('label');
	label.className = 'field-label';
	label.textContent = labelText;

	const input = document.createElement('input');
	input.className = 'field-input';
	input.readOnly = true;
	input.value = value;

	field.append(label, input, createErrorRegion());
	return field;
}

function createTextField(
	path: string,
	labelText: string,
	value: string,
	multiline: boolean,
	placeholder: string
): HTMLElement {
	const field = document.createElement('div');
	field.className = multiline ? 'form-field wide' : 'form-field';
	field.dataset.validationPath = path;

	const label = document.createElement('label');
	label.className = 'field-label';
	label.textContent = labelText;
	label.htmlFor = `${path}-input`;

	const input = multiline ? document.createElement('textarea') : document.createElement('input');
	input.className = multiline ? 'field-textarea' : 'field-input';
	input.id = `${path}-input`;
	input.value = value;
	input.placeholder = placeholder;
	input.spellcheck = true;
	input.addEventListener('input', () => {
		ensureEditableDocument();
		setPropertyValue(path, input.value);
		commitCurrentDocument();
	});

	field.append(label, input, createErrorRegion());
	return field;
}

function createTextAreaField(path: string, labelText: string, value: string, placeholder: string): HTMLElement {
	return createTextField(path, labelText, value, true, placeholder);
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
	const body = createListEditor(fieldName, items, options);
	const itemLabel = items.length === 1 ? '1 item' : `${items.length} items`;
	return createCollapsibleCard(
		title,
		`${description} ${itemLabel}.`,
		body,
		{
			className: `${fieldName}-card`,
			validationPath: fieldName,
			cardPath: fieldName,
			open: false
		}
	);
}

function createRequirementsCard(autoOpenRequirementIndex: number | undefined): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';
	const header = document.createElement('div');
	header.className = 'section-heading-row';
	header.append(
		createSectionHeading('Requirements', 'Ordered requirement records. Use the arrows to reorder.'),
		createActionButton('Add requirement', 'Add a new requirement record', () => {
			ensureEditableDocument();
			currentDocument!.requirements = currentDocument!.requirements ?? [];
			pendingOpenRequirementIndex = currentDocument!.requirements.length;
			currentDocument!.requirements.push(createEmptyRequirement());
			commitCurrentDocument(true);
			renderEditor();
			refreshChrome();
			renderValidationState();
		}, true)
	);
	card.append(header);

	const list = document.createElement('div');
	list.className = 'requirements-list';
	list.dataset.validationPath = 'requirements';

	const requirements = currentDocument?.requirements ?? [];
	requirements.forEach((requirement, index) => {
		list.append(createRequirementCard(requirement, index, autoOpenRequirementIndex === index));
	});

	card.append(list, createErrorRegion());
	return card;
}

function createRequirementCard(requirement: SpecificationRequirement, index: number, open = false): HTMLElement {
	const path = `requirements[${index}]`;
	const card = document.createElement('details');
	card.className = 'requirement-card';
	card.dataset.validationPath = path;
	card.dataset.cardPath = path;
	card.open = isCardExpanded(path) || open;

	const summary = document.createElement('summary');
	summary.className = 'requirement-summary';

	const summaryCopy = document.createElement('div');
	summaryCopy.className = 'requirement-summary-copy';
	const requirementId = requirement.id?.trim() || `Requirement ${index + 1}`;
	const requirementTitle = requirement.title?.trim() || 'Untitled requirement';

	const summaryLine = document.createElement('div');
	summaryLine.className = 'requirement-summary-line';

	const summaryIdentifier = document.createElement('span');
	summaryIdentifier.className = 'requirement-summary-id';
	summaryIdentifier.textContent = requirementId;

	const summaryTitle = document.createElement('span');
	summaryTitle.className = 'requirement-summary-title';
	summaryTitle.textContent = requirementTitle;

	summaryLine.append(summaryIdentifier, summaryTitle);

	const summaryDescription = document.createElement('div');
	summaryDescription.className = 'requirement-summary-statement';
	summaryDescription.textContent = requirement.statement?.trim() || 'Add the requirement statement.';

	summaryCopy.append(summaryLine, summaryDescription);

	const summaryState = document.createElement('div');
	summaryState.className = 'requirement-summary-state';
	summaryState.textContent = open ? 'Open' : 'Collapsed';

	summary.append(summaryCopy, summaryState);
	card.append(summary);
	if (card.open) {
		setCardExpanded(path, true);
	}
	card.addEventListener('toggle', () => {
		setCardExpanded(path, card.open);
		summaryState.textContent = card.open ? 'Open' : 'Collapsed';
		persistWebviewState();
	});

	const toolbar = document.createElement('div');
	toolbar.className = 'requirement-toolbar wide';

	toolbar.append(
		createIconButton('↑', 'Move requirement up', () => moveRequirement(index, index - 1), index === 0),
		createIconButton('↓', 'Move requirement down', () => moveRequirement(index, index + 1), index === (currentDocument?.requirements?.length ?? 0) - 1),
		createIconButton('×', 'Remove requirement', () => removeRequirement(index))
	);

	const body = document.createElement('div');
	body.className = 'requirement-body';

	body.append(
		toolbar,
		createRequirementField(path, 'id', 'Requirement id', stringValue(requirement.id), false, 'REQ-EXAMPLE-0001'),
		createRequirementField(path, 'title', 'Title', stringValue(requirement.title), false, 'Requirement title'),
		createRequirementField(path, 'statement', 'Statement', stringValue(requirement.statement), true, 'Normative requirement statement'),
		createRequirementListField(path, 'coverage', 'Coverage', requirement.coverage ?? [], false, 'Coverage item'),
		createRequirementListField(path, 'trace', 'Trace', requirement.trace ?? [], false, 'Trace item'),
		createRequirementListField(path, 'notes', 'Notes', requirement.notes ?? [], true, 'Note')
	);

	card.append(body, createErrorRegion());
	return card;
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
	const field = document.createElement('div');
	field.className = multiline ? 'form-field wide' : 'form-field';
	field.dataset.validationPath = fieldPath;

	const label = document.createElement('label');
	label.className = 'field-label';
	label.textContent = labelText;
	label.htmlFor = `${fieldPath}-input`;

	const input = multiline ? document.createElement('textarea') : document.createElement('input');
	input.className = multiline ? 'field-textarea' : 'field-input';
	input.id = `${fieldPath}-input`;
	input.placeholder = placeholder;
	input.value = value;
	input.spellcheck = true;
	input.addEventListener('input', () => {
		ensureEditableDocument();
		const requirementIndex = parseRequirementIndex(requirementPath);
		const requirement = currentDocument!.requirements?.[requirementIndex];
		if (!requirement) {
			return;
		}

		setRequirementField(requirement, fieldName, input.value);
		commitCurrentDocument();
	});

	field.append(label, input, createErrorRegion());
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
	const field = document.createElement('div');
	field.className = 'list-field wide';
	field.dataset.validationPath = fieldPath;

	const label = document.createElement('div');
	label.className = 'field-label';
	label.textContent = labelText;

	const helper = document.createElement('div');
	helper.className = 'helper';
	helper.textContent = multiline ? 'Each item can span multiple lines.' : 'Each item is a separate string entry.';

	field.append(label, helper);

	items.forEach((item, index) => {
		field.append(createListRow(fieldPath, items, index, item, multiline, placeholder));
	});

	const addButton = document.createElement('button');
	addButton.type = 'button';
	addButton.className = 'action-button';
	addButton.textContent = 'Add item';
	addButton.addEventListener('click', () => {
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
	});

	field.append(addButton, createErrorRegion());
	return field;
}

function createListEditor(
	fieldName: TopLevelListField,
	items: string[],
	options: {
		multiline: boolean;
		placeholder: string;
		addLabel: string;
	}
): HTMLElement {
	const field = document.createElement('div');
	field.className = 'list-field wide';
	field.dataset.validationPath = fieldName;

	const itemsContainer = document.createElement('div');
	itemsContainer.className = 'requirements-list';

	items.forEach((item, index) => {
		itemsContainer.append(createListRow(fieldName, items, index, item, options.multiline, options.placeholder));
	});

	const addButton = document.createElement('button');
	addButton.type = 'button';
	addButton.className = 'action-button';
	addButton.textContent = options.addLabel;
	addButton.addEventListener('click', () => {
		ensureEditableDocument();
		const list = getTopLevelArray(fieldName);
		list.push('');
		commitCurrentDocument(true);
		renderEditor();
		refreshChrome();
		renderValidationState();
	});

	field.append(itemsContainer, addButton, createErrorRegion());
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
	input.className = multiline ? 'field-textarea' : 'field-input';
	input.placeholder = placeholder;
	input.value = value;
	input.spellcheck = true;
	input.addEventListener('input', () => {
		ensureEditableDocument();
		items[index] = input.value;
		commitCurrentDocument();
	});

	const up = createIconButton('↑', 'Move item up', () => moveArrayItem(items, index, index - 1), index === 0);
	const down = createIconButton('↓', 'Move item down', () => moveArrayItem(items, index, index + 1), index === items.length - 1);
	const remove = createIconButton('×', 'Remove item', () => removeArrayItem(items, index));

	const controls = document.createElement('div');
	controls.style.display = 'flex';
	controls.style.gap = '6px';
	controls.append(up, down, remove);

	row.append(input, controls, createErrorRegion());
	return row;
}

function createIconButton(label: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'icon-button';
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
	heading.textContent = title;

	const copy = document.createElement('div');
	copy.className = 'section-copy';
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
): HTMLDetailsElement {
	const card = document.createElement('details');
	card.className = ['card', 'collapsible-card', options?.className].filter(Boolean).join(' ');
	const cardPath = options?.cardPath;
	const open = options?.open ?? false;
	card.open = cardPath ? isCardExpanded(cardPath) || open : open;

	if (options?.validationPath !== undefined) {
		card.dataset.validationPath = options.validationPath;
	}

	if (cardPath) {
		card.dataset.cardPath = cardPath;
	}

	const summary = document.createElement('summary');
	summary.className = 'collapsible-card-summary';
	summary.append(createSectionHeading(title, description));

	const bodyContainer = document.createElement('div');
	bodyContainer.className = 'card-body';
	bodyContainer.append(body);

	card.append(summary, bodyContainer);
	if (card.open && cardPath) {
		setCardExpanded(cardPath, true);
	}
	card.addEventListener('toggle', () => {
		if (!cardPath) {
			return;
		}

		setCardExpanded(cardPath, card.open);
		persistWebviewState();
	});
	return card;
}

function createActionButton(label: string, title: string, onClick: () => void, primary = false): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = primary ? 'action-button primary' : 'action-button';
	button.textContent = label;
	button.title = title;
	button.addEventListener('click', onClick);
	return button;
}

function createCard(title: string, description: string): HTMLElement {
	const card = document.createElement('section');
	card.className = 'loading-card';
	const heading = document.createElement('div');
	heading.className = 'loading-title';
	heading.textContent = title;
	const body = document.createElement('div');
	body.className = 'loading-body';
	body.textContent = description;
	card.append(heading, body);
	return card;
}

function createValidationSummaryCard(): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';

	const heading = document.createElement('h2');
	heading.textContent = 'Validation';

	const summary = document.createElement('div');
	summary.id = 'validation-summary';
	summary.className = 'summary-errors';

	card.append(heading, summary);
	return card;
}

function createErrorRegion(): HTMLElement {
	const region = document.createElement('div');
	region.className = 'field-errors';
	region.dataset.validationSlot = 'errors';
	return region;
}

function refreshChrome(): void {
	const syncChip = document.getElementById('sync-chip');
	const dirtyChip = document.getElementById('dirty-chip');
	const conflictChip = document.getElementById('conflict-chip');
	const validationChip = document.getElementById('validation-chip');
	const validationSummary = document.getElementById('validation-summary');
	const heroTitle = document.getElementById('hero-title');
	const heroSubtitle = document.getElementById('hero-subtitle');

	if (syncChip) {
		syncChip.textContent = currentDirty ? 'Unsaved changes' : 'Synced';
		syncChip.classList.toggle('warning', currentDirty);
	}

	if (dirtyChip) {
		dirtyChip.textContent = currentDirty ? 'Dirty' : 'Clean';
		dirtyChip.classList.toggle('warning', currentDirty);
	}

	if (conflictChip) {
		conflictChip.textContent = currentExternalConflict ? 'External conflict' : 'No conflict';
		conflictChip.classList.toggle('warning', currentExternalConflict);
	}

	if (validationChip) {
		validationChip.textContent = currentIssues.length === 0 ? 'No validation issues' : `${currentIssues.length} issues`;
		validationChip.classList.toggle('warning', currentIssues.length > 0);
	}

	if (validationSummary) {
		validationSummary.replaceChildren();
		if (currentIssues.length === 0) {
			const line = document.createElement('div');
			line.textContent = 'No validation issues.';
			validationSummary.append(line);
		} else {
			for (const issue of currentIssues.slice(0, 8)) {
				const line = document.createElement('div');
				line.textContent = `${issue.path || 'document'}: ${issue.message}`;
				validationSummary.append(line);
			}
		}
	}

	if (heroTitle) {
		heroTitle.textContent = currentDocument?.title?.trim() || currentDocument?.artifact_id?.trim() || 'Untitled specification';
	}

	if (heroSubtitle) {
		heroSubtitle.textContent = currentDocument
			? `Editing ${currentDocument.artifact_id?.trim() || 'specification'}`
			: 'Waiting for document...';
	}
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

	const nextExpandedCardPaths = new Set<string>();
	for (const card of cards) {
		const cardPath = card.dataset.cardPath;
		if (cardPath && card instanceof HTMLDetailsElement && card.open) {
			nextExpandedCardPaths.add(cardPath);
		}
	}

	expandedCardPaths = nextExpandedCardPaths;
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
		expandedCardPaths: Array.from(expandedCardPaths)
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
	moveArrayItem(requirements, currentIndex, targetIndex);
	commitCurrentDocument(true);
	renderEditor();
	refreshChrome();
	renderValidationState();
}

function removeRequirement(index: number): void {
	ensureEditableDocument();
	currentDocument!.requirements = currentDocument!.requirements ?? [];
	currentDocument!.requirements.splice(index, 1);
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
