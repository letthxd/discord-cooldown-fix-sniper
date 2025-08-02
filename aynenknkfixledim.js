"use strict";
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
const tls = require("tls");
const WebSocket = require("ws");
const fs = require("fs/promises");
const extractJsonFromString = require("extract-json-from-string");
let vanity, websocket, mfaToken;
const token = "";
const swid = "1370572722136027238";
const guilds = {};
const vanityRequestCache = new Map();
const CONNECTION_POOL_SIZE = 25;
const tlsConnections = [];
const HEARTBEAT_BUFFER = Buffer.from('{"op":1,"d":null}');
const READY_CHECK = '"READY"';
const GUILD_UPDATE_CHECK = '"GUILD_UPDATE"';
const OP_10_CHECK = '"op":10';
const RATE_LIMIT_RETRY_MS = 300;
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
];
const superProperties = [
    "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==",
    "eyJicm93c2VyIjoiU2FmYXJpIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNjA1LjEuMTUiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTU2MjV9",
    "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFhJOyBMaW51eCB4ODZfNjQpIEFwcGxlV2ViS2l0LzUzNy4zNiIsImNsaWVudF9idWlsZF9udW1iZXIiOjM1NTYyNn0="
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getRandomSuperProperties() {
    return superProperties[Math.floor(Math.random() * superProperties.length)];
}

function getVanityPatchRequestBuffer(vanityCode, uniqueId) {
    const cacheKey = `${vanityCode}_${uniqueId}`; // Her istek için benzersiz cache anahtarı
    if (vanityRequestCache.has(cacheKey)) {
        return vanityRequestCache.get(cacheKey);
    }
    const payload = `{"code":"${vanityCode}"}`;
    const payloadLength = Buffer.byteLength(payload);
    const requestStr = 
        `PATCH /api/v10/guilds/${swid}/vanity-url HTTP/1.1\r\n` +
        `Host: canary.discord.com\r\n` +
        `Authorization: ${token}\r\n` +
        `X-Discord-MFA-Authorization: ${mfaToken}\r\n` +
        `User-Agent: ${getRandomUserAgent()}\r\n` +
        `X-Super-Properties: ${getRandomSuperProperties()}\r\n` +
        `Content-Type: application/json\r\n` +
        `Connection: keep-alive\r\n` +
        `Accept-Encoding: gzip, deflate, br\r\n` +
        `Content-Length: ${payloadLength}\r\n\r\n${payload}`;
    
    const requestBuffer = Buffer.from(requestStr);
    vanityRequestCache.set(cacheKey, requestBuffer);
    return requestBuffer;
}

const keepAliveRequest = Buffer.from(`GET / HTTP/1.1\r\nHost: canary.discord.com\r\nConnection: keep-alive\r\n\r\n`);

setInterval(() => {
    const activeConnections = tlsConnections.filter(conn => conn.writable && !conn.destroyed);
    for (let i = 0; i < activeConnections.length; i++) {
        activeConnections[i].write(keepAliveRequest);
    }
}, 2000); // Keep-alive sıklığını artırdık

function connectWebSocket() {
    websocket = new WebSocket("wss://gateway-us-east1-b.discord.gg", { 
        perMessageDeflate: false,
        handshakeTimeout: 2000,
        maxPayload: 100 * 1024 * 1024
    }); 
    websocket.onclose = () => setTimeout(connectWebSocket, 200);
    websocket.onerror = () => setTimeout(connectWebSocket, 200);    
    websocket.onmessage = (message) => {
        const data = message.data;
        if (data.includes(READY_CHECK)) {
            const parsed = JSON.parse(data);
            if (parsed.d?.guilds) {
                for (const g of parsed.d.guilds) {
                    if (g.vanity_url_code) guilds[g.id] = g.vanity_url_code;
                }
                console.log(`loaded: ${Object.keys(guilds).length} id:`, Object.values(guilds));
            }
        }
        else if (data.includes(GUILD_UPDATE_CHECK)) {
            const parsed = JSON.parse(data);
            const d = parsed.d;           
            if (d?.guild_id && guilds[d.guild_id] && guilds[d.guild_id] !== d.vanity_url_code) {
                const vanityCode = guilds[d.guild_id];
                vanity = vanityCode;
                console.log(`detected: ${vanityCode}`);
                const activeConnections = tlsConnections.filter(conn => conn.writable && !conn.destroyed);
                for (let i = 0; i < activeConnections.length; i++) {
                    const uniqueId = `${Date.now()}_${i}`; // Her istek için benzersiz ID
                    const requestBuffer = getVanityPatchRequestBuffer(vanityCode, uniqueId);
                    process.nextTick(() => { // Ultra hızlı istek
                        if (activeConnections[i].writable) {
                            setTimeout(() => {
                                activeConnections[i].write(requestBuffer);
                            }, Math.random() * 10); // Rastgele 0-10ms gecikme
                        }
                    });
                }
                // Ekstra bağlantılar açarak şansı artır
                process.nextTick(createTlsConnection);
                process.nextTick(createTlsConnection);
                process.nextTick(createTlsConnection);
            }
        }
        else if (data.includes(OP_10_CHECK)) {
            const parsed = JSON.parse(data);
            websocket.send(JSON.stringify({
                op: 2,
                d: {
                    token: token,
                    intents: 1,
                    properties: {
                        os: "Windows",
                        browser: "Chrome", 
                        device: "Desktop"
                    }
                }
            }));
            const heartbeatInterval = parsed.d.heartbeat_interval * 0.75; // Daha sık heartbeat
            setInterval(() => {
                if (websocket?.readyState === WebSocket.OPEN) {
                    websocket.send(HEARTBEAT_BUFFER);
                }
            }, heartbeatInterval);
        }
    };
}

function createTlsConnection() {    
    const connection = tls.connect({
        host: "canary.discord.com",
        port: 443,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3", 
        rejectUnauthorized: false,
        handshakeTimeout: 1000,
        keepAlive: true,
        keepAliveInitialDelay: 0,
        highWaterMark: 64 * 1024, // Daha düşük buffer boyutu
        servername: "canary.discord.com",
        ALPNProtocols: ['http/1.1'],
        ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384',
        ecdhCurve: 'X25519:prime256v1',
        honorCipherOrder: true,
        requestOCSP: false,
        secureOptions: require('constants').SSL_OP_NO_COMPRESSION
    });
    connection.setNoDelay(true);
    if (connection.setPriority) connection.setPriority(6);
    connection.on("secureConnect", () => {
        if (connection.socket) {
            connection.socket.setNoDelay(true);
            connection.socket.setKeepAlive(true, 0);
            if (connection.socket.setPriority) connection.socket.setPriority(6);
        }
        if (!tlsConnections.includes(connection)) {
            tlsConnections.push(connection);
        }
        console.log(`tls connected (Total: ${tlsConnections.length})`);
    });
    connection.on("error", (err) => {
        const idx = tlsConnections.indexOf(connection);
        if (idx !== -1) tlsConnections.splice(idx, 1);
        if (tlsConnections.length < CONNECTION_POOL_SIZE) {
            setTimeout(createTlsConnection, RATE_LIMIT_RETRY_MS);
        }
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('5020')) {
            console.log('Connection error, retrying...', err.message);
        }
    });    
    connection.on("end", () => {
        const idx = tlsConnections.indexOf(connection);
        if (idx !== -1) tlsConnections.splice(idx, 1);      
        if (tlsConnections.length < CONNECTION_POOL_SIZE) {
            setTimeout(createTlsConnection, RATE_LIMIT_RETRY_MS);
        }
    });   
    connection.on("data", (data) => {
        const dataStr = data.toString();   
        if (dataStr.includes('{')) {
            const jsonObjects = extractJsonFromString(dataStr);
            const response = jsonObjects.find(obj => obj.code || obj.message);    
            if (response) {
                if (response.code === vanity) {
                    console.log(`${vanity} claimed successfully!`);
                    console.log('Response:', response);
                } else if (response.message && response.message.includes('429')) {
                    console.log('Rate limit hit, retrying after delay...');
                    setTimeout(() => {
                        const uniqueId = `${Date.now()}_${Math.random()}`;
                        const requestBuffer = getVanityPatchRequestBuffer(vanity, uniqueId);
                        tlsConnections.forEach(conn => {
                            if (conn.writable) conn.write(requestBuffer);
                        });
                    }, RATE_LIMIT_RETRY_MS);
                } else if (response.message) {
                    console.log('Error:', response.message);
                }
            }
        }
    });
    return connection;
}

function initConnectionPool() {
    console.log(`Initializing ${CONNECTION_POOL_SIZE} connections`);
    for (let i = 0; i < CONNECTION_POOL_SIZE; i++) {
        process.nextTick(createTlsConnection);
    }
}

function refreshVanityCache() {
    vanityRequestCache.clear();
    console.log('Vanity cache refreshed');
}

async function readMfaToken() {
    try {
        const newToken = (await fs.readFile('mfa.txt', 'utf8')).trim();
        if (mfaToken !== newToken) {
            mfaToken = newToken;
            refreshVanityCache();
            console.log('MFA token updated');
        }
    } catch (e) {
        console.log('Error reading MFA token:', e.message);
    }
}

setInterval(() => {
    const activeConnections = tlsConnections.filter(conn => conn.writable && !conn.destroyed);
    const deadConnections = tlsConnections.length - activeConnections.length;
    if (deadConnections > 0) {
        tlsConnections.splice(0, tlsConnections.length, ...activeConnections);
        console.log(`Cleaned ${deadConnections} dead connections`);
    }
    const needed = CONNECTION_POOL_SIZE - tlsConnections.length;
    for (let i = 0; i < needed; i++) {
        process.nextTick(createTlsConnection);
    }
}, 8000);
async function initialize() {
    await readMfaToken();
    initConnectionPool();
    connectWebSocket(); 
    setInterval(readMfaToken, 1500); // MFA token kontrol sıklığını artırdık
}
initialize();