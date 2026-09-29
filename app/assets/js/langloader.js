const fs = require('fs-extra')
const path = require('path')
const toml = require('toml')
const merge = require('lodash.merge')

let lang

exports.loadLanguage = function(id){
    const filePath = path.join(__dirname, '..', 'lang', `${id}.toml`)
    try {
        if(!fs.existsSync(filePath)) {
            // Arquivo de idioma não encontrado, ignorar silenciosamente
            return
        }
        const content = fs.readFileSync(filePath, 'utf8')
        if(!content || content.trim().length === 0) {
            return
        }
        const parsed = toml.parse(content)
        lang = merge(lang || {}, parsed || {})
    } catch(err) {
        // Log to file if available, otherwise stderr
        try {
            const FileLogger = require('./loggerutil')
            const flog = FileLogger.getLogger('LangLoader')
            flog.error(`Failed to load language file '${id}':`, err)
        } catch(_) {
            // Fallback - não quebrar se FileLogger não estiver disponível
        }
    }
}

exports.query = function(id, placeHolders){
    let query = id.split('.')
    let res = lang
    for(let q of query){
        if(res == null) return id
        res = res[q]
    }
    if(res == null || res === lang) return id
    let text = res
    if (placeHolders) {
        Object.entries(placeHolders).forEach(([key, value]) => {
            text = text.replace(`{${key}}`, value)
        })
    }
    return text
}

exports.queryJS = function(id, placeHolders){
    return exports.query(`js.${id}`, placeHolders)
}

exports.queryEJS = function(id, placeHolders){
    return exports.query(`ejs.${id}`, placeHolders)
}

exports.setupLanguage = function(){
    // Load Language Files
    exports.loadLanguage('en_US')
    // Uncomment this when translations are ready
    //exports.loadLanguage('xx_XX')

    // Load Custom Language File for Launcher Customizer
    exports.loadLanguage('_custom')
}