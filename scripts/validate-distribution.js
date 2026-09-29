/**
 * Valida os hashes MD5 e tamanhos de todos os artefatos no distribution.json.
 * 
 * Modos de uso:
 *   node scripts/validate-distribution.js          → Valida apenas arquivos locais do repo
 *   node scripts/validate-distribution.js --remote → Valida todos, incluindo downloads externos (Modrinth, Dropbox, etc.)
 *   node scripts/validate-distribution.js --fix    → Corrige automaticamente MD5/size dos arquivos locais no distribution.json
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const url = require('url')

const ROOT = path.resolve(__dirname, '..')
const DISTRO_PATH = path.join(ROOT, 'distribution.json')
const GITHUB_RAW_PREFIX = 'https://raw.githubusercontent.com/MidgardNetwork/MidgardLauncher/main/'

const args = process.argv.slice(2)
const CHECK_REMOTE = args.includes('--remote')
const AUTO_FIX = args.includes('--fix')

// Cores para terminal
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

function md5File(filePath) {
    const data = fs.readFileSync(filePath)
    return crypto.createHash('md5').update(data).digest('hex')
}

function fileSize(filePath) {
    return fs.statSync(filePath).size
}

function downloadBuffer(fileUrl) {
    return new Promise((resolve, reject) => {
        const maxRedirects = 5
        
        function doRequest(requestUrl, redirectCount) {
            if (redirectCount > maxRedirects) {
                reject(new Error('Too many redirects'))
                return
            }
            
            const parsed = new URL(requestUrl)
            const lib = parsed.protocol === 'https:' ? https : http
            
            lib.get(requestUrl, { headers: { 'User-Agent': 'MidgardValidator/1.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    doRequest(res.headers.location, redirectCount + 1)
                    return
                }
                
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} for ${requestUrl}`))
                    return
                }
                
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => resolve(Buffer.concat(chunks)))
                res.on('error', reject)
            }).on('error', reject)
        }
        
        doRequest(fileUrl, 0)
    })
}

function extractAllArtifacts(distro) {
    const artifacts = []
    
    function walkModules(modules, parentName) {
        for (const mod of modules) {
            if (mod.artifact) {
                artifacts.push({
                    id: mod.id,
                    name: mod.name,
                    type: mod.type,
                    parent: parentName,
                    artifact: mod.artifact
                })
            }
            if (mod.subModules) {
                walkModules(mod.subModules, mod.name)
            }
        }
    }
    
    for (const server of distro.servers) {
        walkModules(server.modules, server.name)
    }
    
    return artifacts
}

function isLocalRepoFile(artifactUrl) {
    return artifactUrl.startsWith(GITHUB_RAW_PREFIX)
}

function urlToLocalPath(artifactUrl) {
    const relativePath = decodeURIComponent(artifactUrl.replace(GITHUB_RAW_PREFIX, ''))
    return path.join(ROOT, relativePath)
}

async function validateArtifact(entry) {
    const { id, name, type, artifact } = entry
    const result = { id, name, type, url: artifact.url, status: 'ok', issues: [] }
    
    const isLocal = isLocalRepoFile(artifact.url)
    
    if (isLocal) {
        const localPath = urlToLocalPath(artifact.url)
        
        if (!fs.existsSync(localPath)) {
            result.status = 'error'
            result.issues.push(`Arquivo NÃO ENCONTRADO: ${localPath}`)
            return result
        }
        
        const actualMD5 = md5File(localPath)
        const actualSize = fileSize(localPath)
        
        if (artifact.MD5 && actualMD5 !== artifact.MD5) {
            result.status = 'error'
            result.issues.push(`MD5 INCORRETO → esperado: ${artifact.MD5} | real: ${actualMD5}`)
            result.correctMD5 = actualMD5
        }
        
        if (artifact.size && actualSize !== artifact.size) {
            result.status = 'error'
            result.issues.push(`Tamanho INCORRETO → esperado: ${artifact.size} | real: ${actualSize}`)
            result.correctSize = actualSize
        }
        
    } else if (CHECK_REMOTE) {
        try {
            const buffer = await downloadBuffer(artifact.url)
            const actualMD5 = crypto.createHash('md5').update(buffer).digest('hex')
            const actualSize = buffer.length
            
            if (artifact.MD5 && actualMD5 !== artifact.MD5) {
                result.status = 'error'
                result.issues.push(`MD5 INCORRETO (remoto) → esperado: ${artifact.MD5} | real: ${actualMD5}`)
                result.correctMD5 = actualMD5
            }
            
            if (artifact.size && actualSize !== artifact.size) {
                result.status = 'error'
                result.issues.push(`Tamanho INCORRETO (remoto) → esperado: ${artifact.size} | real: ${actualSize}`)
                result.correctSize = actualSize
            }
        } catch (err) {
            result.status = 'warning'
            result.issues.push(`Não foi possível baixar: ${err.message}`)
        }
    } else {
        result.status = 'skipped'
        result.issues.push('URL externa (use --remote para validar)')
    }
    
    return result
}

async function main() {
    console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}`)
    console.log(`${BOLD}${CYAN}  MidgardRP - Validador de distribution.json${RESET}`)
    console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}\n`)
    
    if (!fs.existsSync(DISTRO_PATH)) {
        console.error(`${RED}distribution.json não encontrado em: ${DISTRO_PATH}${RESET}`)
        process.exit(1)
    }
    
    const distro = JSON.parse(fs.readFileSync(DISTRO_PATH, 'utf8'))
    const artifacts = extractAllArtifacts(distro)
    
    console.log(`Modo: ${CHECK_REMOTE ? 'Local + Remoto' : 'Apenas arquivos locais'}`)
    console.log(`Auto-fix: ${AUTO_FIX ? 'SIM' : 'NÃO'}`)
    console.log(`Total de artefatos: ${artifacts.length}\n`)
    
    let okCount = 0
    let errorCount = 0
    let warningCount = 0
    let skippedCount = 0
    const errors = []
    const fixEntries = []
    
    for (const entry of artifacts) {
        const result = await validateArtifact(entry)
        
        switch (result.status) {
            case 'ok':
                okCount++
                console.log(`  ${GREEN}✓${RESET} ${result.name} (${result.type})`)
                break
            case 'error':
                errorCount++
                console.log(`  ${RED}✗${RESET} ${result.name} (${result.type})`)
                for (const issue of result.issues) {
                    console.log(`    ${RED}→ ${issue}${RESET}`)
                }
                errors.push(result)
                if (result.correctMD5 || result.correctSize) {
                    fixEntries.push(result)
                }
                break
            case 'warning':
                warningCount++
                console.log(`  ${YELLOW}⚠${RESET} ${result.name} (${result.type})`)
                for (const issue of result.issues) {
                    console.log(`    ${YELLOW}→ ${issue}${RESET}`)
                }
                break
            case 'skipped':
                skippedCount++
                console.log(`  ${CYAN}⊘${RESET} ${result.name} (${result.type}) - externo`)
                break
        }
    }
    
    console.log(`\n${BOLD}═══ Resultado ═══${RESET}`)
    console.log(`  ${GREEN}OK:${RESET}       ${okCount}`)
    console.log(`  ${RED}Erros:${RESET}    ${errorCount}`)
    console.log(`  ${YELLOW}Avisos:${RESET}   ${warningCount}`)
    console.log(`  ${CYAN}Ignorados:${RESET} ${skippedCount}`)
    
    if (errorCount > 0) {
        console.log(`\n${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`)
        console.log(`${RED}${BOLD}║  ATENÇÃO: ${errorCount} artefato(s) com problemas!                    ║${RESET}`)
        console.log(`${RED}${BOLD}║  Jogadores vão re-baixar esses arquivos toda vez!       ║${RESET}`)
        console.log(`${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`)
        
        if (AUTO_FIX && fixEntries.length > 0) {
            console.log(`\n${YELLOW}${BOLD}Corrigindo distribution.json...${RESET}`)
            
            let distroText = fs.readFileSync(DISTRO_PATH, 'utf8')
            
            for (const fix of fixEntries) {
                if (fix.correctMD5) {
                    const oldMD5 = fix.artifact.MD5
                    // Find and replace the specific MD5 near the artifact id context
                    distroText = distroText.replace(
                        `"MD5": "${oldMD5}"`,
                        `"MD5": "${fix.correctMD5}"`
                    )
                    console.log(`  ${GREEN}→ MD5 corrigido:${RESET} ${fix.name}: ${oldMD5} → ${fix.correctMD5}`)
                }
                if (fix.correctSize) {
                    const oldSize = fix.artifact.size
                    // Replace size near the url context to avoid wrong matches
                    const urlFragment = fix.artifact.url.slice(-40)
                    const searchRegion = distroText.indexOf(urlFragment)
                    if (searchRegion !== -1) {
                        // Find the nearest "size" before this URL
                        const region = distroText.lastIndexOf(`"size": ${oldSize}`, searchRegion)
                        if (region !== -1) {
                            distroText = distroText.substring(0, region) +
                                `"size": ${fix.correctSize}` +
                                distroText.substring(region + `"size": ${oldSize}`.length)
                            console.log(`  ${GREEN}→ Tamanho corrigido:${RESET} ${fix.name}: ${oldSize} → ${fix.correctSize}`)
                        }
                    }
                }
            }
            
            fs.writeFileSync(DISTRO_PATH, distroText, 'utf8')
            console.log(`\n${GREEN}${BOLD}distribution.json atualizado com sucesso!${RESET}`)
        } else if (!AUTO_FIX && fixEntries.length > 0) {
            console.log(`\n${YELLOW}Use --fix para corrigir automaticamente os MD5/tamanhos locais.${RESET}`)
        }
    } else {
        console.log(`\n${GREEN}${BOLD}Tudo OK! O distribution.json está consistente.${RESET}`)
    }
    
    console.log('')
}

main().catch(err => {
    console.error(`${RED}Erro fatal: ${err.message}${RESET}`)
    process.exit(1)
})
