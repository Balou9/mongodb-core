// 'use strict';
// const Msg = require('../connection/msg').Msg;
// const KillCursor = require('../connection/commands').KillCursor;
// const GetMore = require('../connection/commands').GetMore;
import { Msg, KillCursor, GetMore } from "./../connection/commands.ts";
// const calculateDurationInMs = require('../utils').calculateDurationInMs;
import { MongoError } from "./../errors.ts";
import { calculateDurationInMs } from "./../utils.ts"

/** Commands that we want to redact because of the sensitive nature of their contents */
const SENSITIVE_COMMANDS: Set<string> = new Set([
  'authenticate',
  'saslStart',
  'saslContinue',
  'getnonce',
  'createUser',
  'updateUser',
  'copydbgetnonce',
  'copydbsaslstart',
  'copydb'
]);

// Helper functions
// const extractCommandName = commandDoc => Object.keys(commandDoc)[0];
function extractCommandName(command: {[key:string]: any}): string {
  return Object.keys(command)[0];
}

function namespace(command: {[key:string]: any}): string {
  return command.ns;
}

function databaseName(command: {[key:string]: any}): string {
  return command.ns.split('.')[0];
}
// const namespace = command => command.ns;
// const databaseName = command => command.ns.split('.')[0];
// const collectionName = command => command.ns.split('.')[1];
function collectionName(command: {[key:string]: any}): string {
  return command.ns.split('.')[1];
}

function generateConnectionId(pool: {[key:string]: any}): string {
  return `${pool.options.host}:${pool.options.port}`;
}
// const generateConnectionId = pool => `${pool.options.host}:${pool.options.port}`;
// const maybeRedact = (commandName, result) => (SENSITIVE_COMMANDS.has(commandName) ? {} : result);
function maybeRedact(commandName: string, result: {[key:string]: any}):  {[key:string]: any} {
  return SENSITIVE_COMMANDS.has(commandName) ? {} : result
}

const LEGACY_FIND_QUERY_MAP: {[key:string]: string} = {
  $query: 'filter',
  $orderby: 'sort',
  $hint: 'hint',
  $comment: 'comment',
  $maxScan: 'maxScan',
  $max: 'max',
  $min: 'min',
  $returnKey: 'returnKey',
  $showDiskLoc: 'showRecordId',
  $maxTimeMS: 'maxTimeMS',
  $snapshot: 'snapshot'
};

const LEGACY_FIND_OPTIONS_MAP: {[key:string]: string} = {
  numberToSkip: 'skip',
  numberToReturn: 'batchSize',
  returnFieldsSelector: 'projection'
};

const OP_QUERY_KEYS: string[] = [
  'tailable',
  'oplogReplay',
  'noCursorTimeout',
  'awaitData',
  'partial',
  'exhaust'
];

/**
 * Extracts the actual command from the query, possibly upconverting if it's a legacy
 * format.
 */
function extractCommand (command: {[key:string]: any}):  {[key:string]: any} {
  if (command instanceof GetMore) {
    return {
      getMore: command.cursorId,
      collection: collectionName(command),
      batchSize: command.numberToReturn
    };
  }

  if (command instanceof KillCursor) {
    return {
      killCursors: collectionName(command),
      cursors: command.cursorIds
    };
  }

  if (command instanceof Msg) {
    return command.command;
  }

  if (command.query && command.query.$query) {
    let result: {[key:string]: any};
    if (command.ns === 'admin.$cmd') {
      // upconvert legacy command
      result = Object.assign({}, command.query.$query);
    } else {
      // upconvert legacy find command
      result = { find: collectionName(command) };
      Object.keys(LEGACY_FIND_QUERY_MAP).forEach(key => {
        if (typeof command.query[key] !== 'undefined')
          result[LEGACY_FIND_QUERY_MAP[key]] = command.query[key];
      });
    }

    Object.keys(LEGACY_FIND_OPTIONS_MAP).forEach(key => {
      if (typeof command[key] !== 'undefined') result[LEGACY_FIND_OPTIONS_MAP[key]] = command[key];
    });

    OP_QUERY_KEYS.forEach(key => {
      if (command[key]) result[key] = command[key];
    });

    if (typeof command.pre32Limit !== 'undefined') {
      result.limit = command.pre32Limit;
    }

    if (command.query.$explain) {
      return { explain: result };
    }

    return result;
  }

  return command.query ? command.query : command;
};

/** Extracts a reply. */
function extractReply (command: {[key:string]: any}, reply: {[key:string]: any}): {[key:string]: any} {
  if (command instanceof GetMore) {
    return {
      ok: 1,
      cursor: {
        id: reply.message.cursorId,
        ns: namespace(command),
        nextBatch: reply.message.documents
      }
    };
  }

  if (command instanceof KillCursor) {
    return {
      ok: 1,
      cursorsUnknown: command.cursorIds
    };
  }

  // is this a legacy find command?
  if (command.query && typeof command.query.$query !== 'undefined') {
    return {
      ok: 1,
      cursor: {
        id: reply.message.cursorId,
        ns: namespace(command),
        firstBatch: reply.message.documents
      }
    };
  }

  // in the event of a `noResponse` command, just return
  if (reply === null) return reply;

  return reply.result;
};

/** An event indicating the start of a given command */
export class CommandStartedEvent {
  readonly command: {[key:string]: any};
  readonly databaseName: string;
  readonly commandName: string;
  readonly requestId: number;
  readonly connnectionId: string;

  /** Creates a started event. */
  constructor(pool: unknown, command: { [key:string]: any}) {
    // const cmd: { [key:string]: any} =
    // const commandName: string =

    // NOTE: remove in major revision, this is not spec behavior
    // if (SENSITIVE_COMMANDS.has(commandName)) {
    //   this.commandObj = {};
    //   this.commandObj[commandName] = true;
    // }

    // Object.assign(this, {
    //   command: cmd,
    //   databaseName: databaseName(command),
    //   commandName,
    //   requestId: command.requestId,
    //   connectionId: generateConnectionId(pool)
    // });

    this.command = extractCommand(command);
    this.commandName = extractCommandName(this.command);
    this.databaseName = databaseName(command)
    this.requestId = command.requestId;
    this.connnectionId = generateConnectionId(pool)
  }
}

/** An event indicating the success of a given command */
export class CommandSucceededEvent {
  readonly duration: number;
  readonly commandName: string;
  readonly reply:  { [key:string]: any}
  readonly requestId: number;
  readonly connectionId: string;

  /** Create a succeeded event. */
  constructor(pool: unknown, command: { [key:string]: any}, reply:{ [key:string]: any}, started: number) {
    // const cmd = extractCommand(command);
    // const commandName = extractCommandName(cmd);
    const cmd: { [key:string]: any}= extractCommand(command);
    this.commandName = extractCommandName(cmd);

    // Object.assign(this, {
    //   duration: calculateDurationInMs(started),
    //   commandName,
    //   reply: maybeRedact(commandName, extractReply(command, reply)),
    //   requestId: command.requestId,
    //   connectionId: generateConnectionId(pool)
    // });

    this.duration = calculateDurationInMs(started)
    this.reply = maybeRedact(this.commandName, extractReply(command, reply))
    this.requestId = command.requestId
    this.connectionId = generateConnectionId(pool)
  }
}

/** An event indicating the failure of a given command */
export class CommandFailedEvent {
  readonly duration: number;
  readonly commandName: string;
  readonly failure:  { [key:string]: any}
  readonly requestId: number;
  readonly connectionId: string
  /**
   * Create a failure event
   *
   * @param {Pool} pool the pool that originated the command
   * @param {Object} command the command
   * @param {MongoError|Object} error the generated error or a server error response
   * @param {Array} started a high resolution tuple timestamp of when the command was first sent, to calculate duration
   */
  constructor(pool: unknown, command: { [key:string]: any}, error: MongoError | { [key:string]: any}, started: number) {
    // const cmd = extractCommand(command);
    // const commandName = extractCommandName(cmd);

    // Object.assign(this, {
    //   duration: calculateDurationInMs(started),
    //   commandName,
    //   failure: maybeRedact(commandName, error),
    //   requestId: command.requestId,
    //   connectionId: generateConnectionId(pool)
    // });
    this.commandName = extractCommandName(extractCommand(command));
    this.duration = calculateDurationInMs(started)
    this.failure = maybeRedact(this.commandName, error)
    this.requestId = command.requestId
    this.connectionId = generateConnectionId(pool)
  }
}

// module.exports = {
//   CommandStartedEvent,
//   CommandSucceededEvent,
//   CommandFailedEvent
// };
