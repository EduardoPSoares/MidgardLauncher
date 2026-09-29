const net = require('net')

let FileLog
try {
    const FileLogger = require('./loggerutil')
    FileLog = FileLogger.getLogger('ServerStatus')
} catch(_) {
    FileLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

/**
 * Retrieves the status of a minecraft server.
 * 
 * @param {string} address The server address.
 * @param {number} port Optional. The port of the server. Defaults to 25565.
 * @returns {Promise.<Object>} A promise which resolves to an object containing
 * status information.
 */
exports.getStatus = function(address, port = 25565){

    if(port === null || port === undefined || port === ''){
        port = 25565
    }
    if(typeof port === 'string'){
        port = parseInt(port)
    }

    if(!address || typeof address !== 'string') {
        FileLog.warn('getStatus called with invalid address:', address)
        return Promise.reject({ code: 'INVALID_ADDRESS', message: 'Invalid server address' })
    }

    if(isNaN(port) || port < 1 || port > 65535) {
        FileLog.warn('getStatus called with invalid port:', port)
        return Promise.reject({ code: 'INVALID_PORT', message: 'Invalid port number' })
    }

    FileLog.debug(`Checking server status: ${address}:${port}`)

    return new Promise((resolve, reject) => {
        let settled = false

        const socket = net.connect(port, address, () => {
            let buff = Buffer.from([0xFE, 0x01])
            socket.write(buff)
        })

        socket.setTimeout(2500, () => {
            if(settled) return
            settled = true
            socket.destroy()
            FileLog.debug(`Server status timeout: ${address}:${port}`)
            reject({
                code: 'ETIMEDOUT',
                errno: 'ETIMEDOUT',
                address,
                port
            })
        })

        socket.on('data', (data) => {
            if(settled) return
            settled = true
            if(data != null && data != ''){
                let server_info = data.toString().split('\x00\x00\x00')
                const NUM_FIELDS = 6
                if(server_info != null && server_info.length >= NUM_FIELDS){
                    const result = {
                        online: true,
                        version: server_info[2].replace(/\u0000/g, ''),
                        motd: server_info[3].replace(/\u0000/g, ''),
                        onlinePlayers: server_info[4].replace(/\u0000/g, ''),
                        maxPlayers: server_info[5].replace(/\u0000/g,'')
                    }
                    FileLog.debug(`Server ${address}:${port} online - ${result.onlinePlayers}/${result.maxPlayers} players`)
                    resolve(result)
                } else {
                    FileLog.debug(`Server ${address}:${port} returned invalid data (${server_info.length} fields)`)
                    resolve({
                        online: false
                    })
                }
            }
            socket.destroy()
        })

        socket.on('error', (err) => {
            if(settled) return
            settled = true
            socket.destroy()
            FileLog.debug(`Server ${address}:${port} error: ${err.code || err.message}`)
            reject(err)
        })
    })

}