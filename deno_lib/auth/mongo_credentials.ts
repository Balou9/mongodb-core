// 'use strict';

// Resolves the default auth mechanism according to
// https://github.com/mongodb/specifications/blob/master/source/auth/auth.rst
function getDefaultAuthMechanism(ismaster: {[key:string]:any}): string {
  if (ismaster) {
    // If ismaster contains saslSupportedMechs, use scram-sha-256
    // if it is available, else scram-sha-1
    if (Array.isArray(ismaster.saslSupportedMechs)) {
      return ismaster.saslSupportedMechs.includes('SCRAM-SHA-256')
        ? 'scram-sha-256'
        : 'scram-sha-1';
    }

    // Fallback to legacy selection method. If wire version >= 3, use scram-sha-1
    if (ismaster.maxWireVersion >= 3) {
      return 'scram-sha-1';
    }
  }

  // Default for wireprotocol < 3
  return 'mongocr';
}

/** A representation of the credentials used by MongoDB. */
export class MongoCredentials {
  username: string
  password: string
  source: string
  mechanism: string
  mechanismProperties:{[key:string]:any}

  constructor(options:{[key:string]:any}={}) {
    // options = options || {};
    this.username = options.username;
    this.password = options.password;
    this.source = options.source || options.db;
    this.mechanism = options.mechanism || 'default';
    this.mechanismProperties = options.mechanismProperties;
  }

  /** Determines if two MongoCredentials objects are equivalent. */
  equals(other: MongoCredentials): boolean {
    return (
      this.mechanism === other.mechanism &&
      this.username === other.username &&
      this.password === other.password &&
      this.source === other.source
    );
  }

  /**
   * If the authentication mechanism is set to "default", resolves the authMechanism
   * based on the server version and server supported sasl mechanisms.
   *
   * @param {Object} [ismaster] An ismaster response from the server
   */
  resolveAuthMechanism(ismaster: {[key:string]:any}): void {
    // If the mechanism is not "default", then it does not need to be resolved
    if (this.mechanism.toLowerCase() === 'default') {
      this.mechanism = getDefaultAuthMechanism(ismaster);
    }
  }
}

// module.exports = { MongoCredentials };
