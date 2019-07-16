// 'use strict';

// const crypto = require('crypto');
// const Buffer = require('safe-buffer').Buffer;
// const retrieveBSON = require('../connection/utils').retrieveBSON;
// const MongoError = require('../error').MongoError;
// const AuthProvider = require('./auth_provider').AuthProvider;
import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
import { saslprep } from "https://denopkg.com/chiefbiiko/saslprep/mod.ts";
import { encode,decode } from "https://denopkg.com/chiefbiiko/std-encoding/mod.ts";
import { md5 } from "https://denopkg.com/chiefbiiko/md5/mod.ts";
import { sha1 } from "https://denopkg.com/chiefbiiko/sha1/mod.ts";
import { sha256 } from "https://denopkg.com/chiefbiiko/sha256/mod.ts";
import { hmac } from "https://denopkg.com/chiefbiiko/hmac/mod.ts";
import { pbkdf2 } from "https://denopkg.com/chiefbiiko/pbkdf2/mod.ts";
import {MongoError} from "./../errors.ts"
import { AuthProvider, SendAuthCommand } from "./auth_provider.ts"
import { Connection} from "./../connection/connection.ts"
import { MongoCredentials } from "./mongo_credentials.ts"
import {Callback, concat, noop} from "./../utils.ts"

// const BSON = retrieveBSON();
// const Binary = BSON.Binary;

// let saslprep;
// try {
//   saslprep = require('saslprep');
// } catch (e) {
//   // don't do anything;
// }

/** Parses a payload. */
function parsePayload(payload: string): {[key:string]:any} {
  const dict: {[key:string]:any} = {};
  const parts: string[] = payload.split(',');

  for (let i: number = 0; i < parts.length; i++) {
    const valueParts: string[] = parts[i].split('=');
    dict[valueParts[0]] = valueParts[1];
  }

  return dict;
}

/** Creates a MD5 digest of the username and password pair. */
function credentialsDigest(username: string, password: string): Uint8Array {
  // if (typeof username !== 'string') throw new MongoError('username must be a string');
  // if (typeof password !== 'string') throw new MongoError('password must be a string');
  if (!password.length) {throw new MongoError('password cannot be empty');}

  // // Use node md5 generator
  // var md5 = crypto.createHash('md5');
  // // Generate keys used for authentication
  // md5.update(username + ':mongo:' + password, 'utf8');
  // return md5.digest('hex');
  return md5(`${username}:mongo:${password}`, "utf8", "hex")
}

// XOR two buffers
function xor(a: Uint8Array, b: Uint8Array): string {
  // if (!Buffer.isBuffer(a)) a = Buffer.from(a);
  // if (!Buffer.isBuffer(b)) b = Buffer.from(b);
  const length: number = Math.max(a.byteLength, b.byteLength);
  // const res = [];
  const c: Uint8Array = new Uint8Array(length);

  for (let i: number = 0; i < length; ++i ) {
    // res.push(a[i] ^ b[i]);
    c[i] = a[i] ^ b[i]
  }

  // return Buffer.from(res).toString('base64');
  return decode(c, "base64")
}

/** Obtains a SHA1 or SHA256 diigest. */
function H(method: string, text: Uint8Array): Uint8Array {
  if (method.toLowerCase() === "sha256") {
    return sha256(text);
  } else if (method.toLowerCase() === "sha1") {
    return sha1(text)
  }
  // return crypto
  //   .createHash(method)
  //   .update(text)
  //   .digest();
}

// function HMAC(method: string, key: Uint8Array, text: Uint8Array): Uint8Array {
//   return hmac(method, key, text)
//   // return crypto
//   //   .createHmac(method, key)
//   //   .update(text)
//   //   .digest();
// }

let _hiCache: {[key:string]: Uint8Array} = {};
let _hiCacheCount: number = 0;

/** Purges the hiCache. */
function _hiCachePurge (): void {
  _hiCache = {};
  _hiCacheCount = 0;
};

const hiLengthMap: {[key:string]: number} = {
  sha256: 32,
  sha1: 20
};

/** Derives and caches a key. */
function HI(data: Uint8Array, salt: Uint8Array, iterations: number, cryptoMethod: string): Uint8Array {
  // omit the work if already generated
  // const key = [data, salt.toString('base64'), iterations].join('_');
  const key: string  = [decode(data, "base64"), decode(salt, "base64"), iterations].join('_');

    // const key: string = [decode(data, "base64"), decode(salt, "base64"), iterations].join('_');

  if (_hiCache[key]) {
    return _hiCache[key];
  }

  // generate the salt
  // const saltedData: Uint8Array = crypto.pbkdf2Sync(
  //   data,
  //   salt,
  //   iterations,
  //   hiLengthMap[cryptoMethod],
  //   cryptoMethod
  // );
  const saltedData: Uint8Array =   pbkdf2(
          cryptoMethod,
      data,
      salt,
      null,
      null,
      hiLengthMap[cryptoMethod],
      iterations
    );

  // cache a copy to speed up the next lookup, but prevent unbounded cache growth
  if (_hiCacheCount >= 200) {
    _hiCachePurge();
  }

  _hiCache[key] = saltedData;

  ++_hiCacheCount //+= 1;

  return saltedData;
}

/** Class representation of a SCRAM-SHA authentication mechanism. */
class ScramSHA extends AuthProvider {
  readonly cryptoMethod: string

  /** Creates a new ScramSHA authentication mechanism. */
  constructor(/*bson, */cryptoMethod: string) {
    // super(bson);
    super()
    this.cryptoMethod = cryptoMethod || 'sha1';
  }

  /** Transforms possibly plain objects to correct errors. */
  static _getError(err? :MongoError, r?:{[key:string]: any}): MongoError {
    if (err) {
      return err;
    }

    if (r &&(r.$err || r.errmsg)) {
      return new MongoError(r);
    }

    return null
  }

  /** Executes SCRAM authentication. */
  _executeScram(sendAuthCommand: SendAuthCommand, connection: Connection, credentials: MongoCredentials, nonce: string, callback: Callback=noop): void {
    let username: string = credentials.username;
    const password: string = credentials.password;
    const db: string = credentials.source;

    const cryptoMethod: string = this.cryptoMethod;
    let mechanism: string = 'SCRAM-SHA-1';
    let processedCredentials: string | Uint8Array;

    if (cryptoMethod === 'sha256') {
      mechanism = 'SCRAM-SHA-256';
      processedCredentials = saslprep ? saslprep(password) : password;
    } else {
      try {
        processedCredentials = credentialsDigest(username, password);
      } catch (err) {
        return callback(err);
      }
    }

    // Clean up the user
    username = username.replace('=', '=3D').replace(',', '=2C');

    // NOTE: This is done b/c Javascript uses UTF-16, but the server is hashing in UTF-8.
    // Since the username is not sasl-prep-d, we need to do this here.
    // const firstBare = Buffer.concat([
    //   Buffer.from('n=', 'utf8'),
    //   Buffer.from(username, 'utf8'),
    //   Buffer.from(',r=', 'utf8'),
    //   Buffer.from(nonce, 'utf8')
    // ]);

    const firstBare: Uint8Array = concat([
      encode("n=", "utf8"),
      encode(username, "utf8"),
      encode(",r=", "utf8"),
      encode(nonce, "utf8")
    ])

    // Build command structure
    const saslStartCmd: {[key:string]:any} = {
      saslStart: 1,
      mechanism,
      payload: new BSON.Binary(concat([encode('n,,', 'utf8'), firstBare])),
      autoAuthorize: 1
    };

    // Write the commmand on the connection
    sendAuthCommand(connection, `${db}.$cmd`, saslStartCmd, (err? : MongoError, r?:{[key:string]:any}):void => {
      const tmpError: MongoError = ScramSHA._getError(err, r);

      if (tmpError) {
        return callback(tmpError, null);
      }

      const payload: BSON.Binary = r.payload instanceof Uint8Array ? new BSON.Binary(r.payload) : r.payload;
      const dict: {[key:string]:any} = parsePayload(payload.value());
      const iterations: number = parseInt(dict.i, 10);
      const salt: string = dict.s;
      const rnonce: string = dict.r;

      // Set up start of proof
      const withoutProof: string = `c=biws,r=${rnonce}`;

      const saltedPassword: Uint8Array = HI(
        typeof processedCredentials === "string" ? encode(processedCredentials, "utf8") : processedCredentials,
        encode(salt, 'base64'),
        iterations,
        cryptoMethod
      );

      if (iterations && iterations < 4096) {
        const error: MongoError = new MongoError(`Server returned an invalid iteration count ${iterations}`);
        return callback(error, false);
      }

      // const clientKey = HMAC(cryptoMethod, saltedPassword, 'Client Key');
      const clientKey: Uint8Array = hmac(cryptoMethod, "Client Key", saltedPassword)
      const storedKey: Uint8Array = H(cryptoMethod, clientKey);
      // const authMessage: string = [firstBare, payload.value().toString('base64'), withoutProof].join(',');
      const authMessage: string = [firstBare, payload.value(), withoutProof].join(',');

      const clientSignature: Uint8Array = hmac(cryptoMethod, storedKey, authMessage);
      const clientProof: string = `p=${xor(clientKey, clientSignature)}`;
      const clientFinal: string = [withoutProof, clientProof].join(',');

      const saslContinueCmd: {[key:string]:any} = {
        saslContinue: 1,
        conversationId: r.conversationId,
        payload: new BSON.Binary(encode(clientFinal, "utf8"))
      };

      sendAuthCommand(connection, `${db}.$cmd`, saslContinueCmd, (err? :MongoError, r?:{[key:string]:any}):void => {
        if (!r || r.done !== false) {
          return callback(err, r);
        }

        const retrySaslContinueCmd: {[key:string]:any} = {
          saslContinue: 1,
          conversationId: r.conversationId,
          payload: new Uint8Array(0)
        };

        sendAuthCommand(connection, `${db}.$cmd`, retrySaslContinueCmd, callback);
      });
    });
  }

  /** Implementation of authentication for a single connection. */
  _authenticateSingleConnection(sendAuthCommand: SendAuthCommand, connection: Connection, credentials: MongoCredentials, callback: Callback=noop): void {
    // Create a random nonce
    // crypto.randomBytes(24, (err, buff) => {
    //   if (err) {
    //     return callback(err, null);
    //   }
    //
    //   return this._executeScram(
    //     sendAuthCommand,
    //     connection,
    //     credentials,
    //     buff.toString('base64'),
    //     callback
    //   );
    // });

    const randomBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(24))

    this._executeScram(
      sendAuthCommand,
      connection,
      credentials,
      // buff.toString('base64'),
      decode(randomBytes, "base64"),
      callback
    )
  }

  /** Authenticates. */
  auth(sendAuthCommand: SendAuthCommand, connections: Connection[], credentials: MongoCredentials, callback: Callback=noop): void {
    this._checkSaslprep();
    super.auth(sendAuthCommand, connections, credentials, callback);
  }


  /** NOTE: obsolete. */
  _checkSaslprep(): void {
    // const cryptoMethod = this.cryptoMethod;
    //
    // if (cryptoMethod === 'sha256') {
    //   if (!saslprep) {
    //     console.warn('Warning: no saslprep library specified. Passwords will not be sanitized');
    //   }
    // }
    console.warn("obsolete ScramSHA.prototype._checkSaslprep method is a noop")
  }
}

/** Class representation of a SCRAM-SHA1 authentication mechanism. */
export class ScramSHA1 extends ScramSHA {

  /** Creates a ScramSHA1 auth mechanism. */
  constructor(/*bson*/) {
    super(/*bson, */'sha1');
  }
}

/** Class representation of a SCRAM-SHA256 authentication mechanism. */
export class ScramSHA256 extends ScramSHA {

    /** Creates a ScramSHA1 auth mechanism. */
  constructor() {
    super( 'sha256');
  }
}

// module.exports = { ScramSHA1, ScramSHA256 };
