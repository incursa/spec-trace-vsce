import { readFile, stat } from 'node:fs/promises';

const requiredAssets = [
	'images/icon.png',
	'images/icon-128.png',
	'images/spectrace-readme-banner.png',
	'images/spectrace-wordmark-vscode.svg',
	'resources/spec-trace.svg'
];

for (const asset of requiredAssets) {
	const metadata = await stat(asset);
	if (!metadata.isFile() || metadata.size === 0) {
		throw new Error(`Required asset is missing or empty: ${asset}`);
	}
}

const icon = await readFile('images/icon-128.png');
const { width, height } = readPngDimensions(icon);
if (width !== 128 || height !== 128) {
	throw new Error(`Marketplace icon must be exactly 128x128 pixels; found ${width}x${height}.`);
}
const sourceDimensions = readPngDimensions(await readFile('images/icon.png'));
if (sourceDimensions.width !== 256 || sourceDimensions.height !== 256) {
	throw new Error(`Approved icon source must remain 256x256 pixels; found ${sourceDimensions.width}x${sourceDimensions.height}.`);
}

for (const svgPath of ['images/spectrace-wordmark-vscode.svg', 'resources/spec-trace.svg']) {
	const svg = await readFile(svgPath, 'utf8');
	if (!/<svg\b/i.test(svg) || !/viewBox=/i.test(svg)) {
		throw new Error(`SVG asset must contain an svg root and viewBox: ${svgPath}`);
	}
	if (/<script\b|javascript:|(?:href|src)=["']https?:\/\//i.test(svg)) {
		throw new Error(`SVG asset contains disallowed active or remote content: ${svgPath}`);
	}
}

console.log(`Verified ${requiredAssets.length} brand assets; images/icon-128.png is ${width}x${height}.`);

function readPngDimensions(buffer) {
	const signature = buffer.subarray(0, 8).toString('hex');
	if (signature !== '89504e470d0a1a0a' || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
		throw new Error('images/icon.png is not a valid PNG with an IHDR header.');
	}

	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20)
	};
}
