// 'use strict';

// const MongoError = require('../error').MongoError
import { MongoError} from "./../errors.ts"
import { Callback, noop} from "./../utils.ts"
import { Connection} from "./../connection/connection.ts"
import { MongoCredentials} from "./mongo_credentials.ts"

/** A function that writes authentication commands to a specific connection. */
export interface SendAuthCommand {
  (connection: Connection, command:{toBin:() => Uint8Array[], [key:string]: any}, callback:Callback) : void
}

/** Generic auth provider representation. */
export class AuthProvider {
  authStore: MongoCredentials[]

  /**
   * Creates a new AuthProvider, which dictates how to authenticate for a given
   * mechanism.
   */
  constructor(/*bson*/) {
    // this.bson = bson;
    this.authStore = [];
  }

  /**
   * Authenticate
   * @method
   * @param {SendAuthCommand} sendAuthCommand Writes an auth command directly to a specific connection
   * @param {Connection[]} connections Connections to authenticate using this authenticator
   * @param {MongoCredentials} credentials Authentication credentials
   * @param {authResultCallback} callback The callback to return the result from the authentication
   */
  auth(sendAuthCommand: SendAuthCommand, connections: Connection[], credentials: MongoCredentials, callback: Callback=noop): void {
    // Total connections
    let count: number = connections.length;

    if (!count/* === 0*/) {
       return callback(null, null);
      // return;
    }

    // Valid connections
    let numberOfValidConnections: number = 0;
    let errorObject: MongoError = null;

    const execute: (connection: Connection) => void = (connection: Connection): void => {
      this._authenticateSingleConnection(sendAuthCommand, connection, credentials, (err? :MongoError, r?:{[key:string]:any}): void => {
        // Adjust count
        // count = count - 1;
        --count

        // If we have an error
        if (err) {
          errorObject = new MongoError(err);
        } else if (r && (r.$err || r.errmsg)) {
          errorObject = new MongoError(r);
        } else {
          // numberOfValidConnections = numberOfValidConnections + 1;
          ++numberOfValidConnections
        }

        if (count !== 0) {
                  // Still authenticating against other connections.
          return;
        }

        if (numberOfValidConnections > 0) {
            // We have authenticated all connections, store the auth details
          this.addCredentials(credentials);
          // Return correct authentication
          callback(null, true);
        } else {
          if (!errorObject) {
            errorObject = new MongoError(`failed to authenticate using ${credentials.mechanism}`);
          }
          callback(errorObject, false);
        }
      });
    };

    const executeInNextTick: (_connection:Connection) => void =( _connection: Connection): void => {setTimeout((): void => execute(_connection), 0)};

    // For each connection we need to authenticate
    while (connections.length > 0) {
      executeInNextTick(connections.shift());
    }
  }

  /**
   * Implementation of a single connection authenticating. Must be overridden.
   * Will error if called directly.
   */
  _authenticateSingleConnection(sendAuthCommand: SendAuthCommand, connection: Connection, credentials: MongoCredentials, callback:Callback) {
    throw new Error('_authenticateSingleConnection must be overridden');
  }

  /**
   * Adds credentials to store only if it does not exist
   * @param {MongoCredentials} credentials credentials to add to store
   */
  addCredentials(credentials: MongoCredentials): void {
    const found: boolean = this.authStore.some((cred: MongoCredentials): boolean => cred.equals(credentials));

    if (!found) {
      this.authStore.push(credentials);
    }
  }

  /** Re-authenticates the auth store. */
  reauthenticate(sendAuthCommand: SendAuthCommand, connections: Connection[], callback: Callback=noop): void {
    const authStore: MongoCredentials[] = this.authStore.slice(0);

    let count: number = authStore.length;

    if (!count) {
      return callback(null, null);
    }

    for (let i: number = 0; i < authStore.length; i++) {
      this.auth(sendAuthCommand, connections, authStore[i], function(err? :MongoError): void {
        // count = count - 1;
        --count

        if (!count) {
          callback(err, null);
        }
      });
    }
  }

  /**
   * Remove credentials that have been previously stored in the auth provider
   * @method
   * @param {string} source Name of database we are removing authStore details about
   * @return {object}
   */
  logout(source: string): void {
    this.authStore = this.authStore.filter((credentials: MongoCredentials): boolean => credentials.source !== source);
  }
}

/**
 * A function that writes authentication commands to a specific connection
 * @callback SendAuthCommand
 * @param {Connection} connection The connection to write to
 * @param {Command} command A command with a toBin method that can be written to a connection
 * @param {AuthWriteCallback} callback Callback called when command response is received
 */

/**
 * A callback for a specific auth command
 * @callback AuthWriteCallback
 * @param {Error} err If command failed, an error from the server
 * @param {object} r The response from the server
 */

/**
 * This is a result from an authentication strategy
 *
 * @callback authResultCallback
 * @param {error} error An error object. Set to null if no error present
 * @param {boolean} result The result of the authentication process
 */

// module.exports = { AuthProvider };
