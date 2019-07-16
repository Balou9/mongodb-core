// 'use strict';

// const retrieveBSON = require('../connection/utils').retrieveBSON;
import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const AuthProvider = require('./auth_provider').AuthProvider;
import { AuthProvider, SendAuthCommand} from "./auth_provider.ts"
import { MongoCredentials} from "./mongo_credentials.ts"
import {Connection } from "./../connection/connection.ts"
import {Callback, noop} from "./../utils.ts"

// TODO: can we get the Binary type from this.bson instead?
// const BSON = retrieveBSON();
// const Binary = BSON.Binary;

/** Creates a new Plain authentication mechanism. */
export class Plain extends AuthProvider {

  /** Implementation of authentication for a single connection. */
  _authenticateSingleConnection(sendAuthCommand: SendAuthCommand, connection: Connection, credentials: MongoCredentials, callback: Callback =noop):void {
    const username: string = credentials.username;
    const password: string = credentials.password;
    const payload: BSON.Binary = new BSON.Binary(`\x00${username}\x00${password}`);

    const command: {[key:string]:any} = {
      saslStart: 1,
      mechanism: 'PLAIN',
      payload: payload,
      autoAuthorize: 1
    };

    sendAuthCommand(connection, '$external.$cmd', command, callback);
  }
}

// module.exports = Plain;
