#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { open } = require('@vscode/test-web');
const playwright = require('playwright');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeFixtureRelativePath = path.join('specs', 'requirements', 'spec-trace-vsce', 'SPEC-VSCE-EDITOR.json');
const screenshotDir = process.env.SPEC_TRACE_SMOKE_SCREENSHOT_DIR;
const smokeCommit = process.env.SPEC_TRACE_SMOKE_COMMIT;
let launchedBrowser;
let coverageSmokeState;

const originalChromiumLaunch = playwright.chromium.launch.bind(playwright.chromium);
playwright.chromium.launch = async (...args) => {
	launchedBrowser = await originalChromiumLaunch(...args);
	return launchedBrowser;
};

async function main() {
	const port = await findFreePort(3100, 3199);
	let workspaceRoot;
	let server;

	try {
		workspaceRoot = await createSmokeWorkspace();
		server = await open({
			browserType: 'chromium',
			quality: smokeCommit ? 'insiders' : undefined,
			commit: smokeCommit,
			extensionDevelopmentPath: repoRoot,
			folderPath: workspaceRoot,
			host: 'localhost',
			port,
			headless: true,
			printServerLog: false
		});

		const browser = launchedBrowser;
		if (!browser) {
			throw new Error('Failed to capture the Playwright browser launched by @vscode/test-web.');
		}

		const context = browser.contexts()[0];
		const page = context.pages()[0] ?? await context.newPage();
		page.setDefaultTimeout(30_000);
		await page.setViewportSize({ width: 1600, height: 1200 });
		page.on('console', (message) => {
			const text = message.text();
			if (text.includes('spec-trace-vsce') || text.includes('Extension Host')) {
				console.log('PAGE CONSOLE:', text);
			}
		});
		page.on('pageerror', (error) => {
			console.error('PAGE ERROR:', error.message);
		});

		await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
		await openRepositoryExplorer(page);
		await verifyRepositoryExplorer(page);
		await expandRequirementTree(page);
		await verifyExpandedRequirementTree(page);
		await openTargetFile(page);

		const frame = await findCustomEditorFrame(page);
		await frame.locator('.requirement-index-row').first().waitFor({ state: 'visible' });
		await frame.locator('[data-card-path^="requirements["]').first().waitFor({ state: 'visible' });
		await captureSmokeScreenshot(frame, 'initial');

		await verifyUiKitSurface(frame);
		await verifyCollapsedDefaults(frame);
		await verifyRequirementIndexSearchAndFilter(frame);
		await verifyCoverageSummaryAndDrillDown(frame);
		await verifyRequirementDetailNavigation(frame);
		await verifyOpenQuestionsAddItemKeepsState(frame);
		await verifySupplementalSectionsAddItemKeepsState(frame);
		await verifyRequirementNotesAddItemKeepsState(frame);
		await verifySaveAndReloadPersistence(page);
	} finally {
		if (launchedBrowser) {
			await launchedBrowser.close().catch(() => {});
		}
		if (server) {
			await Promise.resolve(server.dispose());
		}
		if (workspaceRoot) {
			await cleanupSmokeWorkspace(workspaceRoot);
		}
	}
}

async function openRepositoryExplorer(page) {
	await runCommandPaletteCommand(page, 'Open Repository Explorer');
	await waitForSidebarTree(page);
}

async function openTargetFile(page) {
	await runCommandPaletteCommand(page, 'Open Smoke Fixture');
}

async function expandRequirementTree(page) {
	const tree = page.locator('.part.sidebar [role="treeitem"]');
	const domainNode = tree.filter({ hasText: 'spec-trace-vsce' }).first();
	await domainNode.locator('.monaco-tl-twistie').click({ force: true });
	await waitForTreeRowExpanded(domainNode);

	const specificationNode = tree.filter({ hasText: 'SPEC-VSCE-EDITOR' }).first();
	await specificationNode.waitFor({ state: 'visible', timeout: 10_000 });
	await specificationNode.locator('.monaco-tl-twistie').click({ force: true });
	await waitForTreeRowExpanded(specificationNode);
}

async function findVisibleInput(page, selector, timeout = 10_000) {
	const inputs = page.locator(selector);
	await inputs.first().waitFor({ state: 'attached', timeout });

	const count = await inputs.count();
	for (let index = 0; index < count; index += 1) {
		const input = inputs.nth(index);
		if (await input.isVisible()) {
			return input;
		}
	}

	return inputs.first();
}

async function waitForQuickOpenResult(page, targetName, timeout) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const optionTexts = await page.locator('[role="option"]').evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ''));
		if (optionTexts.some((text) => text.includes(targetName))) {
			return;
		}
		await pause(100);
	}

	throw new Error(`Timed out waiting for quick open to show ${targetName}.`);
}

async function waitForSidebarTree(page) {
	const treeItems = page.locator('.part.sidebar [role="treeitem"]');
	await treeItems.first().waitFor({ state: 'visible', timeout: 10_000 });
}

async function waitForTreeRowExpanded(row, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const expanded = await row.evaluate((element) => element.getAttribute('aria-expanded') === 'true').catch(() => false);
		if (expanded) {
			return;
		}

		await pause(100);
	}

	throw new Error('Timed out waiting for tree row to expand.');
}

async function findCustomEditorFrame(page) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		for (const frame of page.frames()) {
			let hasEditorSurface = false;
			try {
				hasEditorSurface = ((await frame.locator('[data-card-path="document-fields"]').count()) > 0
					&& await frame.locator('[data-card-path="document-fields"]').isVisible())
					|| ((await frame.locator('.requirement-index-row').count()) > 0
						&& await frame.locator('.requirement-index-row').first().isVisible())
					|| ((await frame.locator('.requirement-detail-card').count()) > 0
						&& await frame.locator('.requirement-detail-card').isVisible());
			} catch {
				hasEditorSurface = false;
			}

			if (hasEditorSurface) {
				return frame;
			}
		}

		await pause(250);
	}

	throw new Error('Timed out waiting for the custom editor webview frame.');
}

async function verifyUiKitSurface(frame) {
	const surface = await frame.evaluate(() => {
		const page = document.querySelector('inc-page');
		const header = document.querySelector('inc-page-header');
		const section = document.querySelector('inc-section');
		const card = document.querySelector('inc-card');
		const disclosure = document.querySelector('inc-disclosure');
		const field = document.querySelector('inc-field');
		const validation = document.querySelector('inc-validation-summary');
		const readonlyField = document.querySelector('inc-readonly-field');
		const listGroup = document.querySelector('inc-list-group');
		const badge = document.querySelector('inc-badge');
		const button = document.querySelector('inc-button');
		const buttonToolbar = document.querySelector('inc-button-toolbar');
		const buttonGroup = document.querySelector('inc-button-group');
		const keyValueGrid = document.querySelector('inc-key-value-grid');
		const documentFieldsCard = document.querySelector('[data-card-path="document-fields"]');
		const statusSelect = document.querySelector('#status-input');
		const saveButton = document.querySelector('inc-button[variant="primary"]');

		return {
			bodyClass: document.body.className,
			hasPage: Boolean(page),
			hasHeader: Boolean(header),
			hasSection: Boolean(section),
			hasCard: Boolean(card),
			hasDisclosure: Boolean(disclosure),
			hasField: Boolean(field),
			hasValidation: Boolean(validation),
			hasReadonlyField: Boolean(readonlyField),
			hasListGroup: Boolean(listGroup),
			hasBadge: Boolean(badge),
			hasButton: Boolean(button),
			hasButtonToolbar: Boolean(buttonToolbar),
			hasButtonGroup: Boolean(buttonGroup),
			hasKeyValueGrid: Boolean(keyValueGrid),
			bodyBackgroundImage: getComputedStyle(document.body).backgroundImage,
			documentFieldsBackgroundImage: documentFieldsCard ? getComputedStyle(documentFieldsCard).backgroundImage : '',
			statusBackgroundImage: statusSelect ? getComputedStyle(statusSelect).backgroundImage : '',
			saveBackgroundImage: saveButton ? getComputedStyle(saveButton).backgroundImage : ''
		};
	});

	assert.ok(
		surface.bodyClass.includes('vscode-light') || surface.bodyClass.includes('vscode-high-contrast-light'),
		`Expected light theme classes, got: ${surface.bodyClass}`
	);
	assert.ok(surface.hasPage, 'Expected <inc-page> to be present.');
	assert.ok(surface.hasHeader, 'Expected <inc-page-header> to be present.');
	assert.ok(surface.hasSection, 'Expected <inc-section> to be present.');
	assert.ok(surface.hasCard, 'Expected <inc-card> to be present.');
	assert.ok(surface.hasDisclosure, 'Expected <inc-disclosure> to be present.');
	assert.ok(surface.hasField, 'Expected <inc-field> to be present.');
	assert.ok(typeof surface.hasValidation === 'boolean', 'Expected validation summary detection to complete.');
	assert.ok(surface.hasReadonlyField, 'Expected <inc-readonly-field> to be present.');
	assert.ok(surface.hasListGroup, 'Expected <inc-list-group> to be present.');
	assert.ok(surface.hasBadge, 'Expected <inc-badge> to be present.');
	assert.ok(surface.hasButton, 'Expected <inc-button> to be present.');
	assert.ok(surface.hasButtonToolbar, 'Expected <inc-button-toolbar> to be present.');
	assert.ok(surface.hasButtonGroup, 'Expected <inc-button-group> to be present.');
	assert.ok(surface.hasKeyValueGrid, 'Expected <inc-key-value-grid> to be present.');
	assert.ok(!/gradient/i.test(surface.bodyBackgroundImage), 'The host body should not paint gradient backgrounds.');
	assert.ok(!/gradient/i.test(surface.documentFieldsBackgroundImage), 'Document surfaces should not use host gradients.');
	assert.ok(!/gradient/i.test(surface.statusBackgroundImage), 'Controls should not use host gradients.');
	assert.ok(!/gradient/i.test(surface.saveBackgroundImage), 'Buttons should not use host gradients.');
}

async function verifyRepositoryExplorer(page) {
	const nodes = await readTreeNodes(page);

	assert.ok(nodes.some((node) => node.name.includes('Specifications')), 'Expected a Specifications category in the repository explorer.');
	assert.ok(nodes.some((node) => node.name.includes('Architectural Views')), 'Expected an Architectural Views category in the repository explorer.');
	assert.ok(nodes.some((node) => node.name.includes('Work Items')), 'Expected a Work Items category in the repository explorer.');
	assert.ok(nodes.some((node) => node.name.includes('Verification Documents')), 'Expected a Verification Documents category in the repository explorer.');
	assert.ok(nodes.some((node) => node.name.includes('spec-trace-vsce')), 'Expected the spec domain node to be present.');
	assert.ok(nodes.some((node) => node.name.includes('WB')), 'Expected the WB domain node to be present.');
}

async function verifyExpandedRequirementTree(page) {
	await waitForTreeNode(page, (node) => node.name.includes('0001'), 'Expected the requirement suffix to be visible after expansion.');
	const nodes = await readTreeNodes(page);
	assert.ok(nodes.some((node) => node.name.includes('SPEC-VSCE-EDITOR')), 'Expected the specification artifact node to be expanded.');
}

async function waitForTreeNode(page, predicate, message, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const nodes = await readTreeNodes(page);
		if (nodes.some(predicate)) {
			return;
		}

		await pause(100);
	}

	throw new Error(message);
}

async function readTreeNodes(page) {
	return await page.locator('.part.sidebar [role="treeitem"]').evaluateAll((elements) => elements.map((element) => {
		const iconLabel = element.querySelector('.label-name')?.textContent?.trim() ?? '';
		const description = element.querySelector('.label-description')?.textContent?.trim() ?? '';
		return {
			name: iconLabel,
			description
		};
	}));
}

async function verifyCollapsedDefaults(frame) {
	const coverageSummary = frame.locator('[data-card-path="coverage-summary"]');
	const documentFields = frame.locator('[data-card-path="document-fields"]');
	const openQuestions = frame.locator('[data-card-path="open_questions"]');
	const supplementalSections = frame.locator('[data-card-path="supplemental_sections"]');
	const requirementIndexRow = frame.locator('.requirement-index-row').first();
	const requirementDetail = frame.locator('.requirement-detail-card');

	assert.equal(await isDetailsOpen(coverageSummary), true, 'Coverage should start expanded.');
	assert.equal(await isDetailsOpen(documentFields), false, 'Document fields should start collapsed.');
	assert.equal(await isDetailsOpen(openQuestions), false, 'Open questions should start collapsed.');
	assert.equal(await isDetailsOpen(supplementalSections), false, 'Supplemental sections should start collapsed.');
	await requirementIndexRow.waitFor({ state: 'visible' });
	assert.equal(await requirementDetail.count(), 0, 'Requirement detail should not be visible in the default index view.');
}

async function verifyCoverageSummaryAndDrillDown(frame) {
	assert.ok(coverageSmokeState, 'Coverage smoke fixture state should be initialized.');
	const coverageSummary = frame.locator('[data-card-path="coverage-summary"]');
	const coverageChip = frame.locator('#coverage-chip');
	const coverageMeta = frame.locator('#coverage-meta-text');
	const coverageSelect = frame.locator('#coverage-requirement-select');

	await waitForDetailsState(coverageSummary, true, 'Coverage summary should stay expanded.');
	await waitForLocatorText(coverageChip, `${coverageSmokeState.coveredCount}/${coverageSmokeState.totalRequirements} covered`);
	await waitForLocatorText(coverageMeta, coverageSummaryMetaText(coverageSmokeState));

	await coverageSelect.selectOption({ index: 1 });
	await waitForLocatorText(frame.locator('#coverage-selected-status [data-inc-readonly-value="true"]'), 'Partial');
	await waitForLocatorText(frame.locator('#coverage-selected-coverage-count [data-inc-readonly-value="true"]'), '0');
	await waitForLocatorText(frame.locator('#coverage-selected-trace-count [data-inc-readonly-value="true"]'), '1');
	await waitForLocatorText(frame.locator('#coverage-selected-notes-count [data-inc-readonly-value="true"]'), '1');
	await waitForLocatorText(frame.locator('#coverage-selected-id [data-inc-readonly-value="true"]'), coverageSmokeState.partialRequirementId);
	await captureSmokeScreenshot(frame, 'coverage-drilldown');
}

async function verifyRequirementIndexSearchAndFilter(frame) {
	assert.ok(coverageSmokeState, 'Coverage smoke fixture state should be initialized.');
	await setRequirementSearch(frame, coverageSmokeState.partialRequirementId);
	await waitForRequirementRowCount(frame, 1);
	await waitForLocatorText(frame.locator('.requirement-index-row .requirement-summary-id').first(), coverageSmokeState.partialRequirementId);

	await setRequirementSearch(frame, '');
	await waitForRequirementRowCount(frame, coverageSmokeState.totalRequirements);

	await frame.locator('inc-button', { hasText: 'Partial' }).click();
	await waitForRequirementRowCount(frame, coverageSmokeState.partialCount);
	await waitForLocatorTextContains(frame.locator('.requirement-index-results'), `${coverageSmokeState.partialCount} of ${coverageSmokeState.totalRequirements} requirements shown`);

	await frame.locator('inc-button', { hasText: 'All' }).click();
	await waitForRequirementRowCount(frame, coverageSmokeState.totalRequirements);
	await captureSmokeScreenshot(frame, 'requirement-index-filtered');
}

async function verifyOpenQuestionsAddItemKeepsState(frame) {
	const openQuestions = frame.locator('[data-card-path="open_questions"]');
	await openQuestions.locator('summary').click();
	await waitForDetailsState(openQuestions, true, 'Open questions should expand when clicked.');

	await openQuestions.locator('inc-button').click();
	await pause(250);

	await waitForDetailsState(frame.locator('[data-card-path="open_questions"]'), true, 'Adding an open question should not collapse the section.');
	await captureSmokeScreenshot(frame, 'open-questions-added');
}

async function verifySupplementalSectionsAddItemKeepsState(frame) {
	const supplementalSections = frame.locator('[data-card-path="supplemental_sections"]');
	await supplementalSections.locator('summary').click();
	await waitForDetailsState(supplementalSections, true, 'Supplemental sections should expand when clicked.');

	await supplementalSections.locator('inc-button').click();
	await pause(250);

	await waitForDetailsState(
		frame.locator('[data-card-path="supplemental_sections"]'),
		true,
		'Adding a supplemental section should not collapse the section.'
	);
	await captureSmokeScreenshot(frame, 'supplemental-sections-added');
}

async function verifyRequirementDetailNavigation(frame) {
	assert.ok(coverageSmokeState, 'Coverage smoke fixture state should be initialized.');
	const firstRequirementRow = frame.locator('.requirement-index-row').first();
	await firstRequirementRow.click();
	await frame.locator('.requirement-detail-card').waitFor({ state: 'visible' });
	await captureSmokeScreenshot(frame, 'requirement-detail');

	await frame.locator('inc-button', { hasText: 'Next' }).click();
	await waitForLocatorText(frame.locator('#selected-requirement-subtitle'), `${coverageSmokeState.partialRequirementId} · 2 of ${coverageSmokeState.totalRequirements}`);

	await frame.locator('inc-button', { hasText: 'Previous' }).click();
	await waitForLocatorText(frame.locator('#selected-requirement-subtitle'), `${coverageSmokeState.coveredRequirementId} · 1 of ${coverageSmokeState.totalRequirements}`);

	await frame.locator('inc-button[label="Return to the requirements index"]').click();
	await frame.locator('.requirement-index-row').first().waitFor({ state: 'visible' });
}

async function verifyRequirementNotesAddItemKeepsState(frame) {
	const firstRequirementRow = frame.locator('.requirement-index-row').first();
	await firstRequirementRow.click();
	await frame.locator('.requirement-detail-card').waitFor({ state: 'visible' });
	await frame.locator('inc-button', { hasText: 'Edit requirement' }).click();
	await frame.locator('inc-button[variant="primary"]').waitFor({ state: 'visible' });
	await waitForLocatorText(frame.locator('#selected-requirement-subtitle'), `${coverageSmokeState.coveredRequirementId} · 1 of ${coverageSmokeState.totalRequirements}`);

	const notesField = frame.locator('.requirement-detail-card [data-validation-path$=".notes"]').first();
	await notesField.locator('inc-button').click();
	await pause(250);

	await waitForLocatorText(frame.locator('#selected-requirement-subtitle'), `${coverageSmokeState.coveredRequirementId} · 1 of ${coverageSmokeState.totalRequirements}`);
	await frame.locator('inc-button[label="Return to the read-only requirement details page"]').click();
	await frame.locator('inc-button[label="Return to the requirements index"]').click();
	await frame.locator('.requirement-index-row').first().waitFor({ state: 'visible' });
	await captureSmokeScreenshot(frame, 'requirement-notes-added');
}

async function verifySaveAndReloadPersistence(page) {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
	await openRepositoryExplorer(page);
	await openTargetFile(page);

	let frame = await findCustomEditorFrame(page);
	const documentFields = frame.locator('[data-card-path="document-fields"]');
	await waitForLocatorText(frame.locator('#dirty-chip'), 'Clean');
	await waitForLocatorText(frame.locator('#sync-chip'), 'Synced');
	if (!(await isDetailsOpen(documentFields))) {
		await documentFields.locator('summary').click();
	}

	const titleInput = frame.locator('#title-input');
	await titleInput.waitFor({ state: 'visible' });
	const originalTitle = await titleInput.inputValue();
	const persistedTitle = `${originalTitle || 'Spec Trace'} [playwright smoke]`;

	await titleInput.fill(persistedTitle);
	await waitForLocatorText(frame.locator('#dirty-chip'), 'Dirty');
	await frame.locator('.requirement-index-row').first().click();
	await frame.locator('.requirement-detail-card').waitFor({ state: 'visible' });
	await frame.locator('inc-button', { hasText: 'Edit requirement' }).click();
	await frame.locator('inc-button[variant="primary"]').click();
	await waitForLocatorText(frame.locator('#dirty-chip'), 'Clean');
	await waitForLocatorText(frame.locator('#sync-chip'), 'Synced');
	await frame.locator('inc-button[label="Return to the read-only requirement details page"]').click();
	await frame.locator('inc-button[label="Return to the requirements index"]').click();
	await frame.locator('[data-card-path="document-fields"]').waitFor({ state: 'visible' });

	await closeActiveEditor(page);
	await openRepositoryExplorer(page);
	await openTargetFile(page);

	frame = await findCustomEditorFrame(page);
	await frame.locator('[data-card-path="document-fields"]').waitFor({ state: 'visible' });
	const reloadedDocumentFields = frame.locator('[data-card-path="document-fields"]');
	if (!(await isDetailsOpen(reloadedDocumentFields))) {
		await reloadedDocumentFields.locator('summary').click();
	}
	await titleInputReload(frame, persistedTitle);
	await waitForLocatorText(frame.locator('#dirty-chip'), 'Clean');
	await waitForLocatorText(frame.locator('#sync-chip'), 'Synced');
}

async function titleInputReload(frame, expectedTitle) {
	const titleInput = frame.locator('#title-input');
	await titleInput.waitFor({ state: 'visible' });
	assert.equal(await titleInput.inputValue(), expectedTitle, 'Expected the saved title to be restored after reload.');
}

async function waitForLocatorText(locator, expectedText, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if ((await locator.textContent())?.trim() === expectedText) {
			return;
		}

		await pause(100);
	}

	const actualText = (await locator.textContent()).trim();
	throw new Error(`Timed out waiting for ${expectedText}. Actual text: ${actualText}`);
}

async function waitForLocatorTextContains(locator, expectedText, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if ((await locator.textContent())?.trim().includes(expectedText)) {
			return;
		}

		await pause(100);
	}

	const actualText = (await locator.textContent()).trim();
	throw new Error(`Timed out waiting for text containing ${expectedText}. Actual text: ${actualText}`);
}

async function waitForRequirementRowCount(frame, expectedCount, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if ((await frame.locator('.requirement-index-row').count()) === expectedCount) {
			return;
		}

		await pause(100);
	}

	throw new Error(`Timed out waiting for ${expectedCount} requirement rows.`);
}

async function setRequirementSearch(frame, value) {
	await frame.evaluate((nextValue) => {
		const input = document.getElementById('requirement-search-input');
		if (!(input instanceof HTMLInputElement)) {
			throw new Error('Requirement search input is missing.');
		}

		input.value = nextValue;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, value);
}

async function closeActiveEditor(page) {
	await runCommandPaletteCommand(page, 'Close Editor');
	await page.keyboard.press('Escape');
	await pause(500);
}

async function runCommandPaletteCommand(page, commandLabel) {
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
	const commandInput = await findVisibleInput(page, 'input', 10_000);
	await commandInput.fill(`>${commandLabel}`);
	await waitForQuickOpenResult(page, commandLabel, 10_000);

	const commandOptions = page.locator('[role="option"]');
	const optionTexts = await commandOptions.evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ''));
	const matchingIndex = optionTexts.findIndex((text) => text.includes(commandLabel));
	if (matchingIndex >= 0) {
		await commandInput.press('ArrowDown');
		await pause(100);
		await commandInput.press('Enter');
		return;
	}

	await commandInput.press('Enter');
}

async function createSmokeWorkspace() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-trace-vsce-smoke-'));
	await copySmokeFixture(workspaceRoot, path.join('specs', 'requirements', '_index.md'));
	await copySmokeFixture(workspaceRoot, path.join('specs', 'requirements', 'spec-trace-vsce', '_index.md'));
	await copySmokeFixture(workspaceRoot, path.join('specs', 'requirements', 'spec-trace-vsce', 'SPEC-VSCE-EDITOR.json'));
	coverageSmokeState = await seedCoverageEvidence(workspaceRoot);
	await copySmokeFixture(workspaceRoot, path.join('specs', 'architecture', 'WB', '_index.md'));
	await copySmokeFixture(workspaceRoot, path.join('specs', 'work-items', 'WB', '_index.md'));
	await copySmokeFixture(workspaceRoot, path.join('specs', 'verification', 'WB', '_index.md'));

	await writeSmokeMarkdown(
		workspaceRoot,
		path.join('specs', 'architecture', 'WB', 'ARC-WB-0001.md'),
		'ARC-WB-0001',
		'Repository navigation architecture',
		'The tree view MUST expose repository navigation from the sidebar.'
	);
	await writeSmokeMarkdown(
		workspaceRoot,
		path.join('specs', 'work-items', 'WB', 'WI-WB-0001.md'),
		'WI-WB-0001',
		'Add repository tree view',
		'The extension MUST add a tree view for specifications and related artifacts.'
	);
	await writeSmokeMarkdown(
		workspaceRoot,
		path.join('specs', 'verification', 'WB', 'VER-WB-0001.md'),
		'VER-WB-0001',
		'Tree view smoke verification',
		'The tree view MUST surface category, domain, and document nodes.'
	);

	return workspaceRoot;
}

async function seedCoverageEvidence(workspaceRoot) {
	const specPath = path.join(workspaceRoot, smokeFixtureRelativePath);
	const text = await fs.readFile(specPath, 'utf8');
	const document = JSON.parse(text);

	if (!Array.isArray(document.requirements) || document.requirements.length < 2) {
		throw new Error('The smoke fixture does not contain enough requirements to seed coverage evidence.');
	}

	const coveredRequirement = document.requirements[0];
	coveredRequirement.coverage = ['browser host smoke coverage'];
	coveredRequirement.trace = [];
	coveredRequirement.notes = [];

	const partialRequirement = document.requirements[1];
	partialRequirement.coverage = [];
	partialRequirement.trace = ['REQ-VSCE-EDITOR-0002'];
	partialRequirement.notes = ['Verified in browser smoke.'];

	await fs.writeFile(specPath, `${JSON.stringify(document, undefined, 2)}\n`);

	const requirementSummaries = document.requirements.map((requirement) => summarizeCoverageRequirement(requirement));

	return {
		totalRequirements: document.requirements.length,
		coveredCount: requirementSummaries.filter((summary) => summary.status === 'covered').length,
		partialCount: requirementSummaries.filter((summary) => summary.status === 'partial').length,
		missingCount: requirementSummaries.filter((summary) => summary.status === 'missing').length,
		coveredRequirementId: coveredRequirement.id,
		partialRequirementId: partialRequirement.id
	};
}

function summarizeCoverageRequirement(requirement) {
	const coverageCount = countMeaningfulStrings(requirement.coverage);
	const traceCount = countMeaningfulStrings(requirement.trace);
	const notesCount = countMeaningfulStrings(requirement.notes);

	return {
		status: coverageCount > 0 ? 'covered' : (traceCount > 0 || notesCount > 0 ? 'partial' : 'missing'),
		coverageCount,
		traceCount,
		notesCount
	};
}

function countMeaningfulStrings(value) {
	if (!Array.isArray(value)) {
		return 0;
	}

	return value.filter((item) => typeof item === 'string' && item.trim().length > 0).length;
}

function coverageSummaryMetaText(summary) {
	if (summary.totalRequirements === 0) {
		return 'Add requirements to start tracking coverage.';
	}

	if (summary.missingCount === 0 && summary.partialCount === 0) {
		return 'All requirements are covered.';
	}

	if (summary.missingCount === 0) {
		return `${summary.partialCount} partial requirement${summary.partialCount === 1 ? ' still needs' : 's still need'} coverage entries.`;
	}

	const missingLabel = `${summary.missingCount} missing requirement${summary.missingCount === 1 ? ' has' : 's have'} no evidence`;
	const partialLabel = summary.partialCount > 0
		? ` ${summary.partialCount} partial requirement${summary.partialCount === 1 ? ' still needs' : 's still need'} coverage entries.`
		: '';
	return `${missingLabel}.${partialLabel}`.trim();
}

async function copySmokeFixture(workspaceRoot, relativePath) {
	const sourcePath = path.join(repoRoot, relativePath);
	const destinationPath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	await fs.copyFile(sourcePath, destinationPath);
}

async function writeSmokeMarkdown(workspaceRoot, relativePath, artifactId, title, statement) {
	const destinationPath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	await fs.writeFile(destinationPath, [
		'---',
		`artifact_id: ${artifactId}`,
		`title: ${title}`,
		'---',
		'',
		statement,
		''
	].join('\n'));
}

async function cleanupSmokeWorkspace(workspaceRoot) {
	await fs.rm(workspaceRoot, { recursive: true, force: true });
}

async function captureSmokeScreenshot(frame, name) {
	if (!screenshotDir) {
		return;
	}

	const targetPath = path.resolve(screenshotDir, `${name}.png`);
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	const frameElement = await frame.frameElement();
	await frameElement.screenshot({ path: targetPath });
	console.log(`Captured smoke screenshot at ${targetPath}`);
}

async function isDetailsOpen(locator) {
	return locator.evaluate((element) => {
		if (element instanceof HTMLDetailsElement) {
			return element.open;
		}

		if (element instanceof HTMLElement) {
			const innerDetails = element.querySelector('details.inc-disclosure');
			if (innerDetails instanceof HTMLDetailsElement) {
				return innerDetails.open;
			}

			return element.hasAttribute('open');
		}

		throw new Error('Expected an element with open state.');
	});
}

async function waitForDetailsState(locator, expectedOpen, message, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if ((await isDetailsOpen(locator)) === expectedOpen) {
			return;
		}

		await pause(100);
	}

	const state = await locator.evaluate((element) => ({
		tagName: element.tagName,
		className: element.className,
		open: element.hasAttribute('open'),
		outerHTML: element.outerHTML.slice(0, 400)
	})).catch(() => null);

	throw new Error(`${message}${state ? ` Current state: ${JSON.stringify(state)}` : ''}`);
}

async function findFreePort(startPort, endPort) {
	for (let port = startPort; port <= endPort; port += 1) {
		// eslint-disable-next-line no-await-in-loop
		const isFree = await isPortFreeOnLoopback(port);

		if (isFree) {
			return port;
		}
	}

	throw new Error(`Unable to find a free port between ${startPort} and ${endPort}.`);
}

async function isPortFreeOnLoopback(port) {
	const servers = [];
	const hosts = ['127.0.0.1', '::1'];

	try {
		for (const host of hosts) {
			// eslint-disable-next-line no-await-in-loop
			const isFree = await new Promise((resolve) => {
				const server = net.createServer();

				server.unref();
				server.once('error', () => resolve(false));
				server.listen({ host, port }, () => {
					servers.push(server);
					resolve(true);
				});
			});

			if (!isFree) {
				return false;
			}
		}

		return true;
	} finally {
		await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
	}
}

async function pause(milliseconds) {
	await new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
