/**
 * Patches helios-core's DownloadEngine to support auth headers
 * for downloading assets from private GitHub repos.
 * Run via: npm run postinstall
 */
const fs = require('fs')
const path = require('path')

const enginePath = path.join(__dirname, '..', 'node_modules', 'helios-core', 'dist', 'dl', 'DownloadEngine.js')

if (!fs.existsSync(enginePath)) {
    console.log('[patch] DownloadEngine.js not found, skipping patch.')
    process.exit(0)
}

let content = fs.readFileSync(enginePath, 'utf8')

const marker = 'GH_DOWNLOAD_TOKEN'
if (content.includes(marker)) {
    console.log('[patch] DownloadEngine.js already patched.')
    process.exit(0)
}

const original = 'const downloadStream = got_1.default.stream(url);'
const patched = `const streamOpts = {};
            if (url.includes('raw.githubusercontent.com/MidgardNetwork/MidgardLauncher/') && process.env.GH_DOWNLOAD_TOKEN) {
                streamOpts.headers = { Authorization: 'Bearer ' + process.env.GH_DOWNLOAD_TOKEN };
            }
            const downloadStream = got_1.default.stream(url, streamOpts);`

if (!content.includes(original)) {
    console.log('[patch] Could not find target string in DownloadEngine.js, skipping.')
    process.exit(0)
}

content = content.replace(original, patched)
fs.writeFileSync(enginePath, content, 'utf8')
console.log('[patch] DownloadEngine.js patched successfully.')
