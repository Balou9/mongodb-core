// 'use strict';

export class CommandResult {
  readonly result: {[key:string]: any};
  readonly connection: unknown;
  readonly message: unknown;

  /** Creates a new command result. */
  constructor(result: {[key:string]: any}, connection: unknown, message: unknown) {
    this.result = result;
    this.connection = connection;
    this.message = message;
  }

  /** JSON representation of a command result. */
  toJSON(): {[key:string]: any} {
    const result: {[key:string]: any}  = Object.assign({}, this, this.result);
    delete result.message;
    return result;
  }

  /** String representation of a command result. */
  toString(): string {
    return JSON.stringify(this.toJSON());
  }
}

// /**
//  * Creates a new CommandResult instance
//  * @class
//  * @param {object} result CommandResult object
//  * @param {Connection} connection A connection instance associated with this result
//  * @return {CommandResult} A cursor instance
//  */
// var CommandResult = function(result, connection, message) {
//   this.result = result;
//   this.connection = connection;
//   this.message = message;
// };
//
// /**
//  * Convert CommandResult to JSON
//  * @method
//  * @return {object}
//  */
// CommandResult.prototype.toJSON = function() {
//   let result = Object.assign({}, this, this.result);
//   delete result.message;
//   return result;
// };
//
// /**
//  * Convert CommandResult to String representation
//  * @method
//  * @return {string}
//  */
// CommandResult.prototype.toString = function() {
//   return JSON.stringify(this.toJSON());
// };
//
// module.exports = CommandResult;
