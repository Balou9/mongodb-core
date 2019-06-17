'use strict';
// const net = require('net');
// const tls = require('tls');
// const Connection = require('./connection');
import { Connection } from "./connection.ts";
// const Query = require('./commands').Query;
import { Query } from "./commmands.ts"
// const createClientInfo = require('../topologies/shared').createClientInfo;
import { createClientInfo } from "./../topologies/shared.ts";
// const MongoError = require('../error').MongoError;
import { MongoError, MongoNetworkError} from "./../errors.ts"
// const MongoNetworkError = require('../error').MongoNetworkError;
// const defaultAuthProviders = require('../auth/defaultAuthProviders').defaultAuthProviders;
import { defaultAuthProviders } from "./../auth/defaultAuthProviders.ts"
// const WIRE_CONSTANTS = require('../wireprotocol/constants');
// const MAX_SUPPORTED_WIRE_VERSION = WIRE_CONSTANTS.MAX_SUPPORTED_WIRE_VERSION;
// const MAX_SUPPORTED_SERVER_VERSION = WIRE_CONSTANTS.MAX_SUPPORTED_SERVER_VERSION;
// const MIN_SUPPORTED_WIRE_VERSION = WIRE_CONSTANTS.MIN_SUPPORTED_WIRE_VERSION;
// const MIN_SUPPORTED_SERVER_VERSION = WIRE_CONSTANTS.MIN_SUPPORTED_SERVER_VERSION;
import {MAX_SUPPORTED_WIRE_VERSION, MAX_SUPPORTED_SERVER_VERSION,
MIN_SUPPORTED_WIRE_VERSION, MIN_SUPPORTED_SERVER_VERSION} from "./../wireprotocol/constants.ts"

export interface ConnectOptions {
  family?: number;
  bson?: unknown;
}

let AUTH_PROVIDERS: unknown;

function connect(options: ConnectOptions, callback: (err?: Error, socket?: unknown) => void): void {
  if (!AUTH_PROVIDERS) {
    AUTH_PROVIDERS = defaultAuthProviders(options.bson);
  }

  if (options.family !== void 0) {
    return makeConnection(options.family, options, (err: Error, socket: unknown): void => {
      if (err) {
        return callback(err, socket); // in the error case, `socket` is the originating error event name
      }

      performInitialHandshake(new Connection(socket, options), options, callback);
    });
  }

  return makeConnection(6, options, (err: Error, ipv6Socket: unknown): void => {
    if (err) {
      return makeConnection(4, options, (err: Error, ipv4Socket: unknown): void => {
        if (err) {
          return callback(err, ipv4Socket); // in the error case, `ipv4Socket` is the originating error event name
        }

        performInitialHandshake(new Connection(ipv4Socket, options), options, callback);
      });
    }

    performInitialHandshake(new Connection(ipv6Socket, options), options, callback);
  });
}

function getSaslSupportedMechs(options?: {[key:string]: any}): { saslSupportedMechs?: string} {
  if (!(options && options.credentials)) {
    return {};
  }

  // const credentials: {[key:string]: any} = options.credentials;

  // TODO: revisit whether or not items like `options.user` and `options.dbName` should be checked here
  const authMechanism: any = options.credentials.mechanism;
  const authSource: string = options.credentials.source || options.dbName || 'admin';
  const user: string = options.credentials.username || options.user;

  if (typeof authMechanism === 'string' && authMechanism.toUpperCase() !== 'DEFAULT') {
    return {};
  }

  if (!user) {
    return {};
  }

  return { saslSupportedMechs: `${authSource}.${user}` };
}

function checkSupportedServer(ismaster: {[key:string]: any}, options: {[key:string]: any}): MongoError {
  const serverVersionHighEnough: boolean =
    ismaster &&
    typeof ismaster.maxWireVersion === 'number' &&
    ismaster.maxWireVersion >= MIN_SUPPORTED_WIRE_VERSION;
  const serverVersionLowEnough: boolean =
    ismaster &&
    typeof ismaster.minWireVersion === 'number' &&
    ismaster.minWireVersion <= MAX_SUPPORTED_WIRE_VERSION;

  if (serverVersionHighEnough) {
    if (serverVersionLowEnough) {
      return null;
    }

    const message: string = `Server at ${options.host}:${options.port} reports minimum wire version ${
      ismaster.minWireVersion
    }, but this version of the Node.js Driver requires at most ${MAX_SUPPORTED_WIRE_VERSION} (MongoDB ${MAX_SUPPORTED_SERVER_VERSION})`;
    return new MongoError(message);
  }

  const message: string = `Server at ${options.host}:${
    options.port
  } reports maximum wire version ${ismaster.maxWireVersion ||
    0}, but this version of the Node.js Driver requires at least ${MIN_SUPPORTED_WIRE_VERSION} (MongoDB ${MIN_SUPPORTED_SERVER_VERSION})`;
  return new MongoError(message);
}

function performInitialHandshake(conn: Connection, options: {[key:string]: any}, callback: (err?: Error, socket?: unknown) => void): void {
  function _callback(err?: Error, rtn?: unknown): void {
    if (err && conn) {
      conn.destroy();
    }
    callback(err, rtn);
  };

  let compressors: unknown[] = [];
  if (options.compression && options.compression.compressors) {
    compressors = options.compression.compressors;
  }

  const handshakeDoc: {[key:string]: any} = Object.assign(
    {
      ismaster: true,
      client: createClientInfo(options),
      compression: compressors
    },
    getSaslSupportedMechs(options)
  );

  const start: number = new Date().getTime();
  runCommand(conn, 'admin.$cmd', handshakeDoc, options, (err: Error, ismaster: {[key:string]: any}): void => {
    if (err) {
      return _callback(err, null);
    }

    if (ismaster.ok === 0) {
      return _callback(new MongoError(ismaster), null);
    }

    const supportedServerErr: MongoError = checkSupportedServer(ismaster, options);
    
    if (supportedServerErr) {
      return   _callback(supportedServerErr, null);
    }

    // resolve compression
    if (ismaster.compression) {
      const agreedCompressors: unknown[] = compressors.filter(
        compressor => ismaster.compression.indexOf(compressor) !== -1
      );

      if (agreedCompressors.length) {
        conn.agreedCompressor = agreedCompressors[0];
      }

      if (options.compression && options.compression.zlibCompressionLevel) {
        conn.zlibCompressionLevel = options.compression.zlibCompressionLevel;
      }
    }

    // NOTE: This is metadata attached to the connection while porting away from
    //       handshake being done in the `Server` class. Likely, it should be
    //       relocated, or at very least restructured.
    conn.ismaster = ismaster;
    conn.lastIsMasterMS = new Date().getTime() - start;

    const credentials: Credentials = options.credentials;
    
    if (!ismaster.arbiterOnly && credentials) {
      credentials.resolveAuthMechanism(ismaster);
      return authenticate(conn, credentials, _callback);
    }

    _callback(null, conn);
  });
}

const LEGAL_SSL_SOCKET_OPTIONS: string[] = [
  'pfx',
  'key',
  'passphrase',
  'cert',
  'ca',
  'ciphers',
  'NPNProtocols',
  'ALPNProtocols',
  'servername',
  'ecdhCurve',
  'secureProtocol',
  'secureContext',
  'session',
  'minDHSize',
  'crl',
  'rejectUnauthorized'
];

function parseConnectOptions(family: number, options: {[key:string]: any}): {[key:string]: any} {
  const host: string = typeof options.host === 'string' ? options.host : 'localhost';
  
  if (host.indexOf('/') !== -1) {
    return { path: host };
  }

  const result: {[key:string]: any} = {
    family,
    host,
    port: typeof options.port === 'number' ? options.port : 27017,
    rejectUnauthorized: false
  };

  return result;
}

function parseSslOptions(family: number, options: {[key:string]: any}): {[key:string]: any} {
  const result: {[key:string]: any} = parseConnectOptions(family, options);

  // Merge in valid SSL options
  for (const name in options) {
    if (options[name] != null && LEGAL_SSL_SOCKET_OPTIONS.indexOf(name) !== -1) {
      result[name] = options[name];
    }
  }

  // Override checkServerIdentity behavior
  if (!options.checkServerIdentity) {
    // Skip the identiy check by retuning undefined as per node documents
    // https://nodejs.org/api/tls.html#tls_tls_connect_options_callback
    result.checkServerIdentity = (..._: any[]): void => undefined;
  } else if (typeof options.checkServerIdentity === 'function') {
    result.checkServerIdentity = options.checkServerIdentity;
  }

  // Set default sni servername to be the same as host
  if (!result.servername) {
    result.servername = result.host;
  }

  return result;
}

function makeConnection(family: number, options: {[key:string]: any}, callback:(err?: Error, socket?: unknown) => void): void {
  const useSsl = typeof options.ssl === 'boolean' ? options.ssl : false;
  const keepAlive = typeof options.keepAlive === 'boolean' ? options.keepAlive : true;
  let keepAliveInitialDelay =
    typeof options.keepAliveInitialDelay === 'number' ? options.keepAliveInitialDelay : 300000;
  const noDelay = typeof options.noDelay === 'boolean' ? options.noDelay : true;
  const connectionTimeout =
    typeof options.connectionTimeout === 'number' ? options.connectionTimeout : 30000;
  const socketTimeout = typeof options.socketTimeout === 'number' ? options.socketTimeout : 360000;
  const rejectUnauthorized =
    typeof options.rejectUnauthorized === 'boolean' ? options.rejectUnauthorized : true;

  if (keepAliveInitialDelay > socketTimeout) {
    keepAliveInitialDelay = Math.round(socketTimeout / 2);
  }

  let socket: unknown;
  function _callback(err: Error, rtn: unknown): void {
    if (err && socket) {
      socket.destroy();
    }
    
    callback(err, rtn);
  };

  try {
    if (useSsl) {
      socket = tls.connect(parseSslOptions(family, options));
      if (typeof socket.disableRenegotiation === 'function') {
        socket.disableRenegotiation();
      }
    } else {
      socket = net.createConnection(parseConnectOptions(family, options));
    }
  } catch (err) {
    return _callback(err);
  }

  socket.setKeepAlive(keepAlive, keepAliveInitialDelay);
  socket.setTimeout(connectionTimeout);
  socket.setNoDelay(noDelay);

  const errorEvents: string[] = ['error', 'close', 'timeout', 'parseError', 'connect'];
  
  function errorHandler(eventName: string): (err: Error) => void {
    return (err: Error): void => {
      errorEvents.forEach((event: string) => socket.removeAllListeners(event));
      socket.removeListener('connect', connectHandler);
      _callback(connectionFailureError(eventName, err), eventName);
    };
  }

  function connectHandler(): void {
    errorEvents.forEach(event => socket.removeAllListeners(event));
    if (socket.authorizationError && rejectUnauthorized) {
      return _callback(socket.authorizationError);
    }

    socket.setTimeout(socketTimeout);
    _callback(null, socket);
  }

  socket.once('error', errorHandler('error'));
  socket.once('close', errorHandler('close'));
  socket.once('timeout', errorHandler('timeout'));
  socket.once('parseError', errorHandler('parseError'));
  socket.once('connect', connectHandler);
}

const CONNECTION_ERROR_EVENTS = ['error', 'close', 'timeout', 'parseError'];
function runCommand(conn, ns, command, options, callback) {
  if (typeof options === 'function') (callback = options), (options = {});
  const socketTimeout = typeof options.socketTimeout === 'number' ? options.socketTimeout : 360000;
  const bson = conn.options.bson;
  const query = new Query(bson, ns, command, {
    numberToSkip: 0,
    numberToReturn: 1
  });

  function errorHandler(err) {
    conn.resetSocketTimeout();
    CONNECTION_ERROR_EVENTS.forEach(eventName => conn.removeListener(eventName, errorHandler));
    conn.removeListener('message', messageHandler);
    callback(err, null);
  }

  function messageHandler(msg) {
    if (msg.responseTo !== query.requestId) {
      return;
    }

    conn.resetSocketTimeout();
    CONNECTION_ERROR_EVENTS.forEach(eventName => conn.removeListener(eventName, errorHandler));
    conn.removeListener('message', messageHandler);

    msg.parse({ promoteValues: true });
    callback(null, msg.documents[0]);
  }

  conn.setSocketTimeout(socketTimeout);
  CONNECTION_ERROR_EVENTS.forEach(eventName => conn.once(eventName, errorHandler));
  conn.on('message', messageHandler);
  conn.write(query.toBin());
}

function authenticate(conn, credentials, callback) {
  const mechanism = credentials.mechanism;
  if (!AUTH_PROVIDERS[mechanism]) {
    callback(new MongoError(`authMechanism '${mechanism}' not supported`));
    return;
  }

  const provider = AUTH_PROVIDERS[mechanism];
  provider.auth(runCommand, [conn], credentials, err => {
    if (err) return callback(err);
    callback(null, conn);
  });
}

function connectionFailureError(type, err) {
  switch (type) {
    case 'error':
      return new MongoNetworkError(err);
    case 'timeout':
      return new MongoNetworkError(`connection timed out`);
    case 'close':
      return new MongoNetworkError(`connection closed`);
    default:
      return new MongoNetworkError(`unknown network error`);
  }
}

module.exports = connect;
