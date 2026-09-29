/**
 * Runtime asset decryption module.
 * Decrypts XOR-encrypted assets that were protected at build time.
 */
const fs = require('fs')
const path = require('path')

const ASSET_KEY = Buffer.from('M1dg4rdN3tw0rk_Pr0t3ct_2025!', 'utf8')

function decrypt(encryptedBuffer) {
    if(!Buffer.isBuffer(encryptedBuffer)) {
        throw new Error('decrypt() expects a Buffer argument')
    }
    const result = Buffer.alloc(encryptedBuffer.length)
    for (let i = 0; i < encryptedBuffer.length; i++) {
        result[i] = encryptedBuffer[i] ^ ASSET_KEY[i % ASSET_KEY.length]
    }
    return result
}

function loadProtectedAsset(filePath) {
    if(!filePath || typeof filePath !== 'string') {
        throw new Error('loadProtectedAsset() requires a valid file path')
    }
    if(!fs.existsSync(filePath)) {
        let flog
        try {
            const FileLogger = require('./loggerutil')
            flog = FileLogger.getLogger('AssetGuard')
            flog.warn('Protected asset not found:', filePath)
        } catch(_) { /* ignore */ }
        throw new Error(`Protected asset not found: ${filePath}`)
    }
    try {
        const encrypted = fs.readFileSync(filePath)
        return decrypt(encrypted)
    } catch(err) {
        let flog
        try {
            const FileLogger = require('./loggerutil')
            flog = FileLogger.getLogger('AssetGuard')
            flog.error('Failed to decrypt asset:', filePath, err)
        } catch(_) { /* ignore */ }
        throw err
    }
}

function getProtectedDir() {
    return path.join(__dirname, '..', 'protected')
}

module.exports = { decrypt, loadProtectedAsset, getProtectedDir }
