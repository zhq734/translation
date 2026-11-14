import { readFileSync } from 'node:fs'
import { decodePng } from '../src/main/pngCodec.ts'

const image = decodePng(readFileSync('/tmp/translation-pdf-repro-current/assets/asset-2930e9000656d787'))
const offset = (303 * image.width + 300) * 4
console.log('image', image.width, image.height, 'pixel', [...image.data.subarray(offset, offset + 4)])
for (const [label, top] of [['top', 296], ['bottom', 326]] as const) {
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (let y = top; y < top + 10; y += 1) {
    for (let x = 185; x < 480; x += 1) {
      const index = (y * image.width + x) * 4
      if (image.data[index + 3] !== 255) continue
      red += image.data[index]!
      green += image.data[index + 1]!
      blue += image.data[index + 2]!
      count += 1
    }
  }
  console.log(label, [red / count, green / count, blue / count], count)
}
