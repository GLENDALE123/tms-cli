// Firebase web configuration identifies the project; it is not an administrator credential.
export const config = Object.freeze({
  apiKey: 'AIzaSyB4nSpGhucC0NR57Zpu_syg86sjdFtLtaU',
  projectId: 'hs-jig-b2093',
  databaseId: 'tms-production',
  storageBucket: 'hs-jig-b2093.firebasestorage.app',
  // This fixed HTTPS origin is the independently hosted TMS retrieval service.
  retrievalEndpoint: 'https://oracle.tail1b2b2b.ts.net:10000/tms/v1/search',
  trustedRetrievalOrigins: ['https://oracle.tail1b2b2b.ts.net:10000'],
});
