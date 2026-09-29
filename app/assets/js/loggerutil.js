/**
 * LoggerUtil - Sistema centralizado de logs para o MidgardLauncher.
 * 
 * Grava logs em arquivo no diretório userData, independente do modo (dev/prod).
 * Em produção, console.* é silenciado pelo preloader, mas os logs em arquivo
 * continuam funcionando para diagnóstico.
 * 
 * @module loggerutil
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

// Níveis de log
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    FATAL: 4
}

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']

// Configuração
const MAX_LOG_SIZE = 5 * 1024 * 1024  // 5MB por arquivo
const MAX_LOG_FILES = 5                // Manter até 5 arquivos de log

let logDir = null
let logFilePath = null
let logStream = null
let currentLogSize = 0
let minLevel = LOG_LEVELS.DEBUG

/**
 * Inicializa o sistema de logs.
 * Deve ser chamado uma vez na inicialização do app.
 * 
 * @param {string} userDataPath Caminho do diretório userData do Electron.
 */
function initialize(userDataPath) {
    if (logStream) return // Já inicializado

    logDir = path.join(userDataPath || os.tmpdir(), 'logs')

    try {
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true })
        }
    } catch (err) {
        // Fallback para temp se não conseguir criar no userData
        logDir = path.join(os.tmpdir(), 'midgardlauncher-logs')
        try {
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true })
            }
        } catch (_) {
            return // Não é possível criar diretório de logs
        }
    }

    logFilePath = path.join(logDir, 'launcher.log')

    // Verificar se o arquivo existente excede o tamanho máximo
    try {
        if (fs.existsSync(logFilePath)) {
            const stats = fs.statSync(logFilePath)
            currentLogSize = stats.size
            if (currentLogSize >= MAX_LOG_SIZE) {
                rotateLogFiles()
            }
        }
    } catch (_) {
        currentLogSize = 0
    }

    try {
        logStream = fs.createWriteStream(logFilePath, { flags: 'a' })
        logStream.on('error', () => {
            logStream = null
        })
    } catch (_) {
        logStream = null
    }

    // Escrever cabeçalho de sessão
    const header = [
        '',
        '═'.repeat(80),
        `  MidgardLauncher - Log Session Started`,
        `  Timestamp: ${new Date().toISOString()}`,
        `  Platform: ${process.platform} ${os.release()} (${os.arch()})`,
        `  Node: ${process.version}`,
        `  Electron: ${process.versions.electron || 'N/A'}`,
        `  Memory: ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB total`,
        '═'.repeat(80),
        ''
    ].join('\n')

    writeToFile(header)
}

/**
 * Rotaciona os arquivos de log quando o tamanho máximo é atingido.
 */
function rotateLogFiles() {
    if (logStream) {
        logStream.end()
        logStream = null
    }

    // Remover o arquivo mais antigo
    const oldest = path.join(logDir, `launcher.${MAX_LOG_FILES}.log`)
    try {
        if (fs.existsSync(oldest)) {
            fs.unlinkSync(oldest)
        }
    } catch (_) { /* ignorar */ }

    // Renomear arquivos existentes (4→5, 3→4, etc.)
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const src = path.join(logDir, `launcher.${i}.log`)
        const dst = path.join(logDir, `launcher.${i + 1}.log`)
        try {
            if (fs.existsSync(src)) {
                fs.renameSync(src, dst)
            }
        } catch (_) { /* ignorar */ }
    }

    // Mover arquivo atual para .1
    try {
        if (fs.existsSync(logFilePath)) {
            fs.renameSync(logFilePath, path.join(logDir, 'launcher.1.log'))
        }
    } catch (_) { /* ignorar */ }

    currentLogSize = 0

    try {
        logStream = fs.createWriteStream(logFilePath, { flags: 'a' })
        logStream.on('error', () => {
            logStream = null
        })
    } catch (_) {
        logStream = null
    }
}

/**
 * Escreve uma string diretamente no arquivo de log.
 * 
 * @param {string} text Texto a ser escrito.
 */
function writeToFile(text) {
    if (!logStream) return

    try {
        logStream.write(text)
        currentLogSize += Buffer.byteLength(text, 'utf8')

        if (currentLogSize >= MAX_LOG_SIZE) {
            rotateLogFiles()
        }
    } catch (_) { /* ignorar erros de escrita */ }
}

/**
 * Formata um objeto de erro para string legível.
 * 
 * @param {*} arg Argumento a ser formatado.
 * @returns {string} Representação em string.
 */
function formatArg(arg) {
    if (arg === null) return 'null'
    if (arg === undefined) return 'undefined'
    if (arg instanceof Error) {
        return `${arg.message}\n    Stack: ${arg.stack || 'N/A'}`
    }
    if (typeof arg === 'object') {
        try {
            const seen = new WeakSet()
            return JSON.stringify(arg, (key, value) => {
                if (typeof value === 'object' && value !== null) {
                    if (seen.has(value)) return '[Circular]'
                    seen.add(value)
                }
                return value
            }, 2)
        } catch (_) {
            return String(arg)
        }
    }
    return String(arg)
}

/**
 * Registra uma mensagem de log.
 * 
 * @param {string} category Categoria/módulo.
 * @param {number} level Nível de log.
 * @param  {...any} args Argumentos da mensagem.
 */
function log(category, level, ...args) {
    if (level < minLevel) return

    const timestamp = new Date().toISOString()
    const levelName = LEVEL_NAMES[level] || 'UNKNOWN'
    const message = args.map(formatArg).join(' ')
    const line = `[${timestamp}] [${levelName}] [${category}] ${message}\n`

    writeToFile(line)
}

/**
 * Cria um logger para um módulo específico.
 * 
 * @param {string} category Nome do módulo/categoria.
 * @returns {object} Logger com métodos debug, info, warn, error, fatal.
 */
function getLogger(category) {
    return {
        debug: (...args) => log(category, LOG_LEVELS.DEBUG, ...args),
        info: (...args) => log(category, LOG_LEVELS.INFO, ...args),
        warn: (...args) => log(category, LOG_LEVELS.WARN, ...args),
        error: (...args) => log(category, LOG_LEVELS.ERROR, ...args),
        fatal: (...args) => log(category, LOG_LEVELS.FATAL, ...args)
    }
}

/**
 * Define o nível mínimo de log.
 * 
 * @param {string} level Nome do nível ('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL').
 */
function setLevel(level) {
    if (typeof level === 'number') {
        if (level >= LOG_LEVELS.DEBUG && level <= LOG_LEVELS.FATAL) {
            minLevel = level
        }
        return
    }
    if (typeof level === 'string') {
        const l = LOG_LEVELS[level.toUpperCase()]
        if (l !== undefined) {
            minLevel = l
        }
    }
}

/**
 * Retorna o caminho do diretório de logs.
 * 
 * @returns {string|null} Caminho do diretório de logs.
 */
function getLogDirectory() {
    return logDir
}

/**
 * Retorna o caminho do arquivo de log atual.
 * 
 * @returns {string|null} Caminho do arquivo de log atual.
 */
function getLogFilePath() {
    return logFilePath
}

/**
 * Encerra o sistema de logs corretamente.
 */
function shutdown() {
    if (logStream) {
        writeToFile(`\n[${ new Date().toISOString()}] [INFO] [LoggerUtil] Log session ended.\n`)
        logStream.end()
        logStream = null
    }
}

module.exports = {
    initialize,
    getLogger,
    setLevel,
    getLogDirectory,
    getLogFilePath,
    shutdown,
    LOG_LEVELS
}
