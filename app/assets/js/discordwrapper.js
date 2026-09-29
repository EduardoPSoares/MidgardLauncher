// Work in progress
const { LoggerUtil } = require('helios-core')

const logger = LoggerUtil.getLogger('DiscordWrapper')

let FileLog
try {
    const FileLogger = require('./loggerutil')
    FileLog = FileLogger.getLogger('DiscordWrapper')
} catch(_) {
    FileLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

const { Client } = require('discord-rpc-patch')

const Lang = require('./langloader')

let client
let activity
let connected = false

exports.initRPC = function(genSettings, servSettings, initialDetails = Lang.queryJS('discord.waiting')){
    if(!genSettings || !genSettings.clientId) {
        logger.warn('Discord RPC not initialized: missing clientId')
        FileLog.warn('Discord RPC not initialized: missing clientId in genSettings')
        return
    }

    client = new Client({ transport: 'ipc' })

    activity = {
        details: initialDetails,
        state: Lang.queryJS('discord.state', {shortId: servSettings.shortId}),
        largeImageKey: servSettings.largeImageKey,
        largeImageText: servSettings.largeImageText,
        smallImageKey: genSettings.smallImageKey,
        smallImageText: genSettings.smallImageText,
        startTimestamp: new Date().getTime(),
        instance: false,
        buttons: [
            { label: 'Entrar no Discord', url: 'https://discord.gg/midgardrpg' }
        ]
    }

    client.on('ready', () => {
        connected = true
        logger.info('Discord RPC Connected')
        FileLog.info('Discord RPC connected successfully.')
        try {
            client.setActivity(activity)
        } catch(err) {
            logger.info('Failed to set Discord activity:', err.message)
            FileLog.error('Failed to set Discord activity:', err)
        }
    })
    
    client.login({clientId: genSettings.clientId}).catch(error => {
        connected = false
        if(error.message.includes('ENOENT')) {
            logger.info('Unable to initialize Discord Rich Presence, no client detected.')
            FileLog.info('Discord RPC: no Discord client detected (ENOENT).')
        } else {
            logger.info('Unable to initialize Discord Rich Presence: ' + error.message, error)
            FileLog.error('Discord RPC login failed:', error)
        }
    })
}

exports.isActive = function(){
    return client != null
}

exports.updateDetails = function(details){
    if(!client || !activity || !connected) {
        return
    }
    activity.details = details
    client.setActivity(activity).catch(err => {
        FileLog.error('Failed to update Discord activity:', err)
    })
}

exports.shutdownRPC = function(){
    if(!client) return
    FileLog.info('Shutting down Discord RPC.')
    connected = false
    try {
        client.clearActivity()
        client.destroy()
    } catch(err) {
        FileLog.error('Error shutting down Discord RPC:', err)
    }
    client = null
    activity = null
}