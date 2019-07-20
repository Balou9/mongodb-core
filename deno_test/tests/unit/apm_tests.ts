'use strict';

// const Pool = require('../../../lib/connection/pool');
import { Pool } from '../../../deno_lib/connection/pool.ts';
// const BSON = require('bson');
import * as BSON from "https://denopkg.com/chiefbiiko/bson@deno_port/deno_lib/bson.ts";
// const apm = require('../../../lib/connection/apm');
import * as apm from '../../../deno_lib/connection/apm.ts';

import * as commands from '../../../deno_lib/connection/commands.ts'
// const expect = require('chai').expect;
import { runTests, test } from "https://deno.land/std/testing/mod.ts";
import {
  assertEquals,
  assertStrictEq
} from "https://deno.land/std/testing/asserts.ts";
// const Query = commands.Query;
const Query = commands.Query;
// const KillCursor = commands.KillCursor;
const KillCursor = commands.KillCursor;
// const GetMore = commands.GetMore;
const GetMore = commands.GetMore;

// const bson = new BSON();
const bson : BSON = new BSON();
// const pool = new Pool({}, { bson });
const pool : Pool = new Pool({}, { bson });

test('APM tests', function() {

  const metadata : unknown = { requires: { topology: ['single'] } };

  test(metadata, function commandStartedEventshouldWrapABasicQueryOption() : void {
    const db : string = 'test1';
    const coll : string = 'testingQuery';
    const query = new Query(
      bson,
      `${db}.${coll}`,
      {
        testCmd: 1,
        fizz: 'buzz',
        star: 'trek'
      },
      {}
    );
    const startEvent = new apm.CommandStartedEvent(pool, query);
    assertEquals(startEvent.commandName, 'testCmd');
    assertEquals(startEvent.databaseName, db);
    assertEquals(startEvent.requestId, query.requestId);
    assertStrictEq(startEvent.command, query.query);
  });

  test(metadata, function shouldWrapABasicKillCursorCommand() : void {
    const db : string = 'test2';
    const coll : string = 'testingKillCursors';
    const killCursor = new KillCursor(bson, `${db}.${coll}`, [12, 42, 57]);

    const startEvent = new apm.CommandStartedEvent(pool, killCursor);
    assertEquals(startEvent.commandName, 'killCursors')
    assertEquals(startEvent.databaseName, db)
    assertEquals(startEvent.requestId, killCursor.requestId)
    assertStrictEq(startEvent.command, {killCursors: coll, cursors: killCursor.cursorIds})
  });

  test(metadata, function shouldWrapABasicGetMoreCommand() : void {
    const db : string = 'test3';
    const coll : string = 'testingGetMore';
    const numberToReturn : number = 321;
    const getMore = new GetMore(bson, `${db}.${coll}`, 5525, { numberToReturn });

    const startEvent = new apm.CommandStartedEvent(pool, getMore);

    assertEquals(startEvent.commandName, 'getMore')
    assertEquals(startEvent.databaseName, db)
    assertEquals(startEvent.requestId, getMore.requestId)
    assertStrictEq(startEvent.command, { getMore: getMore.cursorId, collection: coll, batchSize: numberToReturn })
  });

  test(metadata, function shouldUpconvertAQueryWrappingACommandIntoTheCorrespondingCommand() : void {
    const db : string = 'admin';
    const coll = '$cmd'
    const query = new Query(
      bson,
      `${db}.${coll}`,
      {
        $query: {
          testCmd: 1,
          fizz: 'buzz',
          star: 'trek',
          batchSize: 0,
          skip: 0
        }
      },
      {}
    );

    const startEvent = new apm.CommandStartedEvent(pool, query);

    assertEquals(startEvent.commandName, 'testCmd');
    assertEquals(startEvent.databaseName, db);
    assertEquals(startEvent.requestId, query.requestId);
    assertStrictEq(startEvent.command, query.query.$query);
  });

  test(metadata, function shouldUpconvertAQueryWrappingAQueryIntoAFindCommand() : void {
    const db : string = 'test5';
    const coll : string = 'testingFindCommand';
    const query = new Query(
      bson,
      `${db}.${coll}`,
      {
        $query: {
          testCmd: 1,
          fizz: 'buzz',
          star: 'trek'
        }
      },
      {}
    );

    const startEvent = new apm.CommandStartedEvent(pool, query);

    assertEquals(startEvent.commandName, 'find')
    assertEquals(startEvent.databaseName, 'db')
    assertEquals(startEvent.requestId, query.requestId)
    assertStrictEq(startEvent.command, {
      find: coll,
      filter: query.query.$query,
      batchSize: 0,
      skip: 0
    })
  });
});

runTests();


// describe('APM tests', function() {
//   describe('CommandStartedEvent', function() {
//     // Only run on single topology since these are unit tests
//     const metadata = { requires: { topology: ['single'] } };
//
//     it('should wrap a basic query option', metadata, function() {
//       const db = 'test1';
//       const coll = 'testingQuery';
//       const query = new Query(
//         bson,
//         `${db}.${coll}`,
//         {
//           testCmd: 1,
//           fizz: 'buzz',
//           star: 'trek'
//         },
//         {}
//       );
//
//       const startEvent = new apm.CommandStartedEvent(pool, query);
//
//       expect(startEvent).to.have.property('commandName', 'testCmd');
//       expect(startEvent).to.have.property('databaseName', db);
//       expect(startEvent).to.have.property('requestId', query.requestId);
//       expect(startEvent)
//         .to.have.property('connectionId')
//         .that.is.a('string');
//       expect(startEvent)
//         .to.have.property('command')
//         .that.deep.equals(query.query);
//     });
//
//     it('should wrap a basic killCursor command', metadata, function() {
//       const db = 'test2';
//       const coll = 'testingKillCursors';
//       const killCursor = new KillCursor(bson, `${db}.${coll}`, [12, 42, 57]);
//
//       const startEvent = new apm.CommandStartedEvent(pool, killCursor);
//
//       expect(startEvent).to.have.property('commandName', 'killCursors');
//       expect(startEvent).to.have.property('databaseName', db);
//       expect(startEvent).to.have.property('requestId', killCursor.requestId);
//       expect(startEvent)
//         .to.have.property('connectionId')
//         .that.is.a('string');
//       expect(startEvent)
//         .to.have.property('command')
//         .that.deep.equals({
//           killCursors: coll,
//           cursors: killCursor.cursorIds
//         });
//     });
//
//     it('should wrap a basic GetMore command', metadata, function() {
//       const db = 'test3';
//       const coll = 'testingGetMore';
//       const numberToReturn = 321;
//       const getMore = new GetMore(bson, `${db}.${coll}`, 5525, { numberToReturn });
//
//       const startEvent = new apm.CommandStartedEvent(pool, getMore);
//
//       expect(startEvent).to.have.property('commandName', 'getMore');
//       expect(startEvent).to.have.property('databaseName', db);
//       expect(startEvent).to.have.property('requestId', getMore.requestId);
//       expect(startEvent)
//         .to.have.property('connectionId')
//         .that.is.a('string');
//       expect(startEvent)
//         .to.have.property('command')
//         .that.deep.equals({
//           getMore: getMore.cursorId,
//           collection: coll,
//           batchSize: numberToReturn
//         });
//     });
//
//     it(
//       'should upconvert a Query wrapping a command into the corresponding command',
//       metadata,
//       function() {
//         const db = 'admin';
//         const coll = '$cmd';
//         const query = new Query(
//           bson,
//           `${db}.${coll}`,
//           {
//             $query: {
//               testCmd: 1,
//               fizz: 'buzz',
//               star: 'trek',
//               batchSize: 0,
//               skip: 0
//             }
//           },
//           {}
//         );
//
//         const startEvent = new apm.CommandStartedEvent(pool, query);
//
//         expect(startEvent).to.have.property('commandName', 'testCmd');
//         expect(startEvent).to.have.property('databaseName', db);
//         expect(startEvent).to.have.property('requestId', query.requestId);
//         expect(startEvent)
//           .to.have.property('connectionId')
//           .that.is.a('string');
//         expect(startEvent)
//           .to.have.property('command')
//           .that.deep.equals(query.query.$query);
//       }
//     );
//
//     it('should upconvert a Query wrapping a query into a find command', metadata, function() {
//       const db = 'test5';
//       const coll = 'testingFindCommand';
//       const query = new Query(
//         bson,
//         `${db}.${coll}`,
//         {
//           $query: {
//             testCmd: 1,
//             fizz: 'buzz',
//             star: 'trek'
//           }
//         },
//         {}
//       );
//
//       const startEvent = new apm.CommandStartedEvent(pool, query);
//
//       expect(startEvent).to.have.property('commandName', 'find');
//       expect(startEvent).to.have.property('databaseName', db);
//       expect(startEvent).to.have.property('requestId', query.requestId);
//       expect(startEvent)
//         .to.have.property('connectionId')
//         .that.is.a('string');
//       expect(startEvent)
//         .to.have.property('command')
//         .that.deep.equals({
//           find: coll,
//           filter: query.query.$query,
//           batchSize: 0,
//           skip: 0
//         });
//     });
//   });
// });
//
