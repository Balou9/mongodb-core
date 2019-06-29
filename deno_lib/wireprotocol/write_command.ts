// 'use strict';

// const MongoError = require('../error').MongoError;
// import 
// const collectionNamespace = require('./shared').collectionNamespace;
// const command = require('./command');
// const MongoError = require('../error').MongoError;
import { MongoError } from "./../errors.ts"
// const MongoNetworkError = require('../error').MongoNetworkError;
// const collectionNamespace = require('./shared').collectionNamespace;
import { collectionNamespace } from "./shared.ts"
// const maxWireVersion = require('../utils').maxWireVersion;
// const command = require('./command');
import { command } from "./command.ts"
import { Callback} from "./../utils.ts"

function noop(): void {}

export function writeCommand(server: unknown, type: string, opsField: unknown, ns: string, ops: unknown, options: any = {}, callback: Callback =noop): void {
  if (ops.length === 0){ throw new MongoError(`${type} must contain at least one document`);}
  
  if (typeof options === 'function') {
    callback = options as Callback;
    options = {};
  }

  // options = options || {};
  const ordered: boolean = typeof options.ordered === 'boolean' ? options.ordered : true;
  const writeConcern: WriteConcern = options.writeConcern;

  const writeCommand: {[key:string]: any} = {};
  writeCommand[type] = collectionNamespace(ns);
  writeCommand[opsField] = ops;
  writeCommand.ordered = ordered;

  if (writeConcern && Object.keys(writeConcern).length > 0) {
    writeCommand.writeConcern = writeConcern;
  }

  if (options.collation) {
    for (let i: number = 0; i < writeCommand[opsField].length; i++) {
      if (!writeCommand[opsField][i].collation) {
        writeCommand[opsField][i].collation = options.collation;
      }
    }
  }

  if (options.bypassDocumentValidation === true) {
    writeCommand.bypassDocumentValidation = options.bypassDocumentValidation;
  }

  const commandOptions: {[key:string]: any} =     {
        checkKeys: type === 'insert',
        numberToReturn: 1,
        ...options
      }

  command(server, ns, writeCommand, commandOptions, callback);
}

// module.exports = writeCommand;
