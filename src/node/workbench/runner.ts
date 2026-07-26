import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import {
	buildWorkbenchArguments,
	type WorkbenchRequest,
	type WorkbenchResponse
} from './contracts.js';

export interface CancellationLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface WorkbenchRunOptions {
	readonly executable: string;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	readonly cancellation?: CancellationLike;
}

export const DEFAULT_WORKBENCH_TIMEOUT_MS = 30_000;
export const DEFAULT_WORKBENCH_MAX_OUTPUT_BYTES = 1_048_576;
export const HARD_WORKBENCH_TIMEOUT_MS = 120_000;
export const HARD_WORKBENCH_MAX_OUTPUT_BYTES = 5_242_880;

export async function discoverWorkbenchExecutable(
	configuredPath: string | undefined,
	repositoryPath: string
): Promise<string | undefined> {
	const executableName = process.platform === 'win32' ? 'workbench.exe' : 'workbench';
	const candidates = [
		configuredPath?.trim(),
		path.join(repositoryPath, '.workbench', 'bin', executableName),
		path.join(repositoryPath, '.workbench', 'tools', executableName),
		...pathCandidates(executableName)
	].filter((candidate): candidate is string => Boolean(candidate));

	for (const candidate of candidates) {
		if (await isExecutable(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

export async function runWorkbench(
	request: WorkbenchRequest,
	options: WorkbenchRunOptions
): Promise<WorkbenchResponse> {
	const timeoutMs = clamp(options.timeoutMs, 1_000, HARD_WORKBENCH_TIMEOUT_MS);
	const maxOutputBytes = clamp(options.maxOutputBytes, 16_384, HARD_WORKBENCH_MAX_OUTPUT_BYTES);
	const args = buildWorkbenchArguments(request);

	return new Promise<WorkbenchResponse>((resolve, reject) => {
		const child = spawn(options.executable, args, {
			cwd: request.repositoryPath,
			shell: false,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		let timeout: NodeJS.Timeout;
		let cancellationDisposable: { dispose(): void } | undefined;

		const finishWithError = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			cancellationDisposable?.dispose();
			if (!child.killed) {
				child.kill();
			}
			reject(error);
		};

		const append = (target: Buffer[], chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				finishWithError(new Error(`Workbench output exceeded the ${maxOutputBytes}-byte safety limit.`));
				return;
			}
			target.push(chunk);
		};

		child.stdout.on('data', (chunk: Buffer) => append(stdoutChunks, chunk));
		child.stderr.on('data', (chunk: Buffer) => append(stderrChunks, chunk));
		child.once('error', (error) => finishWithError(error));
		child.once('close', (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			cancellationDisposable?.dispose();
			const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
			const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
			if (exitCode !== 0 && exitCode !== 1) {
				reject(new Error(`Workbench exited with code ${exitCode ?? 'unknown'}${stderr ? `: ${stderr}` : '.'}`));
				return;
			}

			if (!stdout) {
				reject(new Error('Workbench returned no structured JSON output.'));
				return;
			}

			try {
				resolve({
					operation: request.operation,
					exitCode: exitCode ?? 0,
					payload: JSON.parse(stdout) as unknown,
					stderr
				});
			} catch {
				reject(new Error('Workbench returned output that was not valid JSON.'));
			}
		});

		timeout = setTimeout(() => {
			finishWithError(new Error(`Workbench timed out after ${timeoutMs} ms.`));
		}, timeoutMs);
		cancellationDisposable = options.cancellation?.onCancellationRequested(() => {
			finishWithError(new Error('Workbench operation was cancelled.'));
		});
		if (options.cancellation?.isCancellationRequested) {
			finishWithError(new Error('Workbench operation was cancelled.'));
		}
	});
}

function pathCandidates(executableName: string): string[] {
	const pathValue = process.env.PATH ?? '';
	return pathValue
		.split(path.delimiter)
		.map((directory) => directory.trim().replace(/^"|"$/g, ''))
		.filter(Boolean)
		.map((directory) => path.join(directory, executableName));
}

async function isExecutable(candidate: string): Promise<boolean> {
	try {
		await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum);
}
