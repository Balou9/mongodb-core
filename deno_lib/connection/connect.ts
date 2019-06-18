'use strict';
// const net = require('net');
// const tls = require('tls');
// const Connection = require('./connection');
import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// import { decode } from "https://denopkg.com/chiefbiiko/std-encoding/mod.ts";

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

export async function connect(options: ConnectOptions): Promise<Connection> {
  if (!AUTH_PROVIDERS) {
    AUTH_PROVIDERS = defaultAuthProviders(options.bson);
  }

  if (options.family !== 4 && options.family !== 6) {
    throw new MongoNetworkError(`Unsupported ip version: ${options.family}.`)
  }

  const conn: Deno.Conn = await  makeConnection(options.family, options)

  return performInitialHandshake(new Connection(conn, options), options)

  // try {
  //   return performInitialHandshake(new Connection(await  makeConnection(6, options), options), options)
  // } catch (_) {
  //   try {
  //     return performInitialHandshake(new Connection(await  makeConnection(4, options), options), options)
  //   } catch (err) {
  //     throw err
  //   }
  // }

  // return makeConnection(6, options, (err: Error, ipv6Socket: unknown): void => {
  //   if (err) {
  //     return makeConnection(4, options, (err: Error, ipv4Socket: unknown): void => {
  //       if (err) {
  //         return callback(err, ipv4Socket); // in the error case, `ipv4Socket` is the originating error event name
  //       }
  //
  //       performInitialHandshake(new Connection(ipv4Socket, options), options, callback);
  //     });
  //   }
  //
  //   performInitialHandshake(new Connection(ipv6Socket, options), options, callback);
  // });
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

async function performInitialHandshake(connection: Connection, options: {[key:string]: any}): Promise<Connection> {
  // function _callback(err?: Error, rtn?: unknown): void {
  //   if (err && conn) {
  //     conn.destroy();
  //   }
  //   callback(err, rtn);
  // };

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

  runCommand(connection, 'admin.$cmd', handshakeDoc, options, (err: Error, ismaster: {[key:string]: any}): void => {
    if (err) {
      connection.destroy()
      // return _callback(err, null);
      throw err
    }

    if (ismaster.ok === 0) {
      // return _callback(new MongoError(ismaster), null);
      connection.destroy()
      throw new MongoError(ismaster)
    }

    const supportedServerErr: MongoError = checkSupportedServer(ismaster, options);

    if (supportedServerErr) {
      // return   _callback(supportedServerErr, null);
      connection.destroy()
      throw supportedServerErr
    }

    // resolve compression
    if (ismaster.compression) {
      const agreedCompressors: unknown[] = compressors.filter(
        (compressor: any): boolean => ismaster.compression.indexOf(compressor) !== -1
      );

      if (agreedCompressors.length) {
        connection.agreedCompressor = agreedCompressors[0];
      }

      if (options.compression && options.compression.zlibCompressionLevel) {
        connection.zlibCompressionLevel = options.compression.zlibCompressionLevel;
      }
    }

    // NOTE: This is metadata attached to the connection while porting away from
    //       handshake being done in the `Server` class. Likely, it should be
    //       relocated, or at very least restructured.
    connection.ismaster = ismaster;
    connection.lastIsMasterMS = new Date().getTime() - start;

    const credentials: {[key:string]: any} = options.credentials;

    if (!ismaster.arbiterOnly && credentials) {
      credentials.resolveAuthMechanism(ismaster);
      return authenticate(connection, credentials);
    }

    return connection;
  });
}

// const LEGAL_SSL_SOCKET_OPTIONS: string[] = [
//   'pfx',
//   'key',
//   'passphrase',
//   'cert',
//   'ca',
//   'ciphers',
//   'NPNProtocols',
//   'ALPNProtocols',
//   'servername',
//   'ecdhCurve',
//   'secureProtocol',
//   'secureContext',
//   'session',
//   'minDHSize',
//   'crl',
//   'rejectUnauthorized'
// ];

/** Parses an address string from connection options. */
function parseConnectAddress(options: {[key:string]: any}): string {
  const host : string = options.host === 'string' ? options.host : 'localhost';
  const port : number = typeof options.port === 'number' ? options.port : 27017;
  return `${host}:${port}`;
}

// function parseConnectOptions(family: number, options: {[key:string]: any}): {[key:string]: any} {
//   const host: string = typeof options.host === 'string' ? options.host : 'localhost';
//
//   if (host.indexOf('/') !== -1) {
//     return { path: host };
//   }
//
//   const result: {[key:string]: any} = {
//     family,
//     host,
//     port: typeof options.port === 'number' ? options.port : 27017,
//     rejectUnauthorized: false
//   };
//
//   return result;
// }

// function parseSslOptions(family: number, options: {[key:string]: any}): {[key:string]: any} {
//   const result: {[key:string]: any} = parseConnectOptions(family, options);
//
//   // Merge in valid SSL options
//   for (const name in options) {
//     if (options[name] != null && LEGAL_SSL_SOCKET_OPTIONS.indexOf(name) !== -1) {
//       result[name] = options[name];
//     }
//   }
//
//   // Override checkServerIdentity behavior
//   if (!options.checkServerIdentity) {
//     // Skip the identiy check by retuning undefined as per node documents
//     // https://nodejs.org/api/tls.html#tls_tls_connect_options_callback
//     result.checkServerIdentity = (..._: any[]): void => undefined;
//   } else if (typeof options.checkServerIdentity === 'function') {
//     result.checkServerIdentity = options.checkServerIdentity;
//   }
//
//   // Set default sni servername to be the same as host
//   if (!result.servername) {
//     result.servername = result.host;
//   }
//
//   return result;
// }

async function makeConnection(family: number, options: {[key:string]: any}): Promise<Deno.Conn> {
  const useTLS: boolean = typeof options.tls === 'boolean'
    ? options.tls
    : typeof options.ssl === 'boolean' ? options.ssl : false;
  const keepAlive: boolean = typeof options.keepAlive === 'boolean' ? options.keepAlive : true;
  let keepAliveInitialDelay: number =
    typeof options.keepAliveInitialDelay === 'number' ? options.keepAliveInitialDelay : 300000;
  const noDelay: boolean = typeof options.noDelay === 'boolean' ? options.noDelay : true;
  const connectionTimeout: number =
    typeof options.connectionTimeout === 'number' ? options.connectionTimeout : 30000;
  const socketTimeout: number = typeof options.socketTimeout === 'number' ? options.socketTimeout : 360000;
  const rejectUnauthorized: boolean =
    typeof options.rejectUnauthorized === 'boolean' ? options.rejectUnauthorized : true;

  if (keepAliveInitialDelay > socketTimeout) {
    keepAliveInitialDelay = Math.round(socketTimeout / 2);
  }

  // let conn: Deno.Conn;

  // function _callback(err?: Error, rtn?: unknown): void {
  //   if (err && conn) {
  //     // socket.destroy();
  //     conn.close();
  //   }
  //   callback(err, rtn);
  // };

  // try {
  //
  // } catch (err) {
  //   if (conn) {
  //     conn.close();
  //   }
  //
  //   // return callback(err);
  //   throw err;
  // }

  if (useTLS) {
    // socket = tls.connect(parseSslOptions(family, options));
    // if (typeof socket.disableRenegotiation === 'function') {
    //   socket.disableRenegotiation();
    // }
    throw new Error("TLS TCP connections not supported yet.")
  } else {
    // socket = net.createConnection(parseConnectOptions(family, options));
    // conn = await Deno.dial("tcp", parseConnectAddress(options));
    return Deno.dial("tcp", parseConnectAddress(options));
  }

  // callback(null, conn)
  // return conn

  // socket.setKeepAlive(keepAlive, keepAliveInitialDelay);
  // socket.setTimeout(connectionTimeout);
  // socket.setNoDelay(noDelay);
  //
  // const errorEvents: string[] = ['error', 'close', 'timeout', 'parseError', 'connect'];
  //
  // function errorHandler(eventName: string): (err: Error) => void {
  //   return (err: Error): void => {
  //     errorEvents.forEach((event: string) => socket.removeAllListeners(event));
  //     socket.removeListener('connect', connectHandler);
  //     _callback(connectionFailureError(eventName, err), eventName);
  //   };
  // }
  //
  // function connectHandler(): void {
  //   errorEvents.forEach(event => socket.removeAllListeners(event));
  //   if (socket.authorizationError && rejectUnauthorized) {
  //     return _callback(socket.authorizationError);
  //   }
  //
  //   socket.setTimeout(socketTimeout);
  //   _callback(null, socket);
  // }
  //
  // socket.once('error', errorHandler('error'));
  // socket.once('close', errorHandler('close'));
  // socket.once('timeout', errorHandler('timeout'));
  // socket.once('parseError', errorHandler('parseError'));
  // socket.once('connect', connectHandler);
}

const CONNECTION_ERROR_EVENTS: string[] = ['error', 'close', 'timeout', 'parseError'];

function runCommand(connection: Connection, ns: string, command: { [key:string]: any}, options: { [key:string]: any}, callback:(err?: Error, doc?: { [key:string]: any}) => void): Promise<void> {
  // if (typeof options === 'function') (callback = options), (options = {});
  const socketTimeout: number = typeof options.socketTimeout === 'number' ? options.socketTimeout : 360000;
  // const bson = conn.options.bson;
  const query: Query = new Query(BSON, ns, command, {
    numberToSkip: 0,
    numberToReturn: 1
  });

  function errorHandler(err?: Error): void {
    connection.resetSocketTimeout();
    CONNECTION_ERROR_EVENTS.forEach((eventName:string): void => connection.removeListener(eventName, errorHandler));
    connection.removeListener('message', messageHandler);
    callback(err, null);
  }

  function messageHandler(msg: { [key:string]: any}): void {
    if (msg.responseTo !== query.requestId) {
      return;
    }

    connection.resetSocketTimeout();
    CONNECTION_ERROR_EVENTS.forEach((eventName:string): void => connection.removeListener(eventName, errorHandler));
    connection.removeListener('message', messageHandler);

    msg.parse({ promoteValues: true });
    callback(null, msg.documents[0]);
  }

  connection.setSocketTimeout(socketTimeout);
  CONNECTION_ERROR_EVENTS.forEach((eventName:string): void => connection.once(eventName, errorHandler));
  connection.on('message', messageHandler);

  connection.write(query.toBin());

  // // REVISIT: this is cheap and unstable - waiting 4 a particular socket msg -
  // const buf: Uint8Array = new Uint8Array(65536);
  // const end: number = Date.now() + socketTimeout
  // let readResult: Deno.ReadResult;
  // let msg: {[key:string]: any};
  //
  // for (;;) {
  //   readResult = await conn.read(buf)
  //
  //   msg = decode(buf.subarray(0, readResult.nread), "utf8")
  //
  //   if (msg.responseTo === query.requestId) {
  //     msg.parse({ promoteValues: true });
  //     // return callback(null, msg.documents[0]);
  //     return msg.documents[0]
  //   }
  //
  //   if (Date.now() >= end) {
  //     // return callback(new MongoError("Connection timeout."))
  //     throw new MongoError("Connection timeout.")
  //   }
  // }
}

async function authenticate(conn: Deno.Conn, credentials: {[key:string]: any}): Promise<Deno.Conn>{
  const mechanism: string = credentials.mechanism;

  if (!AUTH_PROVIDERS[mechanism]) {
    throw new MongoError(`authMechanism '${mechanism}' not supported`)
  }

  const provider: unknown = AUTH_PROVIDERS[mechanism];

  // provider.auth(runCommand, [conn], credentials, (err?: Error) => {
  //   if (err) {return callback(err);}
  //   callback(null, conn);
  // });

  return provider.auth(runCommand, [conn], credentials);
}
//
// function connectionFailureError(type: string, err) {
//   switch (type) {
//     case 'error':
//       return new MongoNetworkError(err);
//     case 'timeout':
//       return new MongoNetworkError(`connection timed out`);
//     case 'close':
//       return new MongoNetworkError(`connection closed`);
//     default:
//       return new MongoNetworkError(`unknown network error`);
//   }
// }
//
// module.exports = connect;
