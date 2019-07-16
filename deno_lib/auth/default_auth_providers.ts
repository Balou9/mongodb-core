// 'use strict';

// const MongoCR = require('./mongocr');
// const X509 = require('./x509');
// const Plain = require('./plain');
// const GSSAPI = require('./gssapi');
// const SSPI = require('./sspi');
// const ScramSHA1 = require('./scram').ScramSHA1;
// const ScramSHA256 = require('./scram').ScramSHA256;

// import { X509 } from "./x509.ts";
import { Plain } from "./plain.ts"
// import { GSSAPI } from "./gssapi.ts"
// import { SSPI } from "./sspi.ts"
import { ScramSHA1, ScramSHA256 } from "./scram.ts"

export const DEFAULT_AUTH_PROVIDERS: {[key:string]: Function} = {
  // DEPRECATED// mongocr: new MongoCR(),
  // x509: new X509(),
  plain: new Plain(),
  // gssapi: new GSSAPI(),
  // sspi: new SSPI(),
  'scram-sha-1': new ScramSHA1(),
  'scram-sha-256': new ScramSHA256()
}

// /**
//  * Returns the default authentication providers.
//  *
//  * @param {BSON} bson Bson definition
//  * @returns {Object} a mapping of auth names to auth types
//  */
// function defaultAuthProviders(bson) {
//   return {
//     mongocr: new MongoCR(bson),
//     x509: new X509(bson),
//     plain: new Plain(bson),
//     gssapi: new GSSAPI(bson),
//     sspi: new SSPI(bson),
//     'scram-sha-1': new ScramSHA1(bson),
//     'scram-sha-256': new ScramSHA256(bson)
//   };
// }

// module.exports = { defaultAuthProviders };
