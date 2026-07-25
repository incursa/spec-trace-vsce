export type WorkbenchOperation =
	| 'doctor'
	| 'validate'
	| 'quality-show'
	| 'quality-proof-health'
	| 'quality-sync-preview'
	| 'quality-sync';

export interface WorkbenchRequest {
	readonly operation: WorkbenchOperation;
	readonly repositoryPath: string;
}

export interface WorkbenchResponse {
	readonly operation: WorkbenchOperation;
	readonly exitCode: number;
	readonly payload: unknown;
	readonly stderr: string;
}

export interface WorkbenchValidationFinding {
	readonly profile?: string;
	readonly category?: string;
	readonly severity?: string;
	readonly message?: string;
	readonly file?: string;
	readonly artifactId?: string;
	readonly field?: string;
	readonly targetId?: string;
	readonly targetType?: string;
	readonly targetFile?: string;
}

export function buildWorkbenchArguments(request: WorkbenchRequest): string[] {
	const global = ['--repo', request.repositoryPath, '--format', 'json'];
	switch (request.operation) {
		case 'doctor':
			return [...global, 'doctor', '--json'];
		case 'validate':
			return [...global, 'validate'];
		case 'quality-show':
			return [...global, 'quality', 'show'];
		case 'quality-proof-health':
			return [...global, 'quality', 'proof-health'];
		case 'quality-sync-preview':
			return [...global, 'quality', 'sync', '--dry-run'];
		case 'quality-sync':
			return [...global, 'quality', 'sync'];
	}
}

export function getValidationFindings(payload: unknown): WorkbenchValidationFinding[] {
	if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.findings)) {
		return [];
	}

	return payload.data.findings.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
