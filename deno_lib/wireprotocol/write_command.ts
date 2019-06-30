// 'use strict';

// const MongoError = require('../error').MongoError;
// import 
// const collectionNamespace = require('./shared').collectionNamespace;
// const command = require('./command');
// const MongoError = require('../error').MongoError;
import { WriteConcern} from "./../transactions.ts"
import { MongoError } from "./../errors.ts"
// const MongoNetworkError = require('../error').MongoNetworkError;
// const collectionNamespace = require('./shared').collectionNamespace;
import { collectionNamespace } from "./shared.ts"
// const maxWireVersion = require('../utils').maxWireVersion;
// const command = require('./command');
import { command } from "./command.ts"
import { Callback, noop} from "./../utils.ts"

// function noop(): void {}

/** Wraps given ops in a write command and sends them to the db server. */
export function writeCommand(server: unknown, type: string, opsField: number | string, ns: string, ops: {[key:string]:any}[], options: any = {}, callback: Callback =noop): void {
  if (ops.length === 0){ throw new MongoError(`${type} must contain at least one document`);}
  
  if (typeof options === 'function') {
    callback = options as Callback;
    options = {};
  }

  // options = options || {};
  const ordered: boolean = typeof options.ordered === 'boolean' ? options.ordered : true;
  const writeConcern: WriteConcern = options.writeConcern;

  const cmd: {[key:string]: any} = {};
  
  cmd[type] = collectionNamespace(ns);
  cmd[opsField] = ops;
  cmd.ordered = ordered;

  if (writeConcern && Object.keys(writeConcern).length > 0) {
    cmd.writeConcern = writeConcern;
  }

  if (options.collation) {
    for (let i: number = 0; i < cmd[opsField].length; i++) {
      if (!cmd[opsField][i].collation) {
        cmd[opsField][i].collation = options.collation;
      }
    }
  }

  if (options.bypassDocumentValidation === true) {
    cmd.bypassDocumentValidation = options.bypassDocumentValidation;
  }

  const cmdOptions: {[key:string]: any} =     {
        checkKeys: type === 'insert',
        numberToReturn: 1,
        ...options
      }

  command(server, ns, cmd, cmdOptions, callback);
}

// module.exports = writeCommand;
