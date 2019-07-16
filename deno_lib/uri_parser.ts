// 'use strict';
// const URL = require('url');
// const qs = require('querystring');
// const dns = require('dns');
// const MongoParseError = require('./error').MongoParseError;
import {MongoError, MongoParseError} from "./errors.ts"
// const ReadPreference = require('./topologies/read_preference');
import { ReadPreference} from "./topologies/read_preference.ts"
import { Callback, noop} from "./utils.ts"

/**
 * The following regular expression validates a connection string and breaks the
 * provide string into the following capture groups: [protocol, username, password, hosts]
 */
const HOSTS_RX: RegExp = /(mongodb(?:\+srv|)):\/\/(?: (?:[^:]*) (?: : ([^@]*) )? @ )?([^/?]*)(?:\/|)(.*)/;

// Options that are known boolean types
const BOOLEAN_OPTIONS: Set<string> = new Set([
  'slaveok',
  'slave_ok',
  'sslvalidate',
  'fsync',
  'safe',
  'retrywrites',
  'j'
]);

// Known string options
// TODO: Do this for more types
const STRING_OPTIONS: Set<string> = new Set(['authsource', 'replicaset', 'appname']);

// Supported text representations of auth mechanisms
// NOTE: this list exists in native already, if it is merged here we should deduplicate
const AUTH_MECHANISMS: Set<string> = new Set([
  'GSSAPI',
  'MONGODB-X509',
  // 'MONGODB-CR',
  'DEFAULT',
  'SCRAM-SHA-1',
  'SCRAM-SHA-256',
  'PLAIN'
]);

// Lookup table used to translate normalized (lower-cased) forms of connection string
// options to their expected camelCase version
const CASE_TRANSLATION: {[key:string]:string} = {
  replicaset: 'replicaSet',
  connecttimeoutms: 'connectTimeoutMS',
  sockettimeoutms: 'socketTimeoutMS',
  maxpoolsize: 'maxPoolSize',
  minpoolsize: 'minPoolSize',
  maxidletimems: 'maxIdleTimeMS',
  waitqueuemultiple: 'waitQueueMultiple',
  waitqueuetimeoutms: 'waitQueueTimeoutMS',
  wtimeoutms: 'wtimeoutMS',
  readconcern: 'readConcern',
  readconcernlevel: 'readConcernLevel',
  readpreference: 'readPreference',
  maxstalenessseconds: 'maxStalenessSeconds',
  readpreferencetags: 'readPreferenceTags',
  authsource: 'authSource',
  authmechanism: 'authMechanism',
  authmechanismproperties: 'authMechanismProperties',
  gssapiservicename: 'gssapiServiceName',
  localthresholdms: 'localThresholdMS',
  serverselectiontimeoutms: 'serverSelectionTimeoutMS',
  serverselectiontryonce: 'serverSelectionTryOnce',
  heartbeatfrequencyms: 'heartbeatFrequencyMS',
  retrywrites: 'retryWrites',
  uuidrepresentation: 'uuidRepresentation',
  zlibcompressionlevel: 'zlibCompressionLevel',
  tlsallowinvalidcertificates: 'tlsAllowInvalidCertificates',
  tlsallowinvalidhostnames: 'tlsAllowInvalidHostnames',
  tlsinsecure: 'tlsInsecure',
  tlscafile: 'tlsCAFile',
  tlscertificatekeyfile: 'tlsCertificateKeyFile',
  tlscertificatekeyfilepassword: 'tlsCertificateKeyFilePassword',
  wtimeout: 'wTimeoutMS',
  j: 'journal'
};

/** Auth mechanisms that require a username. */
const USERNAME_REQUIRED_MECHANISMS: Set<string> = new Set([
  'GSSAPI',
  'MONGODB-CR',
  'PLAIN',
  'SCRAM-SHA-1',
  'SCRAM-SHA-256'
]);

const PROTOCOL_MONGODB: string = 'mongodb';
const PROTOCOL_MONGODB_SRV: string = 'mongodb+srv';
const SUPPORTED_PROTOCOLS: string[] = [PROTOCOL_MONGODB, PROTOCOL_MONGODB_SRV];

// /** Matches anything up to the first dot. */
// const B4DOT_RX: RegExp = /^.*?\./;

// /**
//  * Determines whether a provided address matches the provided parent domain in order
//  * to avoid certain attack vectors.
//  */
// function matchesParentDomain(srvAddress: string, parentDomain: string): boolean {
//   // const regex = /^.*?\./;
//   const srv: string = `.${srvAddress.replace(B4DOT_RX, '')}`;
//   const parent: string = `.${parentDomain.replace(B4DOT_RX, '')}`;
//
//   return srv.endsWith(parent);
// }

// /**
//  * Lookup a `mongodb+srv` connection string, combine the parts and reparse it as a normal
//  * connection string.
//  *
//  * @param {string} uri The connection string to parse
//  * @param {object} options Optional user provided connection string options
//  * @param {function} callback
//  */
// function parseSrvConnectionString(uri, options, callback) {
//   const result = URL.parse(uri, true);
//
//   if (result.hostname.split('.').length < 3) {
//     return callback(new MongoParseError('URI does not have hostname, domain name and tld'));
//   }
//
//   result.domainLength = result.hostname.split('.').length;
//   if (result.pathname && result.pathname.match(',')) {
//     return callback(new MongoParseError('Invalid URI, cannot contain multiple hostnames'));
//   }
//
//   if (result.port) {
//     return callback(new MongoParseError(`Ports not accepted with '${PROTOCOL_MONGODB_SRV}' URIs`));
//   }
//
//   // Resolve the SRV record and use the result as the list of hosts to connect to.
//   const lookupAddress = result.host;
//   dns.resolveSrv(`_mongodb._tcp.${lookupAddress}`, (err, addresses) => {
//     if (err) return callback(err);
//
//     if (addresses.length === 0) {
//       return callback(new MongoParseError('No addresses found at host'));
//     }
//
//     for (let i = 0; i < addresses.length; i++) {
//       if (!matchesParentDomain(addresses[i].name, result.hostname, result.domainLength)) {
//         return callback(
//           new MongoParseError('Server record does not share hostname with parent URI')
//         );
//       }
//     }
//
//     // Convert the original URL to a non-SRV URL.
//     result.protocol = 'mongodb';
//     result.host = addresses.map(address => `${address.name}:${address.port}`).join(',');
//
//     // Default to SSL true if it's not specified.
//     if (
//       !('ssl' in options) &&
//       (!result.search || !('ssl' in result.query) || result.query.ssl === null)
//     ) {
//       result.query.ssl = true;
//     }
//
//     // Resolve TXT record and add options from there if they exist.
//     dns.resolveTxt(lookupAddress, (err, record) => {
//       if (err) {
//         if (err.code !== 'ENODATA') {
//           return callback(err);
//         }
//         record = null;
//       }
//
//       if (record) {
//         if (record.length > 1) {
//           return callback(new MongoParseError('Multiple text records not allowed'));
//         }
//
//         record = qs.parse(record[0].join(''));
//         if (Object.keys(record).some(key => key !== 'authSource' && key !== 'replicaSet')) {
//           return callback(
//             new MongoParseError('Text record must only set `authSource` or `replicaSet`')
//           );
//         }
//
//         Object.assign(result.query, record);
//       }
//
//       // Set completed options back into the URL object.
//       result.search = qs.stringify(result.query);
//
//       const finalString = URL.format(result);
//       parseConnectionString(finalString, options, callback);
//     });
//   });
// }

/**
 * Parses a query string item according to the connection string spec
 *
 * @param {string} key The key for the parsed value
 * @param {Array|String} value The value to parse
 * @return {Array|Object|String} The parsed value
 */
function parseQueryStringItemValue(key: string, value: any): any {
  if (Array.isArray(value)) {
    // deduplicate and simplify arrays
    value = value.filter((v: string, i: number): boolean => value.indexOf(v) === i);

    if (value.length === 1) {value = value[0];}
  } else if (STRING_OPTIONS.has(key)) {
    // TODO: refactor function to make this early return not
    // stand out or make everything retur nfrom its exclusive branch
    return value;
  } else if (value.indexOf(':') > 0) {
    value = value.split(',').reduce((result: {[key:string]: any}, pair: string): {[key:string]: any} => {
      const parts: string[] = pair.split(':');
      result[parts[0]] = parseQueryStringItemValue(key, parts[1]);
      return result;
    }, {});
  } else if (value.indexOf(',') > 0) {
    value = value.split(',').map((v: string): any => {
      return parseQueryStringItemValue(key, v);
    });
  } else if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
    value = value.toLowerCase() === 'true';
  } else if (!Number.isNaN(value)) {
    const numericValue: number = parseFloat(value);

    if (!Number.isNaN(numericValue)) {
      value = numericValue//parseFloat(value);
    }
  }

  return value;
}



/** Sets the value for `key`, allowing for any required translation. */
function applyConnectionStringOption(obj:{[key:string]:any}, key: string, value:any, options: {[key:string]:any}={}): void {
  // simple key translation
  if (key === 'journal') {
    key = 'j';
  } else if (key === 'wtimeoutms') {
    key = 'wtimeout';
  }

  // more complicated translation
  if (BOOLEAN_OPTIONS.has(key)) {
    value = value === 'true' || value === true;
  } else if (key === 'appname') {
    value = decodeURIComponent(value);
  } else if (key === 'readconcernlevel') {
    obj['readConcernLevel'] = value;
    key = 'readconcern';
    value = { level: value };
  }

  // simple validation
  if (key === 'compressors') {
    value = Array.isArray(value) ? value : [value];

    const onlyValidCompressors: boolean =value.every((c: string): boolean => c === 'snappy' || c === 'zlib')

    if (!onlyValidCompressors) {
      throw new MongoParseError(
        'Value for `compressors` must be at least one of: `snappy`, `zlib`'
      );
    }
  }

  if (key === 'authmechanism' && !AUTH_MECHANISMS.has(value)) {
    throw new MongoParseError(
      'Value for `authMechanism` must be one of: `DEFAULT`, `GSSAPI`, `PLAIN`, `MONGODB-X509`, `SCRAM-SHA-1`, `SCRAM-SHA-256`'
    );
  }

  if (key === 'readpreference' && !ReadPreference.isValid(value)) {
    throw new MongoParseError(
      'Value for `readPreference` must be one of: `primary`, `primaryPreferred`, `secondary`, `secondaryPreferred`, `nearest`'
    );
  }

  if (key === 'zlibcompressionlevel' && (value < -1 || value > 9)) {
    throw new MongoParseError('zlibCompressionLevel must be an integer between -1 and 9');
  }

  // special cases
  if (key === 'compressors' || key === 'zlibcompressionlevel') {
    obj.compression = obj.compression || {};
    obj = obj.compression;
  }

  if (key === 'authmechanismproperties') {
    if (typeof value.SERVICE_NAME === 'string') {obj.gssapiServiceName = value.SERVICE_NAME;}

    if (typeof value.SERVICE_REALM === 'string'){ obj.gssapiServiceRealm = value.SERVICE_REALM;}

    if (typeof value.CANONICALIZE_HOST_NAME !== 'undefined') {
      obj.gssapiCanonicalizeHostName = value.CANONICALIZE_HOST_NAME;
    }
  }

  if (key === 'readpreferencetags' && Array.isArray(value)) {
    value = splitArrayOfMultipleReadPreferenceTags(value);
  }

  // set the actual value
  if (options.caseTranslate && CASE_TRANSLATION[key]) {
    obj[CASE_TRANSLATION[key]] = value;
    return;
  }

  obj[key] = value;
}


/** Map an array of readpreference tags to a document array. */
function splitArrayOfMultipleReadPreferenceTags(value: string[]):{[key:string]:string}[] {
  const parsedTags: {[key:string]:string}[] = [];

  for (let i: number = 0; i < value.length; i++) {
    parsedTags[i] = {};

    value[i].split(',').forEach((individualTag: string): void => {
      const splitTag: string[] = individualTag.split(':');
      parsedTags[i][splitTag[0]] = splitTag[1];
    });
  }

  return parsedTags;
}

/**
 * Modifies the parsed connection string object taking into account expectations we
 * have for authentication-related options.
 *
 * @param {object} parsed The parsed connection string result
 * @return The parsed connection string result possibly modified for auth expectations
 */
function applyAuthExpectations(parsed: {[key:string]:any}): void {
  if (!parsed || !parsed.options) {
    return;
  }

  const options: {[key:string]:any} = parsed.options;
  const authSource: string = options.authsource || options.authSource;
  const authMechanism: string = options.authmechanism || options.authMechanism;

  if (authSource) {
    // parsed.auth = Object.assign({}, parsed.auth, { db: authSource });
    parsed.auth = { ...parsed.auth, db: authSource}
  }

  if (authMechanism) {
    if (
      USERNAME_REQUIRED_MECHANISMS.has(authMechanism) &&
      (!parsed.auth || !parsed.auth.username)
    ) {
      throw new MongoParseError(`Username required for mechanism \`${authMechanism}\``);
    }

    if (authMechanism === 'GSSAPI') {
      if (authSource  && authSource !== '$external') {
        throw new MongoParseError(
          `Invalid source \`${authSource}\` for mechanism \`${authMechanism}\` specified.`
        );
      }

      // parsed.auth = Object.assign({}, parsed.auth, { db: '$external' });
      parsed.auth = {...parsed.auth, db: "$external"}
    }

    if (authMechanism === 'MONGODB-X509') {
      if (parsed.auth && parsed.auth.password) {
        throw new MongoParseError(`Password not allowed for mechanism \`${authMechanism}\``);
      }

      if (authSource  && authSource !== '$external') {
        throw new MongoParseError(
          `Invalid source \`${authSource}\` for mechanism \`${authMechanism}\` specified.`
        );
      }

      // parsed.auth = Object.assign({}, parsed.auth, { db: '$external' });
            parsed.auth = {...parsed.auth, db: "$external"}
    }

    if (authMechanism === 'PLAIN') {
      if (parsed.auth && !parsed.auth.db) {
        // parsed.auth = Object.assign({}, parsed.auth, { db: '$external' });
              parsed.auth = {...parsed.auth, db: "$external"}
      }
    }
  }

  // default to `admin` if nothing else was resolved
  if (parsed.auth && !parsed.auth.db) {
    // parsed.auth = Object.assign({}, parsed.auth, { db: 'admin' });
          parsed.auth = {...parsed.auth, db: "admin"}
  }

  // return parsed;
}

/** Parses a query string according the connection string spec. */
function parseQueryString(query: string, options:{[key:string]:any}={}): {[key:string]:any} {
  const result:{[key:string]:any} = {};

  // let parsedQueryString = qs.parse(query);
  const parsedQueryString: {[key:string]:any} = {}

  // Transoform this Map to a simple object.
  new URLSearchParams(query).forEach((value: any, key:string): void => {
    parsedQueryString[key] = value
  });

  checkTLSOptions(parsedQueryString);

  for (const key in parsedQueryString) {
    const value: any = parsedQueryString[key];

    if (!value) {
      throw new MongoParseError('Incomplete key value pair for option');
    }

    const normalizedKey: string = key.toLowerCase();
    const parsedValue: any = parseQueryStringItemValue(normalizedKey, value);

    applyConnectionStringOption(result, normalizedKey, parsedValue, options);
  }

  // special cases for known deprecated options
  if (result.wtimeout && result.wtimeoutms) {
    delete result.wtimeout;
    console.warn('Unsupported option `wtimeout` specified');
  }

  return Object.keys(result).length ? result : null;
}

/**
 * Checks a query string for invalid tls opts according to the URI options spec.
 */
function checkTLSOptions(queryString: {[key:string]:any}): void {
  const queryStringKeys: string[] = Object.keys(queryString);

  if (
    queryStringKeys.includes('tlsInsecure')  &&
    (queryStringKeys.includes('tlsAllowInvalidCertificates')  ||
      queryStringKeys.includes('tlsAllowInvalidHostnames') )
  ) {
    throw new MongoParseError(
      'The `tlsInsecure` option cannot be used with `tlsAllowInvalidCertificates` or `tlsAllowInvalidHostnames`.'
    );
  }

  const tlsValue:any = assertTlsOptionsAreEqual('tls', queryString, queryStringKeys);
  const sslValue:any = assertTlsOptionsAreEqual('ssl', queryString, queryStringKeys);

  if (tlsValue  && sslValue ) {
    if (tlsValue !== sslValue) {
      throw new MongoParseError('All values of `tls` and `ssl` must be the same.');
    }
  }
}

/**
 * Checks a query string to ensure all tls/ssl options are the same.
 *
 * @param {string} key The key (tls or ssl) to check
 * @param {string} queryString The query string to check
 * @throws {MongoParseError}
 * @return The value of the tls/ssl option
 */
function assertTlsOptionsAreEqual(optionName: string, queryString:{[key:string]:any}, queryStringKeys: string[]):any {
  const queryStringHasTLSOption: boolean = queryStringKeys.includes(optionName);

  let optionValue: any;

  if (Array.isArray(queryString[optionName])) {
    optionValue = queryString[optionName][0];
  } else {
    optionValue = queryString[optionName];
  }

  if (queryStringHasTLSOption) {
    if (Array.isArray(queryString[optionName])) {
      const firstValue: any = queryString[optionName][0];

      queryString[optionName].forEach((tlsValue: any): void => {
        if (tlsValue !== firstValue) {
          throw new MongoParseError('All values of ${optionName} must be the same.');
        }
      });
    }
  }

  return optionValue;
}

/**
 * Parses a MongoDB connection string
 *
 * @param {*} uri the MongoDB connection string to parse
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.caseTranslate] Whether the parser should translate options back into camelCase after normalization
 * @param {parseCallback} callback
 */
export function parseConnectionString(uri: string, options: {[key:string]:any}={}, callback:Callback=noop): void {
  if (typeof options === 'function') {
    // (callback = options), (options = {});
    callback = options
    options = {}
  }

  // options = Object.assign({}, { caseTranslate: true }, options);
  options = { caseTRanslate: true, ...options}

  // Check for bad uris before we parse
  try {
    new URL(uri);
  } catch (_) {
    return callback(new MongoParseError('URI malformed, cannot be parsed'));
  }

  const cap: any = uri.match(HOSTS_RX);

  if (!cap) {
    return callback(new MongoParseError('Invalid connection string'));
  }

  const protocol: string = cap[1];

  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    return callback(new MongoParseError('Invalid protocol provided'));
  }

  if (protocol === PROTOCOL_MONGODB_SRV) {
    throw new MongoError("`mongodb+srv` connection string not supported yet")
    // return parseSrvConnectionString(uri, options, callback);
  }

  const dbAndQuery: string[] = cap[4].split('?');
  const db: string = dbAndQuery.length > 0 ? dbAndQuery[0] : null;
  const query: string = dbAndQuery.length > 1 ? dbAndQuery[1] : null;

  let parsedOptions: {[key:string]:any};

  try {
    parsedOptions = parseQueryString(query, options);
  } catch (parseError) {
    return callback(parseError);
  }

  // parsedOptions = Object.assign({}, parsedOptions, options);
  parsedOptions = {...parsedOptions, ...options}

  const auth: {[key:string]: string} = { username: null, password: null, db: db ? decodeURIComponent(db) : null };

  if (parsedOptions.auth) {
    // maintain support for legacy options passed into `MongoClient`
    if (parsedOptions.auth.username) {auth.username = parsedOptions.auth.username;}

    if (parsedOptions.auth.user){ auth.username = parsedOptions.auth.user;}

    if (parsedOptions.auth.password) {auth.password = parsedOptions.auth.password;}
  }

  if (cap[4].split('?')[0].includes('@')) {
    return callback(new MongoParseError('Unescaped slash in userinfo section'));
  }

  const authorityParts: string[] = cap[3].split('@');

  if (authorityParts.length > 2) {
    return callback(new MongoParseError('Unescaped at-sign in authority section'));
  }

  if (authorityParts.length > 1) {
    const authParts: string[] = authorityParts.shift().split(':');

    if (authParts.length > 2) {
      return callback(new MongoParseError('Unescaped colon in authority section'));
    }

    auth.username = decodeURIComponent(authParts[0]);
    auth.password = authParts[1] ? decodeURIComponent(authParts[1]) : null;
  }

  let hostParsingError: MongoParseError = null;

  const hosts: {[key:string]: any}[] = authorityParts
    .shift()
    .split(',')
    .map((host: string): {[key:string]: any} => {
      // TODO: make this parsing work identically in Deno
      // const parsedHost: {[key:string]: any} = URL.parse(`mongodb://${host}`);
      // const parsedUrl: URL = new URL(`mongodb://${host}`)
      const parsedHost: {[key:string]: any} = new URL(`mongodb://${host}`)

      if (parsedHost.path === '/:') {
        hostParsingError = new MongoParseError('Double colon in host identifier');
        return null;
      }

      // heuristically determine if we're working with a domain socket
      if (host.match(/\.sock/)) {
        parsedHost.hostname = decodeURIComponent(host);
        parsedHost.port = null;
      }

      if (Number.isNaN(parsedHost.port)) {
        hostParsingError = new MongoParseError('Invalid port (non-numeric string)');
        return;
      }

      const result: {[key:string]:any} = {
        host: parsedHost.hostname,
        port: parsedHost.port ? parseInt(parsedHost.port) : 27017
      };

      if (result.port === 0) {
        hostParsingError = new MongoParseError('Invalid port (zero) with hostname');
        return;
      }

      if (result.port > 65535) {
        hostParsingError = new MongoParseError('Invalid port (larger than 65535) with hostname');
        return;
      }

      if (result.port < 0) {
        hostParsingError = new MongoParseError('Invalid port (negative number)');
        return;
      }

      return result;
    })
    // .filter(host => !!host);

  if (hostParsingError) {
    return callback(hostParsingError);
  }

  if (!hosts.length || !hosts[0].host/*hosts[0].host === '' || hosts[0].host === null*/) {
    return callback(new MongoParseError('No hostname or hostnames provided in connection string'));
  }

  const result: {[key:string]:any} = {
    hosts: hosts,
    auth: auth.db || auth.username ? auth : null,
    options: Object.keys(parsedOptions).length ? parsedOptions : null
  };

  if (result.auth && result.auth.db) {
    result.defaultDatabase = result.auth.db;
  }

  try {
    applyAuthExpectations(result);
  } catch (authError) {
    return callback(authError);
  }

  callback(null, result);
}

// module.exports = parseConnectionString;
