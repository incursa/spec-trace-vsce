/// <reference lib="dom" />

import {
	getManagedMarkdownSectionHeading,
	getManagedMarkdownSectionKeys,
	getTraceFieldForArtifactType,
	serializeManagedMarkdownDocument,
	type ManagedMarkdownArtifactType,
	type ManagedMarkdownDocument,
	type ManagedMarkdownSectionKey,
	type ManagedMarkdownValidationIssue
} from '../core.js';

interface VsCodeApi {
	postMessage(message: unknown): void;
	setState<T>(state: T): void;
	getState<T>(): T | undefined;
}

type ManagedMarkdownEditorSyncMessage = {
	type: 'sync';
	document: ManagedMarkdownDocument;
	issues: ManagedMarkdownValidationIssue[];
	isDirty: boolean;
	externalConflict: boolean;
	referenceChoices: ReferenceChoice[];
};

type ManagedMarkdownEditorHostMessage = {
	type: 'ready' | 'edit' | 'save' | 'openText' | 'openReference';
	document?: ManagedMarkdownDocument;
	token?: string;
};

type ManagedMarkdownEditorIncomingMessage = ManagedMarkdownEditorSyncMessage | ManagedMarkdownEditorHostMessage;

interface ReferenceChoice {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly kind: 'requirement' | 'artifact' | 'file';
}

interface ManagedMarkdownEditorState {
	document?: ManagedMarkdownDocument;
	issues?: ManagedMarkdownValidationIssue[];
	isDirty?: boolean;
	externalConflict?: boolean;
	lastCommittedSerialized?: string;
	referenceChoices?: ReferenceChoice[];
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const appElement = document.getElementById('app');

if (!appElement) {
	throw new Error('Managed markdown editor root element is missing.');
}

const app = appElement as HTMLElement;

let currentDocument: ManagedMarkdownDocument | undefined;
let currentIssues: ManagedMarkdownValidationIssue[] = [];
let currentDirty = false;
let currentExternalConflict = false;
let lastCommittedSerialized = '';
let referenceChoices: ReferenceChoice[] = [];

window.addEventListener('message', (event: MessageEvent<ManagedMarkdownEditorIncomingMessage>) => {
	const message = event.data;
	if (!message) {
		return;
	}

	if (message.type === 'sync') {
		applyHostState(message);
	}
});

vscode.postMessage({ type: 'ready' } satisfies ManagedMarkdownEditorHostMessage);

const persistedState = vscode.getState<ManagedMarkdownEditorState>();
if (persistedState?.document) {
	currentDocument = cloneDocument(normalizeDocument(cloneDocument(persistedState.document)));
	currentIssues = persistedState.issues ?? [];
	currentDirty = persistedState.isDirty ?? false;
	currentExternalConflict = persistedState.externalConflict ?? false;
	lastCommittedSerialized = persistedState.lastCommittedSerialized ?? serializeManagedMarkdownDocument(currentDocument);
	referenceChoices = persistedState.referenceChoices ?? [];
	renderEditor();
	refreshChrome();
} else {
	renderLoading();
}

function applyHostState(message: ManagedMarkdownEditorSyncMessage): void {
	currentDocument = cloneDocument(normalizeDocument(cloneDocument(message.document)));
	currentIssues = message.issues;
	currentDirty = message.isDirty;
	currentExternalConflict = message.externalConflict;
	lastCommittedSerialized = serializeManagedMarkdownDocument(currentDocument);
	referenceChoices = message.referenceChoices;

	renderEditor();
	persistState();
	refreshChrome();
}

function renderLoading(): void {
	app.replaceChildren(createCard('Managed markdown editor', 'Loading markdown artifact...'));
}

function renderEditor(): void {
	if (!currentDocument) {
		renderLoading();
		return;
	}

	const shell = document.createElement('div');
	shell.className = 'editor-shell';

	shell.append(
		createHeroCard(),
		createValidationCard(),
		createMetadataCard(),
		createTraceCard(),
		createNarrativeCard(),
		createPreviewCard()
	);

	app.replaceChildren(shell);
}

function createHeroCard(): HTMLElement {
	const card = createCard(
		`${currentDocument?.artifact_id || 'Untitled artifact'}`,
		'Managed canonical markdown authoring'
	);

	const body = card.querySelector('.card__body');
	if (!body) {
		return card;
	}

	const statusRow = document.createElement('div');
	statusRow.className = 'status-row';
	statusRow.append(
		createStatusChip(currentDocument?.artifact_type ?? 'architecture'),
		createStatusChip(currentDirty ? 'dirty' : 'clean'),
		createStatusChip(currentExternalConflict ? 'conflict' : 'synced')
	);

	const actions = document.createElement('div');
	actions.className = 'actions';
	actions.append(
		createButton('Save', () => vscode.postMessage({ type: 'save' })),
		createButton('Open as Text', () => vscode.postMessage({ type: 'openText' }), 'secondary')
	);

	const subtitle = document.createElement('div');
	subtitle.className = 'small';
	subtitle.textContent = `${currentDocument?.artifact_type || 'markdown'} · ${currentDocument?.domain || 'unknown domain'}`;

	body.append(statusRow, subtitle, actions);
	return card;
}

function createMetadataCard(): HTMLElement {
	const card = createCard('Canonical fields', 'Editable front matter fields used by the canonical markdown artifact.');
	const body = card.querySelector('.card__body');
	if (!body || !currentDocument) {
		return card;
	}
	const documentState = currentDocument!;
	const artifactType = currentDocument.artifact_type;

	const grid = document.createElement('div');
	grid.className = 'grid';

	grid.append(
		createReadonlyField('artifact_id', documentState.artifact_id || '—'),
		createReadonlyField('artifact_type', documentState.artifact_type || '—'),
		createTextField('Title', 'title', currentDocument.title ?? '', (value) => {
			documentState.title = value;
			commitCurrentDocument();
		}),
		createTextField('Domain', 'domain', currentDocument.domain ?? '', (value) => {
			documentState.domain = value;
			commitCurrentDocument();
		}),
		createSelectField('Status', 'status', currentDocument.status ?? '', statusOptionsFor(artifactType), (value) => {
			documentState.status = value;
			commitCurrentDocument();
		}),
		createTextField('Owner', 'owner', currentDocument.owner ?? '', (value) => {
			documentState.owner = value;
			commitCurrentDocument();
		}),
		createTextField('Summary', 'summary', currentDocument.summary ?? '', (value) => {
			documentState.summary = value;
			commitCurrentDocument();
		}, true),
		createListEditor('related_artifacts', 'Related artifacts', 'Local artifact identifiers or repo-relative paths.', documentState.related_artifacts ?? [], 'artifact')
	);

	body.append(grid);
	return card;
}

function createTraceCard(): HTMLElement {
	if (!currentDocument?.artifact_type) {
		return createCard('Trace references', 'No artifact type available.');
	}

	const documentState = currentDocument!;
	const artifactType = currentDocument.artifact_type;
	const traceField = getTraceFieldForArtifactType(artifactType);
	const traceSectionKeys = getManagedMarkdownSectionKeys(artifactType);
	const traceLabel = traceFieldLabel(traceField);
	const card = createCard('Trace references', `Managed trace references for the ${artifactType} artifact.`);
	const body = card.querySelector('.card__body');
	if (!body) {
		return card;
	}

	body.append(
		createListEditor(traceField, traceLabel, `Local references used by ${traceLabel.toLowerCase()}.`, getListValues(traceField), traceField === 'design_links' || traceField === 'verification_links' ? 'artifact' : 'requirement'),
		createSectionHint(traceSectionKeys)
	);
	return card;
}

function createNarrativeCard(): HTMLElement {
	const card = createCard('Narrative sections', 'Primary authored markdown sections preserved in the managed format.');
	const body = card.querySelector('.card__body');
	if (!body || !currentDocument?.artifact_type) {
		return card;
	}
	const documentState = currentDocument!;
	const artifactType = currentDocument.artifact_type;

	for (const sectionKey of getManagedMarkdownSectionKeys(artifactType)) {
		const section = documentState.sections.find((entry) => entry.key === sectionKey);
		const value = section?.content ?? '';
		body.append(
			createMultilineField(getManagedMarkdownSectionHeading(sectionKey), `sections.${sectionKey}`, value, (nextValue) => {
				const target = documentState.sections.find((entry) => entry.key === sectionKey);
				if (target) {
					target.content = nextValue;
					commitCurrentDocument();
				}
			}, true)
		);
	}

	const preservedSections = documentState.sections.filter((section) => !section.editable || !getManagedMarkdownSectionKeys(artifactType).includes(section.key as ManagedMarkdownSectionKey));
	if (preservedSections.length > 0) {
		const details = document.createElement('details');
		const summary = document.createElement('summary');
		summary.textContent = 'Additional preserved markdown';
		const pre = document.createElement('pre');
		pre.textContent = preservedSections.map((section) => section.rawText ?? section.content).join('\n\n').trim();
		details.append(summary, pre);
		body.append(details);
	}

	return card;
}

function createPreviewCard(): HTMLElement {
	const card = createCard('Markdown preview', 'Collapsed by default to keep authored fields primary.');
	const body = card.querySelector('.card__body');
	if (!body || !currentDocument) {
		return card;
	}

	const details = document.createElement('details');
	const summary = document.createElement('summary');
	summary.textContent = 'Preview';
	const pre = document.createElement('pre');
	pre.textContent = serializeManagedMarkdownDocument(currentDocument);
	details.append(summary, pre);
	body.append(details);
	return card;
}

function createValidationCard(): HTMLElement {
	const card = createCard('Validation', currentIssues.length === 0 ? 'No validation issues detected.' : 'Validation issues are shown inline and below.');
	const body = card.querySelector('.card__body');
	if (!body) {
		return card;
	}

	if (currentExternalConflict) {
		body.append(createBanner('External changes detected. Reopen or revert before saving to avoid overwriting newer content.', 'warning'));
	}

	if (currentIssues.length === 0) {
		return card;
	}

	const list = document.createElement('ul');
	list.className = 'validation-list';
	for (const issue of currentIssues) {
		const item = document.createElement('li');
		item.className = `validation-item validation-item--${issue.severity}`;
		item.textContent = `${issue.path || 'document'}: ${issue.message}`;
		list.append(item);
	}
	body.append(list);
	return card;
}

function createCard(title: string, description: string): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';

	const heading = document.createElement('div');
	heading.className = 'card__heading';
	const titleEl = document.createElement('h2');
	titleEl.textContent = title;
	const descriptionEl = document.createElement('div');
	descriptionEl.className = 'small';
	descriptionEl.textContent = description;
	heading.append(titleEl, descriptionEl);

	const body = document.createElement('div');
	body.className = 'card__body';

	card.append(heading, body);
	return card;
}

function createBanner(message: string, tone: 'warning' | 'error'): HTMLElement {
	const banner = document.createElement('div');
	banner.className = `banner banner--${tone}`;
	banner.textContent = message;
	return banner;
}

function createStatusChip(kind: string): HTMLElement {
	const chip = document.createElement('span');
	chip.className = `chip chip--${sanitizeClassToken(kind)}`;
	chip.textContent = kind;
	return chip;
}

function createReadonlyField(label: string, value: string): HTMLElement {
	const field = document.createElement('div');
	field.className = 'field';
	const labelEl = document.createElement('label');
	labelEl.textContent = label;
	const valueEl = document.createElement('input');
	valueEl.value = value;
	valueEl.readOnly = true;
	field.append(labelEl, valueEl);
	return field;
}

function createTextField(
	label: string,
	path: string,
	value: string,
	onChange: (value: string) => void,
	multiline = false
): HTMLElement {
	const field = document.createElement('div');
	field.className = multiline ? 'field field--wide' : 'field';
	const labelEl = document.createElement('label');
	labelEl.textContent = label;
	const input = multiline ? document.createElement('textarea') : document.createElement('input');
	if (multiline) {
		(input as HTMLTextAreaElement).value = value;
	} else {
		(input as HTMLInputElement).value = value;
	}
	input.addEventListener('input', () => {
		onChange((input as HTMLInputElement | HTMLTextAreaElement).value);
	});
	const issues = issueList(path);
	field.append(labelEl, input, issues);
	return field;
}

function createMultilineField(
	label: string,
	path: string,
	value: string,
	onChange: (value: string) => void,
	wide = false
): HTMLElement {
	const field = document.createElement('div');
	field.className = wide ? 'field field--wide' : 'field';
	const labelEl = document.createElement('label');
	labelEl.textContent = label;
	const input = document.createElement('textarea');
	input.value = value;
	input.addEventListener('input', () => onChange(input.value));
	const issues = issueList(path);
	field.append(labelEl, input, issues);
	return field;
}

function createSelectField(
	label: string,
	path: string,
	value: string,
	options: readonly string[],
	onChange: (value: string) => void
): HTMLElement {
	const field = document.createElement('div');
	field.className = 'field';
	const labelEl = document.createElement('label');
	labelEl.textContent = label;
	const select = document.createElement('select');
	for (const optionValue of options) {
		const option = document.createElement('option');
		option.value = optionValue;
		option.textContent = optionValue;
		select.append(option);
	}
	select.value = value;
	select.addEventListener('change', () => onChange(select.value));
	field.append(labelEl, select, issueList(path));
	return field;
}

function createListEditor(
	fieldName: 'related_artifacts' | 'satisfies' | 'addresses' | 'design_links' | 'verification_links' | 'verifies',
	label: string,
	description: string,
	values: string[],
	pickerKind: 'all' | 'artifact' | 'requirement'
): HTMLElement {
	const field = document.createElement('div');
	field.className = 'field field--wide';
	const labelEl = document.createElement('label');
	labelEl.textContent = label;
	const descriptionEl = document.createElement('div');
	descriptionEl.className = 'small';
	descriptionEl.textContent = description;

	const pickerRow = document.createElement('div');
	pickerRow.className = 'list-row';
	const picker = document.createElement('select');
	for (const choice of filteredChoicesForField(fieldName, pickerKind)) {
		const option = document.createElement('option');
		option.value = choice.value;
		option.textContent = `${choice.label} — ${choice.description}`;
		picker.append(option);
	}
	const addPickerButton = createButton('Add local', () => {
		if (!picker.value) {
			return;
		}

		addReferenceValue(fieldName, picker.value);
	});
	pickerRow.append(picker, addPickerButton);

	const manualRow = document.createElement('div');
	manualRow.className = 'list-row';
	const manualInput = document.createElement('input');
	manualInput.placeholder = 'Manual identifier or repo-relative path';
	const addManualButton = createButton('Add manual', () => {
		const next = manualInput.value.trim();
		if (!next) {
			return;
		}

		addReferenceValue(fieldName, next);
		manualInput.value = '';
	});
	manualRow.append(manualInput, addManualButton);

	const items = document.createElement('div');
	items.className = 'list-items';
	values.forEach((value, index) => {
		items.append(createListItem(fieldName, value, index));
	});

	field.append(labelEl, descriptionEl, pickerRow, manualRow, items, issueList(fieldName));
	return field;
}

function createListItem(
	fieldName: 'related_artifacts' | 'satisfies' | 'addresses' | 'design_links' | 'verification_links' | 'verifies',
	value: string,
	index: number
): HTMLElement {
	const item = document.createElement('div');
	item.className = 'list-item';

	const inputRow = document.createElement('div');
	inputRow.className = 'list-row';
	const input = document.createElement('input');
	input.value = value;
	input.addEventListener('input', () => {
		updateReferenceValue(fieldName, index, input.value);
	});
	const openButton = createButton('Open', () => {
		void vscode.postMessage({ type: 'openReference', token: input.value.trim() });
	}, 'secondary');
	inputRow.append(input, openButton);

	const controls = document.createElement('div');
	controls.className = 'list-item__controls';
	controls.append(
		createButton('Up', () => moveReferenceValue(fieldName, index, index - 1), 'secondary'),
		createButton('Down', () => moveReferenceValue(fieldName, index, index + 1), 'secondary'),
		createButton('Remove', () => removeReferenceValue(fieldName, index), 'danger')
	);

	const meta = document.createElement('div');
	meta.className = 'small';
	meta.textContent = isKnownReference(value) ? 'Resolved locally' : 'Unresolved locally';

	item.append(inputRow, meta, controls);
	return item;
}

function createSectionHint(sectionKeys: readonly ManagedMarkdownSectionKey[]): HTMLElement {
	const hint = document.createElement('div');
	hint.className = 'small';
	hint.textContent = `Editable sections: ${sectionKeys.map((sectionKey) => getManagedMarkdownSectionHeading(sectionKey)).join(', ')}.`;
	return hint;
}

function addReferenceValue(fieldName: ReferenceFieldName, value: string): void {
	ensureDocument();
	const values = getListValues(fieldName);
	values.push(value.trim());
	commitCurrentDocument();
	renderEditor();
}

function updateReferenceValue(fieldName: ReferenceFieldName, index: number, value: string): void {
	ensureDocument();
	const values = getListValues(fieldName);
	if (index < 0 || index >= values.length) {
		return;
	}

	values[index] = value;
	commitCurrentDocument();
}

function moveReferenceValue(fieldName: ReferenceFieldName, fromIndex: number, toIndex: number): void {
	ensureDocument();
	const values = getListValues(fieldName);
	if (toIndex < 0 || toIndex >= values.length) {
		return;
	}

	const [item] = values.splice(fromIndex, 1);
	values.splice(toIndex, 0, item);
	commitCurrentDocument();
	renderEditor();
}

function removeReferenceValue(fieldName: ReferenceFieldName, index: number): void {
	ensureDocument();
	const values = getListValues(fieldName);
	if (index < 0 || index >= values.length) {
		return;
	}

	values.splice(index, 1);
	commitCurrentDocument();
	renderEditor();
}

function getListValues(fieldName: ReferenceFieldName): string[] {
	ensureDocument();
	const document = currentDocument!;
	switch (fieldName) {
		case 'related_artifacts':
			document.related_artifacts = document.related_artifacts ?? [];
			return document.related_artifacts;
		case 'satisfies':
			document.satisfies = document.satisfies ?? [];
			return document.satisfies;
		case 'addresses':
			document.addresses = document.addresses ?? [];
			return document.addresses;
		case 'design_links':
			document.design_links = document.design_links ?? [];
			return document.design_links;
		case 'verification_links':
			document.verification_links = document.verification_links ?? [];
			return document.verification_links;
		case 'verifies':
			document.verifies = document.verifies ?? [];
			return document.verifies;
	}
}

function filteredChoicesForField(fieldName: ReferenceFieldName, pickerKind: 'all' | 'artifact' | 'requirement'): ReferenceChoice[] {
	return referenceChoices.filter((choice) => {
		if (pickerKind === 'artifact') {
			return choice.kind === 'artifact' || choice.kind === 'file';
		}

		if (pickerKind === 'requirement') {
			return choice.kind === 'requirement';
		}

		if (fieldName === 'related_artifacts') {
			return choice.kind === 'artifact' || choice.kind === 'requirement';
		}

		return choice.kind === 'requirement';
	});
}

function issueList(path: string): HTMLElement {
	const list = document.createElement('div');
	list.className = 'field-issues';
	const issues = currentIssues.filter((issue) => issueMatchesPath(issue.path, path));
	for (const issue of issues) {
		const issueItem = document.createElement('div');
		issueItem.className = `field-issue field-issue--${issue.severity}`;
		issueItem.textContent = issue.message;
		list.append(issueItem);
	}

	return list;
}

function issueMatchesPath(issuePath: string, path: string): boolean {
	if (path.length === 0) {
		return true;
	}

	return issuePath === path || issuePath.startsWith(`${path}.`) || issuePath.startsWith(`${path}[`);
}

function ensureDocument(): void {
	if (!currentDocument) {
		throw new Error('Managed markdown document is not available.');
	}
}

function commitCurrentDocument(force = false): void {
	ensureDocument();
	const serialized = serializeManagedMarkdownDocument(currentDocument!);
	if (!force && serialized === lastCommittedSerialized) {
		refreshChrome();
		persistState();
		return;
	}

	currentDirty = true;
	lastCommittedSerialized = serialized;
	vscode.postMessage({
		type: 'edit',
		document: cloneDocument(currentDocument!)
	});
	refreshChrome();
	persistState();
}

function refreshChrome(): void {
	const chips = Array.from(document.querySelectorAll<HTMLElement>('.chip'));
	for (const chip of chips) {
		chip.textContent = chip.dataset.label || chip.textContent || '';
	}
}

function persistState(): void {
	if (!currentDocument) {
		return;
	}

	vscode.setState({
		document: cloneDocument(currentDocument),
		issues: currentIssues,
		isDirty: currentDirty,
		externalConflict: currentExternalConflict,
		lastCommittedSerialized,
		referenceChoices
	} satisfies ManagedMarkdownEditorState);
}

function normalizeDocument(document: ManagedMarkdownDocument): ManagedMarkdownDocument {
	const normalized = cloneDocument(document);
	normalized.artifact_id = stringValue(normalized.artifact_id);
	normalized.artifact_type = normalized.artifact_type;
	normalized.title = stringValue(normalized.title);
	normalized.domain = stringValue(normalized.domain);
	normalized.status = stringValue(normalized.status);
	normalized.owner = stringValue(normalized.owner);
	normalized.summary = stringValue(normalized.summary);
	normalized.related_artifacts = normalizeList(normalized.related_artifacts);
	normalized.satisfies = normalizeList(normalized.satisfies);
	normalized.addresses = normalizeList(normalized.addresses);
	normalized.design_links = normalizeList(normalized.design_links);
	normalized.verification_links = normalizeList(normalized.verification_links);
	normalized.verifies = normalizeList(normalized.verifies);
	normalized.sections = Array.isArray(normalized.sections) ? normalized.sections.map((section) => ({
		key: stringValue(section.key),
		heading: stringValue(section.heading),
		content: typeof section.content === 'string' ? section.content : '',
		editable: section.editable !== false,
		rawText: typeof section.rawText === 'string' ? section.rawText : undefined
	})) : [];
	normalized.frontMatterExtras = typeof normalized.frontMatterExtras === 'object' && normalized.frontMatterExtras !== null
		? cloneJson(normalized.frontMatterExtras)
		: {};
	return normalized;
}

function normalizeList(value: string[] | undefined): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const filtered = value.map((item) => stringValue(item)).filter((item) => item.length > 0);
	return filtered.length > 0 ? filtered : undefined;
}

function cloneDocument(document: ManagedMarkdownDocument): ManagedMarkdownDocument {
	return JSON.parse(JSON.stringify(document)) as ManagedMarkdownDocument;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function isKnownReference(value: string): boolean {
	return referenceChoices.some((choice) => choice.value === value.trim() || choice.label === value.trim());
}

function traceFieldLabel(field: ReturnType<typeof getTraceFieldForArtifactType>): string {
	switch (field) {
		case 'satisfies':
			return 'Satisfies';
		case 'addresses':
			return 'Addresses';
		case 'design_links':
			return 'Design links';
		case 'verification_links':
			return 'Verification links';
		case 'verifies':
			return 'Verifies';
	}
}

function statusOptionsFor(artifactType: ManagedMarkdownArtifactType | undefined): readonly string[] {
	switch (artifactType) {
		case 'architecture':
			return ['draft', 'proposed', 'approved', 'implemented', 'verified', 'superseded', 'retired'];
		case 'work_item':
			return ['planned', 'in_progress', 'blocked', 'complete', 'cancelled', 'superseded'];
		case 'verification':
			return ['planned', 'passed', 'failed', 'blocked', 'waived', 'obsolete'];
		default:
			return ['draft'];
	}
}

type ReferenceFieldName = 'related_artifacts' | 'satisfies' | 'addresses' | 'design_links' | 'verification_links' | 'verifies';

function createButton(label: string, onClick: () => void, tone: 'primary' | 'secondary' | 'danger' = 'primary'): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = label;
	button.dataset.label = label;
	button.className = `button button--${tone}`;
	button.addEventListener('click', onClick);
	return button;
}

function sanitizeClassToken(token: string): string {
	return token.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
