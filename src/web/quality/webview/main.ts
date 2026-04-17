/// <reference lib="dom" />

import type {
	QualityArtifactSnapshot,
	QualityWorkspaceSnapshot
} from '../core.js';

interface VsCodeApi {
	postMessage(message: unknown): void;
	setState<T>(state: T): void;
	getState<T>(): T | undefined;
}

type QualityViewSyncMessage = {
	type: 'sync';
	snapshot: QualityWorkspaceSnapshot;
	selectedUri?: string;
};

type QualityViewHostMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'selectArtifact'; uri: string }
	| { type: 'openArtifact' }
	| { type: 'openReference'; token: string };

type QualityViewIncomingMessage = QualityViewSyncMessage | QualityViewHostMessage;

interface QualityViewState {
	selectedUri?: string;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const appElement = document.getElementById('app');
if (!appElement) {
	throw new Error('Quality view root element is missing.');
}
const app = appElement as HTMLElement;

const persistedState = vscode.getState<QualityViewState>();
let snapshot: QualityWorkspaceSnapshot = {
	state: 'missing',
	message: 'Loading quality artifacts...',
	artifacts: []
};
let selectedUri = persistedState?.selectedUri;

window.addEventListener('message', (event: MessageEvent<QualityViewIncomingMessage>) => {
	const message = event.data;
	if (!message || message.type !== 'sync') {
		return;
	}

	snapshot = message.snapshot;
	selectedUri = resolveSelectedUri(message.snapshot, message.selectedUri ?? selectedUri);
	persistState();
	render();
});

vscode.postMessage({ type: 'ready' } satisfies QualityViewHostMessage);
render();

function render(): void {
	const selected = getSelectedArtifact();
	const shell = document.createElement('div');
	shell.className = 'panel';

	shell.append(
		createHeroCard(selected),
		createSummaryCard(selected),
		createGroupCard('Findings', 'Locally discovered findings or issues.', selected?.findings ?? [], 'No findings were extracted from the selected artifact.'),
		createGroupCard('Coverage and trace evidence', 'Requirement coverage, trace evidence, or related verification data.', selected?.coverageEvidence ?? [], 'No coverage or trace evidence was extracted from the selected artifact.'),
		createGroupCard('Critical files and tests', 'Files or test targets surfaced by the local artifact.', [...(selected?.criticalFiles ?? []), ...(selected?.tests ?? [])], 'No file or test targets were extracted from the selected artifact.'),
		createGroupCard('Attestation aggregates', 'Local attestation snapshots or aggregate summaries.', selected?.attestationAggregates ?? [], 'No attestation aggregates were extracted from the selected artifact.'),
		createReferenceCard(selected),
		createPreviewCard(selected)
	);

	app.replaceChildren(shell);
	updateSelectionControl();
}

function createHeroCard(selected: QualityArtifactSnapshot | undefined): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card hero';

	const header = document.createElement('div');
	header.className = 'hero__header';

	const title = document.createElement('div');
	title.className = 'hero__title';
	const heading = document.createElement('h1');
	heading.textContent = 'Spec Trace Quality';
	const subtitle = document.createElement('div');
	subtitle.className = 'muted';
	subtitle.textContent = snapshot.message;
	title.append(heading, subtitle);

	const toolbar = document.createElement('div');
	toolbar.className = 'toolbar';
	toolbar.append(
		createButton('Refresh', () => vscode.postMessage({ type: 'refresh' }), 'secondary'),
		createButton('Open raw', () => vscode.postMessage({ type: 'openArtifact' }))
	);

	header.append(title, toolbar);

	const selectRow = document.createElement('div');
	selectRow.className = 'field field--wide';
	const label = document.createElement('label');
	label.setAttribute('for', 'artifact-select');
	label.textContent = 'Artifact';
	const select = document.createElement('select');
	select.id = 'artifact-select';
	select.addEventListener('change', () => {
		selectedUri = select.value;
		vscode.postMessage({ type: 'selectArtifact', uri: select.value });
		persistState();
		render();
	});
	for (const artifact of snapshot.artifacts) {
		const option = document.createElement('option');
		option.value = artifactUriToString(artifact.uri);
		option.textContent = `${artifact.label} · ${artifact.relativePath}`;
		select.append(option);
	}
	selectRow.append(label, select);

	const bannerSlot = document.createElement('div');
	bannerSlot.id = 'banner-slot';
	const banner = createBanner(selected);
	if (banner) {
		bannerSlot.append(banner);
	}

	const chips = document.createElement('div');
	chips.id = 'status-chips';
	chips.className = 'chips';
	chips.append(
		createChip(snapshot.state),
		createChip(selected?.kind ?? 'none'),
		createChip(selected?.format ?? 'unknown'),
		createChip(selected?.health ?? 'missing')
	);

	card.append(header, bannerSlot, selectRow, chips);
	return card;
}

function createSummaryCard(selected: QualityArtifactSnapshot | undefined): HTMLElement {
	const card = document.createElement('section');
	card.id = 'summary-card';
	card.className = 'card stack';
	const heading = document.createElement('h2');
	heading.textContent = 'Summary';
	card.append(heading);

	if (!selected) {
		card.append(createEmptyState('No quality artifacts were found in this workspace.'));
		return card;
	}

	const title = document.createElement('div');
	title.className = 'summary-title';
	title.textContent = selected.label;

	const grid = document.createElement('div');
	grid.className = 'summary-grid';
	grid.append(
		createMetric('Status', selected.status),
		createMetric('Test result', selected.testResult),
		createMetric('Coverage', selected.coverage),
		createMetric('Health', selected.health)
	);

	const meta = document.createElement('div');
	meta.className = 'muted';
	meta.textContent = `${selected.relativePath} · ${selected.description}`;

	card.append(title, grid, meta);
	return card;
}

function createGroupCard(title: string, description: string, items: readonly string[], emptyMessage: string): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card stack';
	const heading = document.createElement('h2');
	heading.textContent = title;
	const subtitle = document.createElement('div');
	subtitle.className = 'muted';
	subtitle.textContent = description;
	card.append(heading, subtitle);

	if (items.length === 0) {
		card.append(createEmptyState(emptyMessage));
		return card;
	}

	const list = document.createElement('ul');
	list.className = 'list';
	for (const itemText of items) {
		const item = document.createElement('li');
		item.className = 'list-item';
		item.textContent = itemText;
		list.append(item);
	}

	card.append(list);
	return card;
}

function createReferenceCard(selected: QualityArtifactSnapshot | undefined): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card stack';
	const heading = document.createElement('h2');
	heading.textContent = 'Local references';
	const subtitle = document.createElement('div');
	subtitle.className = 'muted';
	subtitle.textContent = 'Open local Spec Trace targets referenced by the selected quality artifact.';
	card.append(heading, subtitle);

	if (!selected || selected.references.length === 0) {
		card.append(createEmptyState('No resolvable references were extracted from the selected artifact.'));
		return card;
	}

	const list = document.createElement('ul');
	list.className = 'list';
	for (const reference of selected.references) {
		const item = document.createElement('li');
		item.className = 'list-item';

		const row = document.createElement('div');
		row.className = 'list-item__row';
		const title = document.createElement('div');
		title.className = 'list-item__title';
		title.textContent = `${reference.field}: ${reference.value}`;
		const button = createButton(reference.resolved ? 'Open target' : 'Open source', () => vscode.postMessage({ type: 'openReference', token: reference.value }), reference.resolved ? 'primary' : 'secondary');
		row.append(title, button);

		const meta = document.createElement('div');
		meta.className = 'list-item__meta';
		meta.textContent = reference.resolved
			? `${reference.description} · ${reference.targetOpenKind ?? 'text'}`
			: `${reference.description} · unresolved locally`;

		item.append(row, meta);
		list.append(item);
	}

	card.append(list);
	return card;
}

function createPreviewCard(selected: QualityArtifactSnapshot | undefined): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card stack';
	const heading = document.createElement('h2');
	heading.textContent = 'Raw preview';
	const subtitle = document.createElement('div');
	subtitle.className = 'muted';
	subtitle.textContent = 'Collapsed by default to keep the summary primary.';
	card.append(heading, subtitle);

	if (!selected) {
		card.append(createEmptyState('No raw preview is available.'));
		return card;
	}

	const details = document.createElement('details');
	const summary = document.createElement('summary');
	summary.textContent = 'Preview';
	const pre = document.createElement('pre');
	pre.textContent = selected.rawPreview;
	details.append(summary, pre);
	card.append(details);
	return card;
}

function createMetric(label: string, value: string): HTMLElement {
	const metric = document.createElement('div');
	metric.className = 'metric';
	const valueEl = document.createElement('div');
	valueEl.className = 'metric__value';
	valueEl.textContent = value.length > 0 ? value : 'unknown';
	const labelEl = document.createElement('div');
	labelEl.className = 'metric__label';
	labelEl.textContent = label;
	metric.append(valueEl, labelEl);
	return metric;
}

function createChip(value: string): HTMLElement {
	const chip = document.createElement('span');
	chip.className = 'chip';
	chip.textContent = value;
	return chip;
}

function createButton(label: string, onClick: () => void, tone: 'primary' | 'secondary' = 'primary'): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = tone === 'secondary' ? 'secondary' : '';
	button.textContent = label;
	button.addEventListener('click', onClick);
	return button;
}

function createBanner(selected: QualityArtifactSnapshot | undefined): HTMLElement | undefined {
	if (!selected) {
		return undefined;
	}

	if (snapshot.state === 'missing') {
		const banner = document.createElement('div');
		banner.className = 'banner';
		banner.textContent = snapshot.message;
		return banner;
	}

	if (selected.health === 'error') {
		return createBannerWithTone(selected.healthMessage, 'error');
	}

	if (selected.health === 'warning') {
		return createBannerWithTone(selected.healthMessage, 'warning');
	}

	return undefined;
}

function createBannerWithTone(message: string, tone: 'warning' | 'error'): HTMLElement {
	const banner = document.createElement('div');
	banner.className = `banner banner--${tone}`;
	banner.textContent = message;
	return banner;
}

function createEmptyState(message: string): HTMLElement {
	const empty = document.createElement('div');
	empty.className = 'empty muted';
	empty.textContent = message;
	return empty;
}

function getSelectedArtifact(): QualityArtifactSnapshot | undefined {
	const targetUri = resolveSelectedUri(snapshot, selectedUri);
	return snapshot.artifacts.find((artifact) => artifactUriToString(artifact.uri) === targetUri);
}

function resolveSelectedUri(currentSnapshot: QualityWorkspaceSnapshot, targetUri: string | undefined): string | undefined {
	if (!targetUri) {
		return currentSnapshot.artifacts[0] ? artifactUriToString(currentSnapshot.artifacts[0].uri) : undefined;
	}

	return currentSnapshot.artifacts.some((artifact) => artifactUriToString(artifact.uri) === targetUri)
		? targetUri
		: currentSnapshot.artifacts[0] ? artifactUriToString(currentSnapshot.artifacts[0].uri) : undefined;
}

function updateSelectionControl(): void {
	const select = document.getElementById('artifact-select') as HTMLSelectElement | null;
	if (!select) {
		return;
	}

	if (select.options.length === 0) {
		return;
	}

	const targetUri = resolveSelectedUri(snapshot, selectedUri);
	if (targetUri) {
		select.value = targetUri;
	}

	if (!select.value && select.options.length > 0) {
		select.selectedIndex = 0;
	}
}

function persistState(): void {
	vscode.setState({
		selectedUri
	} satisfies QualityViewState);
}

function artifactUriToString(uri: unknown): string {
	if (typeof uri === 'string') {
		return uri;
	}

	if (!uri || typeof uri !== 'object') {
		return String(uri);
	}

	const candidate = uri as {
		scheme?: unknown;
		authority?: unknown;
		path?: unknown;
		query?: unknown;
		fragment?: unknown;
		fsPath?: unknown;
	};

	if (typeof candidate.scheme === 'string' && typeof candidate.path === 'string') {
		const authority = typeof candidate.authority === 'string' ? candidate.authority : '';
		const query = typeof candidate.query === 'string' && candidate.query.length > 0 ? `?${candidate.query}` : '';
		const fragment = typeof candidate.fragment === 'string' && candidate.fragment.length > 0 ? `#${candidate.fragment}` : '';
		if (candidate.scheme === 'file' || authority.length > 0) {
			return `${candidate.scheme}://${authority}${candidate.path}${query}${fragment}`;
		}

		return `${candidate.scheme}:${candidate.path}${query}${fragment}`;
	}

	if (typeof candidate.fsPath === 'string') {
		return candidate.fsPath;
	}

	return String(uri);
}
