import * as assert from 'assert';
import * as vscode from 'vscode';

import { serializeSpecificationDocument, SpecificationDocument } from '../../editor/core/specification.js';
import { SpecificationCustomDocument, SpecificationCustomEditorProvider } from '../../editor/host/specificationCustomEditor.js';

suite('Specification custom document lifecycle', () => {
	test('keeps dirty history and conflict state under host ownership', () => {
		const workspaceFolder: vscode.WorkspaceFolder = {
			uri: vscode.Uri.parse('vscode-test-web://lifecycle-workspace/'),
			name: 'lifecycle-workspace',
			index: 0
		};

		const initial: SpecificationDocument = {
			artifact_id: 'SPEC-VSCE-EDITOR',
			artifact_type: 'specification',
			title: 'Initial title',
			domain: 'spec-trace-vsce',
			capability: 'spec-file-editor',
			status: 'draft',
			owner: 'spec-trace-vsce-maintainers',
			purpose: 'Verify host-owned lifecycle state.',
			requirements: [{
				id: 'REQ-VSCE-EDITOR-0001',
				title: 'Host lifecycle',
				statement: 'The editor MUST keep lifecycle state under host ownership.'
			}]
		};
		const initialText = serializeSpecificationDocument(initial);
		const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'specs', 'requirements', 'spec-trace-vsce', 'SPEC-VSCE-EDITOR.json');
		const provider = {
			releaseDocument: () => undefined
		} as unknown as SpecificationCustomEditorProvider;
		const document = new SpecificationCustomDocument(workspaceFolder, uri, initialText, initial, provider, false);

		try {
			const edited = { ...initial, title: 'Edited title' };
			const editedIndex = document.applyEdit(edited);
			assert.strictEqual(editedIndex, 1);
			assert.strictEqual(document.isDirty, true);

			document.setHistoryIndex(0);
			assert.strictEqual(document.state.title, 'Initial title');
			assert.strictEqual(document.isDirty, false);

			document.setHistoryIndex(editedIndex);
			document.markExternalConflict();
			assert.strictEqual(document.state.title, 'Edited title');
			assert.strictEqual(document.externalConflict, true);

			const savedText = serializeSpecificationDocument(document.state);
			document.markSaved(savedText);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(document.externalConflict, false);
			assert.strictEqual(document.lastDiskText, savedText);

			document.applyEdit({ ...document.state, title: 'Unsaved title' });
			document.markExternalConflict();
			document.replaceWithSnapshot(initialText, initial);
			assert.strictEqual(document.state.title, 'Initial title');
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(document.externalConflict, false);
		} finally {
			document.dispose();
		}
	});
});
