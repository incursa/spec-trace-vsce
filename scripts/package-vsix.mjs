import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import JSZip from 'jszip';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const packageDirectory = path.resolve('artifacts', 'packages');
const vsixPath = path.join(packageDirectory, `${manifest.name}-${manifest.version}.vsix`);
await mkdir(packageDirectory, { recursive: true });

const result = spawnSync(
	process.execPath,
	[path.resolve('node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--out', vsixPath],
	{ encoding: 'utf8', stdio: 'pipe', shell: false, maxBuffer: 10 * 1024 * 1024 }
);
if (result.stdout) {
	process.stdout.write(result.stdout);
}
if (result.stderr) {
	process.stderr.write(result.stderr);
}
if (result.status !== 0) {
	throw new Error(`VSIX packaging failed with exit code ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : '.'}`);
}

const bytes = await readFile(vsixPath);
const archive = await JSZip.loadAsync(bytes);
const entries = Object.keys(archive.files);
const requiredEntries = [
	'extension/package.json',
	'extension/LICENSE.txt',
	'extension/NOTICE',
	'extension/readme.md',
	'extension/changelog.md',
	'extension/dist/web/extension.js',
	'extension/dist/node/extension.cjs',
	'extension/images/icon-128.png',
	'extension/resources/spec-trace.svg'
];
for (const entry of requiredEntries) {
	if (!entries.includes(entry)) {
		throw new Error(`Packaged VSIX is missing required entry: ${entry}`);
	}
}

const forbiddenPatterns = [
	/^extension\/src\//,
	/^extension\/node_modules\//,
	/\.env(?:\.|$)/i,
	/\.map$/i,
	/\.vscode-test/i
];
const forbidden = entries.filter((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry)));
if (forbidden.length > 0) {
	throw new Error(`Packaged VSIX contains forbidden entries: ${forbidden.join(', ')}`);
}

const webBundle = await archive.file('extension/dist/web/extension.js')?.async('string');
if (!webBundle) {
	throw new Error('Unable to inspect the packaged browser entry point.');
}
if (/node:child_process|require\(["']child_process["']\)|workbenchDoctor/.test(webBundle)) {
	throw new Error('Packaged browser bundle leaked desktop-only process integration.');
}

const sha256 = createHash('sha256').update(bytes).digest('hex');
const checksumPath = `${vsixPath}.sha256`;
await writeFile(checksumPath, `${sha256}  ${path.basename(vsixPath)}\n`, 'utf8');
console.log(`Inspected ${entries.length} VSIX entries.`);
console.log(`VSIX: ${vsixPath}`);
console.log(`SHA-256: ${sha256}`);
console.log(`Checksum: ${checksumPath}`);
