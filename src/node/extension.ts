import * as vscode from 'vscode';

import { activate as activatePortable, deactivate as deactivatePortable } from '../web/extension.js';
import { registerWorkbenchIntegration } from './workbench/integration.js';

export function activate(context: vscode.ExtensionContext): void {
	activatePortable(context);
	context.subscriptions.push(registerWorkbenchIntegration(context));
}

export function deactivate(): void {
	deactivatePortable();
}
