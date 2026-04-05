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
let launchedBrowser;

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
		await openTargetFile(page);

		const frame = await findCustomEditorFrame(page);
		await frame.locator('[data-card-path="document-fields"]').waitFor({ state: 'visible' });
		await frame.locator('[data-card-path^="requirements["]').first().waitFor({ state: 'visible' });

		await verifyLightThemePalette(frame);
		await verifyCollapsedDefaults(frame);
		await verifyOpenQuestionsAddItemKeepsState(frame);
		await verifySupplementalSectionsAddItemKeepsState(frame);
		await verifyRequirementCoverageAddItemKeepsState(frame);
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

async function openTargetFile(page) {
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
	const commandInput = await findVisibleInput(page, 'input', 10_000);
	await commandInput.fill('>Spec Trace: Open Smoke Fixture');
	await waitForQuickOpenResult(page, 'Open Smoke Fixture', 10_000);

	const commandOptions = page.locator('[role="option"]');
	const optionTexts = await commandOptions.evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ''));
	const matchingIndex = optionTexts.findIndex((text) => text.includes('Open Smoke Fixture'));
	if (matchingIndex >= 0) {
		await commandInput.press('ArrowDown');
		await pause(100);
		await commandInput.press('Enter');
		return;
	}

	await commandInput.press('Enter');
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

async function findCustomEditorFrame(page) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		for (const frame of page.frames()) {
			let hasDocumentFields = false;
			try {
				hasDocumentFields = (await frame.locator('[data-card-path="document-fields"]').count()) > 0;
			} catch {
				hasDocumentFields = false;
			}

			if (hasDocumentFields) {
				return frame;
			}

			const bodyText = await frame.locator('body').innerText().catch(() => '');
			if (
				bodyText.includes('Spec Trace Spec File Custom Editor') ||
				bodyText.includes('Document fields') ||
				bodyText.includes('Requirements')
			) {
				return frame;
			}
		}

		await pause(250);
	}

	throw new Error('Timed out waiting for the custom editor webview frame.');
}

async function verifyLightThemePalette(frame) {
	const palette = await frame.evaluate(() => {
		const rootStyle = getComputedStyle(document.documentElement);
		const bodyStyle = getComputedStyle(document.body);
		const documentFieldsCard = document.querySelector('[data-card-path="document-fields"]');
		const statusSelect = document.querySelector('#status-input');
		const saveButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Save');

		return {
			bodyClass: document.body.className,
			pageBg: rootStyle.getPropertyValue('--page-bg').trim(),
			cardBg: rootStyle.getPropertyValue('--card-bg').trim(),
			controlBg: rootStyle.getPropertyValue('--control-bg').trim(),
			accent: rootStyle.getPropertyValue('--accent').trim(),
			bodyBackgroundImage: bodyStyle.backgroundImage,
			documentFieldsBackgroundImage: documentFieldsCard ? getComputedStyle(documentFieldsCard).backgroundImage : '',
			statusBackgroundImage: statusSelect ? getComputedStyle(statusSelect).backgroundImage : '',
			saveBackgroundImage: saveButton ? getComputedStyle(saveButton).backgroundImage : ''
		};
	});

	assert.ok(
		palette.bodyClass.includes('vscode-light') || palette.bodyClass.includes('vscode-high-contrast-light'),
		`Expected light theme classes, got: ${palette.bodyClass}`
	);
	assert.ok(palette.pageBg.length > 0, 'Missing --page-bg value.');
	assert.ok(palette.cardBg.length > 0, 'Missing --card-bg value.');
	assert.ok(palette.controlBg.length > 0, 'Missing --control-bg value.');
	assert.ok(palette.accent.length > 0, 'Missing --accent value.');
	assert.notStrictEqual(palette.pageBg, palette.cardBg, 'Page and card surfaces should not use the same color token.');
	assert.notStrictEqual(palette.cardBg, palette.controlBg, 'Card and control surfaces should not use the same color token.');
	assert.match(palette.bodyBackgroundImage, /gradient/i, 'Expected layered page background.');
	assert.notStrictEqual(
		palette.documentFieldsBackgroundImage,
		palette.saveBackgroundImage,
		'Cards and buttons should render with distinct background treatments.'
	);
	assert.notStrictEqual(
		palette.statusBackgroundImage,
		palette.saveBackgroundImage,
		'Dropdowns and primary actions should not collapse to the same surface style.'
	);
}

async function verifyCollapsedDefaults(frame) {
	const documentFields = frame.locator('[data-card-path="document-fields"]');
	const openQuestions = frame.locator('[data-card-path="open_questions"]');
	const supplementalSections = frame.locator('[data-card-path="supplemental_sections"]');
	const firstRequirement = frame.locator('[data-card-path^="requirements["]').first();

	assert.equal(await isDetailsOpen(documentFields), false, 'Document fields should start collapsed.');
	assert.equal(await isDetailsOpen(openQuestions), false, 'Open questions should start collapsed.');
	assert.equal(await isDetailsOpen(supplementalSections), false, 'Supplemental sections should start collapsed.');
	assert.equal(await isDetailsOpen(firstRequirement), false, 'Requirement cards should start collapsed.');
}

async function verifyOpenQuestionsAddItemKeepsState(frame) {
	const openQuestions = frame.locator('[data-card-path="open_questions"]');
	await openQuestions.locator('summary').click();
	assert.equal(await isDetailsOpen(openQuestions), true, 'Open questions should expand when clicked.');

	await openQuestions.getByRole('button', { name: 'Add question' }).click();
	await pause(250);

	assert.equal(await isDetailsOpen(frame.locator('[data-card-path="open_questions"]')), true, 'Adding an open question should not collapse the section.');
}

async function verifySupplementalSectionsAddItemKeepsState(frame) {
	const supplementalSections = frame.locator('[data-card-path="supplemental_sections"]');
	await supplementalSections.locator('summary').click();
	assert.equal(await isDetailsOpen(supplementalSections), true, 'Supplemental sections should expand when clicked.');

	await supplementalSections.getByRole('button', { name: 'Add section' }).click();
	await pause(250);

	assert.equal(
		await isDetailsOpen(frame.locator('[data-card-path="supplemental_sections"]')),
		true,
		'Adding a supplemental section should not collapse the section.'
	);
}

async function verifyRequirementCoverageAddItemKeepsState(frame) {
	const requirement = frame.locator('[data-card-path="requirements[0]"]');
	await requirement.locator('summary').click();
	assert.equal(await isDetailsOpen(requirement), true, 'The first requirement should expand when clicked.');

	const coverageField = requirement.locator('[data-validation-path$=".coverage"]').first();
	await coverageField.getByRole('button', { name: 'Add item' }).click();
	await pause(250);

	assert.equal(
		await isDetailsOpen(frame.locator('[data-card-path="requirements[0]"]')),
		true,
		'Adding a coverage item should not collapse the requirement card.'
	);
}

async function verifySaveAndReloadPersistence(page) {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
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
	await frame.getByRole('button', { name: 'Save' }).evaluate((button) => {
		if (!(button instanceof HTMLButtonElement)) {
			throw new Error('Expected the Save control to be a button.');
		}

		button.click();
	});
	await waitForLocatorText(frame.locator('#dirty-chip'), 'Clean');
	await waitForLocatorText(frame.locator('#sync-chip'), 'Synced');

	await closeActiveEditor(page);
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

	throw new Error(`Timed out waiting for ${expectedText}.`);
}

async function closeActiveEditor(page) {
	await runCommandPaletteCommand(page, 'Close Editor');
	await page.keyboard.press('Escape');
	await pause(500);
}

async function runCommandPaletteCommand(page, commandLabel) {
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
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
	const specFolder = path.join(workspaceRoot, 'specs', 'requirements', 'spec-trace-vsce');
	await fs.mkdir(specFolder, { recursive: true });
	await fs.copyFile(
		path.join(repoRoot, smokeFixtureRelativePath),
		path.join(specFolder, 'SPEC-VSCE-EDITOR.json')
	);

	return workspaceRoot;
}

async function cleanupSmokeWorkspace(workspaceRoot) {
	await fs.rm(workspaceRoot, { recursive: true, force: true });
}

async function isDetailsOpen(locator) {
	return locator.evaluate((element) => {
		if (!(element instanceof HTMLDetailsElement)) {
			throw new Error('Expected a <details> element.');
		}

		return element.open;
	});
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
