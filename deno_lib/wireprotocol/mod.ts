import { writeCommand} from "./write_command.ts"
import { Callback} from "./../utils.ts"

export {killCursors} from "./kill_cursors.ts"
export {getMore} from "./get_more.ts"
export {query} from "./query.ts"
export {command} from "./command.ts"


export function  insert(server: unknown, ns: string, ops:  {[key:string]:any}[], options: {[key:string]: any}, callback: Callback): void {
    writeCommand(server, 'insert', 'documents', ns, ops, options, callback);
  }
  
export function  update(server: unknown, ns: string, ops: {[key:string]:any}[],options : {[key:string]: any}, callback: Callback): void {
    writeCommand(server, 'update', 'updates', ns, ops, options, callback);
  }
  
export  function remove(server: unknown, ns: string, ops: {[key:string]:any}[], options: {[key:string]: any}, callback: Callback): void {
    writeCommand(server, 'delete', 'deletes', ns, ops, options, callback);
  }
  
// export   killCursors: require('./kill_cursors'),
//   getMore: require('./get_more'),
//   query: require('./query'),
//   command: require('./command')
// };