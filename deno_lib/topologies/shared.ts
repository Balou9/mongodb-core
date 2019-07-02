/** MongoDB client information. */
export interface ClientInfo {
  driver: {
    name: string,
    version: string
  };
  os: {
    type: string,
    name: string,
    architecture: string,
    version: string
  };
platform: string;
 application: { name: string}
}
