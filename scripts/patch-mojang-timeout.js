/**
 * Patches helios-core's MojangIndexProcessor to add HTTP request timeouts.
 * Without this, got requests to piston-meta.mojang.com can hang indefinitely,
 * causing the "validating integrity" step to be stuck at 0%.
 * Run via: npm run postinstall
 */
const fs = require('fs')
const path = require('path')

const processorPath = path.join(__dirname, '..', 'node_modules', 'helios-core', 'dist', 'dl', 'mojang', 'MojangIndexProcessor.js')

if (!fs.existsSync(processorPath)) {
    console.log('[patch] MojangIndexProcessor.js not found, skipping patch.')
    process.exit(0)
}

let content = fs.readFileSync(processorPath, 'utf8')

const marker = 'timeout:'
if (content.includes(marker)) {
    console.log('[patch] MojangIndexProcessor.js already patched.')
    process.exit(0)
}

// Add a 30s request timeout to the got client
const original = `responseType: 'json'\n    });`
const patched = `responseType: 'json',\n        timeout: { request: 30000 }\n    });`

if (!content.includes(original)) {
    console.log('[patch] Could not find target string in MojangIndexProcessor.js, skipping.')
    process.exit(0)
}

content = content.replace(original, patched)
fs.writeFileSync(processorPath, content, 'utf8')
console.log('[patch] MojangIndexProcessor.js patched successfully (30s timeout).')
