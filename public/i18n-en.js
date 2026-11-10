// English dictionary: Czech source text → English. One file per area so they can be edited apart;
// a key defined twice must have the same translation (tests/i18n.test.mjs checks it).
import shell from './i18n-en-shell.js';
import home from './i18n-en-home.js';
import security from './i18n-en-security.js';
import systems from './i18n-en-systems.js';
import access from './i18n-en-access.js';
import inventory from './i18n-en-inventory.js';
import server from './i18n-en-server.js';
export const PARTS=Object.freeze({shell,home,security,systems,access,inventory,server});
export default Object.freeze(Object.assign({},...Object.values(PARTS)));
