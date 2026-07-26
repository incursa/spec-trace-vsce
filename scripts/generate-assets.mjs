import { readFile, writeFile } from 'node:fs/promises';

import { PNG } from 'pngjs';

const source = PNG.sync.read(await readFile('images/icon.png'));
if (source.width !== 256 || source.height !== 256) {
	throw new Error(`Approved icon source must remain 256x256; found ${source.width}x${source.height}.`);
}

const output = new PNG({ width: 128, height: 128 });
for (let targetY = 0; targetY < output.height; targetY += 1) {
	for (let targetX = 0; targetX < output.width; targetX += 1) {
		const targetOffset = (targetY * output.width + targetX) * 4;
		const sourceX = targetX * 2;
		const sourceY = targetY * 2;
		for (let channel = 0; channel < 4; channel += 1) {
			let total = 0;
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					const sourceOffset = ((sourceY + y) * source.width + sourceX + x) * 4;
					total += source.data[sourceOffset + channel];
				}
			}
			output.data[targetOffset + channel] = Math.round(total / 4);
		}
	}
}

await writeFile('images/icon-128.png', PNG.sync.write(output, { colorType: 6 }));
console.log('Generated images/icon-128.png from the approved 256x256 source.');
