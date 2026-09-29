/**
 * Build-time asset protection script.
 * XOR-encrypts sounds and background images so they can't be easily
 * extracted from the distributed application.
 *
 * Run before building: node scripts/protect-assets.js
 */
const fs = require('fs')
const path = require('path')

const ASSET_KEY = Buffer.from('M1dg4rdN3tw0rk_Pr0t3ct_2025!', 'utf8')

function xorEncrypt(data) {
    const result = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i++) {
        result[i] = data[i] ^ ASSET_KEY[i % ASSET_KEY.length]
    }
    return result
}

function processDirectory(inputDir, outputDir, label) {
    if (!fs.existsSync(inputDir)) {
        console.log(`[Skip] ${label}: directory not found (${inputDir})`)
        return 0
    }

    fs.mkdirSync(outputDir, { recursive: true })

    const files = fs.readdirSync(inputDir).filter(f => !f.startsWith('.'))
    let count = 0

    for (const file of files) {
        const inputPath = path.join(inputDir, file)
        if (!fs.statSync(inputPath).isFile()) continue

        const outputName = file.replace(/\.[^.]+$/, '.dat')
        const outputPath = path.join(outputDir, outputName)

        const data = fs.readFileSync(inputPath)
        const encrypted = xorEncrypt(data)
        fs.writeFileSync(outputPath, encrypted)

        count++
        console.log(`  [OK] ${file} -> ${outputName} (${data.length} bytes)`)
    }

    return count
}

console.log('=== Midgard Asset Protection ===\n')

const rootDir = path.join(__dirname, '..')
const protectedDir = path.join(rootDir, 'app', 'assets', 'protected')

// Clean previous protected assets
if (fs.existsSync(protectedDir)) {
    fs.rmSync(protectedDir, { recursive: true })
}

// Encrypt sounds
console.log('[Sounds]')
const soundCount = processDirectory(
    path.join(rootDir, 'sounds'),
    path.join(protectedDir, 'sounds'),
    'Sounds'
)

// Encrypt backgrounds
console.log('\n[Backgrounds]')
const bgCount = processDirectory(
    path.join(rootDir, 'app', 'assets', 'images', 'backgrounds'),
    path.join(protectedDir, 'backgrounds'),
    'Backgrounds'
)

console.log(`\n=== Done: ${soundCount} sounds, ${bgCount} backgrounds protected ===`)
